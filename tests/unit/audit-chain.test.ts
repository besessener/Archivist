import { describe, expect, it } from 'vitest';
import { chainHash, verifyChain, type ChainedFields, type ChainedRow } from '../../packages/core/src/services/audit-chain';

const fields = (id: string, over: Partial<ChainedFields> = {}): ChainedFields => ({
  id,
  at: '2026-10-01T10:00:00.000Z',
  action: 'decision.create',
  actor: 'user',
  trigger: 'ui',
  confirmed: true,
  entityIds: ['d1'],
  paths: [],
  before: null,
  success: true,
  runId: null,
  ...over,
});

function chain(...rows: ChainedFields[]): ChainedRow[] {
  let prev: string | null = null;
  return rows.map((row) => {
    const hash = chainHash(row, prev);
    const chained = { ...row, hash, prevHash: prev };
    prev = hash;
    return chained;
  });
}

describe('audit hash chain', () => {
  it('depends on every fixed field and on the entry before', () => {
    const base = chainHash(fields('a'), null);
    expect(chainHash(fields('a'), null)).toBe(base);
    expect(chainHash(fields('a'), 'x')).not.toBe(base);
    for (const over of [
      { id: 'b' },
      { at: '2026-10-01T10:00:01.000Z' },
      { action: 'decision.update' },
      { actor: 'agent' },
      { trigger: 'chat' },
      { confirmed: false },
      { entityIds: ['d2'] },
      { paths: ['/x'] },
      { before: { a: 1 } },
      { success: false },
      { runId: 'r1' },
    ])
      expect(chainHash(fields('a', over), null)).not.toBe(base);
    expect(chainHash(fields('a', { before: undefined }), null)).toBe(base);
  });

  it('accepts an intact chain, an empty one and one that starts after unchained entries', () => {
    expect(verifyChain([])).toEqual({ checked: 0, brokenEntryId: null });
    const rows = chain(fields('a'), fields('b'), fields('c'));
    expect(verifyChain(rows)).toEqual({ checked: 3, brokenEntryId: null });
    const legacy: ChainedRow = { ...fields('old'), hash: null, prevHash: null };
    expect(verifyChain([legacy, ...rows])).toEqual({ checked: 3, brokenEntryId: null });
  });

  it('names the entry that was changed, removed before it, reordered or left unchained', () => {
    const [a, b, c] = chain(fields('a'), fields('b'), fields('c'));
    expect(verifyChain([a!, { ...b!, action: 'forged' }, c!])).toEqual({ checked: 2, brokenEntryId: 'b' });
    expect(verifyChain([a!, c!])).toEqual({ checked: 2, brokenEntryId: 'c' });
    expect(verifyChain([a!, c!, b!])).toEqual({ checked: 2, brokenEntryId: 'c' });
    expect(verifyChain([a!, { ...b!, hash: null }, c!])).toEqual({ checked: 2, brokenEntryId: 'b' });
    expect(verifyChain([a!, { ...fields('x'), hash: null, prevHash: null }])).toEqual({ checked: 2, brokenEntryId: 'x' });
    expect(verifyChain([{ ...a!, hash: 'tampered' }])).toEqual({ checked: 1, brokenEntryId: 'a' });
  });
});
