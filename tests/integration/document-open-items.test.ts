import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

type OpenItemHit = { title: string; description?: string | null; dueAt?: string | null; responsible?: string | null };

/** Dokument importieren, (Fake-)LLM klassifizieren lassen und archivieren – erkannte offene Punkte werden vorgeschlagen. */
async function archived(name: string, openItems: OpenItemHit[]): Promise<string> {
  app.llm.on('DocumentClassification', () => ({
    docType: 'Protokoll',
    title: name,
    summary: `Zusammenfassung ${name}`,
    mainTopic: 'Hausrenovierung',
    project: null,
    persons: [],
    dates: [],
    tags: [],
    location: { categoryPath: 'private/haus', fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems,
    confidence: 0.7,
    rationale: 'x',
  }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}.txt`, `Inhalt von ${name}`)] });
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

const proposedFor = async (documentId: string) =>
  (await app.ok('actions:list', { status: 'proposed' })).filter((a) => a.affectedEntities.some((e) => e.id === documentId));

const approve = (actionId: string) => app.ok('actions:resolve', { decision: 'approve', actionId, confirmed: true, strongConfirmed: false });

const ANGEBOT: OpenItemHit = {
  title: 'Angebot für Dachdämmung einholen',
  description: 'Mindestens zwei Angebote vergleichen.',
  dueAt: '2026-11-15',
  responsible: 'Anna Schmidt',
};

describe('Offene Punkte aus Dokumenten', () => {
  it('übernimmt Verantwortlichen, Fälligkeit und Beschreibung und verknüpft den Punkt mit dem Dokument', async () => {
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

  it('schlägt beim selben Punkt in einem zweiten Dokument „um Quelle ergänzen“ vor statt einen neuen Punkt', async () => {
    const first = await archived('Protokoll Baubesprechung', [{ title: ANGEBOT.title }]);
    await approve((await proposedFor(first))[0]!.id);

    const second = await archived('Protokoll Folgetermin', [ANGEBOT]);
    const [action] = await proposedFor(second);
    expect(action!.actionType).toBe('add_open_item_source');
    expect(action!.label).toBe(`Punkt „${ANGEBOT.title}“ um Quelle ergänzen`);
    expect((await approve(action!.id)).status).toBe('executed');

    const items = await app.ok('openItems:list', {});
    expect(items).toHaveLength(1);
    // fehlende Angaben kommen aus der neuen Quelle dazu
    expect(items[0]).toMatchObject({ sourceIds: [first, second], description: ANGEBOT.description, responsibleName: 'Anna Schmidt' });
    expect(items[0]!.dueAt?.slice(0, 10)).toBe('2026-11-15');

    const targets = app.services.graph.relationsOf(items[0]!.id, { types: ['results_from'] }).map((r) => r.targetEntityId);
    expect(targets.sort()).toEqual([first, second].sort());
  });

  it('legt einen anderen Punkt aus dem zweiten Dokument weiterhin neu an', async () => {
    const first = await archived('Protokoll Baubesprechung', [ANGEBOT]);
    await approve((await proposedFor(first))[0]!.id);

    const second = await archived('Protokoll Folgetermin', [{ title: 'Gerüst für die Fassade bestellen' }]);
    expect((await proposedFor(second)).map((a) => a.actionType)).toEqual(['create_open_item']);
  });
});
