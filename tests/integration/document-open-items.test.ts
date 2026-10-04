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

type OpenItemHit = { title: string; description?: string | null; dueAt?: string | null; responsible?: string | null };

/** Import a document, let the (fake) LLM classify it and archive it – detected open items are proposed. */
async function archived(name: string, openItems: OpenItemHit[]): Promise<string> {
  app.llm.on('DocumentClassification', () =>
    classification({
      title: name,
      summary: `Zusammenfassung ${name}`,
      categoryPath: 'Privat/haus',
      docType: 'Protokoll',
      mainTopic: 'Hausrenovierung',
      openItems,
    }),
  );
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}.txt`, `Inhalt von ${name}`)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'Privat/haus' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

const proposedFor = async (documentId: string) =>
  (await app.ok('actions:list', { status: 'proposed' })).filter((a) => a.affectedEntities.some((e) => e.id === documentId));

const approve = (actionId: string) => app.ok('actions:resolve', { decision: 'approve', actionId, confirmed: true, strongConfirmed: false });

const ANGEBOT: OpenItemHit = {
  title: 'Angebot für Dachdämmung einholen',
  description: 'Mindestens zwei Angebote vergleichen.',
  dueAt: '2026-11-15',
  responsible: 'Anna Schmidt',
};

describe('Open items from documents', () => {
  it('takes over responsible person, due date and description and links the item to the document', async () => {
    const doc = await archived('Protokoll Baubesprechung', [ANGEBOT]);

    const [action] = await proposedFor(doc);
    expect(action!.actionType).toBe('create_open_item');
    expect(action!.proposedParameters).toMatchObject({ responsible: 'Anna Schmidt', dueAt: '2026-11-15' });
    expect((await approve(action!.id)).status).toBe('executed');

    const [item] = await app.ok('openItems:list', {});
    expect(item).toMatchObject({ title: ANGEBOT.title, description: ANGEBOT.description, responsibleName: 'Anna Schmidt', sourceIds: [doc] });
    expect(item!.dueAt?.slice(0, 10)).toBe('2026-11-15');

    const rel = app.services.graph.relationsOf(item!.id, { types: ['results_from'] });
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ sourceEntityId: item!.id, targetEntityId: doc, status: 'confirmed' });
  });

  it('proposes „um Quelle ergänzen“ for the same item in a second document instead of a new item', async () => {
    const first = await archived('Protokoll Baubesprechung', [{ title: ANGEBOT.title }]);
    await approve((await proposedFor(first))[0]!.id);

    const second = await archived('Protokoll Folgetermin', [ANGEBOT]);
    const [action] = await proposedFor(second);
    expect(action!.actionType).toBe('add_open_item_source');
    expect(action!.label).toBe(`Punkt „${ANGEBOT.title}“ um Quelle ergänzen`);
    expect((await approve(action!.id)).status).toBe('executed');

    const items = await app.ok('openItems:list', {});
    expect(items).toHaveLength(1);
    // missing details are added from the new source
    expect(items[0]).toMatchObject({ sourceIds: [first, second], description: ANGEBOT.description, responsibleName: 'Anna Schmidt' });
    expect(items[0]!.dueAt?.slice(0, 10)).toBe('2026-11-15');

    const targets = app.services.graph.relationsOf(items[0]!.id, { types: ['results_from'] }).map((r) => r.targetEntityId);
    expect(targets.sort()).toEqual([first, second].sort());
  });

  it('still creates a different item from the second document as new', async () => {
    const first = await archived('Protokoll Baubesprechung', [ANGEBOT]);
    await approve((await proposedFor(first))[0]!.id);

    const second = await archived('Protokoll Folgetermin', [{ title: 'Gerüst für die Fassade bestellen' }]);
    expect((await proposedFor(second)).map((a) => a.actionType)).toEqual(['create_open_item']);
  });
  const EINSPRUCH = 'Beschluss: Wir legen Einspruch ein.';

  it('proposes open items and decisions with the topic and project chosen in the archive dialog', async () => {
    app.llm.on('DocumentClassification', () =>
      classification({
        title: 'Steuerbescheid',
        summary: 'Bescheid',
        categoryPath: 'Privat/haus',
        mainTopic: 'Steuer',
        project: 'Haushalt',
        openItems: [ANGEBOT],
        decisions: [{ title: 'Einspruch', decisionText: EINSPRUCH, kind: 'decided', evidence: EINSPRUCH, participants: [] }],
      }),
    );
    const imp = await app.ok('documents:import', { paths: [app.file('in/bescheid.txt', `Bescheid\n${EINSPRUCH}`)] });
    await app.services.jobs.whenIdle();
    const doc = imp.imported[0]!.id;
    await app.ok('documents:archive', {
      items: [{ documentId: doc, mode: 'copy', categoryPath: 'Privat/haus', topic: 'Finanzamt 2024', project: '' }],
      confirmed: true,
      approveNewCategories: [],
      confirmMove: false,
    } as never);

    const params = (await proposedFor(doc)).map((a) => [a.actionType, a.proposedParameters]);
    expect(params).toEqual(
      expect.arrayContaining([
        ['create_open_item', expect.objectContaining({ topic: 'Finanzamt 2024', project: null })],
        ['record_decision', expect.objectContaining({ topic: 'Finanzamt 2024', project: null })],
      ]),
    );
    expect(params).toHaveLength(2);
  });
});
