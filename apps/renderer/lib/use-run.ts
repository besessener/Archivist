'use client';

import { useCallback, useState } from 'react';
import { useToast } from './toast';

export interface RunOptions {
  success?: string;
  errorTitle?: string;
}

/**
 * Runs an action, shows errors as a toast (with „Erneut versuchen“ (retry) if possible)
 * and returns `undefined` on errors.
 */
export function useRun() {
  const { toast, reportError } = useToast();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async function runAction<T>(fn: () => Promise<T>, opts: RunOptions = {}): Promise<T | undefined> {
      setBusy(true);
      try {
        const out = await fn();
        if (opts.success) toast({ variant: 'success', title: opts.success });
        return out;
      } catch (err) {
        reportError(err, () => void runAction(fn, opts), opts.errorTitle);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast, reportError],
  );

  return { run, busy };
}
