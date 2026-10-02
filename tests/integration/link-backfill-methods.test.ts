import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const byMethod = () =>
  (
    app.services.database.sqlite.prepare(`SELECT method, count(*) AS c FROM relations WHERE status = 'proposed' GROUP BY method`).all() as Array<{
      method: string | null;
      c: number;
    }>
  ).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.method ?? 'null']: r.c }), {});

describe('Retroactive link run with all methods (#279)', () => {
  it('proposes by every method for the existing archive, analyses notes once and sends ONE notification', async () => {
    // the archive from before: nothing was proposed automatically
    app = await createTestApp({ privacy: 'auto', autoLinks: false });
    app.llm.on('NoteAnalysis', () => ({ topic: 'Hausbau', project: null, persons: [], tags: [] }));
    const e = app.services.eventRecords.create({ title: 'Baubesprechung', occurredAt: '2026-09-01', participants: ['Anna Berger'] });
    const d = app.services.decisions.create({
      decisionText: 'Fenster aus Holz',
      title: 'Fenster',
      decidedAt: '2026-09-01',
      participants: ['Anna Berger'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.8,
    });
    await app.services.notes.create({ title: 'Statiker', content: 'Statiker anrufen.' });
    await app.services.jobs.whenIdle();
    expect(byMethod()).toEqual({});

    const { jobId } = await app.ok('links:startRun', {});
    await app.services.jobs.whenIdle();
    expect(app.services.jobs.get(jobId).status).toBe('succeeded');
    const found = byMethod();
    expect(found.date_person).toBe(1);
    expect(found.analysis).toBeGreaterThanOrEqual(1);
    expect(app.services.graph.relationsOf(e.id).some((r) => r.method === 'date_person' && [r.sourceEntityId, r.targetEntityId].includes(d.id))).toBe(true);
    expect(app.llm.calls.filter((c) => c.schema === 'NoteAnalysis')).toHaveLength(1);
    expect((await app.ok('notifications:list', {})).filter((n) => n.title === 'Verknüpfungsvorschläge')).toHaveLength(1);
  });

  it('continues where it stopped – a note analysed by the language model is not paid for again', async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: false });
    app.llm.on('NoteAnalysis', () => ({ topic: null, project: null, persons: [], tags: ['notiz'] }));
    for (let i = 0; i < 4; i += 1) await app.services.notes.create({ title: `Notiz ${i}`, content: `Inhalt ${i}` });
    const first = await app.services.links.backfill({ maxEntries: 2 });
    expect(first).toMatchObject({ processed: 2, done: false, remaining: 2 });
    const second = await app.services.links.backfill({ maxEntries: 10 });
    expect(second).toMatchObject({ processed: 2, done: true });
    expect(app.llm.calls.filter((c) => c.schema === 'NoteAnalysis')).toHaveLength(4);

    // stopped right away: nothing is done, the position stays
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await app.services.links.backfill({ maxEntries: 10, signal: ctrl.signal })).toMatchObject({ processed: 0 });
    expect(app.llm.calls.filter((c) => c.schema === 'NoteAnalysis')).toHaveLength(4);
  });
});
