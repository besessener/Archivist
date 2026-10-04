import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/harness';
import { agentApp, lastToolOutput, scriptedTurns } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

const subjectsOf = async (id: string) => (await app.ok('subjects:of', { ids: [id] }))[id]!;
/** The model's ref (K…) of a listed entry, from the tool results it got so far. */
const refOf = (name: string) => {
  const outputs = ((app.llm.agentRequests.at(-1)?.input as Array<{ output?: string }>) ?? []).flatMap((i) => (i.output ?? '').split('\n'));
  const line = outputs.find((l) => l.includes(name));
  const ref = line && /K\d+/.exec(line)?.[0];
  if (!ref) throw new Error(`no ref for ${name}`);
  return ref;
};
/** Lists the entries first (the model only knows refs), then calls `calls(ref)`; `check` sees the last tool output. */
const ask = (
  list: Array<{ name: string; args: Record<string, unknown> }>,
  calls: () => Array<{ name: string; args: Record<string, unknown> }>,
  check?: (out: string) => void,
) =>
  scriptedTurns(
    { calls: list },
    () => ({ calls: calls() }),
    () => {
      check?.(lastToolOutput(app));
      return { text: 'Erledigt.' };
    },
  );
const listNotesAndItems = [
  { name: 'list_entries', args: { kind: 'open_item' } },
  { name: 'list_entries', args: { kind: 'note' } },
];

describe('The agent controls the linking features of Epic #269', () => {
  it('set_metadata adds further topics and projects instead of replacing, removes them again, puts entries into a case, tags notes', async () => {
    const item = await app.ok('openItems:create', { title: 'Wärmepumpe beantragen', topic: 'Heizung' });
    const note = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Förderung', description: 'BAFA-Antrag' })).entity;
    const c = (await app.ok('cases:create', { name: 'Sanierung' })).case;

    app.llm.agent = ask(
      listNotesAndItems,
      () => [
        {
          name: 'set_metadata',
          args: {
            targets: [refOf('Wärmepumpe'), refOf('BAFA-Antrag')],
            addTopics: ['Förderung'],
            addProjects: ['Haus 2026'],
            case: 'Sanierung',
            addTags: ['bafa'],
          },
        },
      ],
      (out) => expect(out).toContain('ergänzt'),
    );
    await app.ok('chat:send', { text: 'Ordne beides auch dem Thema Förderung und dem Projekt Haus 2026 zu, in den Vorgang Sanierung, Tag bafa.' });
    // the main topic stays, the new one is a further one; an entry without a main project gets it as its main one
    expect(await subjectsOf(item.id)).toMatchObject({ topic: { name: 'Heizung' }, extraTopics: [{ name: 'Förderung' }], project: { name: 'Haus 2026' } });
    expect((await app.ok('cases:detail', { id: c.id })).entries.map((e) => e.id).toSorted()).toEqual([item.id, note.id].toSorted());
    const tag = app.services.graph.findByName('tag', 'bafa')!.id;
    expect(app.services.graph.relationsOf(note.id).some((r) => r.targetEntityId === tag && r.status === 'confirmed')).toBe(true);
    const foerderung = app.services.graph.findByName('topic', 'Förderung')!.id;
    expect(app.services.graph.relationsOf(note.id).some((r) => r.targetEntityId === foerderung && r.status === 'confirmed')).toBe(true);

    app.llm.agent = ask(listNotesAndItems, () => [{ name: 'set_metadata', args: { targets: [refOf('Wärmepumpe')], removeTopics: ['Förderung'] } }]);
    await app.ok('chat:send', { text: 'Nimm das Thema Förderung beim Antrag wieder raus.' });
    expect(await subjectsOf(item.id)).toMatchObject({ topic: { name: 'Heizung' }, extraTopics: [] });

    // an unknown case is an error, nothing changes
    app.llm.agent = ask(
      listNotesAndItems,
      () => [{ name: 'set_metadata', args: { targets: [refOf('Wärmepumpe')], case: 'Gibt es nicht' } }],
      (out) => expect(out).toContain('unbekannt'),
    );
    await app.ok('chat:send', { text: 'In den Vorgang Gibt es nicht.' });
  });

  it('update_note changes a note; [[Name]] links are made, unknown names are reported; undo works', async () => {
    const project = (await app.ok('knowledge:createEntity', { type: 'project', name: 'Hausbau' })).entity;
    const note = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Baustelle', description: 'Termin mit dem Statiker.' })).entity;
    app.llm.agent = ask(
      listNotesAndItems,
      () => [{ name: 'update_note', args: { note: refOf('Termin mit dem Statiker'), content: 'Termin mit dem Statiker zu [[Hausbau]] und [[Herr Kalt]].' } }],
      (out) => {
        expect(out).toContain('Verlinkt: „Hausbau“');
        expect(out).toContain('Noch ohne Eintrag (anbieten, ihn anzulegen): „Herr Kalt“');
      },
    );
    await app.ok('chat:send', { text: 'Ergänze in der Notiz Baustelle einen Link auf Hausbau und Herr Kalt.' });
    expect(app.services.graph.getEntity(note.id)).toMatchObject({ name: 'Baustelle', description: expect.stringContaining('[[Hausbau]]') });
    expect(
      app.services.graph
        .relationsOf(note.id)
        .filter((r) => r.method === 'wikilink')
        .map((r) => r.targetEntityId),
    ).toEqual([project.id]);
    const entry = (await app.ok('audit:list', {})).find((e) => e.action === 'note.update')!;
    expect(entry.actor).toBe('agent');
    await app.ok('audit:undo', { auditId: entry.id });
    expect(app.services.graph.relationsOf(note.id).filter((r) => r.method === 'wikilink')).toEqual([]);

    // a wrong id is no note
    app.llm.agent = ask(
      [{ name: 'list_subjects', args: { type: 'project' } }],
      () => [{ name: 'update_note', args: { note: refOf('Hausbau'), content: 'x' } }],
      (out) => expect(out).toContain('ist keine Notiz'),
    );
    await app.ok('chat:send', { text: 'Ändere das.' });
  });

  it("update_note never revives a rejected pair; a proposal its [[Name]] takes over is the agent's link of the run", async () => {
    const rejectedTopic = (await app.ok('knowledge:createEntity', { type: 'topic', name: 'Finanzen' })).entity;
    const proposedTopic = (await app.ok('knowledge:createEntity', { type: 'topic', name: 'Steuern' })).entity;
    const note = (await app.ok('knowledge:createEntity', { type: 'note', name: 'Bank', description: 'Kreditgespräch bei der Bank.' })).entity;
    const propose = (targetId: string) =>
      app.services.graph.link({ sourceId: note.id, targetId, relationType: 'relates_to' }, { status: 'proposed', method: 'analysis' })!;
    const rejected = propose(rejectedTopic.id);
    app.services.graph.setRelationStatus(rejected.id, { status: 'rejected' });
    const proposal = propose(proposedTopic.id);
    app.llm.agent = ask(listNotesAndItems, () => [
      { name: 'update_note', args: { note: refOf('Kreditgespräch'), content: 'Kreditgespräch bei der Bank zu [[Finanzen]] und [[Steuern]].' } },
    ]);
    await app.ok('chat:send', { text: 'Verlinke in der Notiz Bank Finanzen und Steuern.' });

    expect(app.services.graph.getRelation(rejected.id)).toMatchObject({ status: 'rejected', method: 'analysis', origin: rejected.origin, runId: null });
    const runId = (await app.ok('audit:list', {})).find((e) => e.action === 'note.update')!.runId;
    expect(runId).toBeTruthy();
    expect(app.services.graph.getRelation(proposal.id)).toMatchObject({ status: 'confirmed', method: 'wikilink', origin: 'agent', runId });
  });

  it('linkage_report, case_overview and the topic tree in list_subjects; resetting learned thresholds always asks', async () => {
    const urlaub = (await app.ok('knowledge:createEntity', { type: 'topic', name: 'Urlaub' })).entity;
    const u26 = (await app.ok('knowledge:createEntity', { type: 'topic', name: 'Urlaub 2026' })).entity;
    await app.ok('knowledge:link', { sourceId: u26.id, targetId: urlaub.id, relationType: 'subtopic_of', confirmed: true });
    const c = (await app.ok('cases:create', { name: 'Autokauf' })).case;
    const item = await app.ok('openItems:create', { title: 'Probefahrt vereinbaren', dueAt: '2026-11-05' });
    await app.ok('cases:assign', { entryIds: [item.id], caseId: c.id });

    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'linkage_report', args: {} }] },
      () => {
        const out = lastToolOutput(app);
        expect(out).toContain('davon ohne Verknüpfung');
        expect(out).toContain('Aus Ablehnungen gelernt');
        expect(out).toContain('ähnlicher Inhalt (Mindest-Ähnlichkeit): unverändert');
        return { calls: [{ name: 'case_overview', args: { case: 'Autokauf' } }] };
      },
      () => {
        const out = lastToolOutput(app);
        expect(out).toContain('Vorgang „Autokauf“ – offen');
        expect(out).toMatch(/2026-11-05 K\d+ offener Punkt „Probefahrt vereinbaren“ \[open\]/);
        return { calls: [{ name: 'list_subjects', args: { type: 'topic' } }] };
      },
      () => {
        expect(lastToolOutput(app)).toContain('Urlaub 2026 (Unterthema von „Urlaub“)');
        return { calls: [{ name: 'reset_learned_thresholds', args: {} }] };
      },
      { text: 'Fertig.' },
    );
    const res = await app.ok('chat:send', { text: 'Wie gut ist mein Archiv verknüpft, wie steht der Autokauf, und setz das Gelernte zurück.' });
    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect(run.steps.find((s) => s.tool === 'linkage_report')).toMatchObject({ outcome: 'ok', risk: 'read' });
    // critical: proposed for confirmation, not done on its own
    expect(run.steps.find((s) => s.tool === 'reset_learned_thresholds')).toMatchObject({ risk: 'critical' });
    expect((await app.ok('audit:list', {})).some((e) => e.action === 'links.thresholds.reset')).toBe(false);
  });
});
