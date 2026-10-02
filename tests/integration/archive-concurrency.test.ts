import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, inInbox } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

const filesIn = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    : [];

/** Makes the next audit entry with `action` fail, as a database error would. */
function failNextAudit(action: string): void {
  const audit = app.services.audit;
  const original = audit.log.bind(audit);
  let failed = false;
  audit.log = (entry: Parameters<typeof original>[0]) => {
    if (!failed && entry.action === action) {
      failed = true;
      throw new Error('database is locked');
    }
    return original(entry);
  };
}

describe('File operations on the same document at the same time (#240)', () => {
  it('two archive requests for one document: one archives, the other reports a conflict – no orphan copy', async () => {
    const id = await inInbox(app, { name: 'brief.txt', content: 'Ein Brief' });
    const request = () =>
      app.services.archive.execute([{ documentId: id, mode: 'copy', categoryPath: 'private/post' }], {
        confirmed: true,
        approveNewCategories: [],
        confirmMove: false,
        trigger: 'agent',
      });
    const [first, second] = await Promise.all([request(), request()]);
    const outcomes = [first.items[0]!.outcome, second.items[0]!.outcome].toSorted();
    expect(outcomes).toEqual(['conflict', 'success']);
    const root = app.services.settings.get().archiveRoot;
    expect(filesIn(path.join(root, 'private', 'post'))).toHaveLength(1);
    expect(app.services.documents.getRow(id).status).toBe('archived');
  });
});

describe('Database and file system stay in step (#221, #238)', () => {
  it('rename: if the database refuses, the file goes back to its old name', async () => {
    const id = await archived(app, { name: 'scan001.txt', content: 'Rechnung', folder: 'private/post' });
    const before = app.services.documents.getRow(id).archiveRelPath!;
    failNextAudit('archive.rename');
    const res = await app.services.archive.rename([{ documentId: id, fileName: 'Rechnung Stadtwerke' }], { confirmed: true, trigger: 'agent' });
    expect(res.items[0]!.outcome).toBe('failed');
    const root = app.services.settings.get().archiveRoot;
    expect(app.services.documents.getRow(id).archiveRelPath).toBe(before);
    expect(fs.existsSync(path.join(root, ...before.split('/')))).toBe(true);
    expect(filesIn(path.join(root, 'private', 'post'))).toEqual([path.posix.basename(before)]);
  });

  it('undo of a rename: if the database refuses, the file stays where the database points – and the undo can be retried', async () => {
    const id = await archived(app, { name: 'scan002.txt', content: 'Rechnung', folder: 'private/post' });
    const res = await app.services.archive.rename([{ documentId: id, fileName: 'Rechnung Wasser' }], { confirmed: true, trigger: 'agent' });
    const renamed = app.services.documents.getRow(id).archiveRelPath!;
    const root = app.services.settings.get().archiveRoot;
    const undo = (auditId: string) => app.services.undo.undo(auditId);
    // the database update of the undo fails once
    const { database } = app.services.ctx;
    const tx = database.transaction.bind(database);
    let failed = false;
    database.transaction = <T>(fn: () => T): T => {
      if (!failed) {
        failed = true;
        throw new Error('database is locked');
      }
      return tx(fn);
    };
    await expect(undo(res.items[0]!.auditId!)).rejects.toThrow();
    expect(app.services.documents.getRow(id).archiveRelPath).toBe(renamed);
    expect(fs.existsSync(path.join(root, ...renamed.split('/')))).toBe(true);
    const retry = await undo(res.items[0]!.auditId!);
    expect(retry.undone).toBe(true);
    expect(app.services.documents.getRow(id).archiveRelPath).not.toBe(renamed);
  });
});
