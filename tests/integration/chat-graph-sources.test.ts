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
    const offer = await archived(app, {
      name: 'angebot.md',
      content: 'Angebot des Dachdeckers Kowalski über 18.000 Euro für die Dachsanierung.',
      folder: 'Privat/haus',
    });
    // the decision text shares no word with the question
    const decision = decide('Sanierung beauftragt', 'Wir beauftragen die Firma für die Arbeiten im Frühjahr.');
    app.services.graph.link(
      { sourceId: offer, targetId: decision.id, relationType: 'supports' },
      { status: 'confirmed', resolvedByUser: true, method: 'manual' },
    );

    const res = await app.ok('chat:send', { text: 'Was stand im Angebot von Kowalski?' });
    const sources = res.assistantMessage.sources;
    expect(sources.map((s) => s.id)).toEqual(expect.arrayContaining([offer, decision.id]));
    expect(sources.find((s) => s.id === decision.id)!.via).toBe('„angebot“ stützt diesen Eintrag');
    expect(knowledgeInput()).toContain('Hinzugekommen über die bestätigte Verknüpfung: „angebot“ stützt diesen Eintrag');
    expect(knowledgeInput()).toContain('Wir beauftragen die Firma');
  });

  it('proposed, rejected and outdated relations are never used', async () => {
    const offer = await archived(app, { name: 'angebot.md', content: 'Angebot des Dachdeckers Kowalski über 18.000 Euro.', folder: 'Privat/haus' });
    const ids = [
      decide('Eins', 'Erster Beschluss zu den Arbeiten.').id,
      decide('Zwei', 'Zweiter Beschluss zu den Arbeiten.').id,
      decide('Drei', 'Dritter Beschluss zu den Arbeiten.').id,
    ];
    app.services.graph.link({ sourceId: offer, targetId: ids[0]!, relationType: 'supports' }, { status: 'proposed', method: 'analysis' });
    const rejected = app.services.graph.link({ sourceId: offer, targetId: ids[1]!, relationType: 'supports' }, { status: 'proposed', method: 'analysis' })!;
    app.services.graph.decideRelation(rejected.id, { status: 'rejected' });
    const outdated = app.services.graph.link({ sourceId: offer, targetId: ids[2]!, relationType: 'supports' }, { status: 'confirmed' })!;
    app.services.graph.setRelationStatus(outdated.id, { status: 'outdated', by: 'system' });

    const res = await app.ok('chat:send', { text: 'Was stand im Angebot von Kowalski?' });
    expect(res.assistantMessage.sources.some((s) => ids.includes(s.id))).toBe(false);
    expect(res.assistantMessage.sources.some((s) => s.via)).toBe(false);
  });
});

describe('Near-duplicate documents do not use up answer slots (#308)', () => {
  const offerText = (n: number) =>
    n === 0
      ? 'Angebot Kowalski Dachdecker Angebote Kowalski Dachdecker. '.repeat(6)
      : `Angebot Nummer ${n} des Dachdeckers Kowalski für die Dachsanierung, Position ${n * 7} Dachziegel und Arbeitszeit.`;

  it('collapses same file, same text and confirmed duplicates, so further distinct sources fit', async () => {
    const best = await archived(app, { name: 'angebot-0.md', content: offerText(0), folder: 'Privat/haus' });
    const sameText = await archived(app, { name: 'angebot-0-kopie.md', content: `${offerText(0)} `, folder: 'Privat/haus' });
    const sameFile = await archived(app, { name: 'angebot-0-scan.md', content: `${offerText(0)} Scan.`, folder: 'Privat/haus' });
    const linked = await archived(app, { name: 'angebot-0-alt.md', content: `${offerText(0)} Alte Fassung.`, folder: 'Privat/haus' });
    const sha = app.services.documents.getRow(best).sha256;
    app.services.ctx.database.sqlite.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run(sha, sameFile);
    app.services.graph.link(
      { sourceId: linked, targetId: best, relationType: 'duplicate_of' },
      { status: 'confirmed', resolvedByUser: true, method: 'manual' },
    );
    const distinct: string[] = [];
    for (let n = 1; n <= 9; n++) distinct.push(await archived(app, { name: `angebot-${n}.md`, content: offerText(n), folder: 'Privat/haus' }));

    app.llm.on('KnowledgeAnswer', () => ({
      answer: 'Antwort.',
      facts: [],
      uncertainties: [],
      contradictions: [],
      missingInformation: [],
      usedSourceIds: Array.from({ length: 14 }, (_, i) => `S${i + 1}`),
      confidence: 0.8,
    }));
    const res = await app.ok('chat:send', { text: 'Was stand in den Angeboten von Kowalski?' });

    const ids = res.assistantMessage.sources.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(distinct));
    expect(ids.filter((id) => [best, sameText, sameFile, linked].includes(id))).toHaveLength(1);
  });
});
