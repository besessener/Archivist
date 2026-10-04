'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcChannel, IpcInput, IpcOutput } from '@archivist/shared';
import { call, IpcError } from './ipc';
import { scopesOf, subscribe } from './events';

export interface UseQueryOptions<C extends IpcChannel = IpcChannel> {
  /** Scopes from `data:changed` that trigger a reload. */
  scopes?: string[];
  /** Reload on `job:updated`. */
  jobs?: boolean;
  enabled?: boolean;
  /** Replaces the single call of `channel` (e.g. a list read page by page); `loadKey` names what makes it a different read. */
  load?: (input: IpcInput<C>) => Promise<IpcOutput<C>>;
  loadKey?: string;
}

export interface QueryState<T> {
  data: T | undefined;
  loading: boolean;
  error: IpcError | null;
  refetch: () => Promise<void>;
}

export function useQuery<C extends IpcChannel>(channel: C, input: IpcInput<C> | undefined, opts: UseQueryOptions<C> = {}): QueryState<IpcOutput<C>> {
  const { scopes, jobs = false, enabled = true, load, loadKey = '' } = opts;
  const [data, setData] = useState<IpcOutput<C> | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<IpcError | null>(null);
  const inputKey = JSON.stringify(input ?? null) + loadKey;
  const loadRef = useRef(load);
  loadRef.current = load;
  const scopesKey = (scopes ?? []).join('|');
  const requestId = useRef(0);
  const inputRef = useRef(input);
  inputRef.current = input;

  const refetch = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    const id = ++requestId.current;
    setLoading(true);
    try {
      const out = loadRef.current ? await loadRef.current(inputRef.current as IpcInput<C>) : await call(channel, inputRef.current);
      if (id !== requestId.current) return;
      setData(out);
      setError(null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof IpcError ? err : new IpcError({ category: 'internal_error', message: String(err), retryable: true }));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [channel, inputKey, enabled]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!enabled) return undefined;
    const wanted = scopesKey ? scopesKey.split('|') : [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetch(), 150);
    };
    const offs: Array<() => void> = [];
    if (wanted.length > 0) {
      offs.push(
        subscribe('data:changed', (payload) => {
          const got = scopesOf(payload);
          if (got.length === 0 || got.some((s) => wanted.includes(s))) trigger();
        }),
      );
    }
    if (jobs) offs.push(subscribe('job:updated', trigger));
    return () => {
      if (timer) clearTimeout(timer);
      for (const off of offs) off();
    };
  }, [scopesKey, jobs, enabled, refetch]);

  return { data, loading, error, refetch };
}
