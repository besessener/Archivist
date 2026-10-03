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

const SENTENCES = ['Beschluss: Die Fassade wird gestrichen.', 'Beschluss: Das Dach wird erneuert.'];

/** Archives a document whose classification contains one decision per sentence; returns its id. */
async function archivedWithDecisions(name: string, sentences: string[]): Promise<string> {
  app.llm.on('DocumentClassification', () =>
    classification({
      title: name,
      summary: 'Protokoll',
      categoryPath: 'private/haus',
      decisions: sentences.map((s) => ({ title: s.slice(10, 30), decisionText: s, kind: 'decided', evidence: s, participants: [] })),
    }),
  );
  const imported = await app.ok('documents:import', { paths: [app.file(`in/${name}.txt`, `Protokoll ${name}\n${sentences.join('\n')}`)] });
  await app.services.jobs.whenIdle();
  const id = imported.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'private/haus' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

const proposals = () => app.ok('actions:list', { status: 'proposed', actionType: 'record_decision' });
const decide = (actionId: string, decision: 'approve' | 'reject') =>
  decision === 'approve'
    ? app.ok('actions:resolve', { decision, actionId, confirmed: true, strongConfirmed: false })
    : app.ok('actions:resolve', { decision, actionId });
const openExtracted = async () => (await app.ok('notifications:list', {})).filter((n) => n.type === 'file_has_decision');

describe('Reviewing decisions found in documents at archive scale (#181)', () => {
  it('pages through every decision proposal, beyond the newest 200', async () => {
    for (let i = 0; i < 230; i += 1) {
      app.services.actions.propose({
        actionType: 'record_decision',
        label: `Entscheidung ${i}`,
        rationale: 'x',
        confidence: 0.5,
        affectedEntities: [],
        requiredConfirmation: 'confirm',
        proposedParameters: { title: `Entscheidung ${i}`, decisionText: `Text ${i}`, participants: [], sourceIds: [] },
      });
    }

    const first = await app.ok('actions:list', { status: 'proposed', actionType: 'record_decision', limit: 200, offset: 0 });
    const rest = await app.ok('actions:list', { status: 'proposed', actionType: 'record_decision', limit: 200, offset: 200 });

    expect(first).toHaveLength(200);
    expect(rest).toHaveLength(30);
    expect(new Set([...first, ...rest].map((a) => a.id)).size).toBe(230);
  });

  it('filters by action type and fetches one action by id', async () => {
    const doc = await archivedWithDecisions('Protokoll Haus', SENTENCES);
    const [decision] = await proposals();

    expect(decision!.affectedEntities.map((e) => e.id)).toContain(doc);
    expect(await app.ok('actions:get', { id: decision!.id })).toMatchObject({ id: decision!.id, actionType: 'record_decision', status: 'proposed' });
    expect((await app.ok('actions:list', { status: 'proposed', actionType: 'create_open_item' })).every((a) => a.actionType === 'create_open_item')).toBe(true);
  });

  it('keeps the document notification open until every proposal is decided, then resolves it', async () => {
    await archivedWithDecisions('Protokoll Haus', SENTENCES);
    const [first, second] = await proposals();
    expect(await openExtracted()).toHaveLength(1);

    await decide(first!.id, 'approve');
    expect(await openExtracted()).toHaveLength(1);

    await decide(second!.id, 'reject');
    expect(await openExtracted()).toHaveLength(0);
    expect(await proposals()).toHaveLength(0);
  });

  it('offers to dismiss the notification without deciding its proposals, which stay reachable', async () => {
    await archivedWithDecisions('Protokoll Haus', SENTENCES);
    const [notification] = await openExtracted();

    expect(notification!.proposedActions.map((a) => a.kind)).toEqual(expect.arrayContaining(['confirm_action', 'navigate', 'ignore']));
    await app.ok('notifications:resolve', { id: notification!.id });

    expect(await openExtracted()).toHaveLength(0);
    expect(await proposals()).toHaveLength(2);
  });

  it('still requires the explicit confirmation to approve', async () => {
    await archivedWithDecisions('Protokoll Haus', SENTENCES);
    const [decision] = await proposals();

    const result = await app.call('actions:resolve', { decision: 'approve', actionId: decision!.id, strongConfirmed: false } as never);

    expect(result.ok).toBe(false);
    expect((await app.ok('actions:get', { id: decision!.id })).status).toBe('proposed');
  });
});
