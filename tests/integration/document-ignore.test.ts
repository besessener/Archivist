import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { documents } from '../../packages/core/src/db/schema';
import { agentApp, archived, inInbox } from '../helpers/agent';
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
});
