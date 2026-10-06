import { describe, expect, it } from 'vitest';
import { ChatMessage, EntityType, RefType } from '@archivist/shared';
import { ENTITY_TYPE_LABELS, ENTITY_TYPE_TONES, entityHref } from '../../apps/renderer/lib/nav';
import { SECTIONS, sectionOf } from '../../apps/renderer/lib/sections';

describe('link targets in the renderer (entityHref)', () => {
  it('leads every reference type to the matching view', () => {
    expect(entityHref('document', 'd 1')).toBe('/documents/?id=d%201');
    expect(entityHref('decision', 'x')).toBe('/decisions/?id=x');
    expect(entityHref('task', 'x')).toBe('/open-items/');
    expect(entityHref('question', 'x')).toBe('/open-items/');
    expect(entityHref('reminder', 'rem-1')).toBe('/open-items/');
    expect(entityHref('contradiction', 'c-1')).toBe('/insights/');
    expect(entityHref('note', 'n-1')).toBe('/knowledge/?id=n-1');
    expect(entityHref('topic', 't-1')).toBe('/knowledge/?id=t-1');
  });

  it('has a label for every reference type', () => {
    for (const t of RefType.options) expect(ENTITY_TYPE_LABELS[t]).toBeTruthy();
    expect(ENTITY_TYPE_LABELS.reminder).toBe('Erinnerung');
    expect(ENTITY_TYPE_LABELS.contradiction).toBe('Widerspruch');
  });

  it('reference types extend the knowledge objects without invalidating saved messages', () => {
    expect(EntityType.options.every((t) => RefType.options.includes(t))).toBe(true);
    expect(EntityType.safeParse('reminder').success).toBe(false);
    // old message: reminder still stored as a note, contradiction still stored as a decision
    const old = {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      content: 'x',
      createdAt: '2026-01-01T00:00:00Z',
      sources: [{ id: 'r1', type: 'note', title: 'Erinnerung' }],
      context: { contradictions: [{ type: 'decision', id: 'k1', label: 'W' }] },
      actions: [],
      confidence: null,
      uncertainties: [],
      intent: null,
      errorMessage: null,
    };
    expect(ChatMessage.safeParse(old).success).toBe(true);
    const current = {
      ...old,
      sources: [{ id: 'r1', type: 'reminder', title: 'E' }],
      context: { contradictions: [{ type: 'contradiction', id: 'k1', label: 'W' }] },
    };
    expect(ChatMessage.safeParse(current).success).toBe(true);
  });
});

describe('colours of object types and sections', () => {
  it('gives every reference type a colour, related types the same one', () => {
    for (const t of RefType.options) expect(ENTITY_TYPE_TONES[t]).toBeTruthy();
    expect(ENTITY_TYPE_TONES.question).toBe(ENTITY_TYPE_TONES.task);
    expect(ENTITY_TYPE_TONES.case).toBe(ENTITY_TYPE_TONES.project);
    expect(ENTITY_TYPE_TONES.contradiction).toBe('danger');
  });

  it('finds the section of a route, sub-routes included, and none for an unknown route', () => {
    expect(sectionOf('/open-items/')?.label).toBe('Offene Punkte');
    expect(sectionOf('/decisions/proposed/')?.label).toBe('Entscheidungen');
    expect(sectionOf('/knowledge/')?.tone).toBe('topic');
    expect(sectionOf('/')).toBeUndefined();
    expect(new Set(SECTIONS.map((section) => section.testId)).size).toBe(SECTIONS.length);
  });
});
