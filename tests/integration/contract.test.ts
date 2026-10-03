import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '@archivist/shared';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp({ privacy: 'auto', scanEnabled: true });
  app.llm.on('DocumentClassification', () => ({
    docType: 'Protokoll',
    title: 'Jour Fixe',
    summary: 'Zusammenfassung',
    mainTopic: 'Nordlicht',
    project: 'Nordlicht',
    persons: ['Anna'],
    dates: [{ date: '2026-05-04', label: null }],
    tags: ['jf'],
    location: { categoryPath: 'Arbeit/meetings/2026', fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.8 },
    decisions: [{ title: 'Pause', decisionText: 'Nordlicht wird pausiert.', decidedAt: '2026-05-04', participants: [] }],
    openItems: [{ title: 'Budget klären', description: 'Budget muss noch geklärt werden', dueAt: null }],
    confidence: 0.8,
    rationale: 'x',
  }));
  app.llm.on('ChatIntent', () => ({ intent: 'knowledge_question', confidence: 0.9, query: 'Nordlicht' }));
  app.llm.on('KnowledgeAnswer', () => ({ answer: 'Antwort', facts: [{ statement: 'Fakt', sourceIds: ['S1'] }], confidence: 0.7 }));

  const doc = app.file('Downloads/protokoll.txt', 'Jour Fixe Nordlicht am 04.05.2026. Das Budget muss noch geklärt werden. Nordlicht wird pausiert.');
  const imp = await app.ok('documents:import', { paths: [doc] });
  await app.services.jobs.whenIdle();
  await app.ok('documents:archive', {
    items: [{ documentId: imp.imported[0]!.id, mode: 'copy' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  });
  for (const [text, date] of [
    ['Wir führen Nordlicht weiter.', '2026-01-01'],
    ['Nordlicht wird pausiert.', '2026-05-04'],
  ] as const) {
    await app.ok('decisions:create', {
      decisionText: text,
      title: text,
      topic: 'Nordlicht',
      decidedAt: date,
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: false,
    });
  }
  await app.ok('decisions:create', {
    decisionText: 'Unvollständig',
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    participants: [],
    confidence: 0.5,
    asDraft: true,
  });
  const item = await app.ok('openItems:create', { title: 'Offener Punkt', dueAt: '2020-01-01', priority: 'high', sourceIds: [], confidence: 0.9 });
  await app.ok('reminders:create', { targetType: 'open_item', targetId: item.id, title: 'Erinnerung', remindAt: '2030-01-01' });
  await app.ok('chat:send', { text: 'Was war mit Nordlicht?' });
  await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
  await app.ok('scanner:start', {});
  await app.services.jobs.whenIdle();
  await app.ok('consistency:run', {});
  await app.services.jobs.whenIdle();
  await app.ok('backup:create', { includeArchive: false });
});
afterAll(() => app.cleanup());

describe('IPC contract: outputs from real data match the schemas', () => {
  it('all read channels answer schema-conformant', async () => {
    const topic = (await app.ok('knowledge:listEntities', { type: 'topic' }))[0]!;
    const decision = (await app.ok('decisions:list', {}))[0]!;
    const doc = (await app.ok('documents:list', {}))[0]!;
    const conv = (await app.ok('chat:conversations', {}))[0]!;
    const action = (await app.ok('actions:list', {}))[0]!;
    const calls: Array<[string, unknown]> = [
      ['app:getStatus', {}],
      ['settings:get', {}],
      ['llm:transmissions', {}],
      ['chat:history', { conversationId: conv.id }],
      ['chat:conversations', {}],
      ['actions:list', {}],
      ['actions:get', { id: action.id }],
      ['decisions:list', {}],
      ['decisions:get', { id: decision.id }],
      ['decisions:search', { query: 'Nordlicht' }],
      ['documents:list', {}],
      ['documents:get', { id: doc.id }],
      ['documents:forTopic', { topicId: topic.id }],
      ['scanner:listDirectories', {}],
      ['scanner:getResults', {}],
      ['scanner:proposals', {}],
      ['scanner:listExclusions', {}],
      ['jobs:list', {}],
      ['notifications:list', {}],
      ['insights:list', {}],
      ['contradictions:list', {}],
      ['reminders:list', {}],
      ['openItems:list', {}],
      ['knowledge:listEntities', {}],
      ['knowledge:getEntity', { id: topic.id }],
      ['timeline:get', {}],
      ['timeline:get', { topicId: topic.id }],
      ['search:global', { query: 'Nordlicht' }],
      ['audit:list', {}],
      ['categories:list', {}],
      ['backup:list', {}],
      ['archive:verify', {}],
    ];
    for (const [channel, input] of calls) {
      const r = await app.dispatch(channel, input);
      expect(r.ok, `${channel}: ${!r.ok ? `${r.error.message} ${r.error.details ?? ''}` : ''}`).toBe(true);
    }
    expect(calls.length).toBeGreaterThan(25);
    expect(IPC_CHANNELS.length).toBeGreaterThan(calls.length);
  });

  it('the sample data contains the expected objects (no empty fake success)', async () => {
    expect((await app.ok('timeline:get', {})).length).toBeGreaterThan(4);
    expect((await app.ok('contradictions:list', {})).length).toBeGreaterThanOrEqual(1);
    expect((await app.ok('insights:list', {})).length).toBeGreaterThan(1);
    // „Nordlicht“ is both a topic and a project: a question insight with answer options
    expect((await app.ok('insights:list', {})).find((i) => i.kind === 'topic_project_name')?.choices).toHaveLength(3);
    expect((await app.ok('notifications:list', {})).length).toBeGreaterThan(3);
    expect((await app.ok('knowledge:listEntities', { type: 'document' })).length).toBe(1);
    const t = (await app.ok('timeline:get', {})).filter((e) => e.kind === 'decision');
    expect(t.every((e) => e.refs.length > 0 && e.year >= 2026)).toBe(true);
    const entity = await app.ok('knowledge:getEntity', { id: (await app.ok('knowledge:listEntities', { type: 'topic' }))[0]!.id });
    expect(entity.relations.length).toBeGreaterThan(0);
  });
});
