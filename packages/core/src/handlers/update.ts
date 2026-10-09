import type { UpdateStatus } from '@archivist/shared';
import { AppError } from '../util/errors';
import type { HandlerGroup, HostApi } from './types';

const UNSUPPORTED: UpdateStatus = { state: 'unsupported', reason: 'In dieser Umgebung sind keine Updates verfügbar.' };

export function updateHandlers({ updates }: HostApi): HandlerGroup<'update'> {
  return {
    'update:status': () => updates?.status() ?? UNSUPPORTED,
    'update:check': () => updates?.check() ?? UNSUPPORTED,
    'update:download': () => updates?.download() ?? UNSUPPORTED,
    'update:install': () => {
      if (updates?.status().state !== 'downloaded') throw new AppError('validation_error', 'Es ist kein Update heruntergeladen.');
      updates.install();
      return { ok: true };
    },
  };
}
