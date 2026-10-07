'use client';

import { useEffect, useState } from 'react';
import { UpdateStatus } from '@archivist/shared';
import { call } from './ipc';
import { subscribe } from './events';

/** The current state of the app update, kept live via `update:changed`; `undefined` until the first answer. */
export function useUpdateStatus(): UpdateStatus | undefined {
  const [status, setStatus] = useState<UpdateStatus | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void call('update:status').then(
      (initial) => active && setStatus((current) => current ?? initial),
      () => undefined,
    );
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
