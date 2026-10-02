import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { archived } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('KnowledgeAnswer', () => ({
    answer: 'Antwort.',
    facts: [],
    uncertainties: [],
    contradictions: [],
    missingInformation: [],
    usedSourceIds: ['S1', 'S2'],
    confidence: 0.8,
  }));
  app.llm.on('ChatIntent', () => ({ intent: 'knowledge_question', confidence: 0.9, rationale: 'test', query: 'Angebot Dachdecker Kowalski' }));
});
afterEach(async () => {
  await app.cleanup();
});

const knowledgeInput = () => app.llm.calls.find((c) => c.schema === 'KnowledgeAnswer')?.input ?? '';
const decide = (title: string, text: string) =>
  app.services.decisions.create({
    decisionText: text,
    title,
    decidedAt: '2026-09-10',
    participants: [],
    alternatives: [],
    unknownFields: [],
    asDraft: false,
    sourceIds: [],
    confidence: 0.9,
  });

describe('Knowledge answers use the knowledge graph (#289)', () => {
  it('a question about a document also finds the decision the document supports – with the relation as path', async () => {
    const offer = await archived(app, 'angebot.md', 'Angebot des Dachdeckers Kowalski über 18.000 Euro für die Dachsanierung.', 'private/haus');
    // the decision text shares no word with the question
    const decision = decide('Sanierung beauftragt', 'Wir beauftragen die Firma für die Arbeiten im Frühjahr.');
    app.services.graph.link(offer, decision.id, 'supports', { status: 'confirmed', resolvedByUser: true, method: 'manual' });

    const res = await app.ok('chat:send', { text: 'Was stand im Angebot von Kowalski?' });
    const sources = res.assistantMessage.sources;
    expect(sources.map((s) => s.id)).toEqual(expect.arrayContaining([offer, decision.id]));
    expect(sources.find((s) => s.id === decision.id)!.via).toBe('„angebot“ stützt diesen Eintrag');
    expect(knowledgeInput()).toContain('Hinzugekommen über die bestätigte Verknüpfung: „angebot“ stützt diesen Eintrag');
    expect(knowledgeInput()).toContain('Wir beauftragen die Firma');
  });

  it('proposed, rejected and outdated relations are never used', async () => {
    const offer = await archived(app, 'angebot.md', 'Angebot des Dachdeckers Kowalski über 18.000 Euro.', 'private/haus');
    const ids = [
      decide('Eins', 'Erster Beschluss zu den Arbeiten.').id,
      decide('Zwei', 'Zweiter Beschluss zu den Arbeiten.').id,
      decide('Drei', 'Dritter Beschluss zu den Arbeiten.').id,
    ];
    app.services.graph.link(offer, ids[0]!, 'supports', { status: 'proposed', method: 'analysis' });
    const rejected = app.services.graph.link(offer, ids[1]!, 'supports', { status: 'proposed', method: 'analysis' })!;
    app.services.graph.decideRelation(rejected.id, 'rejected');
    const outdated = app.services.graph.link(offer, ids[2]!, 'supports', { status: 'confirmed' })!;
    app.services.graph.setRelationStatus(outdated.id, 'outdated', 'system');

    const res = await app.ok('chat:send', { text: 'Was stand im Angebot von Kowalski?' });
    expect(res.assistantMessage.sources.some((s) => ids.includes(s.id))).toBe(false);
    expect(res.assistantMessage.sources.some((s) => s.via)).toBe(false);
  });
});
