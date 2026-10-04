import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

// Document update, graph node and notice of an analysis are written together (#221).

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('DocumentClassification', () => classification({ title: 'Quittung', summary: 'Zusammenfassung', categoryPath: 'Privat/belege', mainTopic: null }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

const classifiedNotices = () => app.services.notifications.list().filter((n) => n.type === 'classification_ready');

describe('Analysis result is stored atomically', () => {
  it('a failing graph registration leaves neither the proposal nor the notice behind', async () => {
    const register = app.services.graph.registerNode.bind(app.services.graph);
    let calls = 0;
    vi.spyOn(app.services.graph, 'registerNode').mockImplementation((node) => {
      calls += 1;
      if (calls > 1) throw new Error('SQLITE_IOERR: disk I/O error'); // the first call is the import itself
      return register(node);
    });

    const imp = await app.ok('documents:import', { paths: [app.file('in/quittung.txt', 'Quittung über 12 Euro')] });
    await app.services.jobs.whenIdle();

    const row = app.services.documents.getRow(imp.imported[0]!.id);
    expect(row.status).not.toBe('proposed');
    expect(row.proposal).toBeNull();
    expect(classifiedNotices()).toEqual([]);
  });

  it('a successful analysis stores proposal, graph node and notice', async () => {
    const imp = await app.ok('documents:import', { paths: [app.file('in/quittung.txt', 'Quittung über 12 Euro')] });
    await app.services.jobs.whenIdle();

    const id = imp.imported[0]!.id;
    expect(app.services.documents.getRow(id).status).toBe('proposed');
    expect(app.services.graph.getEntity(id)).toBeTruthy();
    expect(classifiedNotices()).toHaveLength(1);
  });
});
