import { describe, expect, it } from 'vitest';
import { ChatMessage, EntityType, RefType } from '@archivist/shared';
import { ENTITY_TYPE_LABELS, entityHref } from '../../apps/renderer/lib/nav';

describe('Verweisziele im Renderer (entityHref)', () => {
  it('führt jede Verweisart zur passenden Ansicht', () => {
    expect(entityHref('document', 'd 1')).toBe('/documents/?id=d%201');
    expect(entityHref('decision', 'x')).toBe('/decisions/?id=x');
    expect(entityHref('task', 'x')).toBe('/open-items/');
    expect(entityHref('question', 'x')).toBe('/open-items/');
    expect(entityHref('reminder', 'rem-1')).toBe('/open-items/');
    expect(entityHref('contradiction', 'c-1')).toBe('/insights/');
    expect(entityHref('note', 'n-1')).toBe('/knowledge/?id=n-1');
    expect(entityHref('topic', 't-1')).toBe('/knowledge/?id=t-1');
  });

  it('hat für jede Verweisart eine Bezeichnung', () => {
    for (const t of RefType.options) expect(ENTITY_TYPE_LABELS[t]).toBeTruthy();
    expect(ENTITY_TYPE_LABELS.reminder).toBe('Erinnerung');
    expect(ENTITY_TYPE_LABELS.contradiction).toBe('Widerspruch');
  });

  it('Verweisarten erweitern die Wissensobjekte, ohne gespeicherte Nachrichten ungültig zu machen', () => {
    expect(EntityType.options.every((t) => RefType.options.includes(t))).toBe(true);
    expect(EntityType.safeParse('reminder').success).toBe(false);
    // alte Nachricht: Erinnerung noch als Notiz, Widerspruch noch als Entscheidung gespeichert
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
    const neu = {
      ...old,
      sources: [{ id: 'r1', type: 'reminder', title: 'E' }],
      context: { contradictions: [{ type: 'contradiction', id: 'k1', label: 'W' }] },
    };
    expect(ChatMessage.safeParse(neu).success).toBe(true);
  });
});
