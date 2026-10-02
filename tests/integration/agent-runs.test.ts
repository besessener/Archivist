import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, folderOf, scriptedTurns } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

const doc = (id: string) => app.services.documents.get(id);
const openItemTitles = async () => (await app.ok('openItems:list', {})).map((o) => o.title);
const noteTexts = () => app.services.graph.listEntities({ type: 'note', limit: 100 }).map((n) => n.description ?? n.name);
const relationsBetween = (a: string, b: string) =>
  app.services.graph.relationsOf(a).filter((r) => (r.sourceEntityId === a && r.targetEntityId === b) || (r.sourceEntityId === b && r.targetEntityId === a));

describe('Agent runs: undo (#299)', () => {
  it('undoes a run with mixed changes (move, metadata, open item, note, link) completely and in reverse order', async () => {
    const a = await archived(app, 'steuer.md', 'Steuerunterlagen 2025', 'work/misc');
    const other = await archived(app, 'quittung.md', 'Quittung', 'work/misc');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'steuer' } }] },
      {
        calls: [
          { name: 'move_documents', args: { documents: ['D1'], folder: 'work/steuer' } },
          { name: 'set_metadata', args: { targets: ['D1'], topic: 'Steuer', addTags: ['2025'] } },
          { name: 'create_open_item', args: { title: 'Steuererklärung 2025 abgeben', dueAt: '2026-12-31' } },
          { name: 'record_note', args: { content: 'Die Steuerunterlagen 2025 liegen jetzt in work/steuer.' } },
          { name: 'link', args: { a: 'D1', b: 'K1', relationType: 'relates_to', onUserRequest: true } },
        ],
      },
      // the same document moved once more: undo must go back step by step
      { calls: [{ name: 'move_documents', args: { documents: ['D1'], folder: 'work/steuer/2025' } }] },
      { text: 'Erledigt.' },
    );
    const res = await app.ok('chat:send', {
      text: 'Verschiebe die Steuerdatei nach work/steuer, setz Thema Steuer, leg einen offenen Punkt an, notier das und verknüpfe das Dokument mit dem Punkt',
    });
    const runId = res.assistantMessage.runId!;
    let run = await app.ok('agent:run', { id: runId });
    expect(run.steps.map((s) => [s.tool, s.outcome])).toEqual([
      ['find_documents', 'ok'],
      ['move_documents', 'ok'],
      ['set_metadata', 'ok'],
      ['create_open_item', 'ok'],
      ['record_note', 'ok'],
      ['link', 'ok'],
      ['move_documents', 'ok'],
    ]);
    // everything happened
    expect(folderOf(app, a)).toBe('work/steuer/2025');
    expect(doc(a).topicName).toBe('Steuer');
    expect(doc(a).tags).toContain('2025');
    expect(await openItemTitles()).toContain('Steuererklärung 2025 abgeben');
    expect(noteTexts()).toContain('Die Steuerunterlagen 2025 liegen jetzt in work/steuer.');
    const item = (await app.ok('openItems:list', {})).find((o) => o.title === 'Steuererklärung 2025 abgeben')!;
    expect(relationsBetween(a, item.id).map((r) => r.status)).toEqual(['confirmed']);
    // every change carries the run id
    const audit = (await app.ok('audit:list', { limit: 200 })).filter((e) => e.runId === runId);
    expect(audit.length).toBeGreaterThanOrEqual(6);
    expect(audit.every((e) => e.actor === 'agent')).toBe(true);
    expect(run.undoable).toBe(audit.filter((e) => e.undoable).length);
    expect(run.undoable).toBeGreaterThanOrEqual(6);

    const undo = await app.ok('agent:undoRun', { runId });
    expect(undo).toMatchObject({ failed: 0, conflicts: [] });
    expect(undo.undone).toBe(run.undoable);
    expect(undo.message).toBe(`${run.undoable} Änderung(en) rückgängig gemacht.`);
    expect(folderOf(app, a)).toBe('work/misc');
    expect(folderOf(app, other)).toBe('work/misc');
    expect(doc(a).topicName).toBeNull();
    expect(doc(a).tags).not.toContain('2025');
    expect(await openItemTitles()).not.toContain('Steuererklärung 2025 abgeben');
    expect(noteTexts()).not.toContain('Die Steuerunterlagen 2025 liegen jetzt in work/steuer.');
    expect(relationsBetween(a, item.id)).toEqual([]);
    run = await app.ok('agent:run', { id: runId });
    expect(run.undoable).toBe(0);
    // undone entries stay in the log, marked as undone
    const after = (await app.ok('audit:list', { limit: 200 })).filter((e) => e.runId === runId && e.undoneAt);
    expect(after.length).toBe(undo.undone);
  });

  it('several changes of one document in the same instant are still undone newest first', async () => {
    const a = await archived(app, 'a.md', 'A', 'work/misc');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'a' } }] },
      {
        calls: [
          { name: 'move_documents', args: { documents: ['D1'], folder: 'work/eins' } },
          { name: 'move_documents', args: { documents: ['D1'], folder: 'work/zwei' } },
          { name: 'move_documents', args: { documents: ['D1'], folder: 'work/drei' } },
        ],
      },
      { text: 'ok' },
    );
    const res = await app.ok('chat:send', { text: 'Verschiebe a.md dreimal' });
    expect(folderOf(app, a)).toBe('work/drei');
    const runId = res.assistantMessage.runId!;
    // the log has millisecond resolution: give all entries of the run the same instant
    app.services.database.sqlite.prepare('UPDATE audit_log SET at = ? WHERE run_id = ?').run('2026-10-02T10:00:00.000Z', runId);
    const undo = await app.ok('agent:undoRun', { runId });
    expect(undo).toMatchObject({ undone: 3, failed: 0 });
    expect(folderOf(app, a)).toBe('work/misc');
  });

  it('a conflict (the user edited the metadata after the run) blocks exactly that change; the others are undone', async () => {
    const a = await archived(app, 'vertrag.md', 'Vertrag', 'work/misc');
    const b = await archived(app, 'angebot.md', 'Angebot', 'work/misc');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'vertrag' } }] },
      { calls: [{ name: 'find_documents', args: { name: 'angebot' } }] },
      {
        calls: [
          { name: 'set_metadata', args: { targets: ['D1'], topic: 'Verträge' } },
          { name: 'move_documents', args: { documents: ['D2'], folder: 'work/angebote' } },
          { name: 'create_open_item', args: { title: 'Vertrag unterschreiben' } },
        ],
      },
      { text: 'ok' },
    );
    const res = await app.ok('chat:send', { text: 'Ordne den Vertrag zu, verschiebe das Angebot und leg einen Punkt an' });
    const runId = res.assistantMessage.runId!;
    expect(doc(a).topicName).toBe('Verträge');
    expect(folderOf(app, b)).toBe('work/angebote');
    const before = (await app.ok('agent:run', { id: runId })).undoable ?? 0;

    // the user changes the document by hand afterwards
    await app.ok('documents:updateMetadata', { id: a, title: 'Mietvertrag (von Hand)', confirmed: true });

    const undo = await app.ok('agent:undoRun', { runId });
    expect(undo.failed).toBe(1);
    expect(undo.undone).toBe(before - 1);
    expect(undo.conflicts.join(' ')).toContain('erneut verändert');
    expect(undo.message).toBe(`${before - 1} Änderung(en) rückgängig gemacht, 1 nicht möglich.`);
    // the user's edit and the change it depends on stay
    expect(doc(a).title).toBe('Mietvertrag (von Hand)');
    expect(doc(a).topicName).toBe('Verträge');
    // the rest is undone
    expect(folderOf(app, b)).toBe('work/misc');
    expect(await openItemTitles()).not.toContain('Vertrag unterschreiben');
    expect((await app.ok('agent:run', { id: runId })).undoable).toBe(1);
  });

  it('undoStep undoes exactly one step', async () => {
    const a = await archived(app, 'a.md', 'A', 'work/misc');
    const b = await archived(app, 'b.md', 'B', 'work/misc');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'a' } }] },
      { calls: [{ name: 'find_documents', args: { name: 'b' } }] },
      { calls: [{ name: 'move_documents', args: { documents: ['D1'], folder: 'work/x' } }] },
      { calls: [{ name: 'set_metadata', args: { targets: ['D2'], topic: 'Bauen' } }] },
      { text: 'ok' },
    );
    const res = await app.ok('chat:send', { text: 'Verschiebe a nach work/x und ordne b dem Thema Bauen zu' });
    const runId = res.assistantMessage.runId!;
    const run = await app.ok('agent:run', { id: runId });
    const move = run.steps.find((s) => s.tool === 'move_documents')!;
    expect(move.auditIds).toHaveLength(1);
    const undo = await app.ok('agent:undoStep', { runId, stepId: move.id });
    expect(undo).toMatchObject({ undone: 1, failed: 0 });
    expect(folderOf(app, a)).toBe('work/misc');
    expect(doc(b).topicName).toBe('Bauen');
    expect((await app.ok('agent:run', { id: runId })).undoable).toBe((run.undoable ?? 0) - 1);
    // a second time there is nothing left for this step
    expect((await app.ok('agent:undoStep', { runId, stepId: move.id })).undone).toBe(0);
    const missing = await app.call('agent:undoStep', { runId, stepId: 'gibt-es-nicht' });
    expect(missing.ok).toBe(false);
  });
});

describe('Agent runs: relations (#270, #306)', () => {
  it('relations created in a run carry origin agent and the run id; explicit request → confirmed, own accord → proposed', async () => {
    const a = await archived(app, 'a.md', 'A', 'work/misc');
    const b = await archived(app, 'b.md', 'B', 'work/misc');
    const c = await archived(app, 'c.md', 'C', 'work/misc');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'a' } }] },
      { calls: [{ name: 'find_documents', args: { name: 'b' } }] },
      { calls: [{ name: 'find_documents', args: { name: 'c' } }] },
      {
        calls: [
          { name: 'link', args: { a: 'D1', b: 'D2', onUserRequest: true } },
          { name: 'link', args: { a: 'D1', b: 'D3', onUserRequest: false } },
        ],
      },
      { text: 'ok' },
    );
    const res = await app.ok('chat:send', { text: 'Verknüpfe a mit b' });
    const runId = res.assistantMessage.runId!;
    const [ab] = relationsBetween(a, b);
    const [ac] = relationsBetween(a, c);
    expect(ab).toMatchObject({ status: 'confirmed', origin: 'agent', runId });
    expect(ac).toMatchObject({ status: 'proposed', origin: 'agent', runId });
    // undo of the run removes both again
    await app.ok('agent:undoRun', { runId });
    expect(relationsBetween(a, b)).toEqual([]);
    expect(relationsBetween(a, c)).toEqual([]);
  });

  it('in the background even an „explicit“ link stays a proposal', async () => {
    const a = await archived(app, 'a.md', 'A', 'work/misc');
    const b = await archived(app, 'b.md', 'B', 'work/misc');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'a' } }] },
      { calls: [{ name: 'find_documents', args: { name: 'b' } }] },
      { calls: [{ name: 'link', args: { a: 'D1', b: 'D2', onUserRequest: true } }] },
      { text: 'ok' },
    );
    const run = await app.services.agent.runBackground('links');
    expect(run).toBeTruthy();
    expect(relationsBetween(a, b)).toEqual([expect.objectContaining({ status: 'proposed', origin: 'agent', runId: run!.id })]);
  });

  it('a pair the user rejected is never proposed again', async () => {
    const a = await archived(app, 'a.md', 'A', 'work/misc');
    const b = await archived(app, 'b.md', 'B', 'work/misc');
    const linkScript = (onUserRequest: boolean) =>
      scriptedTurns(
        { calls: [{ name: 'find_documents', args: { name: 'a' } }] },
        { calls: [{ name: 'find_documents', args: { name: 'b' } }] },
        { calls: [{ name: 'link', args: { a: 'D1', b: 'D2', onUserRequest } }] },
        { text: 'ok' },
      );
    app.llm.agent = linkScript(false);
    const first = await app.ok('chat:send', { text: 'Was gehört zu a?' });
    const [proposed] = relationsBetween(a, b);
    expect(proposed!.status).toBe('proposed');
    await app.ok('knowledge:resolveRelation', { relationId: proposed!.id, status: 'rejected', confirmed: true });

    app.llm.agent = linkScript(false);
    const second = await app.ok('chat:send', { conversationId: first.conversationId, text: 'Und jetzt?' });
    const last = app.llm.agentRequests.at(-1)!;
    const results = (last.input as Array<{ type?: string; output?: string }>).filter((i) => i.type === 'function_call_output');
    expect(results.at(-1)!.output).toContain('als „gehört nicht zusammen“ abgelehnt – kein neuer Vorschlag');
    expect(relationsBetween(a, b).map((r) => r.status)).toEqual(['rejected']);
    const run = await app.ok('agent:run', { id: second.assistantMessage.runId! });
    expect(run.undoable).toBe(0);
    // the rejected pair is named on request
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'a' } }] },
      { calls: [{ name: 'related', args: { id: 'D1', rejected: true } }] },
      { text: 'ok' },
    );
    await app.ok('chat:send', { text: 'Welche Paare habe ich abgelehnt?' });
    const out = (app.llm.agentRequests.at(-1)!.input as Array<{ type?: string; output?: string }>).filter((i) => i.type === 'function_call_output').at(-1)!;
    expect(out.output).toContain('abgelehnt:');
    expect(out.output).toContain('„b“');
  });
});

describe('Agent runs: lifecycle', () => {
  it('closeInterrupted marks runs still running (e.g. before a restart) as cancelled', async () => {
    app.llm.agent = scriptedTurns({ text: 'fertig' });
    const done = await app.ok('chat:send', { text: 'Hallo' });
    const id = app.services.agentRuns.start({
      conversationId: null,
      trigger: 'chat',
      task: 'unterbrochen',
      provider: 'openai',
      model: 'test-model',
      mode: 'auto',
    });
    expect(app.services.agentRuns.get(id).status).toBe('running');
    expect(app.services.agentRuns.closeInterrupted()).toBe(1);
    const run = app.services.agentRuns.get(id);
    expect(run).toMatchObject({ status: 'cancelled', error: 'Durch einen Neustart unterbrochen.' });
    expect(run.finishedAt).toBeTruthy();
    expect(app.services.agentRuns.get(done.assistantMessage.runId!).status).toBe('done');
    expect(app.services.agentRuns.closeInterrupted()).toBe(0);
  });
});
