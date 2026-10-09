import type { SourceReference } from '@archivist/shared';
import { describe, expect, it } from 'vitest';
import { checkSupersede } from '../../packages/core/src/services/contradiction-resolution';
import {
  cappedConfidence,
  checkEvidence,
  LOW_CONFIDENCE,
  PARTLY_BACKED_CAP,
  UNBACKED_CAP,
  type ModelClaims,
} from '../../packages/core/src/services/knowledge-answer-text';

const source = (title: string): SourceReference => ({ id: title, type: 'document', title, snippet: '', path: null, date: null, score: 1 });

/** Two numbered sources, S1 and S2, both sent to the model. */
const citable = () => {
  const stripped = [source('1. Vertrag'), source('2. Rechnung')];
  return { ids: new Map(stripped.map((s, i) => [`S${i + 1}`, s])), stripped };
};

const claims = (overrides: Partial<ModelClaims> = {}): ModelClaims => ({
  points: [],
  alsoUsed: [],
  confidence: 0.9,
  uncertainties: [],
  missingInformation: [],
  ...overrides,
});

describe('confidence capped by the evidence', () => {
  it('keeps the model confidence when every point is backed', () => {
    expect(cappedConfidence({ confidence: 0.9, kept: 2, dropped: 0 })).toBe(0.9);
  });

  it('caps it when some points were dropped', () => {
    expect(cappedConfidence({ confidence: 0.9, kept: 1, dropped: 1 })).toBe(PARTLY_BACKED_CAP);
    expect(cappedConfidence({ confidence: 0.4, kept: 1, dropped: 1 })).toBe(0.4);
  });

  it('caps it harder when nothing is backed, dropped or not', () => {
    expect(cappedConfidence({ confidence: 0.9, kept: 0, dropped: 2 })).toBe(UNBACKED_CAP);
    expect(cappedConfidence({ confidence: 0.9, kept: 0, dropped: 0 })).toBe(UNBACKED_CAP);
    expect(cappedConfidence({ confidence: 0.1, kept: 0, dropped: 0 })).toBe(0.1);
  });
});

describe('checking the model claims against the citable sources', () => {
  it('cites only valid sources and keeps their public form', () => {
    const evidence = checkEvidence(claims({ points: [{ sourceIds: ['S2', 'S9'] }] }), { citable: citable(), wording: 'answer' });

    expect(evidence.backed).toBe(true);
    expect(evidence.citations(['S2', 'S9', 'S1'])).toBe('[2][1]');
    expect(evidence.sources.map((s) => s.title)).toEqual(['2. Rechnung']);
    expect(evidence.uncertainties).toEqual([]);
  });

  it('counts sources the model says it used', () => {
    const evidence = checkEvidence(claims({ points: [{ sourceIds: ['S1'] }], alsoUsed: ['S2', 'S7'] }), { citable: citable(), wording: 'answer' });

    expect(evidence.sources.map((s) => s.title)).toEqual(['1. Vertrag', '2. Rechnung']);
  });

  it('names dropped points, missing information and a weak backing as uncertain, in this order', () => {
    const evidence = checkEvidence(
      claims({ points: [{ sourceIds: ['S1'] }, { sourceIds: ['S9'] }], confidence: 0.4, uncertainties: ['Unklar.'], missingInformation: ['Frist'] }),
      { citable: citable(), wording: 'challenge' },
    );

    expect(evidence.isBacked({ sourceIds: ['S9'] })).toBe(false);
    expect(evidence.confidence).toBe(0.4);
    expect(evidence.uncertainties).toEqual([
      'Unklar.',
      'Fehlt: Frist',
      '1 Aussage(n) des Modells ohne gültigen Quellenbeleg wurden verworfen.',
      'Die Einschätzung ist nur mit geringer Sicherheit belegt.',
    ]);
  });

  it('shows the top hits as found, not cited, when nothing is backed', () => {
    const evidence = checkEvidence(claims({ points: [{ sourceIds: ['S9'] }] }), { citable: citable(), wording: 'answer' });

    expect(evidence.backed).toBe(false);
    expect(evidence.confidence).toBeLessThan(LOW_CONFIDENCE);
    expect(evidence.sources.map((s) => s.title)).toEqual(['1. Vertrag (gefunden, nicht zitiert)', '2. Rechnung (gefunden, nicht zitiert)']);
    expect(evidence.uncertainties.at(-1)).toBe('Die angezeigten Quellen wurden gefunden, aber in der Antwort nicht zitiert.');
  });
});

describe('superseding a decision while resolving a contradiction', () => {
  const contradiction = { affectedEntityIds: ['older', 'newer'] };

  it('fits for the two decisions of the contradiction, resolved', () => {
    expect(checkSupersede(contradiction, { resolution: 'resolved', olderId: 'older', newerId: 'newer' })).toEqual({ fits: true });
    expect(checkSupersede(contradiction, { resolution: 'resolved', olderId: 'newer', newerId: 'older' })).toEqual({ fits: true });
  });

  it.each([
    ['another resolution', { resolution: 'false_positive' as const, olderId: 'older', newerId: 'newer' }],
    ['the same decision twice', { resolution: 'resolved' as const, olderId: 'older', newerId: 'older' }],
    ['a decision outside the contradiction', { resolution: 'resolved' as const, olderId: 'older', newerId: 'other' }],
  ])('refuses %s', (_, request) => {
    expect(checkSupersede(contradiction, request).fits).toBe(false);
  });
});
