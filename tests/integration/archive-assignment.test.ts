import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('DocumentClassification', () => ({
    docType: 'Notiz',
    title: 'Protokoll',
    summary: 'Zusammenfassung',
    mainTopic: 'Vorgeschlagenes Thema',
    project: 'Falsches Projekt',
    persons: [],
    dates: [],
    tags: [],
    location: { categoryPath: 'work/notes', fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems: [],
    confidence: 0.7,
    rationale: 'x',
  }));
});
afterEach(async () => {
  await app.cleanup();
});

async function importOne(name: string, content: string) {
  const src = app.file(`in/${name}`, content);
  const imp = await app.ok('documents:import', { paths: [src] });
  await app.services.jobs.whenIdle();
  return { src, id: imp.imported[0]!.id };
}

type Item = { documentId: string; mode: 'copy' | 'move' | 'index_only'; topic?: string | null; project?: string | null };
const archive = (items: Item[], extra: Record<string, unknown> = {}) =>
  app.ok('documents:archive', { items, confirmed: true, approveNewCategories: [], confirmMove: false, ...extra } as never);

const linkedEntities = (documentId: string, type: 'topic' | 'project') => app.services.graph.neighbors(documentId, { types: [type] }).map((e) => e.name);

describe('Archive dialog: emptied topic/project', () => {
  it('uses the proposal when the fields are omitted', async () => {
    const a = await importOne('a.txt', 'Protokoll mit ausreichend Inhalt eins');
    const res = await archive([{ documentId: a.id, mode: 'copy' }]);
    expect(res.success).toBe(1);
    const doc = await app.ok('documents:get', { id: a.id });
    expect(doc.topicName).toBe('Vorgeschlagenes Thema');
    expect(doc.projectName).toBe('Falsches Projekt');
  });

  it('archives without topic/project when they are sent as null, ignoring the proposal', async () => {
    const a = await importOne('b.txt', 'Protokoll mit ausreichend Inhalt zwei');
    const plan = await app.ok('documents:previewArchive', { items: [{ documentId: a.id, mode: 'copy', topic: null, project: null }] });
    expect(plan.items[0]!.affected.filter((e) => e.type === 'topic' || e.type === 'project')).toEqual([]);

    const res = await archive([{ documentId: a.id, mode: 'copy', topic: null, project: null }]);
    expect(res.success).toBe(1);
    const doc = await app.ok('documents:get', { id: a.id });
    expect(doc.topicName).toBeNull();
    expect(doc.projectName).toBeNull();
    expect(linkedEntities(a.id, 'project')).toEqual([]);
    expect(linkedEntities(a.id, 'topic')).toEqual([]);
    expect(app.services.graph.findByName('project', 'Falsches Projekt')).toBeFalsy();
  });

  it('keeps the chosen topic while the emptied project clears an earlier assignment', async () => {
    const a = await importOne('c.txt', 'Protokoll mit ausreichend Inhalt drei');
    app.services.documents.assign(a.id, { project: 'Altes Projekt' });
    expect((await app.ok('documents:get', { id: a.id })).projectName).toBe('Altes Projekt');

    const res = await archive([{ documentId: a.id, mode: 'copy', topic: 'Eigenes Thema', project: '' }]);
    expect(res.success).toBe(1);
    const doc = await app.ok('documents:get', { id: a.id });
    expect(doc.topicName).toBe('Eigenes Thema');
    expect(doc.projectName).toBeNull();
    expect(linkedEntities(a.id, 'project')).not.toContain('Falsches Projekt');

    // Undo restores the earlier assignment.
    const undo = await app.ok('documents:undoArchive', { auditId: res.items[0]!.auditId! });
    expect(undo.undone).toBe(true);
    expect((await app.ok('documents:get', { id: a.id })).projectName).toBe('Altes Projekt');
  });
});

describe('Archive plan: "Original wird entfernt" only when it applies', () => {
  it('copying an upload only cleans up the inbox copy', async () => {
    const a = await importOne('d.txt', 'Upload mit ausreichend Inhalt vier');
    const plan = await app.ok('documents:previewArchive', { items: [{ documentId: a.id, mode: 'copy' }] });
    expect(plan.items[0]!.willRemoveSource).toBe(false);
    expect(plan.items[0]!.removesInboxCopy).toBe(true);
  });

  it('moving an upload removes the original outside Archivist', async () => {
    const a = await importOne('e.txt', 'Upload mit ausreichend Inhalt fünf');
    const plan = await app.ok('documents:previewArchive', { items: [{ documentId: a.id, mode: 'move' }] });
    expect(plan.items[0]!.willRemoveSource).toBe(true);
    expect(plan.items[0]!.removesInboxCopy).toBe(true);
  });

  it('index-only touches no file', async () => {
    const a = await importOne('f.txt', 'Upload mit ausreichend Inhalt sechs');
    const plan = await app.ok('documents:previewArchive', { items: [{ documentId: a.id, mode: 'index_only' }] });
    expect(plan.items[0]!.willRemoveSource).toBe(false);
    expect(plan.items[0]!.removesInboxCopy).toBe(false);
  });
});
