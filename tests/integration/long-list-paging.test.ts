import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto', scanEnabled: true });
  app.llm.on('DocumentClassification', () => classification({ title: 'Notiz', summary: 'Eine Notiz.', categoryPath: 'private/notizen' }));
});
afterEach(async () => app.cleanup());

describe('Long lists are paged, not cut off (#228)', () => {
  it('pages through all inbox documents without gaps or repeats', async () => {
    for (let n = 1; n <= 7; n += 1)
      app.services.documents.insertDocument({
        originalName: `d${n}.txt`,
        ext: 'txt',
        size: 1,
        sha256: String(n).repeat(64).slice(0, 64),
        sourcePath: null,
        stagedPath: `/x/d${n}.txt`,
      });

    const first = await app.ok('documents:list', { statuses: ['staged'], limit: 3, offset: 0 });
    const second = await app.ok('documents:list', { statuses: ['staged'], limit: 3, offset: 3 });
    const third = await app.ok('documents:list', { statuses: ['staged'], limit: 3, offset: 6 });

    const ids = [...first, ...second, ...third].map((document) => document.id);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect(await app.ok('documents:count', { statuses: ['staged'] })).toBe(7);
  });

  it('pages through all scan results and tells the total', async () => {
    for (let n = 1; n <= 5; n += 1) app.file(`Downloads/datei${n}.txt`, `Datei ${n} mit ausreichend Text für die Analyse.`);
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();

    const first = await app.ok('scanner:getResults', { limit: 2 });
    const rest = await app.ok('scanner:getResults', { limit: 2, offset: 2 });
    const last = await app.ok('scanner:getResults', { limit: 2, offset: 4 });

    expect(first.total).toBe(5);
    expect([...first.files, ...rest.files, ...last.files].map((file) => file.id)).toHaveLength(5);
    expect(new Set([...first.files, ...rest.files, ...last.files].map((file) => file.id)).size).toBe(5);
  });

  it('loads older notifications beyond the first page', async () => {
    for (let n = 1; n <= 5; n += 1) app.services.notifications.create({ title: `Meldung ${n}`, description: 'x', type: 'system' });

    const newest = await app.ok('notifications:list', { limit: 2 });
    const older = await app.ok('notifications:list', { limit: 2, offset: 2 });
    const oldest = await app.ok('notifications:list', { limit: 2, offset: 4 });

    expect([...newest, ...older, ...oldest].map((notification) => notification.id)).toHaveLength(5);
    expect(new Set([...newest, ...older, ...oldest].map((notification) => notification.id)).size).toBe(5);
  });
});

describe('Files already analysed are skipped unless „erneut analysieren“ is chosen (ING-09)', () => {
  it('does not pay for them again, and analyses them again on request', async () => {
    app.file('Downloads/a.txt', 'Eine Datei mit ausreichend Text für die Analyse.');
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();
    const [file] = app.services.scanner.getResults({}).files;
    await app.ok('scanner:analyze', { fileIds: [file!.id], confirmLlm: true });
    await app.services.jobs.whenIdle();
    const calls = () => app.llm.calls.filter((call) => call.schema === 'DocumentClassification').length;
    expect(calls()).toBe(1);

    await app.ok('scanner:analyze', { fileIds: [file!.id], confirmLlm: true });
    await app.services.jobs.whenIdle();
    expect(calls()).toBe(1);

    await app.ok('scanner:analyze', { fileIds: [file!.id], confirmLlm: true, reanalyze: true });
    await app.services.jobs.whenIdle();
    expect(calls()).toBe(2);
  });
});
