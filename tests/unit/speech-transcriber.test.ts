import { describe, expect, it, vi } from 'vitest';
import { createTranscriber, type RecognitionPipeline } from '../../packages/core/src/services/speech/transcriber';

describe('speech transcriber', () => {
  it('loads the model once and asks for German text', async () => {
    const recognise = vi.fn<RecognitionPipeline>(async () => ({ text: ' Hallo' }));
    const load = vi.fn(async () => recognise);
    const transcribe = createTranscriber(load);

    expect(await transcribe(new Float32Array(3))).toBe(' Hallo');
    await transcribe(new Float32Array(3));

    expect(load).toHaveBeenCalledTimes(1);
    expect(recognise.mock.calls[0]![1]).toMatchObject({ language: 'german', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
  });

  it('joins the parts of a chunked answer', async () => {
    const transcribe = createTranscriber(async () => async () => [{ text: 'Eins' }, { text: 'zwei' }]);
    expect(await transcribe(new Float32Array(3))).toBe('Eins zwei');
  });

  it('tries loading again after a failed load', async () => {
    const load = vi
      .fn<() => Promise<RecognitionPipeline>>()
      .mockRejectedValueOnce(new Error('Datei fehlt'))
      .mockResolvedValue(async () => ({ text: 'ok' }));
    const transcribe = createTranscriber(load);

    await expect(transcribe(new Float32Array(3))).rejects.toThrow('Datei fehlt');
    expect(await transcribe(new Float32Array(3))).toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
