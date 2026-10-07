import type { UpdateStatus } from '@archivist/shared';
import type { HandlerGroup, HostApi } from './types';

const UNSUPPORTED: UpdateStatus = { state: 'unsupported', reason: 'In dieser Umgebung sind keine Updates verfügbar.' };

export function updateHandlers({ updates }: HostApi): HandlerGroup<'update'> {
  return {
    'update:status': () => updates?.status() ?? UNSUPPORTED,
    'update:check': () => updates?.check() ?? UNSUPPORTED,
    'update:download': () => updates?.download() ?? UNSUPPORTED,
    'update:install': () => {
      updates?.install();
      return { ok: true };
    },
  };
}
