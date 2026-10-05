import { z } from 'zod';

/** Whisper reads 16 kHz mono audio. */
export const SPEECH_SAMPLE_RATE = 16_000;
/** Longest dictation: the renderer stops the recording there, the service rejects anything longer. */
export const SPEECH_MAX_SECONDS = 120;
export const SPEECH_MAX_SAMPLES = SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS;

export const SpeechStatus = z.object({
  /** `unavailable`: this version names no model to download. */
  state: z.enum(['unavailable', 'not_installed', 'downloading', 'ready']),
  modelLabel: z.string(),
  totalBytes: z.number().int().min(0),
  receivedBytes: z.number().int().min(0),
  /** Why the last download failed, until the next one starts. */
  error: z.string().nullable(),
});
export type SpeechStatus = z.infer<typeof SpeechStatus>;

/** 16-bit PCM, 16 kHz, mono. */
export const SpeechAudio = z.instanceof(Int16Array).refine((samples) => samples.length <= SPEECH_MAX_SAMPLES, { message: 'Die Aufnahme ist zu lang.' });

export const SpeechTranscript = z.object({
  /** Empty when nothing was understood. */
  text: z.string(),
});
export type SpeechTranscript = z.infer<typeof SpeechTranscript>;
