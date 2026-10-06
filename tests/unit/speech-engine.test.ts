import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerSpeechEngine } from '../../packages/core/src/services/speech/engine';

const WORKER = path.resolve(__dirname, '../helpers/fake-speech-worker.mjs');
const live: WorkerSpeechEngine[] = [];

function engine(overrides: Partial<ConstructorParameters<typeof WorkerSpeechEngine>[0]> = {}): WorkerSpeechEngine {
  const created = new WorkerSpeechEngine({ workerFile: WORKER, modelsDir: '/models', idleMs: 60_000, timeoutMs: 5_000, ...overrides });
  live.push(created);
  return created;
}
const never = new AbortController().signal;
const mode = (value: number) => Float32Array.of(value, 0, 0);

afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.close()));
});

describe('worker speech engine', () => {
  it('answers from the worker thread, which keeps running between recordings', async () => {
    const speech = engine();
    expect(await speech.transcribe(mode(0), 'testmodell', never)).toBe('testmodell hörte 3 Werte');
    expect(await speech.transcribe(Float32Array.of(0, 0, 0, 0), 'testmodell', never)).toBe('testmodell hörte 4 Werte');
  });

  it('turns an error reply into a categorised error', async () => {
    await expect(engine().transcribe(mode(4), 'testmodell', never)).rejects.toMatchObject({
      category: 'native_module_error',
      message: 'Die Spracherkennung ist fehlgeschlagen.',
      options: { details: 'Modell nicht ladbar' },
    });
  });

  it('reports a crash and starts a fresh worker for the next recording', async () => {
    const speech = engine();
    await expect(speech.transcribe(mode(1), 'testmodell', never)).rejects.toMatchObject({
      category: 'native_module_error',
      message: 'Die Spracherkennung ist abgestürzt.',
    });
    expect(await speech.transcribe(mode(0), 'testmodell', never)).toBe('testmodell hörte 3 Werte');
  });

  it('reports a worker that ends on its own', async () => {
    await expect(engine().transcribe(mode(3), 'testmodell', never)).rejects.toMatchObject({ message: 'Die Spracherkennung wurde unerwartet beendet.' });
  });

  it('ends a transcription that takes too long', async () => {
    await expect(engine({ timeoutMs: 100 }).transcribe(mode(2), 'testmodell', never)).rejects.toMatchObject({ category: 'internal_error', retryable: true });
  });

  it('stops when the caller aborts and does not start when it already has', async () => {
    const speech = engine();
    const abort = new AbortController();
    const running = speech.transcribe(mode(2), 'testmodell', abort.signal);
    abort.abort(new Error('abgebrochen'));
    await expect(running).rejects.toThrow('abgebrochen');
    await expect(speech.transcribe(mode(0), 'testmodell', abort.signal)).rejects.toThrow('abgebrochen');
  });

  it('ends the idle worker to free the model and starts it again on demand', async () => {
    const speech = engine({ idleMs: 30 });
    await speech.transcribe(mode(0), 'testmodell', never);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await speech.transcribe(mode(0), 'testmodell', never)).toBe('testmodell hörte 3 Werte');
  });

  it('refuses to start without a worker bundle', async () => {
    await expect(engine({ workerFile: null }).transcribe(mode(0), 'testmodell', never)).rejects.toMatchObject({ category: 'native_module_error' });
  });
});
