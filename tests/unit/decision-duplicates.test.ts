import type { Decision } from '@archivist/shared';
import { describe, expect, it } from 'vitest';
import { trackedChanges } from '../../packages/core/src/services/decision-audit';
import { findDecisionDuplicate } from '../../packages/core/src/services/decision-duplicates';
import type { DecisionRow } from '../../packages/core/src/services/decision-fields';

const decision = (over: Partial<Decision>): Decision =>
  ({ id: 'd1', decisionText: 'Wir nehmen das Angebot von Müller.', topicName: 'Dach', projectName: null, status: 'active', ...over }) as Decision;

describe('findDecisionDuplicate', () => {
  const existing = [decision({})];

  it('ignores case, punctuation and diacritics in text, topic and project', () => {
    expect(findDecisionDuplicate({ decisionText: 'wir nehmen das angebot von muller', topic: ' dach ' }, existing)).toBe(existing[0]);
    expect(findDecisionDuplicate({ decisionText: 'WIR NEHMEN das Angebot von Müller!', topic: ' dach ' }, existing)).toBe(existing[0]);
  });

  it('needs the same topic, also when both have none', () => {
    expect(findDecisionDuplicate({ decisionText: existing[0]!.decisionText, topic: 'Keller' }, existing)).toBeUndefined();
    expect(findDecisionDuplicate({ decisionText: existing[0]!.decisionText }, existing)).toBeUndefined();
    const withoutTopic = [decision({ topicName: null })];
    expect(findDecisionDuplicate({ decisionText: existing[0]!.decisionText, topic: null }, withoutTopic)).toBe(withoutTopic[0]);
  });

  it('needs the same project, also for decisions without a topic', () => {
    const apollo = [decision({ topicName: null, projectName: 'Apollo' })];
    expect(findDecisionDuplicate({ decisionText: apollo[0]!.decisionText, project: 'Phoenix' }, apollo)).toBeUndefined();
    expect(findDecisionDuplicate({ decisionText: apollo[0]!.decisionText }, apollo)).toBeUndefined();
    expect(findDecisionDuplicate({ decisionText: apollo[0]!.decisionText, project: ' apollo ' }, apollo)).toBe(apollo[0]);
    expect(findDecisionDuplicate({ decisionText: existing[0]!.decisionText, topic: 'Dach', project: 'Apollo' }, existing)).toBeUndefined();
  });

  it('compares a topic named like the project as the project alone, as it is stored', () => {
    const stored = [decision({ topicName: null, projectName: 'prod-plat' })];
    expect(findDecisionDuplicate({ decisionText: stored[0]!.decisionText, topic: 'Prod Plat', project: 'prod-plat' }, stored)).toBe(stored[0]);
    expect(findDecisionDuplicate({ decisionText: stored[0]!.decisionText, topic: 'Dach', project: 'prod-plat' }, stored)).toBeUndefined();
  });

  it('settled decisions may be decided again; drafts and unclear ones count', () => {
    for (const status of ['superseded', 'revoked'] as const)
      expect(findDecisionDuplicate({ decisionText: existing[0]!.decisionText, topic: 'Dach' }, [decision({ status })])).toBeUndefined();
    for (const status of ['draft', 'unclear', 'confirmed'] as const)
      expect(findDecisionDuplicate({ decisionText: existing[0]!.decisionText, topic: 'Dach' }, [decision({ status })])).toBeDefined();
  });

  it('finds nothing for an empty text', () => {
    expect(findDecisionDuplicate({ decisionText: ' !! ', topic: 'Dach' }, [decision({ decisionText: '' })])).toBeUndefined();
  });
});

describe('trackedChanges', () => {
  const row = {
    title: 'A',
    decisionText: 'alt',
    decidedAt: '2026-09-01',
    validFrom: null,
    validUntil: null,
    rationale: null,
    consequences: null,
    sourceIds: ['s1'],
  } as DecisionRow;

  it('keeps old and new values of the changed tracked columns only', () => {
    expect(trackedChanges(row, { decisionText: 'neu', title: 'A', sourceIds: ['s1', 's2'], topicId: 't1', updatedAt: 'x' })).toEqual({
      before: { decisionText: 'alt', sourceIds: ['s1'] },
      after: { decisionText: 'neu', sourceIds: ['s1', 's2'] },
    });
  });

  it('is empty when nothing tracked changes', () => {
    expect(trackedChanges(row, { updatedAt: 'x' })).toEqual({ before: {}, after: {} });
  });
});
