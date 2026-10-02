import { describe, expect, it } from 'vitest';
import { assessEventPair, assessNotePair } from '../../packages/core/src/services/cleanup/note-event-assessment';

const PREFIX = 'Für das Sommerfest am 12. Juli brauchen wir noch Zelte, Bänke und Tische vom Sportverein nebenan. ';

describe('assessNotePair', () => {
  it('treats the same text (case, whitespace and punctuation aside) as identical', () => {
    expect(assessNotePair('Server läuft wieder.', '  server LÄUFT wieder ')).toMatchObject({ duplicate: true, match: 'identical' });
  });

  it('treats the same words with reordering or a typo as the same note', () => {
    expect(assessNotePair('Zelte beim Sportverein ausleihen', 'Beim Sportverein Zelte ausleihen')).toMatchObject({ duplicate: true, match: 'similar' });
    expect(assessNotePair('Angebot vom Dachdecker vergleichen', 'Angebot vom Dachdekcer vergleichen')).toMatchObject({ duplicate: true, match: 'similar' });
  });

  it('treats a note that only adds very little as the same note', () => {
    const a = 'Der Stackit-PoC läuft seit Mai stabil im Testbetrieb bei der Fachabteilung';
    const b = 'Der Stackit-PoC läuft seit Mai stabil im Testbetrieb bei der Fachabteilung Vertrieb';
    expect(assessNotePair(a, b)).toMatchObject({ duplicate: true, match: 'contained' });
  });

  it('keeps notes with the same beginning but different content apart', () => {
    expect(assessNotePair(`${PREFIX}Teil eins über Getränke.`, `${PREFIX}Teil zwei über das Essen.`).duplicate).toBe(false);
    // a short note contained in a much longer one is not the same note either
    expect(assessNotePair('Rasen mähen', 'Rasen mähen und danach die Hecke schneiden lassen').duplicate).toBe(false);
  });

  it('keeps notes apart that differ in a negation or in numbers', () => {
    expect(assessNotePair('Der Server läuft wieder', 'Der Server läuft nicht wieder').duplicate).toBe(false);
    expect(assessNotePair('Termin am 3. Mai bestätigt', 'Termin am 4. Mai bestätigt').duplicate).toBe(false);
  });
});

describe('assessEventPair', () => {
  it('detects the same day with a similar title', () => {
    expect(assessEventPair({ title: 'Umzug', occurredAt: '2026-03-01' }, { title: 'umzug!', occurredAt: '2026-03-01' }).duplicate).toBe(true);
    expect(
      assessEventPair(
        { title: 'Beitrag beim Testing Day eingereicht', occurredAt: '2026-10-01' },
        { title: 'Testing-Day-Beitrag eingereicht', occurredAt: '2026-10-01' },
      ).duplicate,
    ).toBe(true);
    expect(assessEventPair({ title: 'Umzug', occurredAt: '2026-03-01' }, { title: 'Umzug nach Berlin', occurredAt: '2026-03-01T00:00:00' }).duplicate).toBe(
      true,
    );
  });

  it('keeps other days, other titles, other times and other topics apart', () => {
    expect(assessEventPair({ title: 'Umzug', occurredAt: '2026-03-01' }, { title: 'Umzug', occurredAt: '2026-03-02' }).duplicate).toBe(false);
    expect(assessEventPair({ title: 'Umzug', occurredAt: '2026-03-01' }, { title: 'Zahnarzttermin', occurredAt: '2026-03-01' }).duplicate).toBe(false);
    expect(assessEventPair({ title: 'Teammeeting', occurredAt: '2026-03-01T09:00' }, { title: 'Teammeeting', occurredAt: '2026-03-01T15:00' }).duplicate).toBe(
      false,
    );
    expect(assessEventPair({ title: 'Release 2.0', occurredAt: '2026-03-01' }, { title: 'Release 2.1', occurredAt: '2026-03-01' }).duplicate).toBe(false);
    expect(
      assessEventPair({ title: 'Kickoff', occurredAt: '2026-03-01', topicId: 't1' }, { title: 'Kickoff', occurredAt: '2026-03-01', topicId: 't2' }).duplicate,
    ).toBe(false);
  });

  it('names agreeing details as reasons', () => {
    expect(
      assessEventPair({ title: 'Kickoff', occurredAt: '2026-03-01', projectId: 'p1' }, { title: 'Kickoff', occurredAt: '2026-03-01', projectId: 'p1' }),
    ).toMatchObject({ duplicate: true, reasons: ['gleiches Projekt'] });
  });
});
