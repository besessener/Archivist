import { SPEECH_SAMPLE_RATE } from '@archivist/shared';
import { toSpeechAudio } from './dictation';

export interface Recorder {
  /** Ends the recording and resolves with 16-bit PCM, 16 kHz, mono, cut at the longest dictation. */
  stop(): Promise<Int16Array<ArrayBuffer>>;
  /** Ends the recording and drops it. */
  cancel(): void;
}

async function decode(blob: Blob): Promise<Int16Array<ArrayBuffer>> {
  // the context's rate is the one decodeAudioData resamples to
  const context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    return toSpeechAudio(Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel)));
  } finally {
    void context.close();
  }
}

/** Asks for the microphone and starts recording; the stream is released as soon as the recording ends. */
export async function startRecorder(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => chunks.push(event.data));
  const ended = new Promise<Blob>((resolve) => recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: recorder.mimeType })), { once: true }));
  const release = () => stream.getTracks().forEach((track) => track.stop());
  recorder.start();
  return {
    async stop() {
      recorder.stop();
      release();
      return decode(await ended);
    },
    cancel() {
      recorder.stop();
      release();
    },
  };
}
