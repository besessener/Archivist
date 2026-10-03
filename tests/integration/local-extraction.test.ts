import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.services.settings.update({ privacy: { llmMode: 'local_only' } });
});
afterEach(async () => {
  await app.cleanup();
});

const MINUTES_EN = [
  'Meeting minutes 2026-05-12',
  'Attendees: Anna Berg, Ben Roth and Carla Neu (project lead)',
  'We decided to move the launch to September.',
  'The budget is still to be confirmed.',
].join('\n');

async function archiveOffline(path: string, text: string) {
  const imported = await app.ok('documents:import', { paths: [app.file(path, text)] });
  await app.services.jobs.whenIdle();
  const id = imported.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'Arbeit/meetings' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

describe('Local analysis builds a graph without an LLM (#196)', () => {
  it('finds people on attendee lines and a topic from the folder, and proposes English decisions and open items', async () => {
    const id = await archiveOffline('in/Hausbau Bern/minutes.txt', MINUTES_EN);

    const doc = await app.ok('documents:get', { id });
    expect(doc.proposal?.analyzedBy).toBe('local');
    expect(doc.persons).toEqual(['Anna Berg', 'Ben Roth', 'Carla Neu']);
    expect(doc.topicName).toBe('Hausbau Bern');
    const actions = await app.ok('actions:list', { status: 'proposed' });
    expect(actions.filter((a) => a.actionType === 'record_decision').map((a) => a.proposedParameters.decisionText)).toEqual([
      'We decided to move the launch to September.',
    ]);
    expect(actions.some((a) => a.actionType === 'create_open_item')).toBe(true);
    expect(app.services.graph.listEntities({ type: 'person' }).map((p) => p.name)).toEqual(expect.arrayContaining(['Anna Berg', 'Ben Roth', 'Carla Neu']));
  });

  it('still reads German minutes and does not take a generic folder as a topic', async () => {
    const id = await archiveOffline(
      'in/Downloads/protokoll.txt',
      'Protokoll\nTeilnehmer: Dora Klein, Emil Voss\nWir haben beschlossen, den Termin zu verschieben.',
    );

    const doc = await app.ok('documents:get', { id });
    expect(doc.persons).toEqual(['Dora Klein', 'Emil Voss']);
    expect(doc.topicName).toBeNull();
    expect((await app.ok('actions:list', { status: 'proposed', actionType: 'record_decision' })).length).toBe(1);
  });
});
