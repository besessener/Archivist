import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

// #199: document text never becomes „known“ context for later prompts; far-reaching proposals need more than a plain yes.
let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const intent = { intents: [{ intent: 'smalltalk', confidence: 0.9, rationale: 'test' }] };
const topic = (name: string) => app.services.graph.findByName('topic', name);
const lastInput = (schema: string) => app.llm.calls.filter((c) => c.schema === schema).at(-1)!.input;
const knownTopicsLine = (input: string) => /Bekannte Themen: (.*)/.exec(input)?.[1] ?? '';

async function archiveWithTopic(name: string, proposedTopic: string, chosenTopic = proposedTopic): Promise<string> {
  app.llm.on('DocumentClassification', () =>
    classification({ title: name, summary: `Zusammenfassung ${name}`, categoryPath: 'private/notizen', mainTopic: proposedTopic }),
  );
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}.txt`, `Inhalt von ${name}`)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'private/notizen', topic: chosenTopic }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

describe('Topics taken from documents stay unconfirmed (#199)', () => {
  it('are marked unconfirmed and are not named to the model as known topics', async () => {
    await archiveWithTopic('Rundschreiben', 'Gartenpflege');
    expect(topic('Gartenpflege')?.unconfirmed).toBe(true);

    app.llm.on('ChatIntent', () => intent);
    await app.ok('chat:send', { text: 'Hallo' });
    expect(knownTopicsLine(lastInput('ChatIntent'))).not.toContain('Gartenpflege');

    await archiveWithTopic('Zweites', 'Anderes Thema');
    expect(knownTopicsLine(lastInput('DocumentClassification'))).not.toContain('Gartenpflege');
  });

  it('once confirmed they are listed', async () => {
    await archiveWithTopic('Rundschreiben', 'Gartenpflege');
    const confirmed = await app.ok('knowledge:confirmEntity', { id: topic('Gartenpflege')!.id });
    expect(confirmed.unconfirmed).toBeUndefined();

    app.llm.on('ChatIntent', () => intent);
    await app.ok('chat:send', { text: 'Hallo' });
    expect(knownTopicsLine(lastInput('ChatIntent'))).toContain('Gartenpflege');
  });

  it('a topic the user typed instead of the proposed one is confirmed', async () => {
    await archiveWithTopic('Rundschreiben', 'Gartenpflege', 'Haus und Garten');
    expect(topic('Haus und Garten')?.unconfirmed).toBeUndefined();
  });

  it('using the name elsewhere (e.g. in a decision) confirms it', async () => {
    await archiveWithTopic('Rundschreiben', 'Gartenpflege');
    await app.ok('decisions:create', {
      title: 'Rasen',
      decisionText: 'Wir mähen den Rasen nur noch alle zwei Wochen.',
      topic: 'Gartenpflege',
      decidedAt: '2026-05-01',
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: false,
    });
    expect(topic('Gartenpflege')?.unconfirmed).toBeUndefined();
  });
});

describe('Relocating many documents is especially far-reaching (#199)', () => {
  const propose = (n: number) =>
    app.services.actions.propose({
      actionType: 'relocate_documents',
      label: `${n} Dokumente verschieben`,
      rationale: 'test',
      confidence: 0.8,
      affectedEntities: [],
      requiredConfirmation: 'confirm',
      proposedParameters: { items: Array.from({ length: n }, (_, i) => ({ documentId: `doc-${i}`, categoryPath: 'privat/ziel' })) },
    });

  it('from 20 documents the proposal needs the strong confirmation', async () => {
    expect(propose(19).requiredConfirmation).toBe('confirm');
    const big = propose(20);
    expect(big.requiredConfirmation).toBe('strong');
    const denied = await app.call('actions:resolve', { decision: 'approve', actionId: big.id, confirmed: true, strongConfirmed: false });
    expect(denied.ok).toBe(false);
  });
});
