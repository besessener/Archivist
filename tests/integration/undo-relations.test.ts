import type { GraphRelation, RelationType } from '@archivist/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('DocumentClassification', () =>
    classification({
      title: 'Steuerbescheid 2025',
      summary: 'Bescheid des Finanzamts',
      categoryPath: 'work/notes',
      docType: 'Bescheid',
      mainTopic: 'Steuern',
      project: 'Hausbau',
    }),
  );
});
afterEach(async () => {
  await app.cleanup();
});

const graph = () => app.services.graph;
const topicId = (name: string) => graph().ensureEntity('topic', name).id;
const projectId = (name: string) => graph().ensureEntity('project', name).id;

function relation(a: string, b: string, type: RelationType): GraphRelation | undefined {
  return graph()
    .relationsOf(a, { types: [type] })
    .find((r) => (r.sourceEntityId === a && r.targetEntityId === b) || (r.sourceEntityId === b && r.targetEntityId === a));
}

async function importDoc(name = 'bescheid.txt', content = 'Steuerbescheid für das Jahr 2025, Einkommensteuer') {
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, content)] });
  await app.services.jobs.whenIdle();
  return imp.imported[0]!.id;
}

const archive = (documentId: string) =>
  app.ok('documents:archive', { items: [{ documentId, mode: 'copy' }], confirmed: true, approveNewCategories: [], confirmMove: false } as never);

async function undoLatest(action: string) {
  const entry = (await app.ok('audit:list', { limit: 50, onlyUndoable: true })).find((e) => e.action === action && !e.undoneAt);
  if (!entry) throw new Error(`no undoable ${action}`);
  return app.ok('audit:undo', { auditId: entry.id });
}

describe('link reports whether it created the relation', () => {
  it('created is true only for a new relation', () => {
    const a = topicId('A');
    const b = topicId('B');
    expect(graph().link(a, b, 'relates_to', { status: 'proposed' })?.created).toBe(true);
    expect(graph().link(a, b, 'relates_to', { status: 'confirmed' })?.created).toBe(false);
    const rel = relation(a, b, 'relates_to')!;
    graph().setRelationStatus(rel.id, 'rejected');
    const again = graph().link(a, b, 'relates_to', { status: 'confirmed' });
    expect(again?.created).toBe(false);
    expect(again?.status).toBe('rejected');
  });
});

describe('undo only removes relations the action created', () => {
  it('archive → change title → undo keeps the relations from archiving and resets name and search', async () => {
    const id = await importDoc();
    expect((await archive(id)).success).toBe(1);
    const topicRel = relation(id, topicId('Steuern'), 'relates_to')!;
    const projectRel = relation(id, projectId('Hausbau'), 'belongs_to')!;
    expect(topicRel.status).toBe('confirmed');
    expect(projectRel.status).toBe('confirmed');
    const title = (await app.ok('documents:get', { id })).title;

    await app.ok('documents:updateMetadata', { id, title: 'Zwischenablage Quittung', confirmed: true });
    expect(graph().getEntity(id)?.name).toBe('Zwischenablage Quittung');
    expect((await app.ok('search:global', { query: 'Zwischenablage', limit: 10 })).some((h) => h.id === id)).toBe(true);

    expect((await undoLatest('document.updateMetadata')).undone).toBe(true);
    expect(graph().getRelation(topicRel.id)?.status).toBe('confirmed');
    expect(graph().getRelation(projectRel.id)?.status).toBe('confirmed');
    // the title is reset everywhere: document, graph node and search index
    expect((await app.ok('documents:get', { id })).title).toBe(title);
    expect(graph().getEntity(id)?.name).toBe(title);
    expect((await app.ok('search:global', { query: 'Zwischenablage', limit: 10 })).some((h) => h.id === id)).toBe(false);
  });

  it('metadata undo restores the previous confidence of a relation the edit only updated', async () => {
    const id = await importDoc();
    await archive(id);
    const before = relation(id, topicId('Steuern'), 'relates_to')!;
    expect(before.confidence).toBeLessThan(0.9);

    await app.ok('documents:updateMetadata', { id, topic: 'Steuern', confirmed: true });
    expect(graph().getRelation(before.id)?.confidence).toBe(0.9);

    expect((await undoLatest('document.updateMetadata')).undone).toBe(true);
    const after = graph().getRelation(before.id)!;
    expect(after.status).toBe('confirmed');
    expect(after.confidence).toBe(before.confidence);
    expect(after.sourceIds).toEqual(before.sourceIds);
  });

  it('archive undo keeps a relation the user rejected before and removes only the created ones', async () => {
    const id = await importDoc();
    const rejected = graph().link(id, topicId('Steuern'), 'relates_to', { status: 'proposed' })!;
    await app.ok('knowledge:resolveRelation', { relationId: rejected.id, status: 'rejected', confirmed: true });

    expect((await archive(id)).success).toBe(1);
    expect(graph().getRelation(rejected.id)?.status).toBe('rejected');
    const projectRel = relation(id, projectId('Hausbau'), 'belongs_to')!;
    expect(projectRel.status).toBe('confirmed');

    expect((await undoLatest('archive.copy')).undone).toBe(true);
    // the rejection is not forgotten
    expect(graph().getRelation(rejected.id)?.status).toBe('rejected');
    // the relation the archiving created is gone
    expect(graph().getRelation(projectRel.id)).toBeUndefined();
  });

  it('archive undo restores the previous status of a relation the archiving confirmed', async () => {
    const id = await importDoc();
    const proposed = graph().link(id, topicId('Steuern'), 'relates_to', { status: 'proposed', confidence: 0.4 })!;
    await archive(id);
    expect(graph().getRelation(proposed.id)?.status).toBe('confirmed');

    expect((await undoLatest('archive.copy')).undone).toBe(true);
    const back = graph().getRelation(proposed.id)!;
    expect(back.status).toBe('proposed');
    expect(back.confidence).toBe(0.4);
  });

  it('archive undo refuses when the user resolved a relation the archiving created', async () => {
    const id = await importDoc();
    await archive(id);
    const projectRel = relation(id, projectId('Hausbau'), 'belongs_to')!;
    await app.ok('knowledge:resolveRelation', { relationId: projectRel.id, status: 'rejected', confirmed: true });

    const res = await undoLatest('archive.copy');
    expect(res.undone).toBe(false);
    expect(res.conflicts.join(' ')).toContain('Verknüpfung');
    expect(graph().getRelation(projectRel.id)?.status).toBe('rejected');
  });

  it('metadata undo keeps a relation the user rejected before', async () => {
    const id = await importDoc();
    const rejected = graph().link(id, topicId('Planung'), 'relates_to', { status: 'proposed' })!;
    await app.ok('knowledge:resolveRelation', { relationId: rejected.id, status: 'rejected', confirmed: true });

    await app.ok('documents:updateMetadata', { id, topic: 'Planung', confirmed: true });
    expect(graph().getRelation(rejected.id)?.status).toBe('rejected');
    expect((await undoLatest('document.updateMetadata')).undone).toBe(true);
    expect(graph().getRelation(rejected.id)?.status).toBe('rejected');
  });

  it('supersede undo keeps a rejected supersedes relation and removes a created one', async () => {
    app.llm.down = true;
    const mk = (decisionText: string, decidedAt: string) => ({ decisionText, decidedAt, topic: 'Plattform', participants: ['Anna'] });
    const a = await app.ok('decisions:create', mk('Wir bleiben bei Server A.', '2026-01-10'));
    const b = await app.ok('decisions:create', mk('Wir wechseln zu Server B.', '2026-03-01'));
    const c = await app.ok('decisions:create', mk('Wir wechseln zu Server C.', '2026-04-01'));

    // b → a: the user rejected this relation before
    const rejected = graph().link(b.id, a.id, 'supersedes', { status: 'proposed' })!;
    await app.ok('knowledge:resolveRelation', { relationId: rejected.id, status: 'rejected', confirmed: true });
    app.services.decisions.supersede(a.id, b.id, { confirmed: true });
    expect((await undoLatest('decision.supersede')).undone).toBe(true);
    expect(graph().getRelation(rejected.id)?.status).toBe('rejected');
    expect((await app.ok('decisions:get', { id: a.id })).status).not.toBe('superseded');

    // c → b: created by the supersede, removed by its undo
    app.services.decisions.supersede(b.id, c.id, { confirmed: true });
    const created = relation(c.id, b.id, 'supersedes')!;
    expect(created.status).toBe('confirmed');
    expect((await undoLatest('decision.supersede')).undone).toBe(true);
    expect(graph().getRelation(created.id)).toBeUndefined();
  });
});
