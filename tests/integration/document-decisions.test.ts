import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

type FoundDecision = {
  title: string;
  decisionText: string;
  decidedAt?: string | null;
  participants?: string[];
  kind?: string | null;
  evidence?: string | null;
};

const PROTOKOLL = [
  'Protokoll der Eigentümerversammlung vom 12.05.2026. Anwesend: Anna, Ben, Carla, Dieter, Eva und Gerd.',
  'Beschluss: Die Fassade wird im Herbst gestrichen.',
  'Über eine neue Heizung wurde gesprochen, entschieden ist noch nichts.',
].join('\n');

/** Imports and archives a document whose (fake) classification contains the given decisions. */
async function archived(decisions: FoundDecision[], text = PROTOKOLL): Promise<string> {
  app.llm.on('DocumentClassification', () =>
    classification({
      title: 'Eigentümerversammlung',
      summary: 'Protokoll',
      categoryPath: 'private/haus',
      docType: 'Protokoll',
      mainTopic: 'Hausverwaltung',
      persons: ['Anna', 'Ben', 'Carla', 'Dieter', 'Eva', 'Gerd'],
      decisions: decisions.map((d) => ({ participants: [], ...d })),
    }),
  );
  const imp = await app.ok('documents:import', { paths: [app.file('in/protokoll.txt', text)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'private/haus' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

const decisionProposals = async (documentId: string) =>
  (await app.ok('actions:list', { status: 'proposed' })).filter(
    (a) => a.actionType === 'record_decision' && a.affectedEntities.some((e) => e.id === documentId),
  );
const approve = (actionId: string) => app.ok('actions:resolve', { decision: 'approve', actionId, confirmed: true, strongConfirmed: false });

const FASSADE: FoundDecision = {
  title: 'Fassade streichen',
  decisionText: 'Die Fassade wird im Herbst gestrichen.',
  decidedAt: '2026-05-12',
  kind: 'decided',
  evidence: 'Beschluss: Die Fassade wird im Herbst gestrichen.',
};

describe('Decisions from documents: decided vs. discussed, verbatim evidence (#175)', () => {
  it('proposes only what was decided and has a sentence of the document as evidence', async () => {
    const doc = await archived([
      FASSADE,
      { title: 'Neue Heizung', decisionText: 'Eine neue Heizung wird eingebaut.', kind: 'discussed', evidence: 'Über eine neue Heizung wurde gesprochen' },
      { title: 'Erfunden', decisionText: 'Das Dach wird erneuert.', kind: 'decided', evidence: 'Beschluss: Das Dach wird erneuert.' },
      { title: 'Ohne Beleg', decisionText: 'Der Garten wird neu angelegt.', kind: 'decided' },
    ]);

    const proposals = await decisionProposals(doc);
    expect(proposals.map((p) => p.proposedParameters.title)).toEqual(['Fassade streichen']);
    expect(proposals[0]!.proposedParameters).toMatchObject({ kind: 'decided', evidence: FASSADE.evidence });
  });

  it('the approved decision keeps its origin and evidence, and answers quote it', async () => {
    const doc = await archived([FASSADE]);
    const [proposal] = await decisionProposals(doc);
    await approve(proposal!.id);

    const [decision] = await app.ok('decisions:list', {});
    expect(decision).toMatchObject({ origin: 'document', evidence: FASSADE.evidence, sourceIds: [doc] });

    app.llm.on('ChatIntent', () => ({ intent: 'knowledge_question', confidence: 0.9, rationale: 'x', query: 'Fassade gestrichen' }));
    app.llm.on('KnowledgeAnswer', () => ({
      answer: 'Ja.',
      facts: [],
      uncertainties: [],
      contradictions: [],
      missingInformation: [],
      usedSourceIds: ['S1'],
      confidence: 0.8,
    }));
    await app.ok('chat:send', { text: 'Was haben wir zur Fassade entschieden?' });
    const input = app.llm.calls.find((c) => c.schema === 'KnowledgeAnswer')!.input;
    expect(input).toContain('Herkunft: aus einem Dokument übernommen');
    expect(input).toContain(`Wörtlich im Dokument: „${FASSADE.evidence}“`);
  });

  it('decisions captured in the chat or the form carry their origin', async () => {
    const formDecision = await app.ok('decisions:create', {
      decisionText: 'Wir sparen.',
      participants: [],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: true,
    });
    expect(formDecision).toMatchObject({ origin: 'form', evidence: null });
  });
});

describe('Decisions from documents get their own participants (#178)', () => {
  it('takes the participants the classification names for the decision, not the first persons of the document', async () => {
    const doc = await archived([{ ...FASSADE, participants: ['Gerd'] }]);
    const [proposal] = await decisionProposals(doc);
    expect(proposal!.proposedParameters.participants).toEqual(['Gerd']);

    await approve(proposal!.id);
    const [decision] = await app.ok('decisions:list', {});
    expect(decision!.participants).toEqual(['Gerd']);
    expect(decision!.status).toBe('confirmed');
  });

  it('without named participants the decision is still complete (#198)', async () => {
    const doc = await archived([FASSADE]);
    const [proposal] = await decisionProposals(doc);
    expect(proposal!.proposedParameters.participants).toEqual([]);

    await approve(proposal!.id);
    const [decision] = await app.ok('decisions:list', {});
    expect(decision!.participants).toEqual([]);
    expect(decision!.missingFields).not.toContain('participants');
  });

  it('proposes every decision found, not only the first three', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `Beschluss ${i + 1}: Punkt ${i + 1} wird umgesetzt.`);
    const doc = await archived(
      lines.map((l, i) => ({ title: `Punkt ${i + 1}`, decisionText: l, kind: 'decided', evidence: l })),
      `Protokoll\n${lines.join('\n')}`,
    );
    expect(await decisionProposals(doc)).toHaveLength(5);
  });
});
