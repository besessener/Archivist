/** What the Whisper pipeline of transformers.js offers; the worker passes the real one, tests a fake. */
export type RecognitionPipeline = (samples: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;

/** Whisper takes 30 seconds at a time; longer recordings are cut into overlapping windows. */
const WINDOW_SECONDS = 30;
const OVERLAP_SECONDS = 5;

/** Loads the model once, on the first recording. */
export function createTranscriber(loadPipeline: () => Promise<RecognitionPipeline>): (samples: Float32Array) => Promise<string> {
  let loading: Promise<RecognitionPipeline> | null = null;
  return async (samples) => {
    loading ??= loadPipeline().catch((err: unknown) => {
      loading = null;
      throw err;
    });
    const recognise = await loading;
    const result = await recognise(samples, { language: 'german', task: 'transcribe', chunk_length_s: WINDOW_SECONDS, stride_length_s: OVERLAP_SECONDS });
    return Array.isArray(result) ? result.map((part) => part.text).join(' ') : result.text;
  };
}
