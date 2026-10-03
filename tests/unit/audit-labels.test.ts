import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditActionLabel } from '../../apps/renderer/lib/audit-labels';

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
