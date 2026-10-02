import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ruleMatches } from '../../packages/core/src/agent/memory';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, folderOf, scriptedTurns } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

const stadtwerkeRule = { when: { sender: 'Stadtwerke' }, then: { folder: 'private/finanzen/energie' } };
const lastOutput = () =>
  ((app.llm.agentRequests.at(-1)?.input as Array<{ type?: string; output?: string }>) ?? []).filter((i) => i.type === 'function_call_output').at(-1)?.output ??
  '';

describe('Learning: rules, workflows, corrections, memory (#315)', () => {
  it('stores a rule on the explicit instruction, gives it to every run and applies it retroactively', async () => {
    const doc = await archived(app, {
      name: 'stadtwerke-rechnung.txt',
      content: 'Stadtwerke München Rechnung Strom',
      folder: 'private/misc',
      docType: 'Rechnung',
      persons: ['Stadtwerke München'],
    });
    app.llm.agent = scriptedTurns(
      {
        calls: [
          {
            name: 'remember',
            args: {
              kind: 'rule',
              name: 'Stadtwerke → Energie',
              content: 'Rechnungen der Stadtwerke immer nach private/finanzen/energie',
              rule: stadtwerkeRule,
            },
          },
        ],
      },
      { text: 'Gemerkt.' },
    );
    await app.ok('chat:send', { text: 'Merk dir: Rechnungen der Stadtwerke immer nach private/finanzen/energie' });
    const rules = await app.ok('agent:memory', { kind: 'rule' });
    expect(rules).toHaveLength(1);

    app.llm.agent = scriptedTurns(
      ({ body }) => {
        // learned content goes into every run, with its id
        expect(String(body.instructions)).toContain(`[${rules[0]!.id}] Stadtwerke → Energie`);
        return { calls: [{ name: 'apply_rules', args: { preview: true } }] };
      },
      () => {
        expect(lastOutput()).toContain('Vorschau');
        return { calls: [{ name: 'apply_rules', args: { preview: false } }] };
      },
      { text: `Regel [${rules[0]!.id}] angewendet.` },
    );
    const res = await app.ok('chat:send', { text: 'Wende meine Regeln auf das Archiv an' });
    expect(folderOf(app, doc)).toBe('private/finanzen/energie');
    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect((run.applied ?? []).map((a) => a.id)).toContain(rules[0]!.id);
    expect((await app.ok('agent:memory', { kind: 'rule' }))[0]!.timesApplied).toBeGreaterThanOrEqual(1);
  });

  it('never stores anything without the user asking for it', async () => {
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'remember', args: { kind: 'fact', name: 'Vermieter', content: 'Vermieter ist Firma X' } }] },
      { text: 'ok' },
    );
    await app.ok('chat:send', { text: 'Wer ist eigentlich mein Vermieter?' });
    expect(await app.ok('agent:memory', {})).toHaveLength(0);
    expect(lastOutput()).toContain('Frag zuerst');
  });

  it('after asking: „ja“ stores the fact', async () => {
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'ask_user', args: { question: 'Soll ich mir merken, dass Firma X dein Vermieter ist?', options: ['Ja', 'Nein'] } }] },
      { calls: [{ name: 'remember', args: { kind: 'fact', name: 'Vermieter', content: 'Vermieter ist Firma X' } }] },
      { text: 'Gemerkt.' },
    );
    const first = await app.ok('chat:send', { text: 'Die Rechnung kam von Firma X, meinem Vermieter.' });
    await app.ok('chat:send', { conversationId: first.conversationId, text: 'Ja' });
    expect((await app.ok('agent:memory', { kind: 'fact' })).map((e) => e.content)).toEqual(['Vermieter ist Firma X']);
  });

  it('contradicting rules are reported, not decided; the document stays where it is', async () => {
    app.services.memory.save({
      kind: 'rule',
      name: 'A',
      content: 'Stadtwerke nach a',
      data: { when: { sender: 'Stadtwerke' }, then: { folder: 'private/a' } },
    });
    app.services.memory.save({ kind: 'rule', name: 'B', content: 'Strom nach b', data: { when: { textContains: 'Strom' }, then: { folder: 'private/b' } } });
    const doc = await archived(app, { name: 'rechnung.txt', content: 'Stadtwerke Strom', folder: 'private/misc', persons: ['Stadtwerke'] });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'apply_rules', args: { preview: false } }] }, { text: 'Widerspruch – welche Regel soll gelten?' });
    await app.ok('chat:send', { text: 'Wende die Regeln an' });
    expect(folderOf(app, doc)).toBe('private/misc');
    expect(lastOutput()).toContain('verschiedene Ordner');
  });

  it('workflows: taught by name, changed later, given to the run', async () => {
    app.llm.agent = scriptedTurns(
      {
        calls: [
          {
            name: 'remember',
            args: {
              kind: 'workflow',
              name: 'Steuer-Mappe',
              content: 'Belege des Vorjahres sammeln, auf Lücken prüfen, ZIP mit Übersicht erstellen',
              workflow: {
                steps: ['Belege des Vorjahres sammeln', 'auf Lücken prüfen', 'ZIP mit Übersicht erstellen'],
                parameters: [{ name: 'jahr', description: 'Steuerjahr' }],
              },
            },
          },
        ],
      },
      { text: 'Ablauf gespeichert.' },
    );
    await app.ok('chat:send', { text: 'Wenn ich „Steuer-Mappe“ sage: alle Belege des Vorjahres sammeln, auf Lücken prüfen, ZIP mit Übersicht erstellen' });
    const wf = (await app.ok('agent:memory', { kind: 'workflow' }))[0]!;
    app.llm.agent = scriptedTurns(
      {
        calls: [
          {
            name: 'update_memory',
            args: {
              id: wf.id,
              workflow: { steps: ['Belege und Spendenquittungen des Vorjahres sammeln', 'auf Lücken prüfen', 'ZIP mit Übersicht erstellen'] },
            },
          },
        ],
      },
      { text: 'Angepasst.' },
    );
    await app.ok('chat:send', { text: 'Nimm bei der Steuer-Mappe künftig auch die Spendenquittungen mit' });
    expect(JSON.stringify((await app.ok('agent:memory', { kind: 'workflow' }))[0]!.data)).toContain('Spendenquittungen');
    app.llm.agent = scriptedTurns(({ body }) => {
      expect(String(body.instructions)).toContain('Steuer-Mappe');
      expect(String(body.instructions)).toContain('Spendenquittungen');
      return { text: 'Ich werde: 1. …' };
    });
    await app.ok('chat:send', { text: 'Mach die Steuer-Mappe für 2025' });
  });

  it('repeated corrections of the agent lead to a rule PROPOSAL; the rule is stored only after confirmation', async () => {
    const docs = [];
    for (const n of [1, 2, 3])
      docs.push(await archived(app, { name: `arzt-${n}.txt`, content: `Arztrechnung ${n}`, folder: 'private/misc', docType: 'Arztrechnung' }));
    // the agent filed them (inside a run) …
    for (const id of docs) {
      app.llm.agent = scriptedTurns(
        { calls: [{ name: 'find_documents', args: { name: app.services.documents.getRow(id).title } }] },
        { calls: [{ name: 'move_documents', args: { documents: ['S1'], folder: 'private/rechnungen' } }] },
        { text: 'verschoben' },
      );
      await app.ok('chat:send', { text: 'Leg die Arztrechnung ab' });
    }
    // … and the user moves them somewhere else
    for (const id of docs) await app.services.archive.relocate([{ documentId: id, categoryPath: 'private/gesundheit' }], { confirmed: true });
    const corrections = await app.ok('agent:memory', { kind: 'correction' });
    expect(corrections.length).toBe(3);
    expect(await app.ok('agent:memory', { kind: 'rule' })).toHaveLength(0);
    const insight = (await app.ok('insights:list', { status: 'open' })).find((i) => i.kind === 'learned_rule')!;
    expect(insight.title).toContain('private/gesundheit');
    await app.ok('insights:respond', { response: 'accept', id: insight.id, confirmed: true });
    const rules = await app.ok('agent:memory', { kind: 'rule' });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.data).toMatchObject({ when: { docType: 'Arztrechnung' }, then: { folder: 'private/gesundheit' } });
  });

  it('everything learned is visible, can be switched off and deleted', async () => {
    const e = await app.ok('agent:saveMemory', { kind: 'preference', name: 'Kurz', content: 'Antworte kurz.' });
    await app.ok('agent:updateMemory', { id: e.id, enabled: false });
    app.llm.agent = scriptedTurns(({ body }) => {
      expect(String(body.instructions)).not.toContain('Antworte kurz.');
      return { text: 'ok' };
    });
    await app.ok('chat:send', { text: 'Hallo' });
    await app.ok('agent:deleteMemory', { id: e.id });
    expect(await app.ok('agent:memory', {})).toHaveLength(0);
  });

  it('rule conditions match the document fields', () => {
    const d = {
      title: 'Rechnung',
      originalName: 'r.pdf',
      ext: 'pdf',
      docType: 'Rechnung',
      topicName: null,
      persons: ['Stadtwerke München'],
      sender: 'Stadtwerke München',
      text: 'Strom',
    };
    expect(ruleMatches({ when: { sender: 'stadtwerke' }, then: { folder: 'x' } }, d)).toBe(true);
    expect(ruleMatches({ when: { sender: 'stadtwerke', ext: 'docx' }, then: { folder: 'x' } }, d)).toBe(false);
    expect(ruleMatches({ when: { docType: 'Rechnung', textContains: 'strom' }, then: { folder: 'x' } }, d)).toBe(true);
  });
});
