import { afterEach, describe, expect, it } from 'vitest';
import type { ChatIntent } from '@archivist/shared';
import { CaptureService } from '../../packages/core/src/services/capture';
import { createTestApp, type TestApp } from '../helpers/harness';
import { agentApp, archived, scriptedTurns } from '../helpers/agent';

/**
 * Capturing knowledge is one module with two callers (#307): the agent's capture tools and the rule-based chat (fallback
 * without LLM, in mode „nur lokal“ or without tool calling). The fallback keeps its tests in chat-*.test.ts; here the
 * agent path of the same capabilities, and the module itself.
 */
let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

/** Text of the last tool results the model saw (Responses API input of the latest request). */
const lastToolOutputs = () =>
  ((app.llm.agentRequests.at(-1)?.input as Array<{ type?: string; output?: string }>) ?? [])
    .filter((i) => i.type === 'function_call_output')
    .map((i) => i.output ?? '');

const intent = (over: Partial<ChatIntent>): ChatIntent => ({
  intent: 'unknown',
  confidence: 0.9,
  rationale: 'test',
  segment: null,
  query: null,
  alternativeQueries: null,
  topic: null,
  project: null,
  timeRange: null,
  decision: null,
  openItem: null,
  event: null,
  reminder: null,
  proposalId: null,
  path: null,
  note: null,
  decisionCertainty: null,
  ...over,
});

const decision = (over: Record<string, unknown>) =>
  ({ participants: [], alternatives: [], unknownFields: [], confidence: 0.85, ...over }) as NonNullable<ChatIntent['decision']>;

const mkDecision = (text: string, topic: string, date: string) =>
  app.ok('decisions:create', {
    decisionText: text,
    title: text.slice(0, 40),
    topic,
    decidedAt: date,
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });

describe('The capture module: one function, two callers (#307)', () => {
  it('the rule-based chat and the agent entry point produce the same decision and the same follow-up question', async () => {
    app = await createTestApp({ privacy: 'auto' });
    const ex = decision({ decisionText: 'Wir nehmen das Angebot von Müller', title: 'Angebot Müller', topic: 'Dach', participants: ['Anna'] });
    app.llm.on('ChatIntent', () => ({ intents: [intent({ intent: 'decision_new', decisionCertainty: 'clear', decision: ex })] }));
    const viaChat = await app.ok('chat:send', { text: 'Wir haben entschieden, das Angebot von Müller zu nehmen.' });
    const viaAgent = await app.services.capture.forAgent(
      null,
      'Wir haben entschieden, das Angebot von Müller zu nehmen.',
      intent({ intent: 'decision_new', decisionCertainty: 'clear', decision: ex }),
    );
    const [a, b] = (await app.ok('decisions:list', {})).toSorted((x, y) => x.createdAt.localeCompare(y.createdAt));
    for (const d of [a!, b!]) expect(d).toMatchObject({ status: 'draft', title: 'Angebot Müller', topicName: 'Dach', participants: ['Anna'] });
    // same text, same question (the agent asks it through ask_user, the chat keeps it as a follow-up question)
    expect(viaAgent.content).toBe(viaChat.assistantMessage.content.replace(/\n\n_Hinweis:[\s\S]*$/, ''));
    expect(viaAgent.question).toBe(viaAgent.content);
    expect(viaAgent.decisionId).toBe(b!.id);
  });

  it('handles exactly the capture intents; anything else is no capture request', async () => {
    app = await createTestApp({ privacy: 'auto' });
    for (const i of [
      'decision_new',
      'decision_amend',
      'decision_supersede',
      'event_record',
      'note_capture',
      'open_item_new',
      'open_item_update',
      'open_item_close',
      'reminder_create',
      'reminder_snooze',
    ] as const)
      expect(CaptureService.handles(i)).toBe(true);
    for (const i of ['knowledge_question', 'document_search', 'archive_structure', 'proposal_confirm', 'unknown'] as const)
      expect(CaptureService.handles(i)).toBe(false);
    await expect(app.services.capture.forAgent(null, 'x', intent({ intent: 'knowledge_question' }))).rejects.toThrow('Kein Erfassungs-Anliegen');
  });

  it('a duplicate open item reports no id; ifDuplicate „create“ (force) creates it anyway', async () => {
    app = await createTestApp({ privacy: 'auto' });
    const oi = {
      title: 'Angebot Müller prüfen',
      description: null,
      responsible: null,
      dueAt: null,
      priority: null,
      targetId: null,
      targetHint: null,
      newStatus: null,
      resolutionNote: null,
    };
    const first = await app.services.capture.forAgent(null, 'Angebot Müller prüfen', intent({ intent: 'open_item_new', openItem: oi }));
    expect(first.openItemId).toBeTruthy();
    // the optional „wer/bis wann?“ of a new item is no question the agent has to ask
    expect(first.question).toBeNull();
    const dup = await app.services.capture.forAgent(null, 'Angebot Müller prüfen', intent({ intent: 'open_item_new', openItem: oi }));
    expect(dup).toMatchObject({ openItemId: null, content: 'Gibt es schon: ‚Angebot Müller prüfen‘ – ergänzen oder neu anlegen?' });
    expect(dup.question).toBe(dup.content);
    const forced = await app.services.capture.forAgent(null, 'Angebot Müller prüfen', intent({ intent: 'open_item_new', openItem: oi }), { force: true });
    expect(forced.openItemId).toBeTruthy();
    expect(await app.ok('openItems:list', {})).toHaveLength(2);
  });
});

describe('Capturing on the agent path (#307) – counterparts of the rule-based chat tests', () => {
  it('superseding: a named older decision is proposed as superseded (card in the reply); confirmed, it is superseded', async () => {
    app = await agentApp();
    const old = await mkDecision('Urlaub im Juni', 'Urlaub', '2026-01-05');
    await mkDecision('Wir nutzen Kafka', 'Messaging', '2026-01-10');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'list_entries', args: { kind: 'decision' } }] },
      () => {
        const ref = /(K\d+)[^\n]*Urlaub im Juni/.exec(lastToolOutputs().join('\n'))![1]!;
        return {
          calls: [
            {
              name: 'record_decision',
              args: {
                text: 'Urlaub im Juli statt Juni',
                title: 'Urlaub Juli',
                topic: 'Urlaub',
                decidedAt: '2026-05-01',
                participants: ['Anna'],
                supersedes: ref,
              },
            },
          ],
        };
      },
      () => {
        expect(lastToolOutputs().at(-1)).toContain('1 Vorschlagskarte(n) zur Bestätigung angelegt');
        return { text: 'Gespeichert – bitte bestätige, dass die alte Entscheidung überholt ist.' };
      },
    );
    const res = await app.ok('chat:send', { text: 'Urlaub im Juli statt Juni, ersetzt die alte Entscheidung.' });
    const card = res.assistantMessage.actions.find((a) => a.actionType === 'supersede_decision')!;
    expect((card.proposedParameters as { oldDecisionId: string }).oldDecisionId).toBe(old.id);
    expect((await app.ok('decisions:list', {})).find((d) => d.id === old.id)?.status).not.toBe('superseded');
    await app.ok('actions:resolve', { decision: 'approve', actionId: card.id, confirmed: true });
    expect((await app.ok('decisions:list', {})).find((d) => d.id === old.id)?.status).toBe('superseded');
  });

  it('superseding with several candidates: the agent gets their refs, asks, and proposes the chosen one', async () => {
    app = await agentApp();
    const june = await mkDecision('Urlaub im Juni', 'Urlaub', '2026-01-05');
    await mkDecision('Urlaub an der See', 'Urlaub', '2026-01-06');
    let candidates: string[] = [];
    let juneRef = '';
    app.llm.agent = scriptedTurns(
      {
        calls: [
          {
            name: 'record_decision',
            args: {
              text: 'Urlaub im Juli in den Bergen',
              title: 'Urlaub Juli',
              topic: 'Urlaub',
              decidedAt: '2026-05-01',
              participants: ['Anna'],
              supersedes: 'Urlaub',
            },
          },
        ],
      },
      () => {
        const out = lastToolOutputs().at(-1)!;
        expect(out).toContain('Welche Entscheidung wird ersetzt?');
        candidates = /Kandidaten[^:]*: (.*)/.exec(out)![1]!.split(', ');
        expect(candidates).toHaveLength(2);
        // the numbered list and the refs are in the same order
        const listed = [...out.matchAll(/^(\d)\. (.+?) \(/gm)].map((m) => m[2]);
        juneRef = candidates[listed.indexOf('Urlaub im Juni')]!;
        return { calls: [{ name: 'ask_user', args: { question: 'Welche Entscheidung wird ersetzt?', options: ['Urlaub im Juni', 'Urlaub an der See'] } }] };
      },
      () => ({ calls: [{ name: 'supersede_decision', args: { older: juneRef, newer: 'K1' } }] }),
      { text: 'Bitte bestätige die Karte.' },
    );
    const first = await app.ok('chat:send', { text: 'Wir fahren im Juli in die Berge, das ersetzt die alte Urlaubsentscheidung.' });
    expect(first.assistantMessage.quickReplies).toContain('Urlaub im Juni');
    const res = await app.ok('chat:send', { conversationId: first.conversationId, text: 'Urlaub im Juni' });
    const card = res.assistantMessage.actions.find((a) => a.actionType === 'supersede_decision')!;
    expect((card.proposedParameters as { oldDecisionId: string }).oldDecisionId).toBe(june.id);
    expect((await app.ok('decisions:list', {})).find((d) => d.id === june.id)?.status).not.toBe('superseded');
  });

  it('contradictions: a new contradicting decision brings the warning and the replace card', async () => {
    app = await agentApp();
    await mkDecision('Wir führen prod-plat weiter.', 'prod-plat', '2026-01-10');
    app.llm.on('ContradictionProposal', () => ({
      isContradiction: true,
      title: 'Widerspruch',
      description: 'Weiterführen und pausieren widersprechen sich.',
      confidence: 0.9,
    }));
    app.llm.agent = scriptedTurns(
      {
        calls: [{ name: 'record_decision', args: { text: 'Wir pausieren prod-plat.', topic: 'prod-plat', decidedAt: '2026-03-01', participants: ['Anna'] } }],
      },
      () => {
        expect(lastToolOutputs().at(-1)).toMatch(/⚠/);
        return { text: 'Achtung, das widerspricht einer älteren Entscheidung.' };
      },
    );
    const res = await app.ok('chat:send', { text: 'Wir haben entschieden, dass wir prod-plat pausieren. Datum 01.03.2026, mit Anna.' });
    expect(res.assistantMessage.actions.some((x) => x.actionType === 'supersede_decision' && x.status === 'proposed')).toBe(true);
    expect((await app.ok('contradictions:list', {})).length).toBeGreaterThan(0);
  });

  it('„Thema oder Projekt?“ goes to the agent as a question; the answer „Projekt“ is stored as the project', async () => {
    app = await agentApp();
    app.llm.agent = scriptedTurns(
      {
        calls: [
          {
            name: 'record_decision',
            args: { text: 'Das Gartenhaus wird aus Holz gebaut', topic: 'Gartenhaus', decidedAt: '2026-08-01', participants: ['Anna'] },
          },
        ],
      },
      () => {
        const out = lastToolOutputs().at(-1)!;
        expect(out).toContain('OFFENE RÜCKFRAGE');
        expect(out).toContain('Ist „Gartenhaus“ das Thema oder der Name des Projekts?');
        return { calls: [{ name: 'ask_user', args: { question: 'Ist „Gartenhaus“ das Thema oder der Name des Projekts?', options: ['Thema', 'Projekt'] } }] };
      },
      { calls: [{ name: 'amend_decision', args: { id: 'K1', project: 'Gartenhaus' } }] },
      { text: 'Als Projekt gespeichert.' },
    );
    const first = await app.ok('chat:send', { text: 'Wir haben entschieden: Das Gartenhaus wird aus Holz gebaut (1.8.2026, mit Anna).' });
    expect(first.assistantMessage.quickReplies).toEqual(['Thema', 'Projekt']);
    await app.ok('chat:send', { conversationId: first.conversationId, text: 'Projekt' });
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.projectName).toBe('Gartenhaus');
  });

  it('persons: „Anna und Ben“ as the answer to „Wer war beteiligt?“ resolves both; „unbekannt“ completes the date', async () => {
    app = await agentApp();
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'record_decision', args: { text: 'Wir kaufen ein E-Auto', topic: 'Auto' } }] },
      () => {
        expect(lastToolOutputs().at(-1)).toContain('Wer war an der Entscheidung beteiligt?');
        return { calls: [{ name: 'ask_user', args: { question: 'Wer war beteiligt, und wann war das?' } }] };
      },
      { calls: [{ name: 'amend_decision', args: { id: 'K1', participants: 'Anna und Ben'.split(' und '), unknownFields: ['decidedAt'] } }] },
      { text: 'Vollständig.' },
    );
    const first = await app.ok('chat:send', { text: 'Wir haben entschieden, ein E-Auto zu kaufen.' });
    await app.ok('chat:send', { conversationId: first.conversationId, text: 'Anna und Ben, das Datum weiß ich nicht' });
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.participants.toSorted()).toEqual(['Anna', 'Ben']);
    expect(d.unknownFields).toContain('decidedAt');
    expect(d.status).not.toBe('draft');
    expect(app.services.graph.findByNameOrAlias('person', 'Ben')).toBeTruthy();
    expect(lastToolOutputs().at(-1)).not.toContain('Es fehlt noch');
  });

  it('open items: „ich“ is the user (with name or as the placeholder „Ich“ with a hint); a duplicate is completed instead', async () => {
    app = await agentApp();
    app.llm.agent = scriptedTurns({ calls: [{ name: 'create_open_item', args: { title: 'Zahnarzt anrufen', responsible: 'mir' } }] }, () => {
      expect(lastToolOutputs().at(-1)).toContain('Einstellungen → Über dich');
      return { text: 'ok' };
    });
    await app.ok('chat:send', { text: 'Zahnarzt anrufen bleibt an mir hängen' });
    let item = (await app.ok('openItems:list', {}))[0]!;
    expect(item.responsibleName).toBe('Ich');
    expect(app.services.graph.getEntity(item.responsiblePersonId!)!.isSelf).toBe(true);
    expect(app.services.graph.findByName('person', 'mir')).toBeFalsy();

    app.services.settings.update({ profile: { name: 'Max Mustermann', nicknames: [] } });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'create_open_item', args: { title: 'Angebot Müller prüfen', responsible: 'ich' } }] },
      // the same once more: the duplicate check reports it, the agent completes the existing one instead
      { calls: [{ name: 'create_open_item', args: { title: 'Angebot Müller prüfen', description: 'bis Freitag Rückmeldung' } }] },
      () => {
        expect(lastToolOutputs().at(-1)).toContain('Gibt es schon: ‚Angebot Müller prüfen‘');
        return { calls: [{ name: 'list_entries', args: { kind: 'open_item' } }] };
      },
      () => {
        const ref = /(K\d+)[^\n]*Angebot Müller prüfen/.exec(lastToolOutputs().join('\n'))![1]!;
        return { calls: [{ name: 'update_open_item', args: { id: ref, description: 'bis Freitag Rückmeldung' } }] };
      },
      { text: 'Ergänzt.' },
    );
    await app.ok('chat:send', { text: 'Ich muss das Angebot für Müller prüfen, bis Freitag Rückmeldung' });
    const items = (await app.ok('openItems:list', {})).filter((o) => o.title === 'Angebot Müller prüfen');
    expect(items).toHaveLength(1);
    item = items[0]!;
    expect(item.responsibleName).toBe('Max Mustermann');
    expect(item.description).toContain('bis Freitag Rückmeldung');
  });

  it('events: with a date in the timeline and the search; a reminder on an open item belongs to the item', async () => {
    app = await agentApp();
    const oi = await app.ok('openItems:create', { title: 'Heizung warten lassen', priority: 'normal', confidence: 0.9 } as never);
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'record_event', args: { title: 'Heizung gewartet', occurredAt: '12.09.2026', description: 'Wartung durch Firma Kalt' } }] },
      { calls: [{ name: 'list_entries', args: { kind: 'open_item' } }] },
      { calls: [{ name: 'create_reminder', args: { title: 'Nächste Wartung', remindAt: '2027-09-01', target: 'K1' } }] },
      { text: 'Eingetragen.' },
    );
    await app.ok('chat:send', { text: 'Die Heizung wurde am 12.9. gewartet. Erinnere mich nächstes Jahr an die nächste Wartung.' });
    const ev = (await app.ok('events:list', {})).find((e) => e.title === 'Heizung gewartet')!;
    expect(ev.occurredAt.slice(0, 10)).toBe('2026-09-12');
    expect((await app.ok('search:global', { query: 'Heizung gewartet', limit: 10 })).some((h) => h.id === ev.id)).toBe(true);
    const reminders = await app.ok('reminders:list', { status: 'pending' });
    expect(reminders.find((r) => r.title === 'Nächste Wartung')).toMatchObject({ targetType: 'open_item', targetId: oi.id });
  });

  it('verified_answer uses the same answer logic as the chat: the matched passage goes to the model, only cited facts count', async () => {
    app = await agentApp();
    await archived(app, {
      name: 'protokoll.txt',
      content: 'Beschluss: Die Plattform zieht bis Ende März nach Frankfurt um, verantwortlich ist Jana.',
      folder: 'work/protokolle',
    });
    app.llm.on('KnowledgeAnswer', () => ({
      answer: 'Nach Frankfurt.',
      facts: [{ statement: 'Die Plattform zieht nach Frankfurt.', sourceIds: ['S1'] }],
      interpretation: null,
      uncertainties: [],
      missingInformation: [],
      contradictions: [],
      usedSourceIds: ['S1'],
      confidence: 0.9,
    }));
    app.llm.agent = scriptedTurns({ calls: [{ name: 'verified_answer', args: { question: 'Wohin zieht die Plattform um?' } }] }, { text: 'Nach Frankfurt.' });
    await app.ok('chat:send', { text: 'Wohin zieht die Plattform um?' });
    const knowledgeInput = app.llm.calls.find((c) => c.schema === 'KnowledgeAnswer')?.input ?? '';
    expect(knowledgeInput).toContain('Textstelle:');
    expect(knowledgeInput).toContain('Frankfurt');
    const out = lastToolOutputs().at(-1)!;
    expect(out).toContain('**Belegte Fakten**');
    expect(out).toContain('Die Plattform zieht nach Frankfurt. [1]');
  });
});
