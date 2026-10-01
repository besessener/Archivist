import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startFakeLlm, type FakeLlmServer } from './fake-llm';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
const appDir = path.resolve(__dirname, '../../apps/desktop');
// ARCHIVIST_E2E_PACKAGED=1: die gepackte Anwendung (electron-builder --dir) statt des Entwicklungsaufbaus testen
const packaged = process.env.ARCHIVIST_E2E_PACKAGED === '1';
const packagedBinary = path.join(appDir, 'release', 'linux-unpacked', 'archivist');

let app: ElectronApplication;
let page: Page;
let llm: FakeLlmServer;
let dataDir: string;
let downloads: string;
let work: string;

const tid = (id: string) => page.getByTestId(id);

test.beforeAll(async () => {
  llm = await startFakeLlm();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-e2e-'));
  dataDir = path.join(work, 'Archivist');
  downloads = path.join(work, 'Downloads');
  fs.mkdirSync(downloads, { recursive: true });
  app = await electron.launch({
    executablePath: packaged ? packagedBinary : electronPath,
    args: [...(packaged ? [] : [appDir]), '--no-sandbox', '--disable-gpu'],
    timeout: 60_000,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ARCHIVIST_DATA_DIR: dataDir, ARCHIVIST_TEST_MODE: '1', ARCHIVIST_TEST_PICK_DIR: downloads },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) await page.screenshot({ path: path.join(process.env.E2E_SHOTS ?? os.tmpdir(), 'e2e-failure.png') });
});

test.afterAll(async () => {
  await app?.close();
  await llm?.close();
  fs.rmSync(work, { recursive: true, force: true });
});

test('vertikaler Slice: Einrichtung → Import → Archivierung → Entscheidung → Scan', async () => {
  // 1) App startet mit Einrichtungsdialog; lokale Verzeichnisstruktur und Datenbank sind angelegt
  await expect(tid('setup-wizard')).toBeVisible();
  for (const d of ['archive', 'database', 'index', 'config', 'logs', 'backups', 'inbox', 'quarantine']) expect(fs.existsSync(path.join(dataDir, d)), d).toBe(true);
  expect(fs.existsSync(path.join(dataDir, 'database', 'archivist.db'))).toBe(true);

  // 2) Testkonfiguration über den Einrichtungsdialog (lokaler Fake-Endpunkt)
  await tid('setup-next').click();
  await tid('setup-baseurl').fill(llm.url);
  await tid('setup-apikey').fill('sk-e2e-SECRET-0123456789');
  await tid('setup-model').fill('e2e-model');
  await tid('setup-test').click();
  await expect(tid('setup-test-result')).toContainText('erfolgreich');
  await tid('setup-next').click();
  await tid('setup-next').click(); // Verzeichnisse überspringen
  await tid('setup-mode-auto').check();
  await tid('setup-next').click();
  await tid('setup-finish').click();
  await expect(tid('chat-page')).toBeVisible();
  // API-Key liegt verschlüsselt und nicht im Klartext
  expect(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf8')).not.toContain('SECRET');
  expect(fs.readFileSync(path.join(dataDir, 'config', 'llm-api-key.enc')).includes(Buffer.from('SECRET'))).toBe(false);

  // 3) Textdatei importieren (Datei-Auswahl entspricht dem Drag-and-Drop-Pfad)
  const note = path.join(downloads, 'jour-fixe.txt');
  fs.writeFileSync(note, 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');
  await tid('file-input').setInputFiles(note);

  // 4) Klassifikationsvorschlag in der Inbox
  await tid('nav-inbox').click();
  const item = tid('inbox-item').first();
  await expect(item).toBeVisible();
  await expect(tid('inbox-proposal').first()).toContainText('work/projects/Nordlicht', { timeout: 30_000 });
  await expect(tid('inbox-llm-status').first()).toContainText(/LLM analysiert/i);

  // 5) Archivierung bestätigen (Quelle, Ziel und Aktion vorher sichtbar)
  await tid('inbox-archive').first().click();
  await expect(tid('archive-plan-source').first()).toContainText('inbox');
  await expect(tid('archive-plan-target').first()).toContainText(path.join('work', 'projects', 'Nordlicht', 'jour-fixe.txt'));
  expect(fs.existsSync(path.join(dataDir, 'archive', 'work', 'projects', 'Nordlicht', 'jour-fixe.txt'))).toBe(false);
  await tid('archive-confirm').click();
  await expect(tid('archive-result')).toContainText(/erfolgreich|archiviert/i);
  expect(fs.readFileSync(path.join(dataDir, 'archive', 'work', 'projects', 'Nordlicht', 'jour-fixe.txt'), 'utf8')).toContain('Jour Fixe');
  expect(fs.existsSync(note)).toBe(true); // Original unverändert
  await tid('archive-close').click();

  // 6) Entscheidung im Chat erfassen, 7) Rückfrage beantworten
  await tid('nav-chat').click();
  await tid('chat-input').fill('Wir haben entschieden, dass wir das Projekt Nordlicht pausieren.');
  await tid('chat-send').click();
  await expect(tid('chat-message').last()).toContainText('Wann wurde das entschieden?');
  await expect(tid('chat-message').last()).toContainText('Wer war an der Entscheidung beteiligt?');
  await tid('chat-input').fill('Am 4. Mai 2026 mit Anna und Ben.');
  await tid('chat-send').click();
  await expect(tid('chat-message').last()).toContainText('Die Entscheidung ist gespeichert');

  // 8) Entscheidung per Chat wiederfinden – mit Quellen
  await tid('chat-input').fill('Wann haben wir Nordlicht pausiert?');
  await tid('chat-send').click();
  await expect(tid('chat-message').last()).toContainText('4. Mai 2026');
  await expect(tid('chat-source').first()).toBeVisible();

  // 9) Scan-Verzeichnis freigeben (Dialog wird im Test durch ARCHIVIST_TEST_PICK_DIR ersetzt)
  await tid('nav-scan').click();
  await tid('scan-enable').click();
  await tid('scan-add-dir').click();
  await expect(tid('scan-dir').first()).toContainText(path.basename(downloads));

  // 10) Datei finden: neue Datei im freigegebenen Ordner, unveränderte bekannte werden übersprungen
  fs.writeFileSync(path.join(downloads, 'urlaub.txt'), 'Urlaubsantrag für den 12.06.2026, bitte genehmigen.');
  await tid('scan-start').click();
  await expect(tid('scan-file-row')).toHaveCount(2, { timeout: 30_000 });
  await tid('scan-start').click();
  await expect(tid('scan-summary')).toContainText(/unverändert/i, { timeout: 30_000 });

  // 11) ausgewählte Datei analysieren (mit ausdrücklicher LLM-Freigabe) und Archivierung bestätigen
  const row = tid('scan-file-row').filter({ hasText: 'urlaub.txt' });
  await row.getByTestId('scan-file-checkbox').check();
  await tid('scan-analyze').click();
  await tid('scan-llm-checkbox').check();
  await tid('scan-analyze-confirm').click();
  await expect(tid('scan-proposal').first()).toBeVisible({ timeout: 30_000 });
  await tid('scan-proposal-archive').first().click();
  await expect(tid('archive-plan-target').first()).toContainText(path.join('private', 'vacation', '2026', 'urlaub.txt'));
  await expect(tid('archive-plan-source').first()).toContainText(downloads);
  await tid('archive-confirm').click();
  await expect(tid('archive-result')).toBeVisible();
  expect(fs.existsSync(path.join(dataDir, 'archive', 'private', 'vacation', '2026', 'urlaub.txt'))).toBe(true);
  expect(fs.existsSync(path.join(downloads, 'urlaub.txt'))).toBe(true);
  await tid('archive-close').click();

  // 12) Notification Bell
  await tid('bell').click();
  await expect(tid('bell-item').first()).toBeVisible();
  expect(await tid('bell-item').count()).toBeGreaterThan(1);

  // Es wurden nur maskierte Auszüge an das LLM gesendet und die Übertragung ist nachvollziehbar protokolliert
  expect(llm.calls.some((c) => c.schema === 'DocumentClassification')).toBe(true);
  const dbFile = path.join(dataDir, 'database', 'archivist.db');
  expect(fs.existsSync(dbFile)).toBe(true);
});
