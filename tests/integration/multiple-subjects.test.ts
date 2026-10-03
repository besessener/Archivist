import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, createTestApp, type TestApp } from '../helpers/harness';
import { archived } from '../helpers/agent';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const lastAudit = async (action: string) => (await app.ok('audit:list', {})).find((e) => e.action === action)!;
const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name).toSorted();

describe('Several topics and projects per entry (#287)', () => {
  it('further topics and projects beside the main one; lists and filters find the entry under each; one undo step', async () => {
    app = await createTestApp();
    const d = await app.ok('decisions:create', { decisionText: 'Wir nehmen die Wärmepumpe.', topic: 'Heizung', asDraft: false, sourceIds: [] });
    const item = await app.ok('openItems:create', { title: 'Förderung beantragen', topic: 'Heizung' });
    const ev = await app.ok('events:create', { title: 'Beratung Energie', occurredAt: '2026-09-01T10:00:00.000Z', topic: 'Heizung' });
    const doc = await archived(app, { name: 'angebot.md', content: 'Angebot Wärmepumpe', folder: 'private/haus', topic: 'Heizung' });

    for (const id of [d.id, item.id, ev.id, doc]) await app.ok('subjects:setExtras', { id, topics: ['Förderung', 'Heizung'], projects: ['Sanierung 2026'] });
    const s = (await app.ok('subjects:of', { ids: [d.id] }))[d.id]!;
    expect(s.topic?.name).toBe('Heizung');
    // the main topic is never a further one
    expect(names(s.extraTopics)).toEqual(['Förderung']);
    expect(names(s.extraProjects)).toEqual(['Sanierung 2026']);

    const foerderung = app.services.graph.findByName('topic', 'Förderung')!.id;
    const sanierung = app.services.graph.findByName('project', 'Sanierung 2026')!.id;
    expect((await app.ok('decisions:list', { topicId: foerderung })).map((x) => x.id)).toEqual([d.id]);
    expect((await app.ok('decisions:list', { projectId: sanierung })).map((x) => x.id)).toEqual([d.id]);
    expect((await app.ok('openItems:list', { topicId: foerderung })).map((x) => x.id)).toEqual([item.id]);
    expect((await app.ok('events:list', { topicId: foerderung })).map((x) => x.id)).toEqual([ev.id]);
    expect((await app.ok('documents:list', { topicId: foerderung })).map((x) => x.id)).toEqual([doc]);
    expect((await app.ok('documents:forTopic', { topicId: sanierung })).map((x) => x.id)).toEqual([doc]);
    // the main topic still lists all of them, the archive folder follows it
    expect((await app.ok('documents:get', { id: doc })).topicName).toBe('Heizung');

    // removing one is one undo step
    await app.ok('subjects:setExtras', { id: d.id, topics: [], projects: [] });
    expect((await app.ok('subjects:of', { ids: [d.id] }))[d.id]).toMatchObject({ extraTopics: [], extraProjects: [] });
    await app.ok('audit:undo', { auditId: (await lastAudit('subjects.update')).id });
    expect(names((await app.ok('subjects:of', { ids: [d.id] }))[d.id]!.extraTopics)).toEqual(['Förderung']);
  });

  it('changing the main topic keeps the further ones; merging a further topic re-points it; the archive check counts it as assigned', async () => {
    app = await createTestApp();
    const item = await app.ok('openItems:create', { title: 'Dach prüfen', topic: 'Haus' });
    await app.ok('subjects:setExtras', { id: item.id, topics: ['Garten'] });
    await app.ok('openItems:update', { id: item.id, patch: { topic: 'Dach' } });
    let s = (await app.ok('subjects:of', { ids: [item.id] }))[item.id]!;
    expect(s.topic?.name).toBe('Dach');
    expect(names(s.extraTopics)).toEqual(['Garten']);

    const garten = app.services.graph.findByName('topic', 'Garten')!;
    const aussen = (await app.ok('knowledge:createEntity', { type: 'topic', name: 'Außenanlage' })).entity;
    const merged = await app.services.graph.merge({ sourceIds: [garten.id], targetId: aussen.id });
    s = (await app.ok('subjects:of', { ids: [item.id] }))[item.id]!;
    expect(names(s.extraTopics)).toEqual(['Außenanlage']);
    await app.ok('audit:undo', { auditId: merged.auditId });
    expect(names((await app.ok('subjects:of', { ids: [item.id] }))[item.id]!.extraTopics)).toEqual(['Garten']);

    const doc = await archived(app, { name: 'brief.md', content: 'Ein Brief', folder: 'private/post' });
    let report = await app.services.consistency.run({ trigger: 'test' });
    expect(report.byKind.orphan_document).toBe(1);
    await app.ok('subjects:setExtras', { id: doc, projects: ['Post'] });
    report = await app.services.consistency.run({ trigger: 'test' });
    expect(report.byKind.orphan_document).toBeUndefined();
  });

  it('the migration gives every main topic/project its relation', async () => {
    app = await createTestApp();
    const item = await app.ok('openItems:create', { title: 'Alt', topic: 'Altes Thema' });
    const db = app.services.database.sqlite;
    db.prepare(`DELETE FROM relations WHERE source_entity_id = ?`).run(item.id);
    const sql = fs.readFileSync(path.join(MIGRATIONS, '0023_subject_assignments.sql'), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) db.exec(stmt);
    const topicId = app.services.graph.findByName('topic', 'Altes Thema')!.id;
    expect(app.services.graph.relationsOf(item.id)).toEqual([
      expect.objectContaining({ targetEntityId: topicId, relationType: 'relates_to', status: 'confirmed', method: 'field' }),
    ]);
    // running it again adds nothing
    for (const stmt of sql.split('--> statement-breakpoint')) db.exec(stmt);
    expect(app.services.graph.relationsOf(item.id)).toHaveLength(1);
  });
});
