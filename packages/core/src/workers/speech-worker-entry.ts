import { parentPort, workerData } from 'node:worker_threads';
import { createTranscriber } from '../services/speech/transcriber';

/** Entry point of the speech worker thread (bundled into speech-worker.cjs by esbuild). */
if (!parentPort) throw new Error('speech-worker-entry must run in a worker thread');
const port = parentPort;
const { modelsDir, modelName } = workerData as { modelsDir: string; modelName: string };

const transcribe = createTranscriber(async () => {
  const { pipeline, env } = await import('@huggingface/transformers');
  // the model comes from the folder Archivist downloaded and checked; this thread never opens a connection
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelsDir;
  env.useFSCache = false;
  return pipeline('automatic-speech-recognition', modelName, { dtype: 'q8', device: 'cpu' });
});

// eslint-disable-next-line @typescript-eslint/no-misused-promises -- the handler catches all errors itself and answers via postMessage
port.on('message', async (message: { samples: Float32Array }) => {
  try {
    port.postMessage({ ok: true, text: await transcribe(message.samples) });
  } catch (err) {
    port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
