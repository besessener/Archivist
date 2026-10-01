import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'local_only' });
});
afterEach(async () => {
  await app.cleanup();
});

/** Imports a file whose content does not match its extension and returns the quarantined document. */
async function quarantineOne(name = 'rechnung.pdf', content = 'MZ\x90 das ist keine pdf') {
  const src = app.file(`in/${name}`, content);
  const res = await app.ok('documents:import', { paths: [src] });
  expect(res.imported).toHaveLength(0);
  expect(res.rejected).toHaveLength(1);
  expect(res.rejected[0]!.reason).toMatch(/Quarantäne/);
  const docs = await app.ok('documents:list', { status: 'quarantined' });
  expect(docs).toHaveLength(1);
  return { src, doc: docs[0]! };
}

describe('quarantine in the inbox', () => {
  it('records a quarantined file as a document with a visible reason and does not analyse it', async () => {
    const { src, doc } = await quarantineOne();
    expect(doc.status).toBe('quarantined');
    expect(doc.originalName).toBe('rechnung.pdf');
    expect(doc.sourcePath).toBe(fs.realpathSync(src));
    expect(doc.processingError).toBe('Der Dateiinhalt passt nicht zur Endung „.pdf“.');
    expect(doc.stagedPath && path.dirname(doc.stagedPath)).toBe(app.services.paths.quarantine);
    expect(fs.existsSync(doc.stagedPath!)).toBe(true);
    // the original stays untouched
    expect(fs.existsSync(src)).toBe(true);

    await app.services.jobs.whenIdle();
    expect((await app.ok('documents:get', { id: doc.id })).status).toBe('quarantined');
    expect(app.services.jobs.list().filter((j) => j.type === 'document.analyze')).toHaveLength(0);

    const notes = app.services.notifications.list({}).filter((n) => n.title === 'Datei in Quarantäne');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.description).toContain('rechnung.pdf');
  });

  it('quarantines the same content only once', async () => {
    const { src, doc } = await quarantineOne();
    const again = await app.ok('documents:import', { paths: [src] });
    expect(again.rejected).toHaveLength(1);
    const docs = await app.ok('documents:list', { status: 'quarantined' });
    expect(docs.map((d) => d.id)).toEqual([doc.id]);
    expect(fs.readdirSync(app.services.paths.quarantine)).toHaveLength(1);
  });

  it('reveals the quarantine folder but never opens the suspicious file', async () => {
    const { doc } = await quarantineOne();
    const open = await app.call('app:openPath', { documentId: doc.id });
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.error.message).toMatch(/Quarantäne/);
    await app.ok('app:revealPath', { documentId: doc.id });
    expect(app.host.opened).toEqual([doc.stagedPath]);
  });

  it('refuses analysis and archiving while the file is quarantined', async () => {
    const { doc } = await quarantineOne();
    const cls = await app.call('documents:classify', { documentId: doc.id, allowLlm: false });
    expect(cls.ok).toBe(false);
    if (!cls.ok) expect(cls.error.message).toMatch(/Trotzdem importieren/);
    const plan = await app.ok('documents:previewArchive', { items: [{ documentId: doc.id, mode: 'copy', categoryPath: 'Privat/Test' }] });
    expect(plan.items[0]!.blocked).toBe(true);
    expect(plan.items[0]!.conflicts.join(' ')).toMatch(/Quarantäne/);
  });

  it('"import anyway" requires confirmation, moves the file to the inbox and queues the analysis', async () => {
    const { doc } = await quarantineOne();
    const unconfirmed = await app.call('documents:releaseQuarantine', { id: doc.id, confirmed: false } as never);
    expect(unconfirmed.ok).toBe(false);
    expect((await app.ok('documents:get', { id: doc.id })).status).toBe('quarantined');

    const released = await app.ok('documents:releaseQuarantine', { id: doc.id, confirmed: true });
    expect(['staged', 'analyzing']).toContain(released.status);
    expect(released.processingError).toBeNull();
    expect(path.dirname(released.stagedPath!)).toBe(app.services.paths.inbox);
    expect(fs.existsSync(released.stagedPath!)).toBe(true);
    expect(fs.existsSync(doc.stagedPath!)).toBe(false);

    await app.services.jobs.whenIdle();
    const after = await app.ok('documents:get', { id: doc.id });
    expect(after.status).toBe('proposed');
    // the content is still no real PDF – the parser reports that visibly, the document stays in the inbox
    expect(after.processingStatus).toBe('failed');

    const audit = app.services.audit.list(50).find((a) => a.action === 'document.releaseQuarantine');
    expect(audit?.confirmed).toBe(true);

    const twice = await app.call('documents:releaseQuarantine', { id: doc.id, confirmed: true });
    expect(twice.ok).toBe(false);
  });

  it('refuses "import anyway" when the quarantined copy changed or vanished', async () => {
    const { doc } = await quarantineOne();
    fs.writeFileSync(doc.stagedPath!, 'MZ verändert');
    const changed = await app.call('documents:releaseQuarantine', { id: doc.id, confirmed: true });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.message).toMatch(/verändert/);

    fs.unlinkSync(doc.stagedPath!);
    const missing = await app.call('documents:releaseQuarantine', { id: doc.id, confirmed: true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toMatch(/nicht mehr vorhanden/);
    expect((await app.ok('documents:get', { id: doc.id })).status).toBe('quarantined');
    expect(fs.readdirSync(app.services.paths.inbox)).toHaveLength(0);
  });
});
