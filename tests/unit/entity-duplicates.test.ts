import { describe, expect, it } from 'vitest';
import { classifyNames, duplicateKey } from '../../packages/core/src/services/cleanup/entity-duplicates';

const c = (a: string, b: string, aliases: { a?: string[]; b?: string[] } = {}) =>
  classifyNames({ name: a, aliases: aliases.a }, { name: b, aliases: aliases.b });

describe('duplicate name classification (#30)', () => {
  it('detects spelling variants: hyphen, space, case, umlauts, word order', () => {
    expect(c('prod-plat', 'ProdPlat')).toBe('spelling');
    expect(c('Prod Plat', 'prod_plat')).toBe('spelling');
    expect(c('E-Mail-Verteiler', 'Email Verteiler')).toBe('spelling');
    expect(c('Müller Umzug', 'Mueller Umzug')).toBe('spelling');
    expect(c('Straßenbau', 'Strassenbau')).toBe('spelling');
    expect(c('Planung Marketing', 'Marketing Planung')).toBe('spelling');
  });

  it('detects singular and plural', () => {
    expect(c('Rechnung', 'Rechnungen')).toBe('plural');
    expect(c('Bericht', 'Berichte')).toBe('plural');
    expect(c('Vertrag', 'Verträge')).toBe('plural');
    expect(c('Kollegin', 'Kolleginnen')).toBe('plural');
    expect(c('E-Mail', 'Emails')).toBe('plural');
    expect(c('Policy', 'Policies')).toBe('plural');
  });

  it('detects typos in longer names only', () => {
    expect(c('Budget', 'Budegt')).toBe('typo');
    expect(c('Steuererklärung', 'Steuererklärnug')).toBe('typo');
    expect(c('Infrastruktur', 'Infrastrucktur')).toBe('typo');
    expect(c('Budget Planung', 'Budegt Planung')).toBe('typo');
    expect(c('Haus', 'Maus')).toBeNull();
    expect(c('Gruppe A', 'Gruppe B')).toBeNull();
    expect(c('Standort Köln', 'Standort Bonn')).toBeNull();
  });

  it('treats an extended name only as a prefix question', () => {
    expect(c('Urlaub', 'Urlaub 2026')).toBe('prefix');
    expect(c('Urlaub 2026', 'Urlaub')).toBe('prefix');
    expect(c('Hauskauf', 'Hauskauf Finanzierung')).toBe('prefix');
    // too generic or too far apart
    expect(c('IT', 'IT Sicherheit')).toBeNull();
    expect(c('Urlaub', 'Urlaub Planung Sommer Familie')).toBeNull();
  });

  it('never matches names that differ in their numbers', () => {
    expect(c('Phase 1', 'Phase 2')).toBeNull();
    expect(c('Urlaub 2025', 'Urlaub 2026')).toBeNull();
    expect(c('Release 1.2', 'Release 1.3')).toBeNull();
  });

  it('recognises a name that is already a known alias of the other entity', () => {
    expect(c('Produktplattform', 'Prod Plat', { b: ['Produktplattform'] })).toBe('alias');
  });

  it('keeps unrelated names apart', () => {
    expect(c('Hauskauf', 'Urlaub')).toBeNull();
    expect(c('Marketing', 'Vertrieb')).toBeNull();
    expect(c('Projekt Alpha', 'Projekt Beta')).toBeNull();
  });

  it('builds a stable key from the sorted ids', () => {
    expect(duplicateKey(['b', 'a'])).toBe(duplicateKey(['a', 'b']));
    expect(duplicateKey(['b', 'a'])).toBe('similar-entities:a|b');
  });
});
