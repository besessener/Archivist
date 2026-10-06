// Stand-in for the bundled Whisper worker: the first sample picks the behaviour.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ samples, model }) => {
  const mode = samples[0];
  if (mode === 1) throw new Error('boom');
  if (mode === 2) return;
  if (mode === 3) process.exit(3);
  if (mode === 4) return parentPort.postMessage({ ok: false, error: 'Modell nicht ladbar' });
  parentPort.postMessage({ ok: true, text: `${model} hörte ${samples.length} Werte` });
});
