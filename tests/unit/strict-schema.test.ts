import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatAnalysis, ContradictionProposal, DocumentClassification, IdeaChallenge, KnowledgeAnswer, SolutionProposal } from '@archivist/shared';
import { LlmHints as EntityDuplicateHints } from '../../packages/core/src/services/cleanup/entity-duplicates';
import { LlmHints as PersonQuestionHints } from '../../packages/core/src/services/cleanup/person-questions';
import { toStrictJsonSchema } from '../../packages/core/src/services/llm/strict-schema';
import { NoteAnalysis } from '../../packages/core/src/services/note-analysis';
import { RelationKindHint } from '../../packages/core/src/services/relation-refiner';
import { TopicName } from '../../packages/core/src/services/topic-namer';

type Node = Record<string, unknown>;

/** Every object in the schema is closed and lists all its properties as required (what strict Structured Outputs demand). */
function expectStrict(node: unknown, path = '$'): void {
  if (Array.isArray(node)) return node.forEach((entry, index) => expectStrict(entry, `${path}[${index}]`));
  if (typeof node !== 'object' || node === null) return;
  const object = node as Node;
  const types = Array.isArray(object.type) ? object.type : [object.type];
  if (types.includes('object')) {
    expect(object.additionalProperties, `${path} additionalProperties`).toBe(false);
    expect(object.required, `${path} required`).toEqual(Object.keys((object.properties ?? {}) as Node));
  }
  for (const forbidden of ['default', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', '$schema', 'oneOf', 'allOf'])
    expect(object, `${path} ${forbidden}`).not.toHaveProperty(forbidden);
  for (const [key, value] of Object.entries(object)) expectStrict(value, `${path}.${key}`);
}

describe('strict JSON schema from Zod', () => {
  it('converts every schema the app sends through completeJson', () => {
    const schemas: Record<string, z.ZodType> = {
      ChatAnalysis,
      ContradictionProposal,
      DocumentClassification,
      KnowledgeAnswer,
      IdeaChallenge,
      SolutionProposal,
      NoteAnalysis,
      RelationKindHint,
      TopicName,
      EntityDuplicateHints,
      PersonQuestionHints,
      ConnectionTest: z.object({ ok: z.boolean() }),
    };
    for (const [name, schema] of Object.entries(schemas)) {
      const converted = toStrictJsonSchema(schema);
      expect(converted, `${name} must convert`).not.toBeNull();
      expectStrict(converted, name);
    }
  });

  it('keeps optional properties required with their own type (Zod would reject a null for them) and nullable ones nullable', () => {
    const converted = toStrictJsonSchema(z.object({ a: z.string().optional(), b: z.string().nullish(), c: z.array(z.string()).default([]) })) as Node;

    expect(converted.required).toEqual(['a', 'b', 'c']);
    const properties = converted.properties as Record<string, Node>;
    expect(properties.a).toEqual({ type: 'string' });
    expect(properties.b).toEqual({ type: ['string', 'null'] });
    expect(properties.c).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('closes nullable objects and arrays as well', () => {
    const converted = toStrictJsonSchema(
      z.object({ inner: z.object({ x: z.string().optional() }).nullable(), items: z.array(z.object({ y: z.string() })).nullable() }),
    );

    expectStrict(converted);
    expect(JSON.stringify(converted)).toContain('"additionalProperties":false');
  });

  it('closes nested objects, array items and unions', () => {
    const converted = toStrictJsonSchema(
      z.object({
        list: z.array(z.object({ x: z.number().min(1), y: z.string().optional() })),
        kind: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
      }),
    );

    expectStrict(converted);
    expect(JSON.stringify(converted)).not.toContain('minimum');
  });

  it.each([
    ['a free-form record', z.object({ map: z.record(z.string(), z.string()) })],
    ['a tuple', z.object({ pair: z.tuple([z.string(), z.number()]) })],
    ['an untyped value', z.object({ anything: z.unknown() })],
    ['a root that is not an object', z.array(z.string())],
  ])('gives up on %s, so the caller falls back to JSON mode', (_name, schema) => {
    expect(toStrictJsonSchema(schema)).toBeNull();
  });
});
