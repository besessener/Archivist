import { z } from 'zod';
import { Confirmed, Empty, channel } from './ipc-channel';
import { SpeechAudio, SpeechModelName, SpeechStatus, SpeechTranscript } from './speech';

/** Channels of the speech input in the chat; merged into the IPC contract. */
export const speechChannels = {
  'speech:status': channel(Empty, SpeechStatus),
  /** Starts the one-time download of the chosen model in the background and answers at once; progress comes via `data:changed` (scope `speech`). */
  'speech:install': channel(z.object({ confirmed: Confirmed }), SpeechStatus),
  'speech:cancelInstall': channel(Empty, SpeechStatus),
  /** Deletes a downloaded model from the disk (not while it is downloading); it can be downloaded again. */
  'speech:remove': channel(z.object({ model: SpeechModelName, confirmed: Confirmed }), SpeechStatus),
  /** Turns a recording into text on this machine; nothing is stored or sent anywhere. */
  'speech:transcribe': channel(z.object({ audio: SpeechAudio }), SpeechTranscript),
} as const;
