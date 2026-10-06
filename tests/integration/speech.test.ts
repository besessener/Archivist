import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPEECH_MAX_SAMPLES } from '@archivist/shared';
import type { SpeechEngine } from '../../packages/core/src/services/speech/engine';
import { createTestApp, type TestApp } from '../helpers/harness';
import { startSpeechModelServer, type SpeechModelServer } from '../helpers/speech-model-server';

const FILES = { 'config.json': '{"model":"whisper"}', 'onnx/encoder_model_quantized.onnx': 'encoder-bytes'.repeat(40) };

class FakeEngine implements SpeechEngine {
  heard: Float32Array[] = [];
  models: string[] = [];
  reply = '  Das ist   ein Test.\n';
  hold: Promise<void> | null = null;
  async transcribe(samples: Float32Array, model: string) {
    this.heard.push(samples);
    this.models.push(model);
    await this.hold;
    return this.reply;
  }
  async close() {}
}

/** 1 s of a tone: loud enough not to count as silence. */
const speech = (seconds = 1) => Int16Array.from({ length: 16_000 * seconds }, (_, i) => Math.round(Math.sin(i / 8) * 8_000));

let server: SpeechModelServer;
let engine: FakeEngine;
let app: TestApp;
const modelDir = (directory = 'test-small') => path.join(app.services.paths.index, 'models', directory);
const waitForState = async (state: string) => {
  for (let i = 0; i < 200 && (await app.ok('speech:status')).state !== state; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  return app.ok('speech:status');
};

beforeEach(async () => {
  server = await startSpeechModelServer(FILES);
  engine = new FakeEngine();
  app = await createTestApp({ speech: { models: server.models, engine } });
});
afterEach(async () => {
  await app.cleanup();
  await server.close();
});

describe('speech input: model download', () => {
  it('starts out not installed and reports the size of the download', async () => {
    const status = await app.ok('speech:status');
    expect(status).toMatchObject({ state: 'not_installed', selected: 'small', modelLabel: 'Testmodell small', receivedBytes: 0, error: null });
    expect(status.totalBytes).toBe(server.spec.files.reduce((sum, file) => sum + file.bytes, 0));
  });

  it('downloads the checked files and becomes ready, announcing every step to the window', async () => {
    const scopes: string[][] = [];
    app.services.events.on('data:changed', (change: { scopes: string[] }) => scopes.push(change.scopes));

    expect((await app.ok('speech:install', { confirmed: true })).state).toBe('downloading');
    const status = await waitForState('ready');

    expect(status).toMatchObject({ state: 'ready', error: null });
    expect(fs.readFileSync(path.join(modelDir(), 'onnx', 'encoder_model_quantized.onnx'), 'utf8')).toBe(FILES['onnx/encoder_model_quantized.onnx']);
    expect(fs.existsSync(`${modelDir()}.partial`)).toBe(false);
    expect(scopes.filter((changed) => changed.includes('speech')).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses an install without the explicit confirmation', async () => {
    const result = await app.call('speech:install', {} as never);
    expect(result.ok).toBe(false);
    expect(server.requests).toEqual([]);
  });

  it('does not start a second download while one is running', async () => {
    server.hold();
    await app.ok('speech:install', { confirmed: true });
    expect((await app.ok('speech:install', { confirmed: true })).state).toBe('downloading');
    server.release();
    await waitForState('ready');
    expect(server.requests).toHaveLength(Object.keys(FILES).length);
  });

  it('discards a file that does not match its checksum and says so', async () => {
    server.corrupt('config.json');

    await app.ok('speech:install', { confirmed: true });
    const status = await waitForState('not_installed');

    expect(status.error).toContain('config.json');
    expect(fs.existsSync(modelDir())).toBe(false);
    expect(fs.existsSync(`${modelDir()}.partial`)).toBe(false);
  });

  it('reports an unreachable host as a network problem', async () => {
    await server.close();
    await app.ok('speech:install', { confirmed: true });
    const failed = await waitForState('not_installed');
    expect(failed.error).toContain('Internetverbindung');
    expect(fs.existsSync(`${modelDir()}.partial`)).toBe(false);
  });

  it('cancels a running download without reporting an error', async () => {
    server.hold();
    await app.ok('speech:install', { confirmed: true });

    expect((await app.ok('speech:cancelInstall')).state).toBe('downloading');
    server.release();
    const status = await waitForState('not_installed');

    expect(status.error).toBeNull();
    expect(fs.existsSync(modelDir())).toBe(false);
  });

  it('downloads nothing in the privacy mode „nur lokal“', async () => {
    await app.cleanup();
    app = await createTestApp({ privacy: 'local_only', speech: { models: server.models, engine } });

    const result = await app.call('speech:install', { confirmed: true });

    expect(result).toMatchObject({ ok: false, error: { category: 'permission_error' } });
    expect(server.requests).toEqual([]);
  });

  it('is unavailable when the version names no files for the model', async () => {
    await app.cleanup();
    app = await createTestApp({ speech: { models: { ...server.models, small: { ...server.models.small, files: [] } }, engine } });

    const status = await app.ok('speech:status');
    expect(status.state).toBe('unavailable');
    expect(status.models.map((model) => model.state)).toEqual(['unavailable', 'not_installed', 'not_installed']);
    expect(await app.call('speech:install', { confirmed: true })).toMatchObject({ ok: false, error: { category: 'validation_error' } });
  });

  it('treats a model with a missing or wrong-sized file as not installed', async () => {
    await app.ok('speech:install', { confirmed: true });
    await waitForState('ready');

    fs.appendFileSync(path.join(modelDir(), 'config.json'), 'x');

    expect((await app.ok('speech:status')).state).toBe('not_installed');
  });
});

describe('speech input: transcription', () => {
  beforeEach(async () => {
    await app.ok('speech:install', { confirmed: true });
    await waitForState('ready');
  });

  it('turns a recording into tidy text on this machine', async () => {
    const result = await app.ok('speech:transcribe', { audio: speech() });

    expect(result).toEqual({ text: 'Das ist ein Test.' });
    expect(engine.heard).toHaveLength(1);
    expect(engine.heard[0]!.length).toBe(16_000);
    expect(Math.max(...engine.heard[0]!)).toBeLessThanOrEqual(1);
  });

  it('answers silence and accidental clicks with an empty text, without asking the model', async () => {
    expect(await app.ok('speech:transcribe', { audio: new Int16Array(32_000) })).toEqual({ text: '' });
    expect(await app.ok('speech:transcribe', { audio: speech().slice(0, 1_000) })).toEqual({ text: '' });
    expect(engine.heard).toEqual([]);
  });

  it('rejects a second recording while one is being transcribed', async () => {
    let release: () => void = () => undefined;
    engine.hold = new Promise((resolve) => (release = resolve));
    const first = app.ok('speech:transcribe', { audio: speech() });

    const second = await app.call('speech:transcribe', { audio: speech() });
    release();

    expect(second).toMatchObject({ ok: false, error: { category: 'validation_error' } });
    expect((await first).text).toBe('Das ist ein Test.');
    expect((await app.ok('speech:transcribe', { audio: speech() })).text).toBe('Das ist ein Test.');
  });

  it('rejects a recording longer than the limit at the IPC boundary', async () => {
    const result = await app.call('speech:transcribe', { audio: new Int16Array(SPEECH_MAX_SAMPLES + 1) });
    expect(result).toMatchObject({ ok: false, error: { category: 'validation_error' } });
    expect(engine.heard).toEqual([]);
  });

  it('rejects anything that is not 16-bit audio', async () => {
    expect((await app.call('speech:transcribe', { audio: [1, 2, 3] } as never)).ok).toBe(false);
  });

  it('refuses to transcribe before the model is installed', async () => {
    await app.cleanup();
    app = await createTestApp({ speech: { models: server.models, engine } });

    expect(await app.call('speech:transcribe', { audio: speech() })).toMatchObject({ ok: false, error: { category: 'validation_error' } });
  });

  it('frees the engine and ends a running download when the app shuts down', async () => {
    let closed = false;
    engine.close = async () => void (closed = true);
    await app.services.speech.close();
    expect(closed).toBe(true);
  });
});

describe('speech input: choosing the model', () => {
  const choose = (model: 'small' | 'medium' | 'turbo') => app.ok('settings:update', { speech: { model } });

  it('starts with the small model and lists every model', async () => {
    const status = await app.ok('speech:status');
    expect(status.selected).toBe('small');
    expect(status.models.map((model) => [model.name, model.label, model.state])).toEqual([
      ['small', 'Testmodell small', 'not_installed'],
      ['medium', 'Testmodell medium', 'not_installed'],
      ['turbo', 'Testmodell turbo', 'not_installed'],
    ]);
  });

  it('downloads the chosen model into its own folder and leaves the others alone', async () => {
    await choose('medium');
    expect(await app.ok('speech:status')).toMatchObject({ selected: 'medium', modelLabel: 'Testmodell medium' });

    await app.ok('speech:install', { confirmed: true });
    const status = await waitForState('ready');

    expect(fs.existsSync(path.join(modelDir('test-medium'), 'config.json'))).toBe(true);
    expect(fs.existsSync(modelDir('test-small'))).toBe(false);
    expect(status.models.map((model) => model.state)).toEqual(['not_installed', 'ready', 'not_installed']);
  });

  it('transcribes with the chosen model, and each model keeps working after a switch', async () => {
    await app.ok('speech:install', { confirmed: true });
    await waitForState('ready');
    await choose('medium');
    await app.ok('speech:install', { confirmed: true });
    await waitForState('ready');

    await app.ok('speech:transcribe', { audio: speech() });
    await choose('small');
    await app.ok('speech:transcribe', { audio: speech() });

    expect(engine.models).toEqual(['test-medium', 'test-small']);
  });

  it('needs the chosen model, not just any model, to transcribe', async () => {
    await app.ok('speech:install', { confirmed: true });
    await waitForState('ready');
    await choose('turbo');

    expect(await app.call('speech:transcribe', { audio: speech() })).toMatchObject({ ok: false, error: { category: 'validation_error' } });
  });

  it('refuses a second download while another model downloads, and shows the one that runs', async () => {
    server.hold();
    await app.ok('speech:install', { confirmed: true });
    await choose('medium');

    const result = await app.call('speech:install', { confirmed: true });
    const status = await app.ok('speech:status');
    server.release();
    await waitForState('not_installed');

    expect(result).toMatchObject({ ok: false, error: { category: 'validation_error' } });
    expect(status.state).toBe('not_installed');
    expect(status.models.map((model) => model.state)).toEqual(['downloading', 'not_installed', 'not_installed']);
  });

  it('shows a failed download only for the model that failed', async () => {
    server.corrupt('config.json');
    await app.ok('speech:install', { confirmed: true });
    await waitForState('not_installed');
    expect((await app.ok('speech:status')).error).toContain('config.json');

    await choose('medium');

    expect((await app.ok('speech:status')).error).toBeNull();
  });

  it('rejects a model name that is not on the list', async () => {
    expect((await app.call('settings:update', { speech: { model: 'gigantisch' } } as never)).ok).toBe(false);
  });
});

describe('speech input: removing a model', () => {
  beforeEach(async () => {
    await app.ok('speech:install', { confirmed: true });
    await waitForState('ready');
  });

  it('deletes the downloaded model from the disk and allows downloading it again', async () => {
    const status = await app.ok('speech:remove', { model: 'small', confirmed: true });

    expect(status.state).toBe('not_installed');
    expect(fs.existsSync(modelDir())).toBe(false);
    await app.ok('speech:install', { confirmed: true });
    expect((await waitForState('ready')).state).toBe('ready');
  });

  it('needs the explicit confirmation', async () => {
    expect((await app.call('speech:remove', { model: 'small' } as never)).ok).toBe(false);
    expect(fs.existsSync(modelDir())).toBe(true);
  });

  it('does not touch a model that is being downloaded', async () => {
    server.hold();
    await app.ok('speech:remove', { model: 'small', confirmed: true });
    await app.ok('speech:install', { confirmed: true });

    expect(await app.call('speech:remove', { model: 'small', confirmed: true })).toMatchObject({ ok: false, error: { category: 'validation_error' } });
    server.release();
    await waitForState('ready');
  });

  it('announces the removal to the window', async () => {
    const scopes: string[][] = [];
    app.services.events.on('data:changed', (change: { scopes: string[] }) => scopes.push(change.scopes));

    await app.ok('speech:remove', { model: 'small', confirmed: true });

    expect(scopes).toContainEqual(['speech']);
  });

  it('removing a model that was never downloaded changes nothing', async () => {
    expect((await app.ok('speech:remove', { model: 'turbo', confirmed: true })).models.map((model) => model.state)).toEqual([
      'ready',
      'not_installed',
      'not_installed',
    ]);
  });
});
