'use client';

import { useCallback, useEffect, useState } from 'react';
import { LIST_MAX_LIMIT } from '@archivist/shared';

/** Rows per page of a growing list; „Mehr laden“ extends the window by one page. */
export const PAGE_SIZE = 100;

/** The window (`limit`) of a list that grows page by page up to the IPC limit and starts over when `resetKey` changes. */
export function usePageWindow(resetKey: string) {
  const [pages, setPages] = useState(1);
  useEffect(() => setPages(1), [resetKey]);
  const limit = Math.min(LIST_MAX_LIMIT, pages * PAGE_SIZE);
  const more = useCallback(() => setPages((current) => current + 1), []);
  return { limit, more, atMaximum: limit >= LIST_MAX_LIMIT };
}
