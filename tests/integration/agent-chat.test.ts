import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, folderOf, scriptedTurns, sentText } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

const lastAssistant = async (conversationId: string) => (await app.ok('chat:history', { conversationId })).filter((m) => m.role === 'assistant').at(-1)!;

describe('Agent in the chat (#295, #303, #304)', () => {
  it('„Verschiebe alle md nach presentations“: finds by extension, moves all, logs the run and undoes it as a whole', async () => {
    const a = await archived(app, 'folien-q1.md', '# Q1', 'work/misc');
    const b = await archived(app, 'folien-q2.md', '# Q2', 'work/misc');
    const other = await archived(app, 'notiz.txt', 'Notiz', 'work/misc');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { ext: ['md'] } }] },
      ({ body }) => {
        // the result set of the previous call stands for ALL hits
        expect(JSON.stringify(body.input)).toContain('Ergebnismenge S1');
        return { calls: [{ name: 'move_documents', args: { documents: ['S1'], folder: 'work/presentations' } }] };
      },
      { text: 'Ich habe 2 Dateien nach work/presentations verschoben.' },
    );
    const res = await app.ok('chat:send', { text: 'Verschiebe alle md nach presentations' });
    expect(res.assistantMessage.content).toContain('2 Dateien');
    expect(res.assistantMessage.runId).toBeTruthy();
    expect(folderOf(app, a)).toBe('work/presentations');
    expect(folderOf(app, b)).toBe('work/presentations');
    expect(folderOf(app, other)).toBe('work/misc');

    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect(run.status).toBe('done');
    expect(run.steps.map((s) => s.tool)).toEqual(['find_documents', 'move_documents']);
    expect(run.steps[1]!.auditIds?.length).toBe(2);
    expect(run.undoable).toBe(2);
    expect(run.usage.requests).toBe(3);
    // every change of the run carries its id
    const audit = await app.ok('audit:list', { limit: 50 });
    expect(audit.filter((e) => e.runId === run.id && e.action === 'archive.relocate')).toHaveLength(2);
    expect(audit.find((e) => e.runId === run.id)?.actor).toBe('agent');

    const undo = await app.ok('agent:undoRun', { runId: run.id });
    expect(undo.undone).toBe(2);
    expect(folderOf(app, a)).toBe('work/misc');
    expect(folderOf(app, b)).toBe('work/misc');
  });

  it('a folder structure plan is always a proposal, one item per group, and can be confirmed in parts (#304)', async () => {
    const a = await archived(app, 'rechnung.md', 'Rechnung', 'work/misc');
    const b = await archived(app, 'vertrag.md', 'Vertrag', 'work/misc');
    app.llm.agent = scriptedTurns(
      {
        calls: [
          { name: 'find_documents', args: { name: 'rechnung' } },
          { name: 'find_documents', args: { name: 'vertrag' } },
        ],
      },
      {
        calls: [
          {
            name: 'propose_structure',
            args: {
              groups: [
                { documents: ['S1'], folder: 'work/finanzen/rechnungen' },
                { documents: ['S2'], folder: 'work/vertraege' },
              ],
            },
          },
        ],
      },
      { text: 'So würde ich es ordnen.' },
    );
    const res = await app.ok('chat:send', { text: 'Wie würdest du work/misc ordnen? Schlag mir eine Struktur vor.' });
    expect(folderOf(app, a)).toBe('work/misc');
    const card = res.assistantMessage.actions.find((x) => x.actionType === 'agent_batch')!;
    const items = (card.proposedParameters as { items: Array<{ tool: string }> }).items;
    expect(items.map((i) => i.tool)).toEqual(['move_documents', 'move_documents']);
    await app.ok('actions:resolve', { decision: 'approve', actionId: card.id, confirmed: true, parameterOverrides: { selected: [1] } });
    expect(folderOf(app, a)).toBe('work/misc');
    expect(folderOf(app, b)).toBe('work/vertraege');
    await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect(folderOf(app, b)).toBe('work/misc');
  });

  it('mode „Fragen“: prepares the change as one proposal card and executes it after confirmation', async () => {
    app.services.settings.update({ agent: { mode: 'ask' } });
    const a = await archived(app, 'a.md', 'A', 'work/misc');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { ext: 'md' } }] },
      { calls: [{ name: 'move_documents', args: { documents: ['S1'], folder: 'work/slides' } }] },
      { text: 'Vorschlag ist vorbereitet.' },
    );
    const res = await app.ok('chat:send', { text: 'Verschieb die md-Dateien nach work/slides' });
    expect(folderOf(app, a)).toBe('work/misc');
    const card = res.assistantMessage.actions.find((x) => x.actionType === 'agent_batch')!;
    expect(card).toBeTruthy();
    const tool = JSON.stringify(app.llm.agentRequests.at(-1)!.input);
    expect(tool).toContain('NICHT AUSGEFÜHRT');
    const done = await app.ok('actions:resolve', { decision: 'approve', actionId: card.id, confirmed: true });
    expect(done.status).toBe('executed');
    expect(folderOf(app, a)).toBe('work/slides');
    // the executed proposal belongs to the run: undo of the run covers it
    const undo = await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect(undo.undone).toBe(1);
    expect(folderOf(app, a)).toBe('work/misc');
  });

  it('„frag mich diesmal vorher“ switches only this conversation to „Fragen“', async () => {
    const a = await archived(app, 'a.md', 'A', 'work/misc');
    app.llm.agent = scriptedTurns({ calls: [{ name: 'move_documents', args: { documents: ['S9'], folder: 'work/x' } }] }, { text: 'ok' });
    const res = await app.ok('chat:send', { text: 'Frag mich diesmal vorher: räum die md auf' });
    const state = await app.ok('agent:conversation', { conversationId: res.conversationId });
    expect(state.override).toBe('ask');
    expect(state.mode).toBe('ask');
    expect(app.services.settings.get().agent.mode).toBe('auto');
    expect(folderOf(app, a)).toBe('work/misc');
    const other = await app.ok('agent:conversation', {});
    expect(other.mode).toBe('auto');
  });

  it('critical exceptions ask even in „Auto“: a new main category and mass actions above the threshold', async () => {
    const a = await archived(app, 'a.md', 'A', 'work/misc');
    const b = await archived(app, 'b.md', 'B', 'work/misc');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { ext: 'md' } }] },
      { calls: [{ name: 'move_documents', args: { documents: ['S1'], folder: 'neu/praesentationen' } }] },
      { text: 'Bitte bestätigen.' },
    );
    const res = await app.ok('chat:send', { text: 'Verschiebe alle md nach neu/praesentationen' });
    expect(folderOf(app, a)).toBe('work/misc');
    expect(res.assistantMessage.actions.some((x) => x.actionType === 'agent_batch')).toBe(true);

    app.services.settings.update({ agent: { massActionThreshold: 1 } });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { ext: 'md' } }] },
      { calls: [{ name: 'move_documents', args: { documents: ['S1'], folder: 'work/slides' } }] },
      { text: 'Massenaktion – bitte bestätigen.' },
    );
    const res2 = await app.ok('chat:send', { conversationId: res.conversationId, text: 'Dann nach work/slides' });
    expect(folderOf(app, b)).toBe('work/misc');
    const run = await app.ok('agent:run', { id: res2.assistantMessage.runId! });
    expect(run.steps.find((s) => s.tool === 'move_documents')?.outcome).toBe('proposed');
  });

  it('invalid arguments go back to the model as an error result; the run continues', async () => {
    app.llm.agent = scriptedTurns({ calls: [{ name: 'find_documents', args: { status: 'kaputt' } }] }, ({ body }) => {
      expect(JSON.stringify(body.input)).toContain('Ungültige Argumente');
      return { text: 'Korrigiert.' };
    });
    const res = await app.ok('chat:send', { text: 'Zeig mir alles' });
    expect(res.assistantMessage.content).toBe('Korrigiert.');
  });

  it('a question to the user is its own exit; the answer continues the run with full context', async () => {
    app.llm.agent = scriptedTurns({ calls: [{ name: 'ask_user', args: { question: 'Welches Jahr meinst du?', options: ['2025', '2026'] } }] }, ({ body }) => {
      const input = JSON.stringify(body.input);
      expect(input).toContain('Antwort des Benutzers: 2025');
      expect(input).toContain('Welches Jahr meinst du?');
      return { text: 'Danke, dann 2025.' };
    });
    const first = await app.ok('chat:send', { text: 'Stell mir die Belege zusammen' });
    expect(first.assistantMessage.content).toContain('Welches Jahr meinst du?');
    expect(first.assistantMessage.quickReplies).toEqual(['2025', '2026']);
    const run1 = await app.ok('agent:run', { id: first.assistantMessage.runId! });
    expect(run1.status).toBe('ask_user');
    const second = await app.ok('chat:send', { conversationId: first.conversationId, text: '2025' });
    expect(second.assistantMessage.content).toBe('Danke, dann 2025.');
  });

  it('refs in the answer are shown as titles; documents not shared stay anonymous', async () => {
    await archived(app, 'mietvertrag.md', 'Mietvertrag Wohnung', 'private/wohnen');
    app.llm.agent = scriptedTurns({ calls: [{ name: 'find_documents', args: { name: 'mietvertrag' } }] }, { text: 'Gefunden: D1.' });
    const res = await app.ok('chat:send', { text: 'Wo ist der Mietvertrag?' });
    expect(res.assistantMessage.content).toBe('Gefunden: „mietvertrag“.');
    expect(res.assistantMessage.sources[0]?.type).toBe('document');
  });

  it('records tokens and an estimated cost per run and in the usage overview (#302)', async () => {
    app.services.settings.update({ llm: { model: 'gpt-5' } });
    app.llm.agent = scriptedTurns({ text: 'Hallo!', usage: { input: 1_000, output: 500, cached: 200 } });
    const res = await app.ok('chat:send', { text: 'Hallo' });
    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect(run.usage).toMatchObject({ inputTokens: 800, outputTokens: 500, cacheReadTokens: 200, requests: 1 });
    expect(run.costUsd).toBeGreaterThan(0);
    const usage = await app.ok('agent:usage', {});
    expect(usage.total.runs).toBeGreaterThanOrEqual(1);
    expect(usage.days[0]?.trigger).toBe('chat');
  });

  it('masks secrets of the user message before it leaves the machine', async () => {
    app.llm.agent = scriptedTurns({ text: 'Notiert.' });
    await app.ok('chat:send', { text: 'Mein API-Key ist sk-live-ABCDEF0123456789abcdef0123' });
    expect(sentText(app)).not.toContain('sk-live-ABCDEF0123456789abcdef0123');
  });

  it('without tool calling at the endpoint, the chat keeps the rule-based evaluation', async () => {
    const plain = await agentApp();
    try {
      // the probe gets plain text from this endpoint (no native tool calling)
      plain.llm.toolCalling = false;
      plain.llm.on('ChatIntent', () => ({ intent: 'smalltalk', confidence: 0.9, rationale: '' }));
      const res = await plain.ok('chat:send', { text: 'Hallo' });
      expect(res.assistantMessage.runId ?? null).toBeNull();
      expect(res.assistantMessage.content).toContain('Archivist');
      expect(plain.services.agent.capability()?.toolCalling).toBe(false);
    } finally {
      await plain.cleanup();
    }
  });

  it('runs requests of one conversation one after another (#251)', async () => {
    let active = 0;
    let maxActive = 0;
    app.llm.agent = () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return { text: 'ok' };
    };
    const first = await app.ok('chat:send', { text: 'eins' });
    await Promise.all([
      app.ok('chat:send', { conversationId: first.conversationId, text: 'zwei' }),
      app.ok('chat:send', { conversationId: first.conversationId, text: 'drei' }),
    ]);
    const history = app.services.agent.historyOf(first.conversationId);
    // user/assistant strictly alternate – no interleaving of the two requests
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(maxActive).toBe(1);
  });

  it('assistant message survives in history after the run (lastAssistant helper)', async () => {
    app.llm.agent = scriptedTurns({ text: 'Fertig.' });
    const res = await app.ok('chat:send', { text: 'Test' });
    expect((await lastAssistant(res.conversationId)).content).toBe('Fertig.');
  });
});
