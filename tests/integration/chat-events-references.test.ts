import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { extractedDecision, intent } from '../helpers/chat-intents';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

describe('Events in the timeline', () => {
  const ev = (over: Record<string, unknown> = {}) =>
    intent({
      intent: 'event_record',
      segment: 'am 01.10.2026 eingereicht',
      event: { title: 'Beitrag beim German Testing Day eingereicht', occurredAt: '2026-10-01' },
      topic: 'Konferenzbeitrag',
      ...over,
    });

  it('records an event with a date directly; it appears in timeline and search and can only be deleted with confirmation', async () => {
    app.llm.on('ChatIntent', () => ({ intents: [ev()] }));
    const r = await app.ok('chat:send', { text: 'Ich habe den Beitrag am 01.10.2026 beim German Testing Day eingereicht.' });
    expect(r.assistantMessage.content).toMatch(/Ereignis in der Timeline eingetragen/);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    const events = await app.ok('events:list', {});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ occurredAt: expect.stringMatching(/^2026-10-01/), topicName: 'Konferenzbeitrag' });
    const entry = (await app.ok('timeline:get', {})).find((e) => e.kind === 'event');
    expect(entry).toMatchObject({ date: '2026-10-01', title: expect.stringContaining('German Testing Day') });
    expect((await app.ok('search:global', { query: 'German Testing Day', limit: 5 })).some((h) => h.type === 'event')).toBe(true);
    await app.ok('events:delete', { id: events[0]!.id, confirmed: true });
    expect(await app.ok('events:list', {})).toHaveLength(0);
    expect((await app.ok('timeline:get', {})).some((e) => e.kind === 'event')).toBe(false);
  });

  it('asks for the date when it is missing and remembers the event until the answer', async () => {
    app.llm.on('ChatIntent', () => ({ intents: [ev({ segment: 'Beitrag eingereicht', event: { title: 'Beitrag eingereicht', occurredAt: null } })] }));
    const r1 = await app.ok('chat:send', { text: 'Ich habe den Beitrag eingereicht.' });
    expect(r1.assistantMessage.content).toMatch(/An welchem Datum/);
    expect(await app.ok('events:list', {})).toHaveLength(0);
    app.llm.on('ChatIntent', () => ({ intents: [ev({ event: { title: 'Beitrag eingereicht', occurredAt: '2026-10-01' } })] }));
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Am 1. Oktober 2026' });
    expect(r2.assistantMessage.content).toMatch(/Ereignis in der Timeline eingetragen/);
    expect(await app.ok('events:list', {})).toHaveLength(1);
  });

  it('also offers „Ereignis“ for an uncertain decision and creates it on that answer', async () => {
    app.llm.on('ChatIntent', () => ({
      intents: [
        intent({
          intent: 'decision_new',
          segment: 'am 01.10.2026 eingereicht',
          decisionCertainty: 'unsure',
          decision: extractedDecision({ decisionText: 'Beitrag eingereicht.', title: 'Beitrag eingereicht', decidedAt: '2026-10-01' }),
        }),
      ],
    }));
    const r1 = await app.ok('chat:send', { text: 'Ich habe am 01.10.2026 den Beitrag eingereicht.' });
    expect(r1.assistantMessage.content).toMatch(/Ereignis/);
    app.llm.on('ChatIntent', () => intent({ intent: 'unknown' }));
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Als Ereignis' });
    expect(r2.assistantMessage.content).toMatch(/Ereignis in der Timeline eingetragen/);
    expect(await app.ok('decisions:list', {})).toHaveLength(0);
    expect((await app.ok('events:list', {}))[0]).toMatchObject({ occurredAt: expect.stringMatching(/^2026-10-01/) });
  });

  it('also creates events manually', async () => {
    const e = await app.ok('events:create', { title: 'Kickoff', occurredAt: '2026-03-03', project: 'Nordlicht', sourceIds: [] });
    expect(e.projectName).toBe('Nordlicht');
    await expect(app.call('events:create', { title: 'x', occurredAt: 'kein Datum', sourceIds: [] })).resolves.toMatchObject({ ok: false });
  });
});

describe('References in the chat lead to the right object', () => {
  const mk = (text: string, date: string) => ({
    decisionText: text,
    title: text.slice(0, 40),
    topic: 'prod-plat',
    decidedAt: date,
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });

  it('returns the reminder as a source of type "reminder" (not as a note)', async () => {
    app.llm.down = true;
    const r1 = await app.ok('chat:send', { text: 'Erinnere mich bitte an das Treffen mit dem Team.' });
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: '31.10.' });
    const rem = (await app.ok('reminders:list', {}))[0]!;
    expect(r2.assistantMessage.sources.find((s) => s.id === rem.id)?.type).toBe('reminder');
    // the type is preserved when read from the stored history too
    const history = await app.ok('chat:history', { conversationId: r1.conversationId });
    expect(history.at(-1)!.sources.find((s) => s.id === rem.id)?.type).toBe('reminder');
  });

  it('marks contradictions in the context as "contradiction" – after a new decision and during the check', async () => {
    app.llm.down = true;
    await app.ok('decisions:create', mk('Wir führen prod-plat weiter.', '2026-01-10'));
    const r = await app.ok('chat:send', { text: 'Wir haben entschieden, dass wir prod-plat pausieren. Datum 01.03.2026.' });
    const r2 = await app.ok('chat:send', { conversationId: r.conversationId, text: 'Anna' });
    const contra = await app.ok('contradictions:list', {});
    expect(contra.length).toBeGreaterThan(0);
    const fromDecision = r2.assistantMessage.context?.contradictions ?? [];
    expect(fromDecision.length).toBeGreaterThan(0);
    expect(fromDecision.every((c) => c.type === 'contradiction' && contra.some((x) => x.id === c.id))).toBe(true);

    const check = await app.ok('chat:send', { text: 'gibt es widersprüche?' });
    expect(check.assistantMessage.intent).toBe('contradiction_check');
    const fromCheck = check.assistantMessage.context?.contradictions ?? [];
    expect(fromCheck.map((c) => c.id).sort()).toEqual(contra.map((c) => c.id).sort());
    expect(fromCheck.every((c) => c.type === 'contradiction')).toBe(true);
  });

  it('links contradictions in the timeline to the contradiction itself', async () => {
    app.llm.down = true;
    await app.ok('decisions:create', mk('Wir führen prod-plat weiter.', '2026-01-10'));
    await app.ok('decisions:create', mk('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01'));
    const [contra] = await app.ok('contradictions:list', {});
    const entry = (await app.ok('timeline:get', {})).find((e) => e.kind === 'contradiction')!;
    expect(entry.refs[0]).toMatchObject({ type: 'contradiction', id: contra!.id });
    expect(entry.refs.slice(1).every((x) => x.type === 'decision')).toBe(true);

    const r = await app.ok('chat:send', { text: 'Zeig mir den Zeitverlauf' });
    expect(r.assistantMessage.intent).toBe('timeline_query');
    expect(r.assistantMessage.sources.find((s) => s.id === contra!.id)?.type).toBe('contradiction');
    expect((r.assistantMessage.context?.contradictions ?? []).map((c) => c.id)).toContain(contra!.id);
  });
});
