import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { topicNoteClassification } from '../helpers/document-classifications';

let app: TestApp;

beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

interface ArchiveItem {
  documentId: string;
  topic?: string;
  project?: string;
}

describe('scan proposal of a project group', () => {
  it('keeps each document its own topic in the archive action', async () => {
    app.services.settings.update({ scan: { enabled: true } });
    app.llm.on('DocumentClassification', (_schema, input) =>
      topicNoteClassification(input.includes('Kreditvertrag') ? 'Finanzierung' : 'Handwerker', { project: 'Hausbau' }),
    );
    app.file('Downloads/kredit.txt', 'Kreditvertrag für den Hausbau in der Musterstraße 1.');
    app.file('Downloads/fliesen.txt', 'Rechnung des Fliesenlegers für den Hausbau in der Musterstraße 1.');
    await app.ok('scanner:addDirectory', { path: path.join(app.home, 'Downloads'), recursive: true });
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();
    const files = (await app.ok('scanner:getResults', {})).files;
    await app.ok('scanner:analyze', { fileIds: files.map((file) => file.id), confirmLlm: true });
    await app.services.jobs.whenIdle();

    const [group] = await app.ok('scanner:proposals', {});
    expect(group?.project).toBe('Hausbau');
    expect(group?.documentIds).toHaveLength(2);
    const action = (await app.ok('actions:list', { status: 'proposed' })).find((proposed) => proposed.actionType === 'archive_documents');
    const items = (action?.proposedParameters.items ?? []) as ArchiveItem[];
    const docs = await app.ok('documents:list', {});
    const topicOf = (name: string) => items.find((item) => docs.find((doc) => doc.id === item.documentId)?.originalName === name)?.topic;
    expect(topicOf('kredit.txt')).toBe('Finanzierung');
    expect(topicOf('fliesen.txt')).toBe('Handwerker');
    expect(items.every((item) => item.project === 'Hausbau')).toBe(true);
  });
});
