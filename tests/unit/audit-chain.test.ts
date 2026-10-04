import { describe, expect, it } from 'vitest';
import {
  chainHash,
  isTruncated,
  parseAnchor,
  verifyAuditLog,
  verifyChain,
  type ChainedFields,
  type ChainedRow,
} from '../../packages/core/src/services/audit-chain';

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
    expect(verifyChain([])).toEqual({ chain: 'intact', checked: 0 });
    const rows = chain(fields('a'), fields('b'), fields('c'));
    expect(verifyChain(rows)).toEqual({ chain: 'intact', checked: 3 });
    const legacy: ChainedRow = { ...fields('old'), hash: null, prevHash: null };
    expect(verifyChain([legacy, ...rows])).toEqual({ chain: 'intact', checked: 3 });
  });

  it('names the entry that was changed, removed before it, reordered or left unchained', () => {
    const [a, b, c] = chain(fields('a'), fields('b'), fields('c'));
    expect(verifyChain([a!, { ...b!, action: 'forged' }, c!])).toEqual({ chain: 'broken', brokenEntryId: 'b', checked: 2 });
    expect(verifyChain([a!, c!])).toEqual({ chain: 'broken', brokenEntryId: 'c', checked: 2 });
    expect(verifyChain([a!, c!, b!])).toEqual({ chain: 'broken', brokenEntryId: 'c', checked: 2 });
    expect(verifyChain([a!, { ...b!, hash: null }, c!])).toEqual({ chain: 'broken', brokenEntryId: 'b', checked: 2 });
    expect(verifyChain([a!, { ...fields('x'), hash: null, prevHash: null }])).toEqual({ chain: 'broken', brokenEntryId: 'x', checked: 2 });
    expect(verifyChain([{ ...a!, hash: 'tampered' }])).toEqual({ chain: 'broken', brokenEntryId: 'a', checked: 1 });
  });
});

describe('audit chain anchor', () => {
  const rows = chain(fields('a'), fields('b'), fields('c'));
  const anchor = { count: 3, hash: rows[2]!.hash! };

  it('accepts the log the anchor describes, and any log while there is no anchor', () => {
    expect(isTruncated(rows, anchor)).toBe(false);
    expect(isTruncated([], null)).toBe(false);
    expect(verifyAuditLog(rows, anchor)).toEqual({ chain: 'intact', checked: 3, truncated: false });
  });

  it('notices removed newest rows, removed oldest rows, and an emptied log', () => {
    expect(isTruncated(rows.slice(0, 2), anchor)).toBe(true);
    expect(isTruncated(rows.slice(1), anchor)).toBe(true);
    expect(isTruncated([], anchor)).toBe(true);
  });

  it('notices removed rows even when later entries were chained on', () => {
    const regrown = chain(fields('a'), fields('b'), fields('d'));
    expect(verifyAuditLog(regrown, anchor).truncated).toBe(true);
    expect(verifyAuditLog(regrown, { count: 4, hash: regrown[2]!.hash! }).truncated).toBe(true);
  });

  it('notices a nulled hash of the first chained row', () => {
    expect(verifyAuditLog([{ ...rows[0]!, hash: null }, rows[1]!, rows[2]!], anchor)).toMatchObject({ truncated: true });
  });

  it('parses only a well-formed anchor', () => {
    expect(parseAnchor(JSON.stringify(anchor))).toEqual(anchor);
    for (const bad of [null, '', 'x', '{}', '{"count":1.5,"hash":"h"}', '{"count":1,"hash":2}']) expect(parseAnchor(bad)).toBeNull();
  });
});
