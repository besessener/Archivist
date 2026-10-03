import { describe, expect, it } from 'vitest';
import {
  AgentActionProposal,
  ActionParamSchemas,
  ArchiveLocationProposal,
  ChatIntent,
  ContradictionProposal,
  DecisionExtraction,
  DocumentClassification,
  EntityExtraction,
  KnowledgeAnswer,
  OpenQuestionExtraction,
  RelationshipProposal,
  SourceReference,
} from '@archivist/shared';

describe('Zod schemas for structured LLM output', () => {
  it('ChatIntent: accepts valid output and rejects unknown intents or wrong types', () => {
    expect(ChatIntent.safeParse({ intent: 'decision_new', confidence: 0.9, decision: { decisionText: 'x', topic: null } }).success).toBe(true);
    expect(ChatIntent.safeParse({ intent: 'format_disk', confidence: 0.9 }).success).toBe(false);
    expect(ChatIntent.safeParse({ intent: 'unknown', confidence: 1.5 }).success).toBe(false);
    expect(ChatIntent.safeParse({ intent: 'decision_new', confidence: 0.5, decision: { participants: 'Anna' } }).success).toBe(false);
  });

  it('DecisionExtraction: defaults and field validation', () => {
    const d = DecisionExtraction.parse({ decisionText: 'x' });
    expect(d.participants).toEqual([]);
    expect(d.unknownFields).toEqual([]);
    expect(DecisionExtraction.safeParse({ unknownFields: ['kaffee'] }).success).toBe(false);
  });

  it('DocumentClassification requires a filing proposal with confidence', () => {
    const ok = {
      docType: 'Vertrag',
      title: 'T',
      summary: 's',
      location: { categoryPath: 'Arbeit/contracts', rationale: 'r', confidence: 0.7 },
      confidence: 0.7,
    };
    expect(DocumentClassification.safeParse(ok).success).toBe(true);
    expect(DocumentClassification.safeParse({ ...ok, location: undefined }).success).toBe(false);
    expect(ArchiveLocationProposal.safeParse({ categoryPath: '', confidence: 0.5 }).success).toBe(false);
  });

  it('further schemas: EntityExtraction, RelationshipProposal, OpenQuestionExtraction, ContradictionProposal, KnowledgeAnswer, SourceReference', () => {
    expect(EntityExtraction.parse({}).topics).toEqual([]);
    expect(RelationshipProposal.safeParse({ relations: [{ sourceId: 'a', targetId: 'b', relationType: 'supports', confidence: 0.4 }] }).success).toBe(true);
    expect(RelationshipProposal.safeParse({ relations: [{ sourceId: 'a', targetId: 'b', relationType: 'hates', confidence: 0.4 }] }).success).toBe(false);
    expect(OpenQuestionExtraction.parse({ items: [{ title: 'Klären' }] }).items[0]!.priority).toBe('normal');
    expect(ContradictionProposal.safeParse({ isContradiction: true, confidence: 0.6 }).success).toBe(true);
    expect(KnowledgeAnswer.safeParse({ answer: 'a', confidence: 0.5 }).success).toBe(true);
    expect(KnowledgeAnswer.safeParse({ confidence: 0.5 }).success).toBe(false);
    expect(SourceReference.safeParse({ id: '1', type: 'document', title: 't' }).success).toBe(true);
  });

  it('AgentActionProposal: required fields and confirmation levels', () => {
    const base = {
      actionType: 'close_open_item',
      rationale: 'r',
      confidence: 0.7,
      affectedEntities: [],
      requiredConfirmation: 'confirm',
      proposedParameters: {},
    };
    expect(AgentActionProposal.safeParse(base).success).toBe(true);
    expect(AgentActionProposal.safeParse({ ...base, requiredConfirmation: 'never' }).success).toBe(false);
    expect(AgentActionProposal.safeParse({ ...base, actionType: 'delete_everything' }).success).toBe(false);
    expect(AgentActionProposal.safeParse({ actionType: 'close_open_item' }).success).toBe(false);
    // there is deliberately no action type for deleting
    expect(Object.keys(ActionParamSchemas).some((k) => /delete|remove|overwrite/i.test(k))).toBe(false);
  });
});
