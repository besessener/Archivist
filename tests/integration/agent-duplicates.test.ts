import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { riskOf, type AgentTool, type ToolContext, type ToolOutput } from '../../packages/core/src/agent/registry';
import type { ToolDeps } from '../../packages/core/src/agent/tools/common';
import { duplicateTools } from '../../packages/core/src/agent/tools/duplicates';
import { documents } from '../../packages/core/src/db/schema';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';
import { emptyToolContext } from '../helpers/agent';

let app: TestApp;
let tools: Map<string, AgentTool>;
let ctx: ToolContext;

function depsOf(t: TestApp): ToolDeps {
  const s = t.services;
  return {
    paths: s.paths,
    settings: s.settings,
    docs: s.documents,
    search: s.search,
    graph: s.graph,
    privacy: s.privacy,
    decisions: s.decisions,
    openItems: s.openItems,
    reminders: s.reminders,
    events: s.eventRecords,
    notes: s.notes,
    timeline: s.timeline,
    insights: s.insights,
    actions: s.actions,
    archive: s.archive,
    categories: s.categories,
    scanner: s.scanner,
    jobs: s.jobs,
    audit: s.audit,
    undo: s.undo,
    persons: s.persons,
    notifications: s.notifications,
    openItemDuplicates: s.openItemDuplicates,
    noteEventDuplicates: s.noteEventDuplicates,
    contradictions: s.contradictions,
    memory: {} as never,
    fileJobs: s.agentFileJobs,
    links: s.links,
    subjects: s.subjects,
    cases: s.cases,
    linkThresholds: s.linkThresholds,
    capture: s.capture,
    answers: s.answers,
    logs: s.logReader,
    diagnostics: s.diagnostics,
    enqueueConsistency: () => undefined,
    logger: s.ctx.logger,
  };
}

beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  tools = new Map(duplicateTools(depsOf(app)).map((t) => [t.name, t]));
  ctx = emptyToolContext();
});
afterEach(async () => {
  await app.cleanup();
});

async function call(name: string, args: unknown): Promise<ToolOutput> {
  const tool = tools.get(name)!;
  return tool.run(tool.schema.parse(args), ctx);
}

const LONG = 'Angebot für die neue Küche mit Einbaugeräten, Arbeitsplatte aus Eiche und Montage durch die Firma Holzbau. '.repeat(4);

async function archived(name: string, content: string, opts: { loc?: string; date?: string | null; title?: string } = {}): Promise<string> {
  const loc = opts.loc ?? 'Privat/haus';
  app.llm.on('DocumentClassification', () =>
    classification({
      title: opts.title ?? name.replace(/\.\w+$/, ''),
      summary: `Zusammenfassung ${name}`,
      categoryPath: loc,
      docType: 'Angebot',
      documentDate: opts.date ?? null,
    }),
  );
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, content)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: loc, topic: null }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

const row = (id: string) => app.services.documents.findRow(id);
const lastAudit = (action: string) => app.services.audit.list({ limit: 50 }).find((e) => e.action === action);

describe('agent duplicate tools', () => {
  it('finds exact duplicates, near duplicates and versions with reason and newest document', async () => {
    const a = await archived('Kuechenangebot.txt', LONG, { date: '2026-01-10' });
    const b = await archived('Kuechenangebot Kopie.txt', `${LONG}\n\n`, { date: '2026-01-11' });
    const v1 = await archived('Gartenplan Entwurf.txt', 'Gartenplan: Beet links, Rasen rechts.', { date: '2026-02-01', title: 'Gartenplan Entwurf' });
    const v2 = await archived('Gartenplan final.txt', 'Gartenplan: Beet links, Rasen rechts, Teich hinten.', { date: '2026-03-01', title: 'Gartenplan final' });
    const x1 = await archived('Brief.txt', 'Hallo Welt', { title: 'Brief an Oma' });
    const x2 = await archived('Brief2.txt', 'Hallo Welt!', { title: 'Brief an Opa' });
    // an exact copy (same checksum) cannot be imported twice – it is created directly
    app.services.database.db
      .update(documents)
      .set({ sha256: row(x1)!.sha256 })
      .where(eq(documents.id, x2))
      .run();

    const out = await call('find_duplicates', {});

    expect(out.content).toMatch(new RegExp(`Exaktes Duplikat \\(2 Dokumente, S\\d+\\) – gleicher Dateiinhalt \\(gleiche Prüfsumme\\)\\. Neueste: D\\d+`));
    expect(out.content).toContain(`Fast gleich (2 Dokumente`);
    expect(out.content).toContain('gleicher Textinhalt (andere Datei');
    expect(out.content).toMatch(
      new RegExp(`Versionen \\(2 Dokumente, S\\d+\\) – gleicher Name bis auf Versions- oder Datumsangaben[^\\n]*Neueste: ${ctx.refs.doc(v2)}`),
    );
    expect(out.content).toContain(ctx.refs.doc(a));
    expect(out.content).toContain(ctx.refs.doc(b));
    expect(out.content).toContain(ctx.refs.doc(v1));
    expect(out.summary).toBe('3 Gruppe(n)');
  });

  it('respects pairs the user marked as different', async () => {
    const v1 = await archived('Gartenplan Entwurf.txt', 'Plan A', { title: 'Gartenplan Entwurf' });
    const v2 = await archived('Gartenplan final.txt', 'Plan B', { title: 'Gartenplan final' });
    expect((await call('find_duplicates', { kinds: ['versions'] })).summary).toBe('1 Gruppe(n)');

    const marked = await call('mark_different', { a: ctx.refs.doc(v1), b: ctx.refs.doc(v2) });
    expect(marked.content).toContain('sind verschieden');
    expect(app.services.graph.rejectedBetween({ a: v1, b: v2, includeDuplicateOf: true })?.relationType).toBe('duplicate_of');
    expect(lastAudit('relation.markDifferent')).toMatchObject({ undoable: false });

    const again = await call('find_duplicates', { kinds: ['versions'] });
    expect(again.summary).toBe('keine Duplikate');
  });

  it('shows a document that is not released without its title', async () => {
    await archived('Befund Entwurf.txt', 'Befund A', { title: 'Befund Entwurf Dr. Geheim' });
    const hidden = await archived('Befund final.txt', 'Befund B', { title: 'Befund final Dr. Geheim' });
    app.services.settings.update({ privacy: { llmMode: 'confirm' } });
    app.services.database.db.update(documents).set({ llmStatus: 'pending' }).where(eq(documents.id, hidden)).run();

    const out = await call('find_duplicates', { kinds: ['versions'] });

    expect(out.content).toContain(`${ctx.refs.doc(hidden)}: [nicht freigegeben]`);
    expect(out.content).not.toContain('Befund final Dr. Geheim');
    expect(ctx.shared.has(hidden)).toBe(false);
  });

  it('marks duplicates with relation and tag; the tag can be undone', async () => {
    const keep = await archived('Angebot.txt', 'Angebot Version 2', { title: 'Angebot' });
    const dup = await archived('Angebot alt.txt', 'Angebot Version 1', { title: 'Angebot alt' });
    const tool = tools.get('mark_duplicates')!;
    const args = tool.schema.parse({ keep: ctx.refs.doc(keep), duplicates: [ctx.refs.doc(dup)], as: 'duplicate', action: 'mark' });
    expect(riskOf(tool, args)).toBe('write');
    expect(riskOf(tool, tool.schema.parse({ keep: 'D1', duplicates: ['D2'], action: 'delete' }))).toBe('critical');

    const out = await tool.run(args, ctx);

    expect(out).toMatchObject({ changed: 1, change: '1 Dokument(e) als Duplikat markiert' });
    expect(row(dup)!.tags).toContain('Duplikat');
    expect(row(keep)!.tags).not.toContain('Duplikat');
    const rel = app.services.graph.relationsOf(dup, { types: ['duplicate_of'] })[0];
    expect(rel).toMatchObject({ sourceEntityId: dup, targetEntityId: keep, status: 'confirmed' });

    const audit = lastAudit('document.bulkUpdate')!;
    await app.services.undo.undo(audit.id);
    expect(row(dup)!.tags).not.toContain('Duplikat');
  });

  it('marks older versions and moves them into a subfolder next to the kept document', async () => {
    const keep = await archived('Vertrag final.txt', 'Vertrag neu', { loc: 'Privat/vertraege', title: 'Vertrag final' });
    const old = await archived('Vertrag Entwurf.txt', 'Vertrag alt', { loc: 'Privat/vertraege', title: 'Vertrag Entwurf' });

    const out = await call('mark_duplicates', { keep: ctx.refs.doc(keep), duplicates: [ctx.refs.doc(old)], as: 'older_version', action: 'subfolder' });

    expect(out.content).toContain('Nach „Privat/vertraege/Ältere Versionen“ verschoben: 1 erfolgreich');
    expect(row(old)!.archiveRelPath).toBe('Privat/vertraege/Ältere Versionen/Vertrag Entwurf.txt');
    expect(row(old)!.tags).toContain('ältere Version');
    expect(app.services.graph.relationsOf(keep, { types: ['supersedes'] })[0]).toMatchObject({
      sourceEntityId: keep,
      targetEntityId: old,
      status: 'confirmed',
    });
    expect(row(keep)!.archiveRelPath).toBe('Privat/vertraege/Vertrag final.txt');
  });

  it('moves duplicates into the trash, never the kept document; undo brings them back', async () => {
    const keep = await archived('Foto-Liste.txt', 'Liste A', { title: 'Foto-Liste' });
    const dup = await archived('Foto-Liste Kopie.txt', 'Liste A Kopie', { title: 'Foto-Liste Kopie' });
    app.services.graph.link({ sourceId: dup, targetId: keep, relationType: 'duplicate_of' }, { status: 'proposed' });

    const out = await call('mark_duplicates', { keep: ctx.refs.doc(keep), duplicates: [ctx.refs.doc(dup), ctx.refs.doc(keep)], action: 'delete' });

    expect(out).toMatchObject({ changed: 1, change: '1 Duplikat(e) in den Papierkorb gelegt' });
    expect(row(dup)).toBeUndefined();
    expect(row(keep)).toBeDefined();
    const trashed = lastAudit('document.trash')!;
    expect(trashed).toMatchObject({ undoable: true, entityIds: [dup], trigger: 'agent' });

    await app.services.undo.undo(trashed.id);

    expect(row(dup)).toMatchObject({ title: 'Foto-Liste Kopie' });
    expect(app.services.graph.relationsOf(keep, { types: ['duplicate_of'] })).toHaveLength(1);
  });

  it('merges duplicate topics through the existing merge flow', async () => {
    const keep = app.services.graph.ensureEntity({ type: 'topic', name: 'Küche' });
    const dup = app.services.graph.ensureEntity({ type: 'topic', name: 'Kueche neu' });

    const out = await call('merge_entries', { kind: 'topic', keep: ctx.refs.entry(keep.id), duplicate: ctx.refs.entry(dup.id) });

    expect(out.summary).toBe('zusammengeführt');
    expect(app.services.graph.getEntity(dup.id)).toBeUndefined();
    expect(app.services.graph.getEntity(keep.id)?.aliases).toContain('Kueche neu');

    const wrong = await call('merge_entries', { kind: 'person', keep: ctx.refs.entry(keep.id), duplicate: ctx.refs.entry(dup.id) });
    expect(wrong.isError).toBe(true);
  });
});

describe('agent duplicate tools: undo and merges', () => {
  it('undoes the duplicate_of relation set by mark_duplicates', async () => {
    const keep = await archived('Angebot.txt', 'Angebot Version 2', { title: 'Angebot' });
    const dup = await archived('Angebot alt.txt', 'Angebot Version 1', { title: 'Angebot alt' });
    await call('mark_duplicates', { keep: ctx.refs.doc(keep), duplicates: [ctx.refs.doc(dup)], as: 'duplicate', action: 'mark' });
    const link = lastAudit('relation.link')!;
    expect(link).toMatchObject({ undoable: true, trigger: 'agent' });

    const result = await app.services.undo.undo(link.id);

    expect(result.undone).toBe(true);
    expect(app.services.graph.relationsOf(dup, { types: ['duplicate_of'] })).toEqual([]);
  });

  it('undoes the supersedes relation set for an older version', async () => {
    const keep = await archived('Vertrag final.txt', 'Vertrag neu', { title: 'Vertrag final' });
    const old = await archived('Vertrag Entwurf.txt', 'Vertrag alt', { title: 'Vertrag Entwurf' });
    await call('mark_duplicates', { keep: ctx.refs.doc(keep), duplicates: [ctx.refs.doc(old)], as: 'older_version', action: 'mark' });
    expect(app.services.graph.relationsOf(keep, { types: ['supersedes'] })).toHaveLength(1);

    await app.services.undo.undo(lastAudit('relation.link')!.id);

    expect(app.services.graph.relationsOf(keep, { types: ['supersedes'] })).toEqual([]);
  });

  it('undoes the move into the subfolder', async () => {
    const keep = await archived('Vertrag final.txt', 'Vertrag neu', { loc: 'Privat/vertraege', title: 'Vertrag final' });
    const old = await archived('Vertrag Entwurf.txt', 'Vertrag alt', { loc: 'Privat/vertraege', title: 'Vertrag Entwurf' });
    await call('mark_duplicates', { keep: ctx.refs.doc(keep), duplicates: [ctx.refs.doc(old)], as: 'older_version', action: 'subfolder' });
    expect(row(old)!.archiveRelPath).toBe('Privat/vertraege/Ältere Versionen/Vertrag Entwurf.txt');

    const result = await app.services.undo.undo(lastAudit('archive.relocate')!.id);

    expect(result.undone).toBe(true);
    expect(row(old)!.archiveRelPath).toBe('Privat/vertraege/Vertrag Entwurf.txt');
  });

  it('merges open items, notes, events and persons and undoes each merge', async () => {
    const keepItem = await app.ok('openItems:create', { title: 'Steuererklärung abgeben', priority: 'normal', sourceIds: [], confidence: 0.9 });
    const dupItem = await app.ok('openItems:create', { title: 'Steuererklärung abgeben!', priority: 'normal', sourceIds: [], confidence: 0.9 });
    const keepNote = await app.services.notes.create({ content: 'Steuerunterlagen bis Ende Mai sammeln' });
    const dupNote = await app.services.notes.create({ content: 'Steuerunterlagen bis Ende Mai sammeln!' });
    const keepEvent = app.services.eventRecords.create({ title: 'Kickoff Projekt Nord', occurredAt: '2026-05-04', sourceIds: [] });
    const dupEvent = app.services.eventRecords.create({ title: 'Kickoff Projekt Nord', occurredAt: '2026-05-04', description: 'mit Kunde', sourceIds: [] });
    const keepPerson = app.services.graph.ensureEntity({ type: 'person', name: 'Anna Schmidt' });
    const dupPerson = app.services.graph.ensureEntity({ type: 'person', name: 'Anna Schmid' });
    const merges = [
      { kind: 'open_item', keep: keepItem.id, duplicate: dupItem.id, action: 'open_item.merge_duplicate' },
      { kind: 'note', keep: keepNote.id, duplicate: dupNote.id, action: 'note.merge_duplicate' },
      { kind: 'event', keep: keepEvent.id, duplicate: dupEvent.id, action: 'event.merge_duplicate' },
      { kind: 'person', keep: keepPerson.id, duplicate: dupPerson.id, action: 'entity.merge' },
    ] as const;

    for (const merge of merges) {
      const out = await call('merge_entries', { kind: merge.kind, keep: ctx.refs.entry(merge.keep), duplicate: ctx.refs.entry(merge.duplicate) });
      expect(out).toMatchObject({ summary: 'zusammengeführt', changed: 1 });
      expect(lastAudit(merge.action)).toMatchObject({ undoable: true, trigger: 'agent' });
    }
    expect(app.services.openItems.get(dupItem.id).status).toBe('dismissed');
    expect(app.services.graph.getEntity(dupNote.id)?.duplicateOfId).toBe(keepNote.id);
    expect(app.services.eventRecords.get(dupEvent.id).duplicateOfId).toBe(keepEvent.id);
    expect(app.services.graph.getEntity(dupPerson.id)).toBeUndefined();

    for (const merge of merges) expect((await app.services.undo.undo(lastAudit(merge.action)!.id)).undone).toBe(true);

    expect(app.services.openItems.get(dupItem.id).status).toBe('open');
    expect(app.services.graph.getEntity(dupNote.id)?.duplicateOfId).toBeNull();
    expect(app.services.eventRecords.get(dupEvent.id).duplicateOfId).toBeNull();
    expect(app.services.graph.getEntity(dupPerson.id)).toMatchObject({ name: 'Anna Schmid' });
  });

  it('groups near duplicates that differ only after the first 200 characters, not those that differ before', async () => {
    const start = 'Mietvertrag über die Wohnung im zweiten Obergeschoss mit Balkon, Einbauküche und Kellerabteil, Miete monatlich im Voraus fällig. '.repeat(2);
    const same1 = await archived('Vertrag A.txt', `${start}Schluss A: Kaution 2400 Euro.`, { title: 'Vertrag Nord' });
    const same2 = await archived('Vertrag B.txt', `${start}Schluss B: Kaution 3000 Euro und Haustiere erlaubt.`, { title: 'Vertrag Süd' });
    const other = await archived('Vertrag C.txt', `Kaufvertrag. ${start}Schluss A: Kaution 2400 Euro.`, { title: 'Vertrag West' });
    expect(start.length).toBeGreaterThan(200);

    const out = await call('find_duplicates', { kinds: ['near'] });

    expect(out.content).toContain('sehr ähnlicher Textanfang');
    expect(out.content).toContain(ctx.refs.doc(same1));
    expect(out.content).toContain(ctx.refs.doc(same2));
    expect(out.content).not.toContain(ctx.refs.doc(other));
  });
});
