import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const entity = (type: 'person' | 'project' | 'tag' | 'topic' | 'case', name: string) => app.services.graph.ensureEntity({ type, name });

describe('Merge suggestion of the Knowledge page (#188)', () => {
  it.each([
    ['person', 'Anna Albers', 'Anne Albers'],
    ['project', 'Umzug', 'Umzug 2026'],
    ['tag', 'Rechnung', 'Rechnungen'],
  ] as const)('proposes, and after the confirmation merges, two %s entries', async (type, sourceName, targetName) => {
    const source = entity(type, sourceName);
    const target = entity(type, targetName);

    const action = await app.ok('knowledge:proposeMerge', { sourceId: source.id, targetId: target.id });
    expect(action.label).toBe(`„${sourceName}“ in „${targetName}“ zusammenführen`);
    expect(app.services.graph.getEntity(source.id)).toBeDefined();

    await app.ok('actions:resolve', { decision: 'approve', actionId: action.id, confirmed: true, strongConfirmed: false });

    expect(app.services.graph.getEntity(source.id)).toBeUndefined();
    expect(app.services.graph.findByNameOrAlias(type, sourceName)!.id).toBe(target.id);
  });

  it('refuses two entries of different kinds and kinds that are not mergeable', async () => {
    const topic = entity('topic', 'Umzug');
    const project = entity('project', 'Umzug 2026');
    const first = entity('case', 'Vorgang A');
    const second = entity('case', 'Vorgang B');

    expect((await app.call('knowledge:proposeMerge', { sourceId: topic.id, targetId: project.id })).ok).toBe(false);
    expect((await app.call('knowledge:proposeMerge', { sourceId: first.id, targetId: second.id })).ok).toBe(false);
    expect((await app.call('knowledge:proposeMerge', { sourceId: topic.id, targetId: topic.id })).ok).toBe(false);
  });
});
