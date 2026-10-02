import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, scriptedTurns } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

/** Text of the last tool results the model saw (Responses API input of the latest request). */
const lastToolOutputs = () =>
  ((app.llm.agentRequests.at(-1)?.input as Array<{ type?: string; output?: string }>) ?? [])
    .filter((i) => i.type === 'function_call_output')
    .map((i) => i.output ?? '');

describe('Capturing knowledge as agent tools (#307)', () => {
  it('a decision without a date is saved as a draft; the handler question goes to the agent, which amends after the answer', async () => {
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'record_decision', args: { text: 'Wir nehmen das Angebot von Müller', topic: 'Dach', participants: ['Anna'] } }] },
      () => {
        expect(lastToolOutputs().join('\n')).toContain('OFFENE RÜCKFRAGE');
        return { calls: [{ name: 'ask_user', args: { question: 'Wann wurde das entschieden?' } }] };
      },
      { calls: [{ name: 'amend_decision', args: { id: 'K1', decidedAt: '15.09.2026' } }] },
      { text: 'Die Entscheidung ist vollständig.' },
    );
    const first = await app.ok('chat:send', { text: 'Wir haben entschieden, das Angebot von Müller zu nehmen.' });
    expect(first.assistantMessage.content).toContain('Wann wurde das entschieden?');
    const draft = (await app.ok('decisions:list', {}))[0]!;
    expect(draft.status).toBe('draft');
    const second = await app.ok('chat:send', { conversationId: first.conversationId, text: '15.09.' });
    expect(second.assistantMessage.content).toContain('vollständig');
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.decidedAt?.slice(0, 10)).toBe('2026-09-15');
    expect(d.participants).toContain('Anna');
  });

  it('„Entscheidung oder nur Notiz?“: certainty unsure saves nothing and asks', async () => {
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'record_decision', args: { text: 'Vielleicht streichen wir die Küche', certainty: 'unsure' } }] },
      { text: '?' },
    );
    await app.ok('chat:send', { text: 'Vielleicht streichen wir die Küche' });
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    expect(lastToolOutputs()[0]).toContain('NICHT GESPEICHERT');
  });

  it('open items: duplicate check reports an existing item; ifDuplicate=create creates it anyway; sources link documents', async () => {
    const doc = await archived(app, 'angebot.txt', 'Angebot Müller', 'work/misc');
    await app.ok('openItems:create', { title: 'Angebot Müller prüfen', priority: 'normal', confidence: 0.9 } as never);
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'angebot' } }] },
      { calls: [{ name: 'create_open_item', args: { title: 'Angebot Müller prüfen', sources: ['D1'] } }] },
      () => {
        expect(lastToolOutputs().at(-1)).toMatch(/gibt es schon|bereits|ergänzen/i);
        return {
          calls: [{ name: 'create_open_item', args: { title: 'Angebot Müller prüfen', description: 'zweiter Punkt', ifDuplicate: 'create', sources: ['D1'] } }],
        };
      },
      { text: 'Angelegt.' },
    );
    await app.ok('chat:send', { text: 'Leg einen offenen Punkt an: Angebot Müller prüfen' });
    const items = await app.ok('openItems:list', {});
    expect(items).toHaveLength(2);
    const created = items.find((i) => i.description === 'zweiter Punkt')!;
    expect(created.sourceIds).toContain(doc);
  });

  it('reminders: date in words is normalized, a second reminder for the same target and day is not created', async () => {
    const doc = await archived(app, 'vertrag.txt', 'Vertrag', 'work/misc');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'vertrag' } }] },
      { calls: [{ name: 'create_reminder', args: { title: 'Vertrag kündigen', remindAt: '2026-11-30', target: 'D1' } }] },
      { calls: [{ name: 'create_reminder', args: { title: 'Vertrag kündigen!', remindAt: '30.11.2026', target: 'D1' } }] },
      { text: 'Erinnerung steht.' },
    );
    await app.ok('chat:send', { text: 'Erinnere mich am 30.11. an die Kündigung des Vertrags' });
    const reminders = (await app.ok('reminders:list', { status: 'pending' })).filter((r) => r.targetId === doc);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.remindAt.slice(0, 10)).toBe('2026-11-30');
    expect(lastToolOutputs().at(-1)).toContain('keine zweite');
  });

  it('notes and events are created once; an event without a date is asked about', async () => {
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'record_note', args: { content: 'Die Heizung macht Geräusche.' } }] },
      { calls: [{ name: 'record_note', args: { content: 'Die Heizung macht Geräusche.' } }] },
      { calls: [{ name: 'record_event', args: { title: 'Heizung gewartet' } }] },
      { text: 'ok' },
    );
    await app.ok('chat:send', { text: 'Notiz: Die Heizung macht Geräusche. Und die Heizung wurde gewartet.' });
    expect(app.services.graph.listEntities({ type: 'note' })).toHaveLength(1);
    expect(lastToolOutputs().at(-1)).toContain('OFFENE RÜCKFRAGE');
  });

  it('changes of a capture run are undone with the run: created open item, note and reminder disappear', async () => {
    app.llm.agent = scriptedTurns(
      {
        calls: [
          { name: 'create_open_item', args: { title: 'Steuer abgeben', dueAt: '2026-12-31' } },
          { name: 'record_note', args: { content: 'Belege liegen im Ordner Steuer.' } },
          { name: 'create_reminder', args: { title: 'Steuer!', remindAt: '2026-12-01' } },
        ],
      },
      { text: 'Alles erfasst.' },
    );
    const res = await app.ok('chat:send', {
      text: 'Leg an: Steuer abgeben bis 31.12., notiere dass die Belege im Ordner Steuer liegen, und erinnere mich am 1.12.',
    });
    expect(await app.ok('openItems:list', {})).toHaveLength(1);
    const undo = await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect(undo.failed).toBe(0);
    expect(await app.ok('openItems:list', {})).toHaveLength(0);
    expect(app.services.graph.listEntities({ type: 'note' })).toHaveLength(0);
    expect(await app.ok('reminders:list', { status: 'pending' })).toHaveLength(0);
  });

  it('update and close open items by K-id; closing is undoable', async () => {
    const item = await app.ok('openItems:create', { title: 'Zahnarzt anrufen', priority: 'normal', confidence: 0.9 } as never);
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'list_entries', args: { kind: 'open_item' } }] },
      { calls: [{ name: 'update_open_item', args: { id: 'K1', dueAt: '2026-11-02', priority: 'high' } }] },
      { calls: [{ name: 'close_open_item', args: { id: 'K1', note: 'Termin steht' } }] },
      { text: 'Erledigt.' },
    );
    const res = await app.ok('chat:send', { text: 'Der Zahnarzt-Punkt ist erledigt, vorher Frist auf 2.11. setzen' });
    const after = await app.ok('openItems:list', {});
    expect(after.find((o) => o.id === item.id)?.status).toBe('resolved');
    await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    const back = (await app.ok('openItems:list', {})).find((o) => o.id === item.id)!;
    expect(back.status).toBe('open');
  });
});
