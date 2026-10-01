import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const classification = (over: Record<string, unknown> = {}) => ({
  docType: 'Protokoll',
  title: 'Jour Fixe prod-plat',
  summary: 'Protokoll des Jour Fixe zum Projekt prod-plat.',
  mainTopic: 'prod-plat',
  project: 'prod-plat',
  persons: ['Anna', 'Ben'],
  dates: [{ date: '2026-06-12', label: 'Termin' }],
  tags: ['jour-fixe', 'budget'],
  location: {
    categoryPath: 'work/projects/prod-plat',
    fileName: null,
    newMainCategory: false,
    rationale: 'Das Dokument nennt das Projekt prod-plat.',
    confidence: 0.86,
  },
  decisions: [],
  openItems: [{ title: 'Budget noch klären', description: 'Das Budget muss noch geklärt werden.', dueAt: null }],
  confidence: 0.86,
  rationale: 'Projektbezug eindeutig',
  ...over,
});

describe('LLM-Anbindung', () => {
  it('testet die Verbindung erfolgreich', async () => {
    const r = await app.ok('llm:testConnection', {});
    expect(r.ok).toBe(true);
    expect(r.modelReply).toBe('OK');
    const tx = await app.ok('llm:transmissions', { limit: 10 });
    expect(tx[0]?.purpose).toBe('Verbindungstest');
  });

  it('meldet einen nicht erreichbaren Endpunkt verständlich', async () => {
    app.llm.down = true;
    const r = await app.ok('llm:testConnection', {});
    expect(r.ok).toBe(false);
    expect(r.error?.category).toBe('network_error');
    expect(r.message).toMatch(/nicht erreichbar/);
  });
});

describe('Datei importieren, klassifizieren, archivieren, rückgängig machen', () => {
  it('führt den Dokument-Slice vollständig aus', async () => {
    app.llm.on('DocumentClassification', () => classification());
    const src = app.file('Downloads/jour-fixe.txt', 'Jour Fixe prod-plat am 12.06.2026.\nTeilnehmer: Anna, Ben.\nDas Budget muss noch geklärt werden.');

    const imp = await app.ok('documents:import', { paths: [src] });
    expect(imp.imported).toHaveLength(1);
    const id = imp.imported[0]!.id;
    await app.services.jobs.whenIdle();

    const doc = await app.ok('documents:get', { id });
    expect(doc.status).toBe('proposed');
    expect(doc.llmStatus).toBe('analyzed');
    expect(doc.proposal?.location.categoryPath).toBe('work/projects/prod-plat');
    expect(doc.stagedPath && fs.existsSync(doc.stagedPath)).toBe(true);
    expect(fs.existsSync(src)).toBe(true);

    // Plan zeigt Quelle/Ziel; nichts wurde bisher kopiert
    const plan = await app.ok('documents:previewArchive', { items: [{ documentId: id, mode: 'copy' }] });
    expect(plan.items[0]!.targetPath).toContain(path.join('work', 'projects', 'prod-plat', 'jour-fixe.txt'));
    expect(fs.existsSync(plan.items[0]!.targetPath!)).toBe(false);

    // ohne Bestätigung → Ablehnung an der IPC-Grenze
    const denied = await app.call('documents:archive', { items: [{ documentId: id, mode: 'copy' }], confirmed: false as unknown as true });
    expect(denied.ok).toBe(false);

    const res = await app.ok('documents:archive', { items: [{ documentId: id, mode: 'copy' }], confirmed: true, approveNewCategories: [], confirmMove: false });
    expect(res.success).toBe(1);
    const target = res.items[0]!.targetPath!;
    expect(fs.readFileSync(target, 'utf8')).toContain('Jour Fixe');
    expect(fs.existsSync(src)).toBe(true); // Original unverändert

    const archived = await app.ok('documents:get', { id });
    expect(archived.status).toBe('archived');
    expect(archived.projectName).toBe('prod-plat');

    // Suche und Wissensgraph aktualisiert
    const hits = await app.ok('search:global', { query: 'Jour Fixe Budget', limit: 5 });
    expect(hits.some((h) => h.id === id)).toBe(true);
    const topics = await app.ok('knowledge:listEntities', { type: 'project' });
    expect(topics.map((t) => t.name)).toContain('prod-plat');

    // Audit + Undo
    const audit = await app.ok('audit:list', { limit: 20, onlyUndoable: true });
    const entry = audit.find((a) => a.action === 'archive.copy');
    expect(entry?.undoable).toBe(true);
    const undone = await app.ok('audit:undo', { auditId: entry!.id });
    expect(undone.undone).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(src)).toBe(true);
    const after = await app.ok('documents:get', { id });
    expect(after.status).toBe('proposed');
    expect(after.stagedPath && fs.existsSync(after.stagedPath)).toBe(true);
  });

  it('erkennt Duplikate beim Import', async () => {
    app.llm.on('DocumentClassification', () => classification());
    const a = app.file('a.txt', 'identischer Inhalt für den Duplikattest, lang genug.');
    const b = app.file('b.txt', 'identischer Inhalt für den Duplikattest, lang genug.');
    const first = await app.ok('documents:import', { paths: [a] });
    const second = await app.ok('documents:import', { paths: [b] });
    expect(first.imported).toHaveLength(1);
    expect(second.imported).toHaveLength(0);
    expect(second.duplicates[0]?.existingDocumentId).toBe(first.imported[0]!.id);
  });
});
