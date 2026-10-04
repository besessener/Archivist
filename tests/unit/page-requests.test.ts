import { describe, expect, it } from 'vitest';
import { LIST_MAX_LIMIT } from '@archivist/shared';
import { joinPages, pageRequests } from '../../apps/renderer/lib/page-requests';

describe('pageRequests', () => {
  it('covers a window within one request with a single page', () => {
    expect(pageRequests(300)).toEqual([{ offset: 0, limit: 300 }]);
  });

  it('pages by offset beyond the IPC limit so that no row is unreachable', () => {
    expect(pageRequests(LIST_MAX_LIMIT + 100)).toEqual([
      { offset: 0, limit: LIST_MAX_LIMIT },
      { offset: LIST_MAX_LIMIT, limit: 100 },
    ]);
    expect(pageRequests(2 * LIST_MAX_LIMIT)).toHaveLength(2);
  });
});

describe('joinPages', () => {
  it('appends later pages after earlier ones', () => {
    expect(joinPages([[1, 2], [3]], 'forward')).toEqual([1, 2, 3]);
  });

  it('puts later (older) pages in front for newest-first windows', () => {
    expect(joinPages([['new1', 'new2'], ['old']], 'backward')).toEqual(['old', 'new1', 'new2']);
  });
});
