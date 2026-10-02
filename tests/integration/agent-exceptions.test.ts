import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, folderOf, inInbox, scriptedTurns, sentText } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

const stepOutcome = async (runId: string | null | undefined, tool: string) =>
  (await app.ok('agent:run', { id: runId! })).steps.find((s) => s.tool === tool)?.outcome;

describe('Exceptions that ask in every mode (#298)', () => {
  it('moving duplicates to the trash is only ever a proposal with the strong confirmation, even in „Auto“', async () => {
    const keep = await archived(app, { name: 'rechnung.txt', content: 'Rechnung 17', folder: 'private/finanzen' });
    const copy = await archived(app, { name: 'rechnung-kopie.txt', content: 'Rechnung 17 Kopie', folder: 'private/finanzen' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'rechnung' } }] },
      { calls: [{ name: 'mark_duplicates', args: { keep: 'D1', duplicates: ['D2'], action: 'delete' } }] },
      { text: 'Bitte bestätige das Löschen.' },
    );
    const res = await app.ok('chat:send', { text: 'Lösch die Kopie der Rechnung' });
    expect(await stepOutcome(res.assistantMessage.runId, 'mark_duplicates')).toBe('proposed');
    expect(app.services.documents.findRow(copy)).toBeTruthy();
    expect(app.services.documents.findRow(keep)).toBeTruthy();
    expect(res.assistantMessage.actions.find((a) => a.actionType === 'agent_batch')?.requiredConfirmation).toBe('strong');
  });

  it('moving originals out of their place (archive_inbox mode move) is only ever a proposal, even in „Auto“', async () => {
    const id = await inInbox(app, { name: 'brief.txt', content: 'Ein Brief' });
    const source = app.services.documents.getRow(id).sourcePath!;
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { status: 'inbox' } }] },
      { calls: [{ name: 'archive_inbox', args: { documents: ['S1'], mode: 'move', folder: 'private/post' } }] },
      { text: 'Bitte bestätigen.' },
    );
    const res = await app.ok('chat:send', { text: 'Verschieb den Brief ins Archiv' });
    expect(await stepOutcome(res.assistantMessage.runId, 'archive_inbox')).toBe('proposed');
    expect(fs.existsSync(source)).toBe(true);
    expect(app.services.documents.getRow(id).status).not.toBe('archived');
  });

  it('the threshold set in the settings counts; learned rules applied to the whole archive cannot get around it', async () => {
    await app.ok('settings:update', { agent: { massActionThreshold: 1 } });
    const a = await archived(app, { name: 'strom-1.txt', content: 'Stadtwerke Strom Januar', folder: 'private/misc' });
    const b = await archived(app, { name: 'strom-2.txt', content: 'Stadtwerke Strom Februar', folder: 'private/misc' });
    app.services.memory.save({
      kind: 'rule',
      name: 'Stadtwerke',
      content: 'Rechnungen der Stadtwerke nach private/energie',
      data: { when: { textContains: 'Stadtwerke' }, then: { folder: 'private/energie' } },
    });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'apply_rules', args: { preview: false } }] }, { text: 'Bitte bestätigen.' });
    const res = await app.ok('chat:send', { text: 'Wende meine Regeln auf alles an' });
    expect(await stepOutcome(res.assistantMessage.runId, 'apply_rules')).toBe('proposed');
    expect(folderOf(app, a)).toBe('private/misc');
    expect(folderOf(app, b)).toBe('private/misc');
  });

  it('background runs follow the same exceptions: a critical change becomes a proposal', async () => {
    const id = await inInbox(app, { name: 'brief.txt', content: 'Ein Brief' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'archive_inbox', args: { documents: ['S1'], mode: 'move', folder: 'private/post' } }] },
      { text: 'Vorgeschlagen.' },
    );
    const run = await app.services.agent.runBackground('inbox', { docIds: [id] });
    expect(run?.steps.find((s) => s.tool === 'archive_inbox')?.outcome).toBe('proposed');
    expect(app.services.documents.getRow(id).status).not.toBe('archived');
  });
});

describe('Agent core: requests and fallback (#295)', () => {
  it('requests of one conversation run one after another – no run starts before the previous one is done (#251)', async () => {
    const first = await app.ok('chat:send', { text: 'Hallo' });
    const turn = (round: number, text: string) => (round % 2 === 1 ? { calls: [{ name: 'list_folders', args: {} }] } : { text });
    app.llm.agent = ({ round, body }) => {
      const input = JSON.stringify(body.input);
      return turn(round, input.includes('Zweite') ? 'B' : 'A');
    };
    app.llm.agentRequests.length = 0;
    const [a, b] = await Promise.all([
      app.ok('chat:send', { conversationId: first.conversationId, text: 'Erste Frage' }),
      app.ok('chat:send', { conversationId: first.conversationId, text: 'Zweite Frage' }),
    ]);
    expect(a.assistantMessage.content).toBe('A');
    expect(b.assistantMessage.content).toBe('B');
    // the two requests of the first run come before any request of the second one
    const lastUser = app.llm.agentRequests.map((r) => {
      const input = JSON.stringify(r.input);
      return input.lastIndexOf('Zweite Frage') > input.lastIndexOf('Erste Frage') ? 'B' : 'A';
    });
    expect(lastUser).toEqual(['A', 'A', 'B', 'B']);
  });

  it('in mode „nur lokal“ the chat stays rule-based: nothing goes to the agent endpoint', async () => {
    app.services.settings.update({ privacy: { llmMode: 'local_only' } });
    app.llm.agent = scriptedTurns({ text: 'Darf nicht kommen.' });
    const res = await app.ok('chat:send', { text: 'Welche offenen Punkte gibt es?' });
    expect(res.assistantMessage.runId ?? null).toBeNull();
    expect(app.llm.agentRequests).toHaveLength(0);
    expect(sentText(app)).toBe('[]');
  });
});
