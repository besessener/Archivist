import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../packages/core/src/context';
import { LlmService } from '../../packages/core/src/services/llm';
import type { SecretService } from '../../packages/core/src/services/secret';
import type { SettingsService } from '../../packages/core/src/services/settings';
import { Logger } from '../../packages/core/src/util/logger';

/** LLM client with fixed settings and an endpoint that rejects the given optional parameters with HTTP 400. */
const client = (rejection: string, unsupported: string[] = ['store']) => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    bodies.push(body);
    if (unsupported.some((p) => p in body)) return new Response(JSON.stringify({ error: { message: rejection } }), { status: 400 });
    return new Response(JSON.stringify({ output_text: 'OK' }), { status: 200 });
  };
  const ctx = { events: { emit: () => true }, logger: new Logger(null), database: {} };
  const settings = {
    get: () => ({
      llm: { baseUrl: 'https://llm.example.test/v1', model: 'test-model', maxInputChars: 10000, reasoningEffort: 'low', timeoutMs: 5000 },
      privacy: { llmMode: 'auto' },
    }),
  };
  const secrets = { getApiKey: () => 'sk-test' };
  const llm = new LlmService(ctx as unknown as AppContext, settings as unknown as SettingsService, secrets as unknown as SecretService, fetchImpl, 0);
  return { llm, bodies, logger: ctx.logger };
};

const request = { instructions: 'Test', input: 'Hallo', purpose: 'Test', json: true };

describe('LLM client: fallback request without optional parameters', () => {
  it.each([
    ["Unsupported parameter: 'store' is not supported with this model.", 'store'],
    ['Unrecognized request argument supplied: reasoning', 'reasoning'],
    ["Unknown parameter: 'text.format'.", 'text'],
    ["'text.format' is not supported", 'text'],
    ["This model does not support the 'reasoning' parameter.", 'reasoning'],
    ["Invalid parameter: 'text.format' of type 'json_object' is not supported with this model.", 'text'],
  ])('retries without exactly the parameter the error names: %s', async (message, param) => {
    const { llm, bodies } = client(message, [param]);

    await expect(llm.complete(request)).resolves.toBe('OK');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ store: false, reasoning: { effort: 'low' }, text: { format: { type: 'json_object' } } });
    expect(bodies[1]).not.toHaveProperty(param);
    for (const kept of ['store', 'reasoning', 'text'].filter((p) => p !== param)) expect(bodies[1]).toHaveProperty(kept);
  });

  it('keeps store:false when the error names no parameter it knows (#150)', async () => {
    const { llm, bodies } = client('Unknown parameter supplied.', ['reasoning']);

    await expect(llm.complete(request)).resolves.toBe('OK');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ store: false });
    expect(bodies[1]).not.toHaveProperty('reasoning');
  });

  it('remembers a rejected parameter per endpoint instead of re-learning it on every call', async () => {
    const { llm, bodies } = client('Unrecognized request argument supplied: reasoning', ['reasoning']);

    await llm.complete(request);
    await llm.complete(request);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toMatchObject({ store: false });
    expect(bodies[2]).not.toHaveProperty('reasoning');
  });

  it('never drops store:false for an error about another parameter, even when it keeps failing', async () => {
    const { llm, bodies } = client('Unrecognized request argument supplied: reasoning', ['store']);

    await expect(llm.complete(request)).rejects.toMatchObject({ message: expect.stringMatching(/abgelehnt/) });
    expect(bodies.every((b) => b.store === false)).toBe(true);
  });

  it.each(['invalid input format', "Invalid 'input': format error"])('reports genuine format errors without a fallback request: %s', async (message) => {
    const { llm, bodies } = client(message);

    await expect(llm.complete(request)).rejects.toMatchObject({
      message: expect.stringMatching(/abgelehnt/),
      options: { details: expect.stringContaining(message) },
    });
    expect(bodies).toHaveLength(1);
    expect(llm.status().state).toBe('error');
  });
});

describe('LLM client: JSON mode', () => {
  /** Behaves like the OpenAI Responses API: json_object requires the word "json" in the input (instructions do not count). */
  const strictClient = () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      bodies.push(body);
      if (body.text && !/json/i.test(String(body.input)))
        return new Response(
          JSON.stringify({
            error: { message: "Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'." },
          }),
          { status: 400 },
        );
      return new Response(JSON.stringify({ output_text: '{"ok":true}' }), { status: 200 });
    };
    const ctx = { events: { emit: () => true }, logger: new Logger(null), database: {} };
    const settings = {
      get: () => ({
        llm: { baseUrl: 'https://llm.example.test/v1', model: 'test-model', maxInputChars: 20, reasoningEffort: null, timeoutMs: 5000 },
        privacy: { llmMode: 'auto' },
      }),
    };
    const secrets = { getApiKey: () => 'sk-test' };
    const llm = new LlmService(ctx as unknown as AppContext, settings as unknown as SettingsService, secrets as unknown as SecretService, fetchImpl, 0);
    return { llm, bodies };
  };

  it('mentions JSON in the input, also after truncation, so the endpoint accepts json_object', async () => {
    const { llm, bodies } = strictClient();

    await expect(llm.complete({ instructions: 'Antworte mit JSON.', input: 'Nachricht des Benutzers: '.repeat(5), purpose: 'Test', json: true })).resolves.toBe(
      '{"ok":true}',
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ text: { format: { type: 'json_object' } } });
    expect(String(bodies[0]?.input)).toMatch(/^Antworte als JSON\.\n\nNachricht des Benutz\n\[… Eingabe auf 20 Zeichen gekürzt\]$/);
    expect(llm.status().state).toBe('ok');
  });

  it('leaves the input unchanged without JSON mode or when it already mentions JSON', async () => {
    const { llm, bodies } = strictClient();

    await llm.complete({ instructions: 'Test', input: 'Hallo', purpose: 'Test' });
    await llm.complete({ instructions: 'Test', input: 'Gib JSON aus', purpose: 'Test', json: true });
    expect(bodies.map((b) => b.input)).toEqual(['Hallo', 'Gib JSON aus']);
  });
});

describe('LLM client: circuit breaker (#151)', () => {
  const failingClient = () => {
    let down = true;
    let requests = 0;
    const fetchImpl = async (): Promise<Response> => {
      requests += 1;
      if (down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return new Response(JSON.stringify({ output_text: 'OK' }), { status: 200 });
    };
    const ctx = { events: { emit: () => true }, logger: new Logger(null), database: {} };
    const settings = {
      get: () => ({
        llm: { baseUrl: 'https://llm.example.test/v1', model: 'test-model', maxInputChars: 10000, reasoningEffort: null, timeoutMs: 5000 },
        privacy: { llmMode: 'auto' },
      }),
    };
    const secrets = { getApiKey: () => 'sk-test' };
    const llm = new LlmService(ctx as unknown as AppContext, settings as unknown as SettingsService, secrets as unknown as SecretService, fetchImpl, 0);
    return {
      llm,
      requests: () => requests,
      up: () => {
        down = false;
      },
    };
  };
  const plain = { instructions: 'Test', input: 'Hallo', purpose: 'Test' };

  it('fails fast after an unreachable endpoint instead of waiting again; the connection test still goes through', async () => {
    const c = failingClient();
    await expect(c.llm.complete(plain)).rejects.toMatchObject({ category: 'network_error' });
    expect(c.requests()).toBe(3);

    await expect(c.llm.complete(plain)).rejects.toMatchObject({ message: expect.stringMatching(/eben nicht erreichbar/) });
    expect(c.requests()).toBe(3);

    c.up();
    await expect(c.llm.complete({ ...plain, bypassPrivacy: true })).resolves.toBe('OK');
    // a success closes the breaker again
    await expect(c.llm.complete(plain)).resolves.toBe('OK');
  });

  it('an endpoint that answers with an HTTP error does not open the breaker', async () => {
    const { llm, bodies } = client('invalid input format');
    await expect(llm.complete(request)).rejects.toThrow();
    await expect(llm.complete(request)).rejects.toThrow(/abgelehnt/);
    expect(bodies).toHaveLength(2);
  });
});

describe('LLM client: transmission log', () => {
  it('a transmission it cannot record is logged as an error, and the call still succeeds', async () => {
    const { llm, logger } = client('', []);
    const error = vi.spyOn(logger, 'error');

    await expect(llm.complete(request)).resolves.toBe('OK');
    expect(error).toHaveBeenCalledWith('llm', 'Recording the LLM transmission failed', expect.objectContaining({ error: expect.any(Error) }));
  });
});
