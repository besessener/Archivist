import { afterEach, describe, expect, it } from 'vitest';
import { intent } from '../helpers/chat-intents';
import { createTestApp, type TestApp } from '../helpers/harness';
import { flatText } from '../helpers/link-texts';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

/** Words without anything in common, so that the notes holding the open proposals are not similar to each other. */
const UNRELATED =
  'Apfel Birne Kirsche Dattel Feige Gurke Hafer Ingwer Joghurt Kakao Linse Mango Nuss Olive Pfeffer Quitte Rettich Salbei Tomate Ulme Vanille Walnuss Zimt'.split(
    ' ',
  );

const note = async (name: string, description: string) => (await app.ok('knowledge:createEntity', { type: 'note', name, description })).entity.id;

/** `count` open proposals between notes in a chain (method `agent`, so the automatic methods' own counts stay apart). */
async function openProposals(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index <= count; index += 1) ids.push(await note(`Merkzettel ${UNRELATED[index]}`, `${UNRELATED[index]} kaufen`));
  for (let index = 0; index < count; index += 1)
    app.services.graph.link(
      { sourceId: ids[index]!, targetId: ids[index + 1]!, relationType: 'related_to' },
      { status: 'proposed', method: 'agent', confidence: 0.9 },
    );
  return ids;
}

const proposedBy = (method: string) =>
  (app.services.database.sqlite.prepare(`SELECT count(*) AS c FROM relations WHERE status = 'proposed' AND method = ?`).get(method) as { c: number }).c;

describe('At most 20 open proposals for the automatic link methods (#361)', () => {
  it('the retroactive run stops at the cap and says so; the job posts the promised notification', async () => {
    app = await createTestApp({ autoLinks: false });
    await openProposals(20);

    expect(await app.services.links.backfill()).toMatchObject({ processed: 0, done: false, stoppedAtLimit: true });

    await app.ok('links:startRun', {});
    await app.services.jobs.whenIdle();
    const notices = (await app.ok('notifications:list', {})).filter((n) => n.title === 'Verknüpfungsvorschläge');
    expect(notices.map((n) => n.description).join(' ')).toContain('20 Vorschläge warten auf deine Prüfung – erst danach geht es weiter.');
  });

  it('counts only the proposals the list shows: proposals of a discarded duplicate do not block the run', async () => {
    app = await createTestApp({ autoLinks: false });
    const hub = await note('Sammelnotiz', 'Kaffee kaufen');
    for (const word of UNRELATED.slice(0, 20))
      app.services.graph.link(
        { sourceId: hub, targetId: await note(`Merkzettel ${word}`, `${word} kaufen`), relationType: 'related_to' },
        { status: 'proposed', method: 'agent', confidence: 0.9 },
      );
    const kept = await note('Kaffee', 'Kaffee kaufen');
    app.services.database.sqlite.prepare('UPDATE entities SET duplicate_of_id = ? WHERE id = ?').run(kept, hub);
    expect(app.services.links.proposals().total).toBe(0);

    const result = await app.services.links.backfill();
    expect(result.processed).toBeGreaterThan(0);
    expect(result.stoppedAtLimit).toBe(false);
  });

  it('the archive check proposes no targets for entries without links while 20 proposals are open', async () => {
    app = await createTestApp({ autoLinks: false });
    await openProposals(21);
    for (const what of ['Mietvertrag', 'Nebenkosten', 'Kündigung', 'Übergabe']) await note(what, flatText(what));

    const orphans = await app.services.links.checkOrphans({ propose: true });
    expect(orphans.proposed).toBe(0);
    expect(app.services.links.proposals().total).toBe(21);
  });

  it('entries indexed at the cap wait and are proposed once the user has decided', async () => {
    app = await createTestApp({ autoLinks: false });
    await openProposals(20);
    app.services.settings.update({ links: { autoPropose: true } });
    for (const what of ['Mietvertrag', 'Nebenkosten', 'Kündigung']) await note(what, flatText(what));
    await app.services.jobs.whenIdle();
    expect(proposedBy('similarity')).toBe(0);

    expect(app.services.links.decideGroup({ groupBy: 'method', key: 'agent' }, { status: 'rejected' })).toBe(20);
    await app.services.jobs.whenIdle();
    expect(proposedBy('similarity')).toBeGreaterThan(0);
  });

  it('entries of one chat message are not proposed as linked while 20 proposals are open', async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: false });
    await openProposals(20);
    app.services.settings.update({ links: { autoPropose: true } });
    app.llm.on('ChatIntent', () => ({
      intents: [
        intent({ intent: 'open_item_new', segment: 'Offen: Angebot prüfen', openItem: { title: 'Angebot prüfen', dueAt: '2026-11-30' } }),
        intent({ intent: 'event_record', segment: 'Heute Termin beim Händler', event: { title: 'Termin beim Händler', occurredAt: '2026-10-02' } }),
      ],
    }));
    await app.ok('chat:send', { text: 'Offen: Angebot prüfen bis Ende November. Heute Termin beim Händler.' });
    await app.services.jobs.whenIdle();
    expect(proposedBy('co_origin')).toBe(0);
    expect(app.services.links.proposals().total).toBe(20);
  });

  it('a note is analysed only below the cap: its paid analysis waits until the user has decided, then runs once', async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: false });
    app.llm.on('NoteAnalysis', () => ({ topic: null, project: null, persons: [], tags: ['wohnung'] }));
    await openProposals(20);
    app.services.settings.update({ links: { autoPropose: true } });
    const flat = await app.services.notes.create({ title: 'Wohnung', content: 'Die Wohnung in der Hauptstraße.' });
    await app.services.jobs.whenIdle();
    const analyses = () => app.llm.calls.filter((c) => c.schema === 'NoteAnalysis').length;
    expect(analyses()).toBe(0);

    app.services.links.decideGroup({ groupBy: 'method', key: 'agent' }, { status: 'rejected' });
    await app.services.jobs.whenIdle();
    expect(analyses()).toBe(1);
    expect(proposedBy('analysis')).toBe(1);
    // checked now: the retroactive run leaves it alone
    expect(app.services.database.sqlite.prepare('SELECT 1 FROM link_scans WHERE entity_id = ?').get(flat.id)).toBeTruthy();
  });
});

describe('Same day and person (#278)', () => {
  it('proposes at most 3 open proposals per entry, counting both ends – also over repeated runs', async () => {
    app = await createTestApp({ autoLinks: false });
    const events = UNRELATED.slice(0, 12).map(
      (word) => app.services.eventRecords.create({ title: `Termin ${word}`, occurredAt: '2026-09-01', participants: ['Anna Berger'], sourceIds: [] }).id,
    );
    const openDatePerson = (id: string) =>
      app.services.graph.relationsOf(id, { statuses: ['proposed'] }).filter((relation) => relation.method === 'date_person').length;

    await app.ok('links:scan', { id: events[0]! });
    app.services.links.forgetScan(events[0]!);
    await app.ok('links:scan', { id: events[0]! });
    expect(openDatePerson(events[0]!)).toBe(3);

    app.services.links.restartBackfill();
    await app.services.links.backfill();
    for (const id of events) expect(openDatePerson(id)).toBeLessThanOrEqual(3);
  });
});
