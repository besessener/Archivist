import { describe, expect, it } from 'vitest';
import { int16ToFloat32, isSilent, tidyTranscript } from '../../packages/core/src/services/speech/audio';

describe('speech audio helpers', () => {
  it('scales 16-bit samples into [-1, 1)', () => {
    expect([...int16ToFloat32(Int16Array.of(0, 16_384, -32_768, 32_767))]).toEqual([0, 0.5, -1, 32_767 / 32_768]);
  });

  it('counts quiet or very short recordings as silence', () => {
    expect(isSilent(new Float32Array(16_000))).toBe(true);
    expect(isSilent(new Float32Array(16_000).fill(0.009))).toBe(true);
    expect(isSilent(new Float32Array(1_000).fill(0.5))).toBe(true);
  });

  it('does not count a recording with one clear sound as silence', () => {
    const samples = new Float32Array(16_000);
    samples[8_000] = -0.02;
    expect(isSilent(samples)).toBe(false);
  });

  it('tidies the spacing Whisper leaves around its text', () => {
    expect(tidyTranscript('  Hallo \n  Welt.  ')).toBe('Hallo Welt.');
    expect(tidyTranscript('   ')).toBe('');
  });
});
