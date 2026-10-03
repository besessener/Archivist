'use client';

import { useMemo, useState } from 'react';
import type { LlmTransmission } from '@archivist/shared';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';

export const TRANSMISSION_PAGE_SIZE = 100;

/** The newest page from the live query plus the older pages loaded on request (offset paging, no entry twice). */
export function useTransmissionPages(newest: LlmTransmission[] | undefined) {
  const { run, busy } = useRun();
  const [older, setOlder] = useState<LlmTransmission[]>([]);
  const [lastPageFull, setLastPageFull] = useState<boolean | null>(null);
  const rows = useMemo(() => [...new Map([...(newest ?? []), ...older].map((entry) => [entry.id, entry])).values()], [newest, older]);
  const canLoadMore = lastPageFull ?? (newest?.length ?? 0) >= TRANSMISSION_PAGE_SIZE;

  async function loadMore() {
    const page = await run(() => call('llm:transmissions', { limit: TRANSMISSION_PAGE_SIZE, offset: rows.length }));
    if (!page) return;
    setOlder((previous) => [...previous, ...page]);
    setLastPageFull(page.length >= TRANSMISSION_PAGE_SIZE);
  }

  return { rows, canLoadMore, loadMore, loading: busy };
}
