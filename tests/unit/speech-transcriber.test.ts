import { describe, expect, it, vi } from 'vitest';
import { createTranscriber, type RecognitionPipeline } from '../../packages/core/src/services/speech/transcriber';

describe('speech transcriber', () => {
  it('loads the model once and asks for German text', async () => {
    const recognise = vi.fn<RecognitionPipeline>(async () => ({ text: ' Hallo' }));
    const load = vi.fn(async (_model: string) => recognise);
    const transcribe = createTranscriber(load);

    expect(await transcribe(new Float32Array(3), 'klein')).toBe(' Hallo');
    await transcribe(new Float32Array(3), 'klein');

    expect(load).toHaveBeenCalledTimes(1);
    expect(recognise.mock.calls[0]![1]).toMatchObject({ language: 'german', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
  });

  it('keeps one model loaded and loads another when the choice changes', async () => {
    const load = vi.fn(async (model: string): Promise<RecognitionPipeline> => async () => ({ text: model }));
    const transcribe = createTranscriber(load);

    expect(await transcribe(new Float32Array(3), 'klein')).toBe('klein');
    expect(await transcribe(new Float32Array(3), 'gross')).toBe('gross');
    expect(await transcribe(new Float32Array(3), 'gross')).toBe('gross');

    expect(load.mock.calls.map(([model]) => model)).toEqual(['klein', 'gross']);
  });

  it('joins the parts of a chunked answer', async () => {
    const transcribe = createTranscriber(async () => async () => [{ text: 'Eins' }, { text: 'zwei' }]);
    expect(await transcribe(new Float32Array(3), 'klein')).toBe('Eins zwei');
  });

  it('tries loading again after a failed load', async () => {
    const load = vi
      .fn<(model: string) => Promise<RecognitionPipeline>>()
      .mockRejectedValueOnce(new Error('Datei fehlt'))
      .mockResolvedValue(async () => ({ text: 'ok' }));
    const transcribe = createTranscriber(load);

    await expect(transcribe(new Float32Array(3), 'klein')).rejects.toThrow('Datei fehlt');
    expect(await transcribe(new Float32Array(3), 'klein')).toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
