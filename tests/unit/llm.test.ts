import { describe, expect, it } from 'vitest';
import type { AppContext } from '../../packages/core/src/context';
import { LlmService } from '../../packages/core/src/services/llm';
import type { SecretService } from '../../packages/core/src/services/secret';
import type { SettingsService } from '../../packages/core/src/services/settings';

/** LLM client with fixed settings and an endpoint that rejects optional parameters with HTTP 400. */
const client = (rejection: string) => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    bodies.push(body);
    if ('store' in body) return new Response(JSON.stringify({ error: { message: rejection } }), { status: 400 });
    return new Response(JSON.stringify({ output_text: 'OK' }), { status: 200 });
  };
  const ctx = { events: { emit: () => true }, logger: { info: () => {}, warn: () => {} }, database: {} };
  const settings = {
    get: () => ({
      llm: { baseUrl: 'https://llm.example.test/v1', model: 'test-model', maxInputChars: 10000, reasoningEffort: 'low', timeoutMs: 5000 },
      privacy: { llmMode: 'auto' },
    }),
  };
  const secrets = { getApiKey: () => 'sk-test' };
  const llm = new LlmService(ctx as unknown as AppContext, settings as unknown as SettingsService, secrets as unknown as SecretService, fetchImpl, 0);
  return { llm, bodies };
};

const request = { instructions: 'Test', input: 'Hallo', purpose: 'Test', json: true };

describe('LLM client: fallback request without optional parameters', () => {
  it.each([
    "Unsupported parameter: 'store' is not supported with this model.",
    'Unrecognized request argument supplied: reasoning',
    "Unknown parameter: 'text.format'.",
    "'text.format' is not supported",
    "This model does not support the 'reasoning' parameter.",
  ])('retries without them when a parameter is clearly unsupported: %s', async (message) => {
    const { llm, bodies } = client(message);

    await expect(llm.complete(request)).resolves.toBe('OK');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ store: false, reasoning: { effort: 'low' }, text: { format: { type: 'json_object' } } });
    expect(bodies[1]).not.toHaveProperty('store');
    expect(bodies[1]).not.toHaveProperty('reasoning');
    expect(bodies[1]).not.toHaveProperty('text');
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
