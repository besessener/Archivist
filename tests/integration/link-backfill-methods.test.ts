import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRunScope } from '../../packages/core/src/agent/scope';
import { createTestApp, type TestApp } from '../helpers/harness';
import { flatText } from '../helpers/link-texts';

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
    const e = app.services.eventRecords.create({ title: 'Baubesprechung', occurredAt: '2026-09-01', participants: ['Anna Berger'], sourceIds: [] });
    const d = app.services.decisions.create({
      decisionText: 'Fenster aus Holz',
      title: 'Fenster',
      decidedAt: '2026-09-01',
      participants: ['Anna Berger'],
      alternatives: [],
      unknownFields: [],
      asDraft: false,
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

  it('similarity proposals keep the cap per entry and are no audit entries of the user', async () => {
    app = await createTestApp({ autoLinks: false });
    app.services.settings.update({ links: { maxProposalsPerEntry: 1 } });
    const notes: string[] = [];
    for (const what of ['Mietvertrag', 'Nebenkosten', 'Kündigung', 'Übergabe', 'Kaution', 'Schlüssel'])
      notes.push((await app.services.notes.create({ title: what, content: flatText(what) })).id);
    await app.services.jobs.whenIdle();

    await app.ok('links:startRun', {});
    await app.services.jobs.whenIdle();
    expect(byMethod().similarity).toBeGreaterThan(0);
    const openSimilarity = (id: string) =>
      app.services.graph.relationsOf(id, { statuses: ['proposed'] }).filter((r) => r.method === 'similarity' && r.relationType === 'related_to');
    for (const id of notes) expect(openSimilarity(id).length).toBeLessThanOrEqual(1);
    expect((await app.ok('audit:list', { limit: 100 })).filter((e) => e.action === 'relation.link')).toEqual([]);
  });

  it('inside an agent run a failing pair skips only itself: the other similar entries are still proposed and counted', async () => {
    app = await createTestApp({ autoLinks: false });
    for (const what of ['Mietvertrag', 'Nebenkosten', 'Kündigung']) await app.services.notes.create({ title: what, content: flatText(what) });
    await app.services.jobs.whenIdle();
    const { graph } = app.services;
    const linkEntries = graph.linkEntries.bind(graph);
    let failed = false;
    vi.spyOn(graph, 'linkEntries').mockImplementation((key, options) => {
      if (failed) return linkEntries(key, options);
      failed = true;
      throw new Error('entry removed meanwhile');
    });

    const result = await agentRunScope.run({ runId: 'run-1', explicit: false, auditIds: [] }, () => app.services.links.backfill({ maxEntries: 1 }));
    expect(failed).toBe(true);
    expect(result.proposed).toBe(1);
    expect(byMethod().similarity).toBe(1);
  });

  it('outside an agent run a failing pair skips only itself: the other similar entries are still proposed and counted', async () => {
    app = await createTestApp({ autoLinks: false });
    for (const what of ['Mietvertrag', 'Nebenkosten', 'Kündigung']) await app.services.notes.create({ title: what, content: flatText(what) });
    await app.services.jobs.whenIdle();
    const { graph } = app.services;
    const link = graph.link.bind(graph);
    let failed = false;
    vi.spyOn(graph, 'link').mockImplementation((key, options) => {
      if (failed || options?.method !== 'similarity' || key.relationType !== 'related_to') return link(key, options);
      failed = true;
      throw new Error('entry removed meanwhile');
    });

    const result = await app.services.links.backfill({ maxEntries: 1 });
    expect(failed).toBe(true);
    expect(result.proposed).toBe(1);
    expect(byMethod().similarity).toBe(1);
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
