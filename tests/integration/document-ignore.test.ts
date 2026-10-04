import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { documents } from '../../packages/core/src/db/schema';
import { agentApp, archived, inInbox } from '../helpers/agent';
import { classification } from '../helpers/document-classifications';
import type { TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

const row = (id: string) => app.services.documents.findRow(id)!;

describe('ignoring a document (#232)', () => {
  it('undo restores the previous status and archive mode', async () => {
    const id = await inInbox(app, { name: 'Werbung.txt', content: 'Werbung Pizza' });
    const before = { status: row(id).status, archiveMode: row(id).archiveMode };

    const { document, auditId } = await app.ok('documents:ignore', { id });
    expect(document.status).toBe('ignored');
    expect(row(id).archiveMode).toBe('ignore');
    expect(app.services.audit.list({ entityId: id })[0]).toMatchObject({ action: 'document.ignore', undoable: true });

    const result = await app.ok('audit:undo', { auditId });

    expect(result).toMatchObject({ undone: true, conflicts: [] });
    expect({ status: row(id).status, archiveMode: row(id).archiveMode }).toEqual(before);
  });

  it('refuses the undo when the document changed meanwhile', async () => {
    const id = await inInbox(app, { name: 'Flyer.txt', content: 'Flyer Rabatt' });
    const { auditId } = await app.ok('documents:ignore', { id });
    app.services.ctx.database.db.update(documents).set({ updatedAt: '2099-01-01T00:00:00.000Z' }).where(eq(documents.id, id)).run();

    const result = await app.ok('audit:undo', { auditId });

    expect(result.undone).toBe(false);
    expect(row(id).status).toBe('ignored');
  });

  it('takes an ignored document back via documents:unignore', async () => {
    const id = await inInbox(app, { name: 'Notiz Test.txt', content: 'Notiz Test' });
    const previous = row(id).status;
    await app.ok('documents:ignore', { id });

    const restored = await app.ok('documents:unignore', { id });

    expect(restored.status).toBe(previous);
    expect(row(id).archiveMode).not.toBe('ignore');
  });

  it('takes a document back that the scanner ignored (no undo entry)', async () => {
    const id = await inInbox(app, { name: 'Scan Rest.txt', content: 'Scan Rest' });
    app.services.ctx.database.db.update(documents).set({ status: 'ignored' }).where(eq(documents.id, id)).run();

    const restored = await app.ok('documents:unignore', { id });

    expect(['staged', 'proposed']).toContain(restored.status);
  });

  it('takes an ignored document back with a logged, undoable restore when it changed after ignoring', async () => {
    const id = await inInbox(app, { name: 'Geändert.txt', content: 'Geändert Test' });
    await app.ok('documents:ignore', { id });
    app.services.ctx.database.db.update(documents).set({ updatedAt: '2099-01-01T00:00:00.000Z' }).where(eq(documents.id, id)).run();

    const restored = await app.ok('documents:unignore', { id });

    expect(['staged', 'proposed']).toContain(restored.status);
    expect(app.services.audit.list({ entityId: id })[0]).toMatchObject({ action: 'document.unignore', undoable: true });
  });

  it('refuses to ignore an archived or to take back a not ignored document', async () => {
    const archivedId = await archived(app, { name: 'Alt.txt', content: 'Alt Dokument', folder: 'Privat/alt' });
    const inboxId = await inInbox(app, { name: 'Neu.txt', content: 'Neu Dokument' });

    expect((await app.call('documents:ignore', { id: archivedId })).ok).toBe(false);
    expect((await app.call('documents:unignore', { id: inboxId })).ok).toBe(false);
  });

  it('leaves a document ignored while its analysis was queued untouched', async () => {
    const id = await inInbox(app, { name: 'Import 40.txt', content: 'Import Rechnung' });
    const { auditId } = await app.ok('documents:ignore', { id });
    const classifications = () => app.llm.calls.filter((c) => c.schema === 'DocumentClassification').length;
    const callsBefore = classifications();

    const result = await app.services.documents.analyze(id, { allowLlm: true });

    expect(result.skipped).toBe(true);
    expect(row(id).status).toBe('ignored');
    expect(classifications()).toBe(callsBefore);
    expect((await app.ok('audit:undo', { auditId })).undone).toBe(true);
  });

  describe('a document whose queued analysis was skipped while ignored', () => {
    const classifications = () => app.llm.calls.filter((c) => c.schema === 'DocumentClassification').length;
    beforeEach(() => {
      app.llm.on('DocumentClassification', () =>
        classification({ title: 'Rechnung', summary: 'Rechnung', categoryPath: 'Privat/eingang', docType: 'Rechnung' }),
      );
    });

    async function ignoredWhileQueued(): Promise<{ id: string; auditId: string }> {
      await app.services.jobs.stop();
      const result = await app.ok('documents:import', { paths: [app.file('in/ofen/Rechnung Ofen.txt', 'Rechnung Ofen 120 Euro')] });
      const id = result.imported[0]!.id;
      const { auditId } = await app.ok('documents:ignore', { id });
      app.services.jobs.start();
      await app.services.jobs.whenIdle();
      expect(row(id).status).toBe('ignored');
      return { id, auditId };
    }

    it('is analysed again after "Wieder aufnehmen"', async () => {
      const { id } = await ignoredWhileQueued();

      await app.ok('documents:unignore', { id });
      await app.services.jobs.whenIdle();

      expect(row(id).status).toBe('proposed');
      expect(classifications()).toBe(1);
    });

    it('is analysed again after undoing the ignore', async () => {
      const { id, auditId } = await ignoredWhileQueued();

      expect((await app.ok('audit:undo', { auditId })).undone).toBe(true);
      await app.services.jobs.whenIdle();

      expect(row(id).status).toBe('proposed');
      expect(classifications()).toBe(1);
    });

    it('is analysed once when taken back before its queued analysis ran', async () => {
      await app.services.jobs.stop();
      const result = await app.ok('documents:import', { paths: [app.file('in/heizung/Heizung.txt', 'Heizung Wartung')] });
      const id = result.imported[0]!.id;
      await app.ok('documents:ignore', { id });
      await app.ok('documents:unignore', { id });

      app.services.jobs.start();
      await app.services.jobs.whenIdle();

      expect(row(id).status).toBe('proposed');
      expect(app.services.jobs.list().filter((job) => job.type === 'document.analyze')).toHaveLength(1);
    });

    it('is left to its import batch when taken back before the batch ran', async () => {
      await app.services.jobs.stop();
      const paths = [app.file('in/batch/Strom.txt', 'Strom Abschlag'), app.file('in/batch/Wasser.txt', 'Wasser Abschlag')];
      const id = (await app.ok('documents:import', { paths })).imported[0]!.id;
      await app.ok('documents:ignore', { id });
      await app.ok('documents:unignore', { id });

      app.services.jobs.start();
      await app.services.jobs.whenIdle();

      expect(row(id).status).toBe('proposed');
      expect(app.services.jobs.list().filter((job) => job.type === 'document.analyze')).toHaveLength(0);
    });
  });
});
