/** What the Whisper pipeline of transformers.js offers; the worker passes the real one, tests a fake. */
export type RecognitionPipeline = (samples: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;

/** Whisper takes 30 seconds at a time; longer recordings are cut into overlapping windows. */
const WINDOW_SECONDS = 30;
const OVERLAP_SECONDS = 5;

/** Loads a model on its first recording and keeps only the one in use: choosing another model replaces it. */
export function createTranscriber(loadPipeline: (model: string) => Promise<RecognitionPipeline>): (samples: Float32Array, model: string) => Promise<string> {
  let loaded: { model: string; pipeline: Promise<RecognitionPipeline> } | null = null;
  return async (samples, model) => {
    const pipeline = loaded?.model === model ? loaded.pipeline : loadPipeline(model);
    if (loaded?.pipeline !== pipeline) {
      loaded = { model, pipeline };
      // a failed load is tried again on the next recording
      pipeline.catch(() => {
        if (loaded?.pipeline === pipeline) loaded = null;
      });
    }
    const recognise = await pipeline;
    const result = await recognise(samples, { language: 'german', task: 'transcribe', chunk_length_s: WINDOW_SECONDS, stride_length_s: OVERLAP_SECONDS });
    return Array.isArray(result) ? result.map((part) => part.text).join(' ') : result.text;
  };
}
