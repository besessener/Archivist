import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionInput } from '@archivist/shared';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ configured: false });
});
afterEach(async () => app.cleanup());

const note = (title: string, content: string) => app.services.notes.create({ title, content });
async function decision(title: string, decisionText: string) {
  const d = app.services.decisions.create(DecisionInput.parse({ title, decisionText, topic: 'Haus', decidedAt: '2026-03-01', participants: ['Jana'] }));
  await app.services.decisions.reindex(d.id);
  return d;
}

describe('Search: type filter and limit count entities, not chunks (#159)', () => {
  it('finds a decision among 80 strongly matching notes, with and without a type filter', async () => {
    for (let i = 0; i < 80; i += 1) await note(`Heizung ${i}`, `Heizung Heizung Heizung: Ablesung Nummer ${i} der Heizung im Keller.`);
    const d = await decision('Wartungsvertrag', 'Wir schließen einen Wartungsvertrag ab; die Heizung wird jährlich geprüft.');

    const decisions = await app.services.search.search('Heizung', { types: ['decision'] });
    expect(decisions.map((h) => h.id)).toEqual([d.id]);
    expect(decisions[0]!.matchedBy).toContain('keyword');

    const all = await app.ok('search:global', { query: 'Heizung', limit: 100 });
    expect(all.map((h) => h.id)).toContain(d.id);
    expect(new Set(all.map((h) => h.id)).size).toBe(all.length);
  });

  it('a long document with many matching chunks counts once against the keyword limit', async () => {
    const long = await note('Heizungsprotokoll', Array.from({ length: 80 }, (_, i) => `Absatz ${i}: Die Heizung lief heute ohne Störung.`).join('\n\n'));
    const short = await note('Thermostat', 'Das Thermostat der Heizung im Bad ist neu.');

    const hits = await app.services.search.search('Heizung', { types: ['note'] });
    expect(hits.map((h) => h.id).sort()).toEqual([long.id, short.id].sort());
    expect(hits.find((h) => h.id === short.id)!.matchedBy).toContain('keyword');
  });
});

describe('Search ranking: documents with all query terms first (#158)', () => {
  it('ranks the minutes that contain every term above short documents dense in one term', async () => {
    for (let i = 0; i < 12; i += 1) await note(`AWS Rechnung ${i}`, `AWS Rechnung für Konto ${i}: AWS EC2, AWS S3, AWS Support.`);
    const filler = 'Unter Verschiedenes ging es um Parkplätze, die Kaffeemaschine und den Sommerausflug. '.repeat(8);
    const minutes = await note('Protokoll Jour Fixe März', `${filler}\n\nEntscheidung: Die AWS-Migration startet im April, Ansprechpartner ist Jana.`);

    const hits = await app.services.search.search('Was war die Entscheidung zur AWS Migration?', { limit: 10 });

    expect(hits[0]?.id).toBe(minutes.id);
  });

  it('question words do not count as search terms', async () => {
    const a = await note('Gartenarbeiten', 'Beim Zaun am Garten ist alles entschieden: er wird grün gestrichen, dazu kommen neue Beete und ein Komposter.');
    for (let i = 0; i < 5; i += 1) await note(`Was wann welche ${i}`, `Was? Wann? Welche? Was wann welche Fragen ${i}.`);

    const hits = await app.services.search.search('Was wurde wann zum Zaun entschieden?', { limit: 3 });

    expect(hits[0]?.id).toBe(a.id);
  });
});

describe('Keyword search bridges inflections (#162)', () => {
  it('a query in another inflection matches as keyword', async () => {
    const a = await note('Dach', 'Wir entscheiden im Mai über das neue Dach.');
    const b = await note('Umzug', 'Der Umzug ins Büro am Markt ist für Juni geplant.');

    const forA = await app.services.search.search('Entscheidungen zum Dach', { types: ['note'] });
    expect(forA[0]?.id).toBe(a.id);
    expect(forA[0]?.matchedBy).toContain('keyword');
    const forB = await app.services.search.search('Umzuge', { types: ['note'] });
    expect(forB.find((h) => h.id === b.id)?.matchedBy).toContain('keyword');
  });
});
