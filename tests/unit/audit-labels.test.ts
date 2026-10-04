import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../packages/shared/src/audit';
import { auditActionLabel, auditChangeLines } from '../../apps/renderer/lib/audit-labels';

const CORE_SOURCE = path.resolve(__dirname, '../../packages/core/src');
const NAMESPACES =
  'document|archive|category|backup|case|decision|entity|persons|person|relation|reminder|trash|note|event|open_item|scanner|scan|subjects|topics|entries|settings|links';
const ACTION_NAME = new RegExp(`'((?:${NAMESPACES})\\.[A-Za-z_.]+)'`, 'g');

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

/** Every action name the core writes to the audit log: literals on lines that mention an `action` or an `*_ACTION` constant. */
function writtenActions(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(CORE_SOURCE)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!/\baction\b|_ACTION\b|AUDIT_ACTION/.test(line)) continue;
      for (const match of line.matchAll(ACTION_NAME)) found.add(match[1]!);
    }
  }
  return [...found];
}

describe('audit action labels (#234)', () => {
  const actions = writtenActions();

  it('finds the actions the core writes', () => {
    expect(actions).toEqual(expect.arrayContaining(['document.ignore', 'archive.relocate', 'relation.confirm', 'scan.exclude', 'open_item.close']));
  });

  it('has a German label for every action the core writes', () => {
    const unlabelled = actions.filter((action) => auditActionLabel(action) === action);
    expect(unlabelled).toEqual([]);
  });

  it('labels the actions whose name is built from a value', () => {
    expect(auditActionLabel('archive.copy')).toBe('Dokument archiviert: Kopieren');
    expect(auditActionLabel('archive.index_only')).toBe('Dokument archiviert: Nur indexieren');
    expect(auditActionLabel('topic.create')).toBe('Thema angelegt');
    expect(auditActionLabel('project.confirm')).toBe('Projekt bestätigt');
    expect(auditActionLabel('relation.outdated')).toBe('Verknüpfung: Veraltet');
    expect(auditActionLabel('action.reject:merge_topics')).toBe('Vorschlag abgelehnt');
    expect(auditActionLabel('scanner.exclude.directory')).toBe('Ordner von der Dokumentensuche ausgeschlossen');
  });

  it('labels an undo with the action it takes back', () => {
    expect(auditActionLabel('undo:document.ignore')).toBe('Rückgängig: Dokument ignoriert');
  });
});

function auditEntry(change: Pick<AuditEntry, 'action' | 'before' | 'after'>): AuditEntry {
  return {
    id: 'audit-1',
    at: '2026-10-04T08:00:00.000Z',
    actor: 'user',
    trigger: 'ui',
    confirmed: true,
    entityIds: [],
    entities: [],
    paths: [],
    success: true,
    error: null,
    undoable: false,
    undoneAt: null,
    ...change,
  };
}

describe('audit change lines', () => {
  it('names the status of an edited decision in German', () => {
    const entry = auditEntry({ action: 'decision.update', before: { status: 'draft', title: 'Alt' }, after: { status: 'confirmed', title: 'Neu' } });
    expect(auditChangeLines(entry)).toEqual(['Status: Entwurf → Bestätigt', 'Kurztitel: Alt → Neu']);
  });

  it('names a changed setting and its values in German instead of the dotted path', () => {
    const entry = auditEntry({
      action: 'settings.change',
      before: { 'llm.maxInputChars': 24000, 'privacy.llmMode': 'confirm', 'scan.enabled': false, 'agent.effort': 'high' },
      after: { 'llm.maxInputChars': 48000, 'privacy.llmMode': 'local_only', 'scan.enabled': true, 'agent.effort': 'max' },
    });
    expect(auditChangeLines(entry)).toEqual([
      'Maximale Eingabegröße der KI (Zeichen): 24.000 → 48.000',
      'Datenschutzmodus: Vor jeder externen Analyse fragen → Nur lokal',
      'Dokumentensuche: aus → an',
      'Denktiefe des Agenten: hoch → maximal',
    ]);
  });

  it('shows lists, empty values and entries of a keyed setting in words', () => {
    const entry = auditEntry({
      action: 'settings.change',
      before: { 'privacy.neverAnalyzeExtensions': [], 'llm.dailyTokenCap': null, 'agent.prices.modell-x': null, 'ocr.languages': 'deu' },
      after: {
        'privacy.neverAnalyzeExtensions': ['xlsx', 'eml'],
        'llm.dailyTokenCap': 50000,
        'agent.prices.modell-x': { input: 3, output: 15 },
        'ocr.languages': 'deu+eng',
      },
    });
    expect(auditChangeLines(entry)).toEqual([
      'Nie analysierte Dateitypen: – → xlsx, eml',
      'Tageslimit (Tokens): kein Limit → 50.000',
      'Eigener Preis für modell-x: Eingabe (US$ je 1 Mio. Tokens): – → 3',
      'Eigener Preis für modell-x: Ausgabe (US$ je 1 Mio. Tokens): – → 15',
      'Texterkennung (OCR): Sprachen: Deutsch → Deutsch, Englisch',
    ]);
  });

  it('shows no values for other actions', () => {
    expect(auditChangeLines(auditEntry({ action: 'document.ignore', before: { status: 'staged' }, after: { status: 'ignored' } }))).toEqual([]);
  });
});
