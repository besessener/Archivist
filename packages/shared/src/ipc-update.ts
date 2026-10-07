import { z } from 'zod';
import { Confirmed, Empty, Ok, channel } from './ipc-channel';
import { UpdateStatus } from './update';

/** Channels of the app update (GitHub Releases); merged into the IPC contract. */
export const updateChannels = {
  'update:status': channel(Empty, UpdateStatus),
  /** Asks GitHub whether a newer release exists; nothing is downloaded. */
  'update:check': channel(Empty, UpdateStatus),
  'update:download': channel(z.object({ confirmed: Confirmed }), UpdateStatus),
  /** Closes Archivist, runs the installer and starts the new version. */
  'update:install': channel(z.object({ confirmed: Confirmed }), Ok),
} as const;
