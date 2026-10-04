import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archived } from '../helpers/agent';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
let ids: string[];
beforeEach(async () => {
  app = await createTestApp({ privacy: 'local_only' });
  ids = [
    await archived(app, { name: 'eins.txt', content: 'Erstes Dokument über die Heizungswartung im Haus Musterstraße.', folder: 'Privat/haus' }),
    await archived(app, { name: 'zwei.txt', content: 'Zweites Dokument über die Steuererklärung des vergangenen Jahres.', folder: 'Privat/steuern' }),
  ];
});
afterEach(async () => app.cleanup());

const hits = async (query: string) => (await app.ok('search:global', { query })).map((hit) => hit.id);
const dropFromIndex = (id: string) => app.services.search.remove(id);

describe('Documents missing from the search index (#220)', () => {
  it('detects them and indexes them again in a job', async () => {
    dropFromIndex(ids[1]!);
    expect(await app.ok('documents:indexStatus', {})).toEqual({ documents: 2, missing: 1 });
    expect(await hits('Steuererklärung')).not.toContain(ids[1]);

    const { jobId } = await app.ok('documents:rebuildIndex', {});
    await app.services.jobs.whenIdle();

    expect(app.services.jobs.get(jobId)).toMatchObject({ status: 'succeeded', summary: '1 von 1 Dokumenten indexiert' });
    expect(await app.ok('documents:indexStatus', {})).toEqual({ documents: 2, missing: 0 });
    expect(await hits('Steuererklärung')).toContain(ids[1]);
  });

  it('leaves a complete index alone', async () => {
    const { jobId } = await app.ok('documents:rebuildIndex', {});
    await app.services.jobs.whenIdle();

    expect(app.services.jobs.get(jobId).summary).toBe('0 von 0 Dokumenten indexiert');
  });

  it('starts the re-embedding of everything on demand', async () => {
    const { jobId } = await app.ok('documents:reembed', {});
    await app.services.jobs.whenIdle();

    expect(app.services.jobs.get(jobId)).toMatchObject({ type: 'search.reembed', status: 'succeeded' });
  });
});
