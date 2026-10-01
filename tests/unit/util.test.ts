import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../../packages/core/src/util/logger';
import { redactSecrets } from '../../packages/core/src/util/redact';
import { normalizeDateInput, parseGermanDate } from '../../packages/core/src/util/dates';
import { chunkText, nameSimilarity } from '../../packages/core/src/util/text';
import { chosenOption, polarity } from '../../packages/core/src/services/contradictions';
import { computeMissingFields, questionFor } from '../../packages/core/src/services/decisions';
import { detectOpenItemSentences } from '../../packages/core/src/services/open-items';
import { localEmbed } from '../../packages/core/src/services/embedding';

describe('Maskierung von Geheimnissen', () => {
  it('maskiert typische Zugangsdaten', () => {
    const r = redactSecrets(
      'password: hunter2xx\nkey sk-abcdefghijklmnop1234 AKIAABCDEFGHIJKLMNOP Bearer abcdefghijklmnopqrstuvwxyz1234 postgres://user:geheim123@host/db',
    );
    expect(r.text).not.toMatch(/hunter2xx|sk-abcdefghijklmnop1234|AKIAABCDEFGHIJKLMNOP|geheim123|abcdefghijklmnopqrstuvwxyz1234/);
    expect(r.count).toBeGreaterThanOrEqual(5);
    expect(redactSecrets('Ganz normaler Text ohne Geheimnis.').count).toBe(0);
  });
});

describe('Logging ohne Geheimnisse', () => {
  it('schreibt weder API-Key noch Dokumentinhalte ins Log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-log-'));
    const log = new Logger(dir, 'debug');
    log.registerSecret('sk-live-TOPSECRET-123456');
    log.info('llm', 'Anfrage mit sk-live-TOPSECRET-123456 gesendet', {
      apiKey: 'sk-live-TOPSECRET-123456',
      authorization: 'Bearer sk-live-TOPSECRET-123456',
      text: 'VERTRAULICHER DOKUMENTINHALT',
      note: 'harmlos',
      nested: { token: 'abc', msg: 'password=supergeheim' },
    });
    await log.close();
    const content = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), 'utf8');
    expect(content).not.toContain('TOPSECRET');
    expect(content).not.toContain('VERTRAULICHER');
    expect(content).not.toContain('supergeheim');
    expect(content).toContain('harmlos');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Datumserkennung', () => {
  const now = new Date(2026, 9, 1); // Do, 01.10.2026
  it('erkennt absolute und relative Angaben', () => {
    expect(parseGermanDate('am 12.06.2026', now)).toBe('2026-06-12');
    expect(parseGermanDate('am 3.7.26', now)).toBe('2026-07-03');
    expect(parseGermanDate('12. Juni 2026', now)).toBe('2026-06-12');
    expect(parseGermanDate('morgen', now)).toBe('2026-10-02');
    expect(parseGermanDate('in sieben Tagen', now)).toBe('2026-10-08');
    expect(parseGermanDate('in 2 Wochen', now)).toBe('2026-10-15');
    expect(parseGermanDate('nächsten Montag', now)).toBe('2026-10-05');
    expect(parseGermanDate('nichts', now)).toBeNull();
    expect(normalizeDateInput('2026-02-30', now)).toBeNull();
    expect(normalizeDateInput('2026-03-04', now)).toBe('2026-03-04');
  });
});

describe('Entscheidungen: Pflichtfelder und Rückfragen', () => {
  it('bestimmt fehlende Pflichtfelder', () => {
    expect(computeMissingFields({ decisionText: 'x' })).toEqual(['decidedAt', 'topic', 'participants']);
    expect(computeMissingFields({ decisionText: 'x', decidedAt: '2026-01-01', topic: 'T', participants: ['A'] })).toEqual([]);
  });
  it('akzeptiert ausdrücklich als unbekannt bestätigte Felder', () => {
    expect(computeMissingFields({ decisionText: 'x', topic: 'T', unknownFields: ['decidedAt', 'participants'] })).toEqual([]);
  });
  it('formuliert gezielte Rückfragen', () => {
    expect(questionFor('decidedAt')).toBe('Wann wurde das entschieden?');
    expect(questionFor('participants')).toBe('Wer war an der Entscheidung beteiligt?');
    expect(questionFor('decisionText', { topic: 'prod-plat' })).toContain('prod-plat');
  });
});

describe('Widerspruchs-Heuristiken', () => {
  it('erkennt gegensätzliche Polarität', () => {
    expect(polarity('Wir machen mit prod-plat vorerst nicht weiter.')).toBe('stop');
    expect(polarity('prod-plat wird pausiert')).toBe('stop');
    expect(polarity('Wir führen prod-plat weiter und setzen es um.')).toBe('go');
    expect(polarity('Das Budget beträgt 5000 Euro.')).toBeNull();
  });
  it('erkennt Auswahlentscheidungen', () => {
    expect(chosenOption('Wir entscheiden uns für Postgres als Datenbank')?.toLowerCase()).toContain('postgres');
  });
});

describe('Weitere Hilfsfunktionen', () => {
  it('erkennt offene Punkte in Text', () => {
    const s = detectOpenItemSentences('Das Budget muss noch geklärt werden. Alles andere ist fertig. Rückmeldung steht noch aus. Termin TBD.');
    expect(s).toHaveLength(3);
  });
  it('lokale Vektoren sind ähnlich für verwandte Texte', () => {
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
    const a = localEmbed('Entscheidung zum Hauskauf in Hamburg');
    const b = localEmbed('Wir haben den Hauskauf in Hamburg entschieden');
    const c = localEmbed('Rezept für Apfelkuchen mit Zimt');
    expect(dot(a, b)).toBeGreaterThan(dot(a, c) + 0.2);
  });
  it('Namensähnlichkeit und Chunking', () => {
    expect(nameSimilarity('prod-plat', 'ProdPlat')).toBeGreaterThan(0.9);
    expect(nameSimilarity('Hauskauf', 'Urlaub')).toBeLessThan(0.5);
    const chunks = chunkText('Satz eins. '.repeat(400), 500, 50);
    expect(chunks.length).toBeGreaterThan(5);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(520);
  });
});
