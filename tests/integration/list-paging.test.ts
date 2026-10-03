import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { contradictions, conversations, decisions, insights, messages, openItems } from '../../packages/core/src/db/schema';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const db = () => app.services.ctx.database.db;
const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
const key = (n: number) => String(n).padStart(6, '0');
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

/** Inserts in batches inside one transaction (SQLite variable limit). */
function seed<T extends object>(rows: T[], insert: (batch: T[]) => void) {
  db().transaction(() => {
    for (let start = 0; start < rows.length; start += 200) insert(rows.slice(start, start + 200));
  });
}

function seedInsights(total: number, status: (n: number) => string = () => 'open') {
  seed(
    Array.from({ length: total }, (_, n) => ({
      id: `i-${key(n)}`,
      kind: 'orphan_document',
      title: `Hinweis ${n}`,
      explanation: 'x',
      status: status(n),
      dedupeKey: `seed:${n}`,
      createdAt: stamp(n),
      updatedAt: stamp(n),
    })),
    (batch) => db().insert(insights).values(batch).run(),
  );
}

function seedDecisions(total: number, status: (n: number) => string = () => 'active') {
  seed(
    Array.from({ length: total }, (_, n) => ({
      id: `d-${key(n)}`,
      title: `Entscheidung ${n}`,
      decisionText: `Wir entscheiden Nummer ${n}`,
      decidedAt: stamp(n),
      status: status(n),
      createdAt: stamp(n),
      updatedAt: stamp(n),
    })),
    (batch) => db().insert(decisions).values(batch).run(),
  );
}

function seedOpenItems(total: number) {
  seed(
    Array.from({ length: total }, (_, n) => ({
      id: `o-${key(n)}`,
      title: `Punkt ${n}`,
      status: n % 2 ? 'resolved' : 'open',
      createdAt: stamp(n),
      updatedAt: stamp(n),
    })),
    (batch) => db().insert(openItems).values(batch).run(),
  );
}

function seedContradictions(total: number) {
  seed(
    Array.from({ length: total }, (_, n) => ({
      id: `c-${key(n)}`,
      title: `Widerspruch ${n}`,
      description: 'x',
      affectedEntityIds: n % 2 ? ['d-a', 'd-b'] : ['d-b', 'd-c'],
      dedupeKey: `seed:${n}`,
      createdAt: stamp(n),
    })),
    (batch) => db().insert(contradictions).values(batch).run(),
  );
}

function seedMessages(conversationId: string, total: number) {
  db()
    .insert(conversations)
    .values({ id: conversationId, title: 'Test', createdAt: stamp(0), updatedAt: stamp(0) })
    .run();
  seed(
    Array.from({ length: total }, (_, n) => ({
      id: `m-${key(n)}`,
      conversationId,
      role: n % 2 ? 'assistant' : 'user',
      content: `Nachricht ${n}`,
      createdAt: stamp(n),
    })),
    (batch) => db().insert(messages).values(batch).run(),
  );
}

describe('paged lists (#223)', () => {
  it('pages insights newest first without gaps or overlaps and counts them', async () => {
    seedInsights(25);

    const pages = [
      await app.ok('insights:list', { status: 'open', limit: 10, offset: 0 }),
      await app.ok('insights:list', { status: 'open', limit: 10, offset: 10 }),
      await app.ok('insights:list', { status: 'open', limit: 10, offset: 20 }),
      await app.ok('insights:list', { status: 'open', limit: 10, offset: 25 }),
    ];

    expect(pages.map((page) => page.length)).toEqual([10, 10, 5, 0]);
    const all = pages.flatMap(ids);
    expect(new Set(all).size).toBe(25);
    expect(all[0]).toBe('i-000024');
    expect(all[24]).toBe('i-000000');
    expect(await app.ok('insights:count', { status: 'open' })).toBe(25);
  });

  it('keeps a caller without paging complete and rejects limits beyond the channel maximum', async () => {
    seedInsights(30);
    expect(await app.ok('insights:list', {})).toHaveLength(30);
    expect((await app.call('insights:list', { limit: 1001 })).ok).toBe(false);
    expect((await app.call('insights:list', { limit: 0 })).ok).toBe(false);
    expect((await app.call('insights:list', { offset: -1 })).ok).toBe(false);
  });

  it('counts open insights like the list does, after a snooze has run out', async () => {
    seedInsights(40, (n) => (n % 5 === 0 ? 'snoozed' : n % 2 ? 'open' : 'accepted'));
    db().update(insights).set({ snoozedUntil: '2000-01-01' }).where(eq(insights.status, 'snoozed')).run();

    const listed = app.services.insights.list({ status: 'open' }).length;

    expect(app.services.insights.openCount()).toBe(listed);
    expect(listed).toBe(20 + 4);
    expect(await app.ok('insights:count', { status: 'open' })).toBe(listed);
  });

  it('filters insights by kind and affected entry', async () => {
    seedInsights(3);
    db()
      .update(insights)
      .set({ kind: 'possibly_superseded', affected: [{ type: 'decision', id: 'd-x', label: 'X' }] })
      .where(eq(insights.id, 'i-000001'))
      .run();

    const hits = await app.ok('insights:list', { kind: 'possibly_superseded', entityId: 'd-x' });

    expect(ids(hits)).toEqual(['i-000001']);
    expect(await app.ok('insights:count', { entityId: 'd-other' })).toBe(0);
  });

  it('pages decisions, filters them by status list and ids, and counts them', async () => {
    seedDecisions(12, (n) => (n < 4 ? 'draft' : 'active'));

    const first = await app.ok('decisions:list', { limit: 5, offset: 0 });
    const last = await app.ok('decisions:list', { limit: 5, offset: 10 });

    expect(first[0]!.id).toBe('d-000011');
    expect(last).toHaveLength(2);
    expect(await app.ok('decisions:count', {})).toBe(12);
    expect(await app.ok('decisions:count', { statuses: ['active', 'confirmed'] })).toBe(8);
    expect(ids(await app.ok('decisions:list', { ids: ['d-000002', 'd-000007'] })).sort()).toEqual(['d-000002', 'd-000007']);
  });

  it('pages open items and counts with the same filter', async () => {
    seedOpenItems(11);

    expect(await app.ok('openItems:list', { limit: 4, offset: 8 })).toHaveLength(3);
    expect(await app.ok('openItems:count', {})).toBe(11);
    expect(await app.ok('openItems:count', { onlyActive: true })).toBe(6);
  });

  it('pages contradictions and filters them by affected entry', async () => {
    seedContradictions(9);

    expect(await app.ok('contradictions:list', { limit: 4, offset: 4 })).toHaveLength(4);
    expect(await app.ok('contradictions:count', {})).toBe(9);
    expect(await app.ok('contradictions:count', { entityId: 'd-a' })).toBe(4);
    expect(await app.ok('contradictions:count', { entityId: 'd-b' })).toBe(9);
  });

  it('loads the newest chat messages first and pages backwards, each page oldest first', async () => {
    seedMessages('conv-1', 25);

    const newest = await app.ok('chat:history', { conversationId: 'conv-1', limit: 10 });
    const earlier = await app.ok('chat:history', { conversationId: 'conv-1', limit: 10, offset: 10 });
    const oldest = await app.ok('chat:history', { conversationId: 'conv-1', limit: 10, offset: 20 });

    expect(ids(newest)).toEqual(Array.from({ length: 10 }, (_, i) => `m-${key(15 + i)}`));
    expect(ids(earlier)[0]).toBe('m-000005');
    expect(ids(oldest)).toEqual(Array.from({ length: 5 }, (_, i) => `m-${key(i)}`));
    expect(await app.ok('chat:historyCount', { conversationId: 'conv-1' })).toBe(25);
  });

  it('answers a seeded list of 10,000 rows within a measured time', async () => {
    seedInsights(10_000, (n) => (n % 2 ? 'open' : 'accepted'));
    seedDecisions(10_000);

    const measured = async (run: () => Promise<unknown>) => {
      const started = performance.now();
      await run();
      return Math.round((performance.now() - started) * 10) / 10;
    };
    const timings = {
      'insights:list (unpaged, 5,000 open)': await measured(() => app.ok('insights:list', { status: 'open' })),
      'insights:list (first 100)': await measured(() => app.ok('insights:list', { status: 'open', limit: 100 })),
      'insights:count': await measured(() => app.ok('insights:count', { status: 'open' })),
      'insights openCount()': await measured(async () => app.services.insights.openCount()),
      'decisions:list (first 100)': await measured(() => app.ok('decisions:list', { limit: 100 })),
      'decisions:count': await measured(() => app.ok('decisions:count', {})),
    };
    console.info('10k-row timings (ms)', timings);

    expect(await app.ok('insights:count', { status: 'open' })).toBe(5000);
    expect(app.services.insights.openCount()).toBe(5000);
    expect(timings['insights:count']).toBeLessThan(500);
    expect(timings['insights:list (first 100)']).toBeLessThan(500);
  });
});
