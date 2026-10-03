import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archived } from '../helpers/agent';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'local_only' });
});
afterEach(async () => app.cleanup());

const TEXT = 'Rechnung Nr. 4711 über die Wartung der Heizungsanlage im Haus Musterstraße 1, fällig in vier Wochen. '.repeat(4);

async function twoCopies(): Promise<[string, string]> {
  const a = await archived(app, { name: 'a.txt', content: TEXT, folder: 'private/rechnungen' });
  const b = await archived(app, { name: 'b.txt', content: `${TEXT} `, folder: 'private/rechnungen' });
  return [a, b];
}

const duplicateInsights = async () => (await app.ok('insights:list', {})).filter((i) => i.kind === 'duplicate');

describe('Archive check duplicate groups', () => {
  it('proposes documents with the same text as duplicates', async () => {
    await twoCopies();
    await app.services.consistency.run();
    expect(await duplicateInsights()).toHaveLength(1);
  });

  it('does not propose a pair the user marked as different', async () => {
    const [a, b] = await twoCopies();
    const relation = app.services.graph.link({ sourceId: b, targetId: a, relationType: 'duplicate_of' }, { status: 'proposed', method: 'analysis' })!;
    app.services.graph.decideRelation(relation.id, { status: 'rejected' });

    await app.services.consistency.run();

    expect(await duplicateInsights()).toHaveLength(0);
  });
});
