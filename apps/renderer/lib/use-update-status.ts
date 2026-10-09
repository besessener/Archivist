'use client';

import { useEffect, useState } from 'react';
import { UpdateStatus } from '@archivist/shared';
import { call } from './ipc';
import { subscribe } from './events';

const UNKNOWN: UpdateStatus = { state: 'error', message: 'Der Stand der Updates konnte nicht abgefragt werden. Versuche es mit „Nach Updates suchen“ erneut.' };

/** The current state of the app update, kept live via `update:changed`; `undefined` until the first answer. */
export function useUpdateStatus(): UpdateStatus | undefined {
  const [status, setStatus] = useState<UpdateStatus | undefined>(undefined);
  useEffect(() => {
    let active = true;
    const settle = (initial: UpdateStatus) => {
      if (active) setStatus((current) => current ?? initial);
    };
    call('update:status').then(settle, () => settle(UNKNOWN));
    const off = subscribe('update:changed', (payload) => {
      const parsed = UpdateStatus.safeParse(payload);
      if (parsed.success) setStatus(parsed.data);
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  return status;
}
