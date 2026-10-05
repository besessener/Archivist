/** Peak below which a recording counts as silence: Whisper invents text for silence, so it is never transcribed. */
const SILENCE_PEAK = 0.01;
/** Shorter recordings are an accidental click, not speech (0.3 s at 16 kHz). */
const MIN_SAMPLES = 4_800;

export function int16ToFloat32(samples: Int16Array): Float32Array {
  const floats = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i]! / 32_768;
  return floats;
}

export function isSilent(samples: Float32Array): boolean {
  if (samples.length < MIN_SAMPLES) return true;
  for (const sample of samples) if (Math.abs(sample) >= SILENCE_PEAK) return false;
  return true;
}

/** Whisper pads its output with spaces and line breaks. */
export const tidyTranscript = (text: string): string => text.replace(/\s+/g, ' ').trim();
