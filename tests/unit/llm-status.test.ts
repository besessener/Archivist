import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppContext } from '../../packages/core/src/context';
import { LlmService } from '../../packages/core/src/services/llm';
import type { SecretService } from '../../packages/core/src/services/secret';
import type { SettingsService } from '../../packages/core/src/services/settings';
import { AppError } from '../../packages/core/src/util/errors';
import { Logger } from '../../packages/core/src/util/logger';

/** LLM client whose endpoint answers /responses with the scripted texts and /embeddings with `embeddingsStatus`. */
function client() {
  const script = { answers: [] as string[], embeddingsStatus: 200, down: false, requests: 0 };
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    script.requests += 1;
    if (script.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (String(url instanceof Request ? url.url : url).endsWith('/embeddings')) {
      if (script.embeddingsStatus !== 200) return new Response(JSON.stringify({ error: { message: 'kaputt' } }), { status: script.embeddingsStatus });
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0], index: 0 }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ output_text: script.answers.shift() ?? 'OK' }), { status: 200 });
  };
  const ctx = { events: { emit: () => true }, logger: new Logger(null), database: {} };
  const settings = {
    get: () => ({
      llm: {
        baseUrl: 'https://llm.example.test/v1',
        model: 'test-model',
        embeddingModel: 'embed-model',
        maxInputChars: 10000,
        reasoningEffort: null,
        timeoutMs: 5000,
      },
      privacy: { llmMode: 'auto' },
    }),
  };
  const secrets = { getApiKey: () => 'sk-test' };
  const llm = new LlmService({
    ctx: ctx as unknown as AppContext,
    settings: settings as unknown as SettingsService,
    secrets: secrets as unknown as SecretService,
    fetchImpl,
    retryDelayMs: 0,
  });
  return { llm, script };
}

const plain = { instructions: 'Test', input: 'Hallo', purpose: 'Test' };
const embeddingRequest = { purpose: 'Suchindex' };

describe('LLM status: embeddings (#152)', () => {
  it('a working embeddings call marks the endpoint as connected', async () => {
    const { llm } = client();
    expect(llm.status().state).toBe('unknown');

    await llm.embeddings(['Text'], embeddingRequest);
    expect(llm.status().state).toBe('ok');
  });

  it('a failing embeddings call shows the error, and the next working call clears it', async () => {
    const { llm, script } = client();
    await llm.complete(plain);
    script.embeddingsStatus = 500;

    await expect(llm.embeddings(['Text'], embeddingRequest)).rejects.toThrow();
    expect(llm.status()).toMatchObject({ state: 'error', lastError: expect.any(String) });

    script.embeddingsStatus = 200;
    await llm.embeddings(['Text'], embeddingRequest);
    expect(llm.status()).toMatchObject({ state: 'ok', lastError: null });
  });
});

describe('LLM status: malformed structured output (#152)', () => {
  const schema = z.object({ ok: z.boolean() });
  const structured = { instructions: 'Test', input: 'Hallo', purpose: 'Test', schemaName: 'Check' };

  it('does not leave the status on "ok" when the answer stays invalid after the correction request', async () => {
    const { llm, script } = client();
    script.answers = ['kein json', 'immer noch kein json'];

    await expect(llm.completeJson(schema, structured)).rejects.toMatchObject({ message: expect.stringMatching(/erwarteten Format/) });
    expect(llm.status()).toMatchObject({ state: 'error', lastError: expect.stringMatching(/erwarteten Format/) });
  });

  it('stays "ok" when the correction request delivers a valid answer', async () => {
    const { llm, script } = client();
    script.answers = ['kein json', '{"ok":true}'];

    await expect(llm.completeJson(schema, structured)).resolves.toEqual({ ok: true });
    expect(llm.status().state).toBe('ok');
  });

  it('a later valid structured answer clears the error', async () => {
    const { llm, script } = client();
    script.answers = ['x', 'y', '{"ok":false}'];
    await expect(llm.completeJson(schema, structured)).rejects.toThrow();

    await llm.completeJson(schema, structured);
    expect(llm.status().state).toBe('ok');
  });
});

describe('LLM status: connection test with unsaved values (#152)', () => {
  const unsaved = { baseUrl: 'https://other.example.test/v1' };

  it('does not touch the shared status, neither on failure nor on success', async () => {
    const { llm, script } = client();
    script.down = true;
    const failed = await llm.testConnection(unsaved);
    expect(failed.ok).toBe(false);
    expect(llm.status().state).toBe('unknown');

    script.down = false;
    expect((await llm.testConnection(unsaved)).ok).toBe(true);
    expect(llm.status().state).toBe('unknown');
  });

  it('does not reset the circuit breaker of the saved endpoint', async () => {
    const { llm, script } = client();
    script.down = true;
    await expect(llm.complete(plain)).rejects.toMatchObject({ category: 'network_error' });
    script.down = false;

    expect((await llm.testConnection(unsaved)).ok).toBe(true);
    await expect(llm.complete(plain)).rejects.toMatchObject({ message: expect.stringMatching(/eben nicht erreichbar/) });
  });

  it('a test of the saved values (also when passed explicitly) does update the status and closes the breaker', async () => {
    const { llm, script } = client();
    script.down = true;
    await expect(llm.complete(plain)).rejects.toThrow();
    script.down = false;

    const result = await llm.testConnection({ baseUrl: 'https://llm.example.test/v1', model: 'test-model', apiKey: 'sk-test' });
    expect(result.ok).toBe(true);
    expect(llm.status().state).toBe('ok');
    await expect(llm.complete(plain)).resolves.toBe('OK');
  });

  it('a structured test with unsaved values does not touch the status either', async () => {
    const { llm, script } = client();
    script.answers = ['kein json', 'kein json'];

    expect((await llm.testStructuredAnswer(unsaved)).ok).toBe(false);
    expect(llm.status().state).toBe('unknown');
  });
});

describe('LLM status: agent requests (#152)', () => {
  it('a failed agent request shows the error, a successful one clears it', () => {
    const { llm } = client();
    const config = llm.adapterConfig();

    config.fail(new AppError('llm_error', 'Agent-Aufruf kaputt'));
    expect(llm.status()).toMatchObject({ state: 'error', lastError: 'Agent-Aufruf kaputt' });

    config.log({
      purpose: 'Agent',
      model: 'm',
      endpoint: 'e',
      bytes: 1,
      redactions: 0,
      personalRedactions: 0,
      documentIds: [],
      preview: '',
      success: true,
      requests: 1,
    });
    expect(llm.status().state).toBe('ok');
  });

  it('a cancelled agent request says nothing about the endpoint', () => {
    const { llm } = client();
    const controller = new AbortController();
    controller.abort();

    llm.adapterConfig().fail(new Error('abgebrochen'), controller.signal);
    expect(llm.status().state).toBe('unknown');
  });

  it('the adapter config of unsaved values does not feed the status', () => {
    const { llm } = client();
    const config = llm.adapterConfig({ baseUrl: 'https://other.example.test/v1' });

    config.fail(new Error('Agent-Aufruf kaputt'));
    expect(llm.status().state).toBe('unknown');
  });
});
