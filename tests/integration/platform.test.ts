import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IPC_CHANNELS, ipcContract, Settings } from '@archivist/shared';
import { createServices } from '../../packages/core/src';
import { DatabaseService } from '../../packages/core/src/db/database';
import { WorkerPool } from '../../packages/core/src/workers/pool';
import { Logger } from '../../packages/core/src/util/logger';
import { makePdf } from '../helpers/fixtures';
import { createTestApp, MIGRATIONS, TestCipher } from '../helpers/harness';

describe('Datenbankmigrationen', () => {
  it('legt das Schema inkl. FTS5 an, ist idempotent und meldet den Stand', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-mig-'));
    const log = new Logger(null);
    const db = new DatabaseService(path.join(dir, 'database', 'archivist.db'), log);
    const s1 = db.migrate(MIGRATIONS);
    expect(s1.upToDate).toBe(true);
    expect(s1.applied).toBe(s1.total);
    expect(s1.total).toBeGreaterThanOrEqual(2);
    const tables = (db.sqlite.prepare("select name from sqlite_master where type in ('table') ").all() as { name: string }[]).map((t) => t.name);
    for (const t of [
      'entities',
      'relations',
      'documents',
      'decisions',
      'open_items',
      'reminders',
      'notifications',
      'insights',
      'contradictions',
      'jobs',
      'audit_log',
      'scan_roots',
      'scan_files',
      'scan_exclusions',
      'categories',
      'chunks',
      'search_fts',
      'llm_transmissions',
      'agent_actions',
      'conversations',
      'messages',
    ])
      expect(tables).toContain(t);
    const s2 = db.migrate(MIGRATIONS);
    expect(s2.applied).toBe(s1.applied);
    // WAL + Foreign Keys + konsistentes Backup über die SQLite-Backup-API
    expect(db.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    db.sqlite.prepare("insert into categories (id, path, approved, created_at) values ('1','test',1,'now')").run();
    return db.backupTo(path.join(dir, 'backup.db')).then(() => {
      const copy = new Database(path.join(dir, 'backup.db'), { readonly: true });
      expect((copy.prepare('select count(*) c from categories').get() as { c: number }).c).toBe(1);
      copy.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  it('scheitert verständlich bei defekten Migrationen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-mig-bad-'));
    const db = new DatabaseService(path.join(dir, 'a.db'), new Logger(null));
    expect(() => db.migrate(path.join(dir, 'gibt-es-nicht'))).toThrow(/Datenbankmigration/);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Persistente Job-Queue', () => {
  it('setzt unterbrochene Jobs nach einem Neustart fort und kennt Wiederholen/Abbrechen', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-jobs-'));
    const make = () =>
      createServices({ dataRoot: path.join(root, 'A'), migrationsFolder: MIGRATIONS, cipher: new TestCipher(), jobConcurrency: 1, llmRetryDelayMs: 0 });

    const s1 = make();
    const job = s1.jobs.enqueue('test.echo', 'Echo', { n: 7 }); // Queue nicht gestartet → bleibt pending
    const waiting = s1.jobs.enqueue('test.echo', 'Wartend', { n: 8 });
    s1.database.sqlite.prepare("update jobs set status='running' where id=?").run(job.id); // Absturz simulieren
    await s1.shutdown();

    const s2 = make();
    const seen: number[] = [];
    s2.jobs.register<{ n: number }>('test.echo', async (j) => {
      j.report(0.5, 'halb');
      seen.push(j.payload.n);
      return { echoed: j.payload.n };
    });
    expect(s2.jobs.start()).toBe(1); // 1 unterbrochener Job wieder eingereiht
    await s2.jobs.whenIdle();
    expect(seen.sort()).toEqual([7, 8]);
    expect(s2.jobs.get(job.id).status).toBe('succeeded');
    expect(s2.jobs.getResult(job.id)).toEqual({ echoed: 7 });
    expect(s2.jobs.get(waiting.id).status).toBe('succeeded');

    // Fehler → failed → retry
    let attempt = 0;
    s2.jobs.register('test.flaky', async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('kaputt');
      return 'ok';
    });
    const flaky = s2.jobs.enqueue('test.flaky', 'Flaky');
    await s2.jobs.whenIdle();
    expect(s2.jobs.get(flaky.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('kaputt') });
    s2.jobs.retry(flaky.id);
    await s2.jobs.whenIdle();
    expect(s2.jobs.get(flaky.id).status).toBe('succeeded');

    // Abbrechen: wartend sofort, laufend kooperativ
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s2.jobs.register('test.long', async (j) => {
      await gate;
      j.throwIfCancelled();
      return 'fertig';
    });
    const running = s2.jobs.enqueue('test.long', 'Lang');
    const queued = s2.jobs.enqueue('test.long', 'Wartet');
    await new Promise((r) => setTimeout(r, 30));
    expect(s2.jobs.cancel(queued.id).status).toBe('cancelled');
    s2.jobs.cancel(running.id);
    release();
    await s2.jobs.whenIdle();
    expect(s2.jobs.get(running.id).status).toBe('cancelled');
    expect(() => s2.jobs.retry(job.id)).toThrow();

    await s2.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('Worker-Threads', () => {
  let tmp: string;
  let workerFile: string;
  beforeAll(async () => {
    // Das Worker-Bundle muss innerhalb des Repos liegen, damit externe Module (pdfjs-dist, sharp) auflösbar sind – wie in der gepackten App.
    const cache = path.resolve(__dirname, '../../node_modules/.cache/archivist-test');
    fs.mkdirSync(cache, { recursive: true });
    tmp = fs.mkdtempSync(path.join(cache, 'worker-'));
    workerFile = path.join(tmp, 'worker.cjs');
    await build({
      entryPoints: [path.resolve(__dirname, '../../packages/core/src/workers/worker-entry.ts')],
      outfile: workerFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['better-sqlite3', 'sharp', 'pdfjs-dist', 'pdfjs-dist/*', 'tesseract.js', '@napi-rs/canvas'],
      logLevel: 'silent',
    });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('verarbeitet Aufgaben außerhalb des Hauptthreads (Hash, Scan, Textextraktion)', async () => {
    const pool = new WorkerPool(workerFile, 2);
    expect(pool.mode).toBe('thread');
    const f = path.join(tmp, 'a.pdf');
    makePdf(f, ['Worker Thread Test Dokument']);
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'hallo');
    const [hash, parsed, scan] = await Promise.all([
      pool.run('hashFile', { path: path.join(tmp, 'b.txt') }),
      pool.run('extractDocument', { path: f }),
      pool.run('scanDirectory', { root: tmp, recursive: true, excludedDirs: [], excludedFiles: [], extensions: ['txt', 'pdf'], maxSizeBytes: 1e6 }),
    ]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.text).toContain('Worker Thread Test');
    expect(scan.entries.map((e) => e.name).sort()).toEqual(['a.pdf', 'b.txt']);
    await expect(pool.run('hashFile', { path: path.join(tmp, 'gibt-es-nicht') })).rejects.toThrow();
    // Pool bleibt nach Fehlern benutzbar
    expect(await pool.run('hashFile', { path: path.join(tmp, 'b.txt') })).toBe(hash);
    await pool.close();
  });

  it('die komplette Anwendung funktioniert mit Worker-Threads (Import + Suche)', async () => {
    const app = await createTestApp({ privacy: 'auto', workerFile });
    app.llm.on('DocumentClassification', () => ({
      docType: 'Notiz',
      title: 'Thread',
      summary: 's',
      mainTopic: null,
      project: null,
      persons: [],
      dates: [],
      tags: [],
      location: { categoryPath: 'work/notes', fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
      decisions: [],
      openItems: [],
      confidence: 0.7,
      rationale: 'x',
    }));
    const imp = await app.ok('documents:import', { paths: [app.file('t.txt', 'Dokument verarbeitet im Worker Thread Zebrastreifen')] });
    await app.services.jobs.whenIdle();
    await app.ok('documents:archive', {
      items: [{ documentId: imp.imported[0]!.id, mode: 'copy' }],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: false,
    });
    expect((await app.ok('search:global', { query: 'Zebrastreifen', limit: 3 }))[0]?.id).toBe(imp.imported[0]!.id);
    await app.cleanup();
  });
});

describe('IPC-Vertrag und Eingabevalidierung', () => {
  it('jeder Kanal hat Input- und Output-Schema', () => {
    expect(IPC_CHANNELS.length).toBeGreaterThan(70);
    for (const c of IPC_CHANNELS) {
      expect(ipcContract[c].input).toBeDefined();
      expect(ipcContract[c].output).toBeDefined();
    }
    for (const required of [
      'app:getStatus',
      'settings:get',
      'settings:update',
      'llm:testConnection',
      'chat:send',
      'decisions:create',
      'decisions:update',
      'decisions:search',
      'documents:import',
      'documents:classify',
      'documents:archive',
      'documents:undoArchive',
      'scanner:addDirectory',
      'scanner:removeDirectory',
      'scanner:start',
      'scanner:getResults',
      'jobs:list',
      'jobs:retry',
      'notifications:list',
      'notifications:resolve',
      'insights:list',
      'contradictions:resolve',
      'reminders:create',
      'reminders:snooze',
      'search:global',
    ])
      expect(IPC_CHANNELS).toContain(required);
  });

  it('lehnt unbekannte Kanäle, ungültige Eingaben und fehlende Bestätigungen ab', async () => {
    const app = await createTestApp();
    const unknown = await app.dispatch('fs:readFile', { path: '/etc/passwd' });
    expect(unknown).toMatchObject({ ok: false, error: { category: 'permission_error' } });
    const proto = await app.dispatch('constructor', {});
    expect(proto.ok).toBe(false);
    const bad = await app.dispatch('chat:send', { text: 123 });
    expect(bad).toMatchObject({ ok: false, error: { category: 'validation_error' } });
    const empty = await app.dispatch('chat:send', { text: '' });
    expect(empty.ok).toBe(false);
    const noConfirm = await app.dispatch('documents:archive', { items: [{ documentId: 'x', mode: 'copy' }] });
    expect(noConfirm).toMatchObject({ ok: false, error: { category: 'validation_error' } });
    const badMode = await app.dispatch('documents:previewArchive', { items: [{ documentId: 'x', mode: 'delete' }] });
    expect(badMode.ok).toBe(false);
    const tooMany = await app.dispatch('documents:import', { paths: [] });
    expect(tooMany.ok).toBe(false);
    const nf = await app.dispatch('documents:get', { id: 'gibt-es-nicht' });
    expect(nf).toMatchObject({ ok: false, error: { category: 'validation_error' } });
    await app.cleanup();
  });
});

describe('Geheimnisse, Backups, Einstellungen', () => {
  it('speichert den API-Key nur verschlüsselt und nie in Konfiguration oder Logs', async () => {
    const app = await createTestApp();
    const KEY = 'sk-test-SECRET-0123456789abcdef';
    await app.ok('llm:testConnection', {});
    await app.services.logger.close();
    const files: string[] = [];
    const walk = (d: string) =>
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
    walk(app.services.paths.root);
    for (const f of files.filter((x) => !x.endsWith('.db') && !x.endsWith('.db-wal') && !x.endsWith('.db-shm')))
      expect(fs.readFileSync(f, 'utf8'), f).not.toContain(KEY);
    // auch die Datenbank enthält ihn nicht
    for (const f of files.filter((x) => x.endsWith('.db') || x.endsWith('-wal'))) expect(fs.readFileSync(f).includes(Buffer.from(KEY)), f).toBe(false);
    const s = await app.ok('settings:get', {});
    expect(JSON.stringify(s)).not.toContain(KEY);
    expect(s.hasApiKey).toBe(true);
    expect(fs.existsSync(path.join(app.services.paths.config, 'llm-api-key.enc'))).toBe(true);
    await app.cleanup();
  });

  it('verweigert das Speichern, wenn kein sicherer Speicher verfügbar ist', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-sec-'));
    const s = createServices({ dataRoot: path.join(root, 'A'), migrationsFolder: MIGRATIONS, cipher: new TestCipher(false) });
    expect(() => s.secrets.setApiKey('sk-abc123456')).toThrow(/sicher/i);
    expect(s.secrets.hasApiKey()).toBe(false);
    await s.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('legt konsistente Backups an (Metadaten vs. vollständig) ohne API-Key', async () => {
    const app = await createTestApp({ privacy: 'auto' });
    app.llm.on('DocumentClassification', () => ({
      docType: 'Notiz',
      title: 'B',
      summary: 's',
      mainTopic: null,
      project: null,
      persons: [],
      dates: [],
      tags: [],
      location: { categoryPath: 'work/notes', fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
      decisions: [],
      openItems: [],
      confidence: 0.7,
      rationale: 'x',
    }));
    const imp = await app.ok('documents:import', { paths: [app.file('b.txt', 'Backup Dokument Inhalt')] });
    await app.services.jobs.whenIdle();
    await app.ok('documents:archive', {
      items: [{ documentId: imp.imported[0]!.id, mode: 'copy' }],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: false,
    });
    const meta = await app.ok('backup:create', { includeArchive: false });
    await new Promise((r) => setTimeout(r, 1100));
    const full = await app.ok('backup:create', { includeArchive: true });
    expect(meta.kind).toBe('metadata');
    expect(full.kind).toBe('full');
    expect(fs.existsSync(path.join(meta.path, 'archive'))).toBe(false);
    expect(fs.readdirSync(path.join(full.path, 'archive', 'work', 'notes'))).toContain('b.txt');
    const copy = new Database(path.join(meta.path, 'archivist.db'), { readonly: true });
    expect((copy.prepare('select count(*) c from documents').get() as { c: number }).c).toBe(1);
    copy.close();
    for (const f of fs.readdirSync(meta.path)) expect(fs.readFileSync(path.join(meta.path, f)).includes(Buffer.from('SECRET-0123456789'))).toBe(false);
    expect((await app.ok('backup:list', {})).map((b) => b.kind).sort()).toEqual(['full', 'metadata']);
    await app.cleanup();
  });

  it('validiert Einstellungen (URL, Archivpfad) und hält Standardwerte datenschutzfreundlich', async () => {
    const app = await createTestApp({ configured: false });
    const s = Settings.parse((await app.ok('settings:get', {})).settings);
    expect(s.scan.enabled).toBe(false);
    expect(s.privacy.llmMode).toBe('confirm');
    expect(s.notifications.desktop).toBe(false);
    expect((await app.call('settings:update', { llm: { baseUrl: 'ftp://x' } })).ok).toBe(false);
    expect(Settings.parse((await app.ok('settings:update', { llm: { baseUrl: 'https://example.openai.azure.com/openai/v1/' } })).settings).llm.baseUrl).toBe(
      'https://example.openai.azure.com/openai/v1',
    );
    await app.cleanup();
  });

  it('verhält sich bei nicht konfiguriertem oder fehlerhaftem LLM verständlich', async () => {
    const app = await createTestApp({ configured: false });
    const r = await app.ok('llm:testConnection', {});
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/nicht konfiguriert/) });
    await app.cleanup();
    const app2 = await createTestApp();
    app2.llm.status = 401;
    expect((await app2.ok('llm:testConnection', {})).message).toMatch(/Anmeldung abgelehnt/);
    app2.llm.status = 429;
    const r429 = await app2.ok('llm:testConnection', {});
    expect(r429.error?.retryable).toBe(true);
    expect((await app2.ok('app:getStatus', {})).llm.status).toBe('error');
    await app2.cleanup();
  });
});
