import type { Decision } from '@archivist/shared';
import { describe, expect, it } from 'vitest';
import {
  assertEditableStatusChange,
  checkedDecisionDate,
  computeMissingFields,
  decisionIndexContent,
  decisionSummary,
  formatDecision,
  plainPatchColumns,
  questionFor,
  statusAfterEdit,
  toDecision,
  type DecisionRow,
} from '../../packages/core/src/services/decision-fields';

const row = (overrides: Partial<DecisionRow> = {}): DecisionRow => ({
  id: 'dec-1',
  title: 'Datenbank',
  decisionText: 'Wir nehmen Postgres.',
  decidedAt: '2026-03-02',
  topicId: 'topic-1',
  projectId: 'project-1',
  participants: ['Anna', 'Bert'],
  rationale: 'Bewährt',
  consequences: 'Migration nötig',
  alternatives: ['MySQL', 'SQLite'],
  status: 'active',
  validFrom: null,
  validUntil: null,
  supersedesDecisionId: null,
  sourceIds: ['doc-1'],
  confidence: 0.86,
  missingFields: [],
  unknownFields: [],
  origin: 'chat',
  evidence: null,
  createdAt: '2026-03-02T10:00:00.000Z',
  updatedAt: '2026-03-03T10:00:00.000Z',
  ...overrides,
});

const names: Record<string, string> = { 'topic-1': 'Infrastruktur', 'project-1': 'Archivist' };
const nameOf = (id: string | null) => (id ? (names[id] ?? null) : null);
const decision = (overrides: Partial<Decision> = {}): Decision => ({ ...toDecision(row(), nameOf), ...overrides });

describe('decision date (#168)', () => {
  it('normalises the date and accepts today and the past', () => {
    expect(checkedDecisionDate('2.3.2026', '2026-03-02')).toBe('2026-03-02');
    expect(checkedDecisionDate('2026-03-01T09:00:00.000Z', '2026-03-02')).toBe('2026-03-01T09:00:00.000Z');
    expect(checkedDecisionDate('2026-03-02T23:00:00.000Z', '2026-03-02')).toBe('2026-03-02T23:00:00.000Z');
    expect(checkedDecisionDate(null, '2026-03-02')).toBeNull();
    expect(checkedDecisionDate(undefined, '2026-03-02')).toBeNull();
  });

  it('rejects a date after today, naming it', () => {
    expect(() => checkedDecisionDate('2026-03-03T00:00:00.000Z', '2026-03-02')).toThrow(
      'Das Entscheidungsdatum 2026-03-03 liegt in der Zukunft. Gib das Datum an, an dem entschieden wurde.',
    );
    expect(() => checkedDecisionDate('2026-03-03', '2026-03-02')).toThrow(expect.objectContaining({ category: 'validation_error' }));
  });
});

describe('required fields of a decision', () => {
  it('reports every missing field in a fixed order', () => {
    expect(computeMissingFields({})).toEqual(['decidedAt', 'topic', 'decisionText']);
    expect(computeMissingFields({ topic: '  ', decisionText: ' ' })).toEqual(['decidedAt', 'topic', 'decisionText']);
  });

  it('accepts each field when present or confirmed as unknown', () => {
    const complete = { decidedAt: '2026-01-01', topic: 'T', decisionText: 'x' };
    expect(computeMissingFields(complete)).toEqual([]);
    expect(computeMissingFields({ unknownFields: ['decidedAt', 'topic', 'participants', 'decisionText'] })).toEqual([]);
  });

  it('asks a targeted question per field', () => {
    expect(questionFor('topic')).toBe('Zu welchem Thema gehört die Entscheidung?');
    expect(questionFor('decisionText')).toBe('Was genau wurde entschieden?');
    expect(questionFor('decisionText', { topic: 'Datenbank' })).toBe('Was genau wurde zu „Datenbank“ entschieden?');
  });
});

describe('status changes by editing', () => {
  it('allows keeping the status and moving between editable statuses', () => {
    expect(() => assertEditableStatusChange('superseded', undefined)).not.toThrow();
    expect(() => assertEditableStatusChange('revoked', 'revoked')).not.toThrow();
    expect(() => assertEditableStatusChange('draft', 'active')).not.toThrow();
  });

  it('refuses superseding or revoking by editing', () => {
    expect(() => assertEditableStatusChange('active', 'superseded')).toThrow(/Ersetzen und Widerrufen/);
    expect(() => assertEditableStatusChange('active', 'revoked')).toThrow(expect.objectContaining({ category: 'permission_error' }));
  });

  it('refuses bringing a superseded or revoked decision back by editing', () => {
    expect(() => assertEditableStatusChange('revoked', 'active')).toThrow(/nicht durch Bearbeiten wieder in Kraft/);
    expect(() => assertEditableStatusChange('superseded', 'draft')).toThrow(expect.objectContaining({ category: 'permission_error' }));
  });

  it('takes a wanted new status, activates a completed draft and otherwise changes nothing', () => {
    expect(statusAfterEdit('draft', { patch: { status: 'confirmed' }, missing: ['topic'] })).toBe('confirmed');
    expect(statusAfterEdit('active', { patch: { status: 'active' }, missing: [] })).toBeUndefined();
    expect(statusAfterEdit('draft', { patch: {}, missing: [] })).toBe('active');
    expect(statusAfterEdit('draft', { patch: { status: 'draft' }, missing: [] })).toBeUndefined();
    expect(statusAfterEdit('draft', { patch: {}, missing: ['topic'] })).toBeUndefined();
    expect(statusAfterEdit('draft', { patch: { asDraft: true }, missing: [] })).toBeUndefined();
    expect(statusAfterEdit('unclear', { patch: {}, missing: [] })).toBeUndefined();
  });
});

describe('plain patch columns', () => {
  it('sets only the fields present in the patch', () => {
    expect(plainPatchColumns(row(), {})).toStrictEqual({});
  });

  it('trims texts, keeps the title when it would become empty and clears empty optional texts', () => {
    expect(plainPatchColumns(row(), { title: '  Neu  ', decisionText: ' Text ', rationale: ' Grund ', consequences: ' Folge ' })).toEqual({
      title: 'Neu',
      decisionText: 'Text',
      rationale: 'Grund',
      consequences: 'Folge',
    });
    expect(plainPatchColumns(row(), { title: '   ', rationale: '  ', consequences: null })).toEqual({
      title: 'Datenbank',
      rationale: null,
      consequences: null,
    });
    expect(plainPatchColumns(row(), { rationale: null })).toEqual({ rationale: null });
  });

  it('normalises validity dates, merges sources and removes duplicate unknown fields', () => {
    expect(
      plainPatchColumns(row(), {
        alternatives: ['MariaDB'],
        validFrom: '1.4.2026',
        validUntil: '31.12.2026',
        sourceIds: ['doc-2', 'doc-1'],
        unknownFields: ['topic', 'topic', 'participants'],
      }),
    ).toEqual({
      alternatives: ['MariaDB'],
      validFrom: '2026-04-01',
      validUntil: '2026-12-31',
      sourceIds: ['doc-1', 'doc-2'],
      unknownFields: ['topic', 'participants'],
    });
  });
});

describe('rendering a decision', () => {
  it('maps a row with the names of topic and project', () => {
    expect(decision()).toMatchObject({ topicName: 'Infrastruktur', projectName: 'Archivist', origin: 'chat', status: 'active' });
    expect(toDecision(row({ origin: null, topicId: null }), nameOf)).toMatchObject({ origin: null, topicName: null });
  });

  it('formats all fields readably', () => {
    expect(formatDecision(decision())).toBe(
      [
        '**Wann:** 2026-03-02',
        '**Thema:** Infrastruktur (Projekt: Archivist)',
        '**Beteiligte:** Anna, Bert',
        '**Entscheidung:** Wir nehmen Postgres.',
        '**Begründung:** Bewährt',
        '**Auswirkungen:** Migration nötig',
        '**Alternativen:** MySQL; SQLite',
        '**Status:** Gültig',
        '**Sicherheit:** 86 %',
      ].join('\n'),
    );
  });

  it('marks open and confirmed unknown fields and leaves out a project named like the topic', () => {
    const sparse = decision({
      decidedAt: null,
      topicName: null,
      projectName: null,
      participants: [],
      rationale: null,
      consequences: null,
      alternatives: [],
      unknownFields: ['participants'],
    });

    expect(formatDecision(sparse).split('\n').slice(0, 7)).toEqual([
      '**Wann:** offen',
      '**Thema:** offen',
      '**Beteiligte:** unbekannt (bestätigt)',
      '**Entscheidung:** Wir nehmen Postgres.',
      '**Begründung:** –',
      '**Auswirkungen:** –',
      '**Alternativen:** –',
    ]);
    expect(formatDecision(decision({ projectName: 'Infrastruktur' }))).toContain('**Thema:** Infrastruktur\n');
    const confirmedUnknown = decision({ decidedAt: null, topicName: null, projectName: null, unknownFields: ['decidedAt', 'topic'] });
    expect(formatDecision(confirmedUnknown)).toMatch(/^\*\*Wann:\*\* unbekannt \(bestätigt\)\n\*\*Thema:\*\* unbekannt \(bestätigt\)\n/);
    expect(formatDecision(decision({ decidedAt: '2026-03-02T10:00:00.000Z' }))).toContain('**Wann:** 2026-03-02\n');
  });

  it('builds the search index text from the filled fields only', () => {
    expect(decisionIndexContent(decision({ decidedAt: '2026-03-02T10:00:00.000Z' }))).toBe(
      [
        'Wir nehmen Postgres.',
        'Thema: Infrastruktur',
        'Projekt: Archivist',
        'Datum: 2026-03-02',
        'Beteiligte: Anna, Bert',
        'Begründung: Bewährt',
        'Auswirkungen: Migration nötig',
        'Status: Gültig',
      ].join('\n'),
    );
    const sparse = decision({ topicName: null, projectName: null, decidedAt: null, participants: [], rationale: null, consequences: null });
    expect(decisionIndexContent(sparse)).toBe('Wir nehmen Postgres.\nStatus: Gültig');
  });

  it('summarises a decision in one line', () => {
    expect(decisionSummary(decision({ decidedAt: '2026-03-02T10:00:00.000Z' }))).toBe('2026-03-02: Datenbank [Infrastruktur] (active)');
    expect(decisionSummary(decision({ decidedAt: null, topicName: null, title: 'x'.repeat(90), status: 'draft' }))).toBe(
      `ohne Datum: ${'x'.repeat(79)}… (draft)`,
    );
  });
});
