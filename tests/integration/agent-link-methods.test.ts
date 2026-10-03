import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, lastToolOutput, scriptedTurns, sentText } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

/** Three documents about the same flat, one recipe. */
async function flat() {
  const lease = await archived(app, {
    name: 'mietvertrag.md',
    content: 'Mietvertrag für die Wohnung in der Hauptstraße 5. Vermieter Schmidt, Kaution 1500 Euro, Miete monatlich.',
    folder: 'private/wohnen',
  });
  const costs = await archived(app, {
    name: 'nebenkosten.md',
    content: 'Nebenkostenabrechnung für die Wohnung in der Hauptstraße 5. Vermieter Schmidt, Miete und Heizung.',
    folder: 'private/wohnen',
  });
  const recipe = await archived(app, { name: 'rezept.md', content: 'Rezept für Apfelkuchen mit Zucker, Mehl und Butter.', folder: 'private/kochen' });
  const notice = await archived(app, {
    name: 'kuendigung.md',
    content: 'Kündigung der Wohnung Hauptstraße 5 an Vermieter Schmidt, Kaution zurück.',
    folder: 'private/wohnen',
  });
  return { lease, costs, recipe, notice };
}

const relationsBetween = (a: string, b: string) =>
  app.services.graph.relationsOf(a).filter((r) => (r.sourceEntityId === a && r.targetEntityId === b) || (r.sourceEntityId === b && r.targetEntityId === a));
const proposedRelatedTo = () =>
  app.services.database.sqlite.prepare(`SELECT status, origin, run_id AS runId FROM relations WHERE relation_type = 'related_to'`).all() as Array<{
    status: string;
    origin: string;
    runId: string | null;
  }>;

describe('Link methods as tools of their own (#313)', () => {
  it('suggest_links: similar entries and a mentioned project, without linked or rejected pairs – the same function as the UI', async () => {
    const d = await flat();
    const project = (await app.ok('knowledge:createEntity', { type: 'project', name: 'Hauptstraße' })).entity;
    const note = (
      await app.ok('knowledge:createEntity', { type: 'note', name: 'Termin', description: 'Termin mit dem Vermieter zum Projekt Hauptstraße am Freitag.' })
    ).entity;
    // the user rejected „Mietvertrag – Kündigung“ before: never proposed again
    const r = app.services.graph.linkEntries(d.lease, d.notice, 'related_to', { status: 'proposed' });
    app.services.graph.decideRelation(r.relation.id, 'rejected');

    const ui = await app.ok('links:suggestions', { id: d.lease, limit: 3 });
    expect(ui.map((c) => c.id)).toEqual([d.costs]);
    expect(ui[0]).toMatchObject({ method: 'similarity', name: 'nebenkosten' });
    expect(ui[0]!.reason).toContain('Nebenkostenabrechnung');
    // a topic or project never proposes itself
    expect((await app.ok('links:suggestions', { id: project.id, limit: 3 })).map((c) => c.id)).not.toContain(project.id);
    expect((await app.ok('links:suggestions', { id: note.id, limit: 3 })).find((c) => c.id === project.id)).toMatchObject({
      method: 'mention',
      reason: 'nennt das Projekt „Hauptstraße“',
    });

    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'mietvertrag' } }] },
      { calls: [{ name: 'suggest_links', args: { entries: ['D1'] } }] },
      () => {
        const out = lastToolOutput(app);
        expect(out).toContain('nebenkosten');
        expect(out).not.toContain('kuendigung');
        expect(out).not.toContain('rezept');
        return { text: 'Nebenkosten passt dazu.' };
      },
    );
    const res = await app.ok('chat:send', { text: 'Was passt zum Mietvertrag?' });
    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect(run.steps.find((s) => s.tool === 'suggest_links')).toMatchObject({ outcome: 'ok', risk: 'read', summary: '1 Vorschläge' });
    // read only: nothing was linked
    expect(relationsBetween(d.lease, d.costs)).toEqual([]);
  });

  it("after capturing, the tool result offers up to 3 links (#283); on the user's „ja“ the link is confirmed", async () => {
    const project = (await app.ok('knowledge:createEntity', { type: 'project', name: 'Hauptstraße' })).entity;
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'record_note', args: { content: 'Der Vermieter will die Fenster im Projekt Hauptstraße tauschen.' } }] },
      () => {
        const out = lastToolOutput(app);
        expect(out).toContain('Mögliche Verknüpfungen');
        expect(out).toMatch(/→ K\d+ Projekt „Hauptstraße“ \(90 %, nennt das Projekt „Hauptstraße“\)/);
        return { calls: [{ name: 'ask_user', args: { question: 'Das klingt nach Projekt Hauptstraße – verknüpfen?', options: ['Ja', 'Nein'] } }] };
      },
      ({ body }) => {
        const out = JSON.stringify(body.input);
        const note = /(K\d+) Notiz gespeichert/.exec(out)?.[1] ?? 'K1';
        const proj = /(K\d+) Projekt „Hauptstraße“/.exec(out)![1]!;
        return { calls: [{ name: 'link', args: { a: note, b: proj, onUserRequest: true } }] };
      },
      { text: 'Verknüpft.' },
    );
    const first = await app.ok('chat:send', { text: 'Notiz: Der Vermieter will die Fenster im Projekt Hauptstraße tauschen.' });
    expect(first.assistantMessage.quickReplies).toEqual(['Ja', 'Nein']);
    await app.ok('chat:send', { conversationId: first.conversationId, text: 'Ja' });
    const note = app.services.graph.listEntities({ type: 'note', limit: 10 })[0]!;
    expect(relationsBetween(note.id, project.id).map((r) => r.status)).toEqual(['confirmed']);
  });

  it('suggest_links passes the privacy filter: a document not released is named neither with title nor passage', async () => {
    const d = await flat();
    await app.ok('documents:setLlmExcluded', { id: d.lease, excluded: true });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'nebenkosten' } }] },
      { calls: [{ name: 'suggest_links', args: { entries: ['D1'] } }] },
      { text: 'ok' },
    );
    await app.ok('chat:send', { text: 'Was passt zu den Nebenkosten?' });
    const sent = sentText(app);
    expect(sent).toContain('[nicht freigegeben]');
    expect(sent).not.toContain('Kaution 1500');
    expect(sent).not.toContain('mietvertrag');
  });

  it('find_unlinked_entries: entries without any proposed or confirmed relation (a folder alone does not count), paged with suggestions', async () => {
    const d = await flat();
    await app.ok('knowledge:link', { sourceId: d.lease, targetId: d.costs, relationType: 'related_to', confirmed: true });
    const page = await app.ok('links:unlinked', { limit: 50, offset: 0 });
    expect(page.items.map((o) => o.id).toSorted()).toEqual([d.recipe, d.notice].toSorted());
    expect(page.total).toBe(2);

    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_unlinked_entries', args: { limit: 1 } }] },
      () => {
        const out = lastToolOutput(app);
        expect(out).toContain('2 verwaiste Einträge, hier 1–1');
        expect(out).toContain('rezept');
        expect(out).toContain('Weitere mit offset=1');
        // the recipe resembles nothing: no target
        expect(out).not.toContain('→');
        return { calls: [{ name: 'find_unlinked_entries', args: { limit: 1, offset: 1 } }] };
      },
      { text: 'ok' },
    );
    await app.ok('chat:send', { text: 'Welche Einträge hängen allein herum?' });
    const out = lastToolOutput(app);
    expect(out).toContain('2 verwaiste Einträge, hier 2–2');
    // the notice gets the lease and the costs as targets
    expect(out).toMatch(/kuendigung“\n\s+→ .*(mietvertrag|nebenkosten)/);
    expect(out).not.toContain('Weitere mit');
  });

  it('find_topic_clusters and propose_topic: a hint „Neues Thema ‚…‘ anlegen?“; „Ja“ assigns the topic (undoable), „Nein“ is remembered', async () => {
    const d = await flat();
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_topic_clusters', args: {} }] },
      () => {
        const out = lastToolOutput(app);
        expect(out).toContain('Gruppe 1 (S1, 3 Einträge)');
        expect(out).not.toContain('rezept');
        return { calls: [{ name: 'propose_topic', args: { name: 'Wohnung Hauptstraße', entries: ['S1'] } }] };
      },
      { text: 'Ich schlage ein Thema vor.' },
    );
    const res = await app.ok('chat:send', { text: 'Gibt es Einträge, die ein gemeinsames Thema bräuchten?' });
    // nothing assigned yet – only the card and the hint
    expect(app.services.documents.get(d.lease).topicName).toBeNull();
    expect(res.assistantMessage.actions.some((a) => a.actionType === 'agent_batch')).toBe(true);
    const hint = (await app.ok('insights:list', { status: 'open' })).find((i) => i.kind === 'topic_cluster')!;
    expect(hint.title).toBe('Neues Thema „Wohnung Hauptstraße“ anlegen?');
    expect(hint.affected.map((a) => a.id).toSorted()).toEqual([d.lease, d.costs, d.notice].toSorted());

    await app.ok('insights:respond', { response: 'accept', id: hint.id, confirmed: true, strongConfirmed: false });
    for (const id of [d.lease, d.costs, d.notice]) expect(app.services.documents.get(id).topicName).toBe('Wohnung Hauptstraße');
    expect(app.services.documents.get(d.recipe).topicName).toBeNull();
    // the assignment belongs to the run that proposed it: undo of the run takes it back
    await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    for (const id of [d.lease, d.costs, d.notice]) expect(app.services.documents.get(id).topicName).toBeNull();

    // „Nein“ to a group is remembered: the same group is not offered again
    const again = app.services.links.proposeTopic('Andere', [d.lease, d.costs]);
    const other = (await app.ok('insights:list', { status: 'open' })).find((i) => i.id === again.insightId)!;
    await app.ok('insights:respond', { response: 'reject', id: other.id });
    expect(app.services.links.proposeTopic('Andere', [d.lease, d.costs]).actionId).toBeNull();
    const clusters = await app.services.links.clusters({ minSize: 2 });
    expect(clusters.some((c) => c.members.length === 2 && c.members.every((m) => [d.lease, d.costs].includes(m.id)))).toBe(false);
  });

  it('backfill_links: proposes (never confirms) in steps and continues where it stopped; rejected pairs never again; undone with the run', async () => {
    const d = await flat();
    const r = app.services.graph.linkEntries(d.costs, d.notice, 'related_to', { status: 'proposed' });
    app.services.graph.decideRelation(r.relation.id, 'rejected');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'backfill_links', args: { maxEntries: 2 } }] },
      () => {
        expect(lastToolOutput(app)).toMatch(/2 Einträge geprüft, \d+ Verknüpfungen vorgeschlagen\. Noch 2 Einträge/);
        return { calls: [{ name: 'backfill_links', args: { maxEntries: 50 } }] };
      },
      () => {
        expect(lastToolOutput(app)).toContain('2 Einträge geprüft');
        expect(lastToolOutput(app)).toContain('vollständig durchlaufen');
        return { text: 'Fertig.' };
      },
    );
    // explicitly asked for – still only proposals: the fixed methods never confirm
    const res = await app.ok('chat:send', { text: 'Verknüpfe bitte mein ganzes Archiv' });
    const runId = res.assistantMessage.runId!;
    const rels = proposedRelatedTo().filter((x) => x.status !== 'rejected');
    expect(rels.length).toBe(2);
    expect(rels.every((x) => x.status === 'proposed' && x.origin === 'agent' && x.runId === runId)).toBe(true);
    expect(relationsBetween(d.lease, d.costs).map((x) => x.status)).toEqual(['proposed']);
    expect(relationsBetween(d.lease, d.notice).map((x) => x.status)).toEqual(['proposed']);
    expect(relationsBetween(d.costs, d.notice).map((x) => x.status)).toEqual(['rejected']);
    expect(relationsBetween(d.lease, d.recipe)).toEqual([]);
    const undo = await app.ok('agent:undoRun', { runId });
    expect(undo).toMatchObject({ undone: 2, failed: 0 });
    expect(proposedRelatedTo().filter((x) => x.status !== 'rejected')).toEqual([]);
  });

  it('the link run of the UI (job) uses the same functions: proposals of the system and ONE notification', async () => {
    await flat();
    const { jobId } = await app.ok('links:startRun', {});
    await app.services.jobs.whenIdle();
    expect(app.services.jobs.get(jobId)).toMatchObject({ status: 'succeeded', summary: '4 Einträge geprüft, 3 Verknüpfungen und 1 Themen vorgeschlagen' });
    const rels = proposedRelatedTo();
    expect(rels).toHaveLength(3);
    expect(rels.every((x) => x.status === 'proposed' && x.origin === 'system' && x.runId === null)).toBe(true);
    const notes = (await app.ok('notifications:list', {})).filter((n) => n.title === 'Verknüpfungsvorschläge');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.description).toBe('3 Verknüpfungen vorgeschlagen. 1 neues Thema vorgeschlagen. Du entscheidest, was übernommen wird.');
    expect((await app.ok('insights:list', { status: 'open' })).filter((i) => i.kind === 'topic_cluster')).toHaveLength(1);
  });
});

describe('Background link run with the link-method tools (#313)', () => {
  it('works through the methods, only proposes, never repeats a rejected pair and sends ONE notification', async () => {
    const d = await flat();
    const r = app.services.graph.linkEntries(d.lease, d.costs, 'related_to', { status: 'proposed' });
    app.services.graph.decideRelation(r.relation.id, 'rejected');
    app.llm.agent = scriptedTurns(
      ({ body, tools }) => {
        const task = JSON.stringify(body.input);
        for (const t of ['backfill_links', 'find_unlinked_entries', 'find_topic_clusters', 'propose_topic']) {
          expect(task).toContain(t);
          expect(tools).toContain(t);
        }
        return { calls: [{ name: 'backfill_links', args: {} }] };
      },
      { calls: [{ name: 'find_unlinked_entries', args: {} }] },
      // the recipe is unlinked; the model links it „on request“ with the notice – in the background only a proposal
      () => {
        const out = lastToolOutput(app);
        const recipe = /(D\d+) Dokument „rezept“/.exec(out)?.[1];
        expect(recipe).toBeTruthy();
        return { calls: [{ name: 'find_documents', args: { name: 'kuendigung' } }], text: recipe };
      },
      ({ body }) => {
        const recipe = /(D\d+) Dokument „rezept“/.exec(JSON.stringify(body.input))![1]!;
        const notice = /(D\d+): „kuendigung“/.exec(lastToolOutput(app))![1]!;
        const lease = /(D\d+) Dokument „mietvertrag“/.exec(JSON.stringify(body.input))?.[1] ?? 'D1';
        return {
          calls: [
            { name: 'link', args: { a: recipe, b: notice, onUserRequest: true } },
            // the rejected pair is not suggested again
            { name: 'suggest_links', args: { entries: [lease] } },
          ],
        };
      },
      () => {
        expect(lastToolOutput(app)).not.toContain('nebenkosten');
        return { calls: [{ name: 'find_topic_clusters', args: {} }] };
      },
      () => {
        const group = /Gruppe 1 \((S\d+), 3 Einträge\)/.exec(lastToolOutput(app))?.[1];
        expect(group).toBeTruthy();
        return { calls: [{ name: 'propose_topic', args: { name: 'Wohnung', entries: [group!] } }] };
      },
      { text: 'Verknüpfungen und ein Thema vorgeschlagen.' },
    );
    const run = await app.services.agent.runBackground('links');
    expect(run?.status).toBe('done');
    expect(run?.trigger).toBe('background:links');
    expect(run?.steps.map((s) => [s.tool, s.outcome])).toEqual([
      ['backfill_links', 'ok'],
      ['find_unlinked_entries', 'ok'],
      ['find_documents', 'ok'],
      // read tools of a round run first
      ['suggest_links', 'ok'],
      ['link', 'ok'],
      ['find_topic_clusters', 'ok'],
      ['propose_topic', 'ok'],
    ]);
    // everything is a proposal – nothing confirmed in the background
    const all = app.services.database.sqlite.prepare(`SELECT status FROM relations WHERE run_id = ?`).all(run!.id) as Array<{ status: string }>;
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((x) => x.status === 'proposed')).toBe(true);
    expect(relationsBetween(d.recipe, d.notice).map((x) => x.status)).toEqual(['proposed']);
    expect(relationsBetween(d.lease, d.costs).map((x) => x.status)).toEqual(['rejected']);
    // no document was assigned a topic – only the hint waits for the user
    expect(app.services.documents.get(d.lease).topicName).toBeNull();
    expect((await app.ok('insights:list', { status: 'open' })).filter((i) => i.kind === 'topic_cluster')).toHaveLength(1);
    const notes = (await app.ok('notifications:list', {})).filter((n) => n.type === 'agent_run');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.description).toContain('1 Vorschlag/Vorschläge warten auf deine Bestätigung.');
  });
});
