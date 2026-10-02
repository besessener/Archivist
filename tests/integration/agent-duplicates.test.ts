import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RefStore, riskOf, type AgentTool, type ToolContext, type ToolOutput } from '../../packages/core/src/agent/registry';
import type { ToolDeps } from '../../packages/core/src/agent/tools/common';
import { duplicateTools } from '../../packages/core/src/agent/tools/duplicates';
import { documents } from '../../packages/core/src/db/schema';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
let tools: Map<string, AgentTool>;
let ctx: ToolContext;

const newCtx = (): ToolContext => ({
  runId: 'r1',
  conversationId: null,
  trigger: 'chat',
  mode: 'auto',
  refs: new RefStore(),
  shared: new Set(),
  signal: new AbortController().signal,
  userText: '',
  lastAnswer: null,
  files: [],
  applied: [],
  changes: [],
  changedCount: 0,
  tainted: null,
  actionIds: [],
});

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
    memory: {} as never,
    fileJobs: s.agentFileJobs,
    links: s.links,
    subjects: s.subjects,
    cases: s.cases,
    linkThresholds: s.linkThresholds,
    capture: s.capture,
    answers: s.answers,
    enqueueConsistency: () => undefined,
  };
}

beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  tools = new Map(duplicateTools(depsOf(app)).map((t) => [t.name, t]));
  ctx = newCtx();
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
  const loc = opts.loc ?? 'private/haus';
  app.llm.on('DocumentClassification', () => ({
    docType: 'Angebot',
    title: opts.title ?? name.replace(/\.\w+$/, ''),
    summary: `Zusammenfassung ${name}`,
    mainTopic: null,
    project: null,
    persons: [],
    dates: [],
    documentDate: opts.date ?? null,
    tags: [],
    location: { categoryPath: loc, fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems: [],
    confidence: 0.7,
    rationale: 'x',
  }));
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
const abs = (id: string) => path.join(app.services.settings.get().archiveRoot, ...row(id)!.archiveRelPath!.split('/'));
const lastAudit = (action: string) => app.services.audit.list(50).find((e) => e.action === action);

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
    expect(app.services.graph.rejectedBetween(v1, v2, { includeDuplicateOf: true })?.relationType).toBe('duplicate_of');
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
    const keep = await archived('Vertrag final.txt', 'Vertrag neu', { loc: 'private/vertraege', title: 'Vertrag final' });
    const old = await archived('Vertrag Entwurf.txt', 'Vertrag alt', { loc: 'private/vertraege', title: 'Vertrag Entwurf' });

    const out = await call('mark_duplicates', { keep: ctx.refs.doc(keep), duplicates: [ctx.refs.doc(old)], as: 'older_version', action: 'subfolder' });

    expect(out.content).toContain('Nach „private/vertraege/Ältere Versionen“ verschoben: 1 erfolgreich');
    expect(row(old)!.archiveRelPath).toBe('private/vertraege/Ältere Versionen/Vertrag Entwurf.txt');
    expect(row(old)!.tags).toContain('ältere Version');
    expect(app.services.graph.relationsOf(keep, { types: ['supersedes'] })[0]).toMatchObject({
      sourceEntityId: keep,
      targetEntityId: old,
      status: 'confirmed',
    });
    expect(row(keep)!.archiveRelPath).toBe('private/vertraege/Vertrag final.txt');
  });

  it('deletes duplicates for good, but never the kept document or a file outside the archive', async () => {
    const keep = await archived('Foto-Liste.txt', 'Liste A', { title: 'Foto-Liste' });
    const dup = await archived('Foto-Liste Kopie.txt', 'Liste A Kopie', { title: 'Foto-Liste Kopie' });
    const dupFile = abs(dup);
    const original = row(dup)!.sourcePath!;
    app.services.graph.link(dup, keep, 'duplicate_of', { status: 'proposed' });

    const out = await call('mark_duplicates', { keep: ctx.refs.doc(keep), duplicates: [ctx.refs.doc(dup), ctx.refs.doc(keep)], action: 'delete' });

    expect(out).toMatchObject({ changed: 1, change: '1 Duplikat(e) endgültig gelöscht' });
    expect(row(dup)).toBeUndefined();
    expect(fs.existsSync(dupFile)).toBe(false);
    expect(fs.existsSync(original), "the user's original stays").toBe(true);
    expect(fs.existsSync(abs(keep))).toBe(true);
    expect(app.services.graph.getEntity(dup)).toBeUndefined();
    expect(app.services.graph.relationsOf(keep, { types: ['duplicate_of'] })).toEqual([]);
    expect(lastAudit('document.delete')).toMatchObject({ undoable: false, entityIds: [dup], before: { title: 'Foto-Liste Kopie' } });
  });

  it('merges duplicate topics through the existing merge flow', async () => {
    const keep = app.services.graph.ensureEntity('topic', 'Küche');
    const dup = app.services.graph.ensureEntity('topic', 'Kueche neu');

    const out = await call('merge_entries', { kind: 'topic', keep: ctx.refs.entry(keep.id), duplicate: ctx.refs.entry(dup.id) });

    expect(out.summary).toBe('zusammengeführt');
    expect(app.services.graph.getEntity(dup.id)).toBeUndefined();
    expect(app.services.graph.getEntity(keep.id)?.aliases).toContain('Kueche neu');

    const wrong = await call('merge_entries', { kind: 'person', keep: ctx.refs.entry(keep.id), duplicate: ctx.refs.entry(dup.id) });
    expect(wrong.isError).toBe(true);
  });
});
