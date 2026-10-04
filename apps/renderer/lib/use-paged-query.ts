'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcChannel, IpcInput, IpcOutput } from '@archivist/shared';
import { call, IpcError } from './ipc';
import { scopesOf, subscribe } from './events';

/** Channels whose input takes `limit` and `offset` (server-side paging). */
type PagedChannel = 'documents:list' | 'scanner:getResults' | 'notifications:list' | 'actions:list' | 'llm:transmissions';
type BaseInput<C extends PagedChannel> = Omit<IpcInput<C>, 'limit' | 'offset'>;

export interface UsePagedQueryOptions {
  pageSize: number;
  scopes?: string[];
  jobs?: boolean;
  enabled?: boolean;
}

export interface PagedState<C extends IpcChannel> {
  /** The pages loaded so far, oldest first; undefined until the first one arrives. */
  pages: Array<IpcOutput<C>> | undefined;
  loading: boolean;
  error: IpcError | null;
  refetch: () => Promise<void>;
  /** Loads the next page; the pages already shown stay. */
  loadMore: () => void;
}

/** Like `useQuery`, but pages through a long list: „Mehr laden“ adds a page, a change reloads all pages shown. */
export function usePagedQuery<C extends PagedChannel>(channel: C, input: BaseInput<C>, opts: UsePagedQueryOptions): PagedState<C> {
  const { pageSize, scopes, jobs = false, enabled = true } = opts;
  const [pages, setPages] = useState<Array<IpcOutput<C>> | undefined>(undefined);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<IpcError | null>(null);
  const requestId = useRef(0);
  const inputRef = useRef(input);
  inputRef.current = input;
  const inputKey = JSON.stringify(input);
  const scopesKey = (scopes ?? []).join('|');

  useEffect(() => {
    setPageCount(1);
  }, [inputKey]);

  const refetch = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    const id = ++requestId.current;
    setLoading(true);
    try {
      const requests = Array.from({ length: pageCount }, (_, index) =>
        call(channel, { ...inputRef.current, limit: pageSize, offset: index * pageSize } as IpcInput<C>),
      );
      const out = await Promise.all(requests);
      if (id !== requestId.current) return;
      setPages(out);
      setError(null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof IpcError ? err : new IpcError({ category: 'native_module_error', message: String(err), retryable: true }));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [channel, inputKey, enabled, pageCount, pageSize]);

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
    if (wanted.length > 0)
      offs.push(
        subscribe('data:changed', (payload) => {
          const got = scopesOf(payload);
          if (got.length === 0 || got.some((scope) => wanted.includes(scope))) trigger();
        }),
      );
    if (jobs) offs.push(subscribe('job:updated', trigger));
    return () => {
      if (timer) clearTimeout(timer);
      for (const off of offs) off();
    };
  }, [scopesKey, jobs, enabled, refetch]);

  const loadMore = useCallback(() => setPageCount((count) => count + 1), []);
  return { pages, loading, error, refetch, loadMore };
}

/** Items of all pages in order, each id once (a page boundary may shift while the list changes). */
export function uniqueById<T extends { id: string }>(lists: T[][] | undefined): T[] {
  const seen = new Map<string, T>();
  for (const item of (lists ?? []).flat()) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}
