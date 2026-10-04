'use client';

import { useCallback, useEffect, useState } from 'react';
import type { IpcInput, IpcOutput } from '@archivist/shared';
import { call } from './ipc';
import { joinPages, pageRequests } from './page-requests';
import { useQuery, type QueryState, type UseQueryOptions } from './use-query';

/** Rows per page of a growing list; „Mehr laden“ extends the window by one page. */
export const PAGE_SIZE = 100;

/** The size of the window of a list that grows page by page and starts over when `resetKey` changes. */
export function usePageWindow(resetKey: string) {
  const [pages, setPages] = useState(1);
  useEffect(() => setPages(1), [resetKey]);
  const more = useCallback(() => setPages((current) => current + 1), []);
  return { window: pages * PAGE_SIZE, more };
}

type PagedChannel = 'chat:history' | 'decisions:list' | 'insights:list' | 'contradictions:list' | 'openItems:list';

interface PagedQueryOptions extends Omit<UseQueryOptions, 'load' | 'loadKey'> {
  /** Which end of the list the first page holds when the pages are joined: `backward` puts later pages in front (chat history). */
  direction?: 'forward' | 'backward';
}

/** A list channel read through its first `window` rows, paged by `offset` beyond the IPC limit of one request. */
export function usePagedQuery<C extends PagedChannel>(
  channel: C,
  filter: Omit<IpcInput<C>, 'limit' | 'offset'> | undefined,
  window: number,
  { direction = 'forward', ...options }: PagedQueryOptions = {},
): QueryState<IpcOutput<C>> {
  const load = useCallback(
    async (input: IpcInput<C>) => {
      const answers: IpcOutput<C>[] = [];
      for (const request of pageRequests(window)) answers.push(await call(channel, { ...input, ...request }));
      return joinPages(answers as unknown[][], direction) as IpcOutput<C>;
    },
    [channel, window, direction],
  );
  return useQuery(channel, filter as IpcInput<C> | undefined, { ...options, load, loadKey: String(window) });
}
