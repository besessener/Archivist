import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Settings } from '@archivist/shared';
import type { AppContext } from '../../packages/core/src/context';
import { LlmService } from '../../packages/core/src/services/llm';
import type { SecretService } from '../../packages/core/src/services/secret';
import { SettingsService } from '../../packages/core/src/services/settings';
import { Logger } from '../../packages/core/src/util/logger';

const API_KEY = 'sk-test-KEY-0123456789';
const request = { instructions: 'Test', input: 'Hallo', purpose: 'Test' };

const settingsWith = (llm: { baseUrl: string; embeddingModel?: string }) =>
  Settings.parse({ llm: { model: 'test-model', ...llm }, privacy: { llmMode: 'auto' } });

/** LLM client over a fake endpoint that records every request it receives. */
function clientFor(settings: Pick<SettingsService, 'get'>) {
  const sent: Array<{ headers: Record<string, string> }> = [];
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    sent.push({ headers });
    return new Response(JSON.stringify({ output_text: 'OK', data: [{ embedding: [1, 2], index: 0 }] }), { status: 200 });
  };
  const ctx = { events: { emit: () => true }, logger: new Logger(null), database: {} };
  const llm = new LlmService({
    ctx: ctx as unknown as AppContext,
    settings: settings as SettingsService,
    secrets: { getApiKey: () => API_KEY } as unknown as SecretService,
    fetchImpl,
    retryDelayMs: 0,
  });
  return { llm, sent };
}

const clientWith = (llm: { baseUrl: string; embeddingModel?: string }) => clientFor({ get: () => settingsWith(llm) });

describe('LLM client: one auth header per endpoint type (#209)', () => {
  it.each([
    ['https://api.openai.com/v1', { authorization: `Bearer ${API_KEY}` }, 'api-key'],
    ['http://127.0.0.1:11434/v1', { authorization: `Bearer ${API_KEY}` }, 'api-key'],
    ['https://llm.example.test/v1', { authorization: `Bearer ${API_KEY}` }, 'api-key'],
    ['https://resource.openai.azure.com/openai/v1', { 'api-key': API_KEY }, 'authorization'],
    ['https://resource.services.ai.azure.com/openai/v1', { 'api-key': API_KEY }, 'authorization'],
  ])('%s receives the key as %j only', async (baseUrl, expected, absent) => {
    const { llm, sent } = clientWith({ baseUrl });
    await expect(llm.complete(request)).resolves.toBe('OK');
    expect(sent[0]!.headers).toMatchObject(expected);
    expect(sent[0]!.headers).not.toHaveProperty(absent);
  });

  it('sends embeddings with the same single header', async () => {
    const { llm, sent } = clientWith({ baseUrl: 'https://resource.openai.azure.com/openai/v1', embeddingModel: 'embedding-model' });
    await llm.embeddings(['Text'], { purpose: 'Test' });
    expect(sent[0]!.headers).toMatchObject({ 'api-key': API_KEY });
    expect(sent[0]!.headers).not.toHaveProperty('authorization');
  });
});

describe('LLM client: clear text to a remote host is never sent (#209)', () => {
  const insecure = 'http://llm.example.test/v1';

  it('complete fails with a validation error before anything is sent', async () => {
    const { llm, sent } = clientWith({ baseUrl: insecure });
    await expect(llm.complete(request)).rejects.toMatchObject({ category: 'validation_error', message: expect.stringContaining('Verwende https://') });
    expect(sent).toHaveLength(0);
  });

  it('a connection test returns the reason as a failed result instead of throwing', async () => {
    const { llm, sent } = clientWith({ baseUrl: 'https://llm.example.test/v1' });
    const result = await llm.testConnection({ baseUrl: insecure });
    expect(result).toMatchObject({ ok: false, error: { category: 'validation_error' }, message: expect.stringContaining('Verwende https://') });
    expect(sent).toHaveLength(0);
  });

  it('embeddings and the agent adapter configuration refuse it as well', async () => {
    const { llm, sent } = clientWith({ baseUrl: insecure, embeddingModel: 'embedding-model' });
    await expect(llm.embeddings(['Text'], { purpose: 'Test' })).rejects.toMatchObject({ category: 'validation_error' });
    expect(() => llm.adapterConfig()).toThrow(/Verwende https:\/\//);
    expect(sent).toHaveLength(0);
  });
});

describe('base URL in the settings file (#209)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-baseurl-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const openSettings = () => new SettingsService({ file: path.join(dir, 'settings.json'), defaultArchiveRoot: path.join(dir, 'archive') });
  const storedWith = (baseUrl: string) => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settingsWith({ baseUrl })));
    return openSettings();
  };

  it('a stored clear-text URL loads without a problem and the LLM client refuses to send to it', async () => {
    const settings = storedWith('http://llm.example.test/v1');
    expect(settings.takeLoadProblem()).toBeNull();
    expect(settings.get().llm.baseUrl).toBe('http://llm.example.test/v1');

    const { llm, sent } = clientFor(settings);
    await expect(llm.complete(request)).rejects.toMatchObject({ category: 'validation_error' });
    expect(sent).toHaveLength(0);
  });

  it('with a stored clear-text URL other settings can still be saved and the URL can be fixed', () => {
    const settings = storedWith('http://llm.example.test/v1');
    expect(settings.update({ llm: { timeoutMs: 30000 } }).llm).toMatchObject({ baseUrl: 'http://llm.example.test/v1', timeoutMs: 30000 });
    expect(settings.update({ llm: { baseUrl: 'https://llm.example.test/v1/' } }).llm.baseUrl).toBe('https://llm.example.test/v1');
  });

  it.each(['http://example.com/v1', 'http://localhost.evil.com', 'ftp://example.com', 'example.com'])(
    'refuses to save %s and keeps the stored value',
    (baseUrl) => {
      const settings = openSettings();
      settings.update({ llm: { baseUrl: 'https://llm.example.test/v1' } });
      expect(() => settings.update({ llm: { baseUrl } })).toThrow(/https:\/\//);
      expect(settings.get().llm.baseUrl).toBe('https://llm.example.test/v1');
      expect(openSettings().get().llm.baseUrl).toBe('https://llm.example.test/v1');
    },
  );

  it.each(['http://localhost:11434/v1/', 'http://127.0.0.1:1234', 'http://[::1]:8080/v1', '', 'https://api.openai.com/v1'])('saves %j', (baseUrl) => {
    expect(openSettings().update({ llm: { baseUrl } }).llm.baseUrl).toBe(baseUrl.replace(/\/$/, ''));
  });
});
