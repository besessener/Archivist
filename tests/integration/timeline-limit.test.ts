import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  await app.cleanup();
});

/** ISO date `n` days after 2024-01-01 (UTC), so every event lands on its own day. */
const day = (n: number) => new Date(Date.UTC(2024, 0, 1 + n)).toISOString().slice(0, 10);

const createEvents = (count: number, extra: { topic?: string } = {}) => {
  for (let i = 0; i < count; i++) app.services.eventRecords.create({ title: `Ereignis ${i}`, occurredAt: day(i), sourceIds: [], ...extra });
};

describe('timeline:get returns the newest entries', () => {
  it('keeps the newest N entries (chronologically sorted) when there are more entries than the limit', async () => {
    createEvents(12);
    const entries = await app.ok('timeline:get', { limit: 5 });
    expect(entries.map((e) => e.title)).toEqual([7, 8, 9, 10, 11].map((i) => `Ereignis: Ereignis ${i}`));
    expect(entries.map((e) => e.date)).toEqual([7, 8, 9, 10, 11].map(day));
  });

  it('applies the default limit of 300 to the newest entries', async () => {
    createEvents(305);
    const entries = await app.ok('timeline:get', {});
    expect(entries).toHaveLength(300);
    expect(entries[0]!.date).toBe(day(5));
    expect(entries.at(-1)!.date).toBe(day(304));
    expect(entries.some((e) => e.title === 'Ereignis: Ereignis 304')).toBe(true);
    expect(entries.some((e) => e.title === 'Ereignis: Ereignis 4')).toBe(false);
  });

  it('filters by time range first and then takes the newest entries of that range', async () => {
    createEvents(30);
    const entries = await app.ok('timeline:get', { from: day(3), to: day(14), limit: 4 });
    expect(entries.map((e) => e.date)).toEqual([11, 12, 13, 14].map(day));
  });

  it('filters by topic first and then takes the newest entries of that topic', async () => {
    createEvents(10, { topic: 'Hausbau' });
    for (let i = 10; i < 20; i++) app.services.eventRecords.create({ title: `Fremd ${i}`, occurredAt: day(i), topic: 'Urlaub', sourceIds: [] });
    const topicId = (await app.ok('knowledge:listEntities', { type: 'topic' })).find((t) => t.name === 'Hausbau')!.id;
    const entries = await app.ok('timeline:get', { topicId, limit: 3 });
    expect(entries.map((e) => e.title)).toEqual([7, 8, 9].map((i) => `Ereignis: Ereignis ${i}`));
  });

  it('returns everything when the limit is not reached and allows larger windows ("Ältere laden")', async () => {
    createEvents(8);
    expect(await app.ok('timeline:get', { limit: 50 })).toHaveLength(8);
    const firstPage = await app.ok('timeline:get', { limit: 3 });
    const twoPages = await app.ok('timeline:get', { limit: 6 });
    expect(twoPages.slice(-3)).toEqual(firstPage);
    expect(twoPages[0]!.date).toBe(day(2));
  });

  it('shows the newest entries in a chat timeline question', async () => {
    app.llm.down = true;
    createEvents(305);
    const r = await app.ok('chat:send', { text: 'Zeig mir den Zeitverlauf' });
    expect(r.assistantMessage.intent).toBe('timeline_query');
    expect(r.assistantMessage.content).toContain('die neuesten 300 Einträge');
    expect(r.assistantMessage.content).toContain('Ereignis 304');
    expect(r.assistantMessage.content).not.toContain('Ereignis 4\n');
    expect(r.assistantMessage.sources.at(-1)?.title).toMatch(/Ereignis 304$/);
  });
});
