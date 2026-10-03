import { LIST_MAX_LIMIT } from '@archivist/shared';

export interface PageRequest {
  limit: number;
  offset: number;
}

/** The IPC requests (each at most `LIST_MAX_LIMIT` rows) that together cover the first `window` rows of a list. */
export function pageRequests(window: number): PageRequest[] {
  const requests: PageRequest[] = [];
  for (let offset = 0; offset < window; offset += LIST_MAX_LIMIT) {
    requests.push({ offset, limit: Math.min(LIST_MAX_LIMIT, window - offset) });
  }
  return requests;
}

/** Joins the answers in request order, or – for lists whose later pages hold older rows shown first – the later pages in front. */
export function joinPages<T>(pages: T[][], direction: 'forward' | 'backward'): T[] {
  return (direction === 'forward' ? pages : [...pages].reverse()).flat();
}
