import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { extractedDecision, intent, userText } from '../helpers/chat-intents';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });

/** complete decision on „prod-plat“ where it is unclear whether it is a topic or a project */
const complete = (over: Record<string, unknown> = {}) =>
  intent({
    intent: 'decision_new',
    decisionCertainty: 'clear',
    segment: 'prod-plat pausiert',
    decision: extractedDecision({
      decisionText: 'Wir machen mit prod-plat erstmal nicht weiter.',
      title: 'prod-plat pausiert',
      topic: 'prod-plat',
      topicIsProject: null,
      decidedAt: '2026-03-03',
      participants: ['Anna', 'Ben'],
      ...over,
    }),
  });
const question = /Ist „prod-plat“ das Thema oder der Name des Projekts\?/;
const reminder = () =>
  intent({ intent: 'reminder_create', segment: 'Erinnere mich am 15.11.2026', reminder: { remindAt: '2026-11-15', title: 'Feedback einholen' } });

describe('Follow-up question „Thema oder Projekt?“ (#51)', () => {
  it('saves an otherwise complete decision and still asks whether the name is a topic or a project', async () => {
    app.llm.on('ChatIntent', () => complete());
    const r = await send('Wir haben am 3.3.2026 mit Anna und Ben entschieden, mit prod-plat erstmal nicht weiterzumachen.');
    expect(r.assistantMessage.content).toContain('Die Entscheidung ist gespeichert');
    expect(r.assistantMessage.content).toMatch(question);
    expect(r.assistantMessage.quickReplies).toEqual(['Thema', 'Projekt']);
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.status).toBe('active');
    expect(d.missingFields).toEqual([]);
  });

  it('takes the answer „Projekt“ as a project and does not ask again afterwards', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /^Projekt$/.test(userText(input)) ? intent({ intent: 'decision_amend', decision: extractedDecision({ topicIsProject: true }) }) : complete(),
    );
    const r1 = await send('Wir haben am 3.3.2026 mit Anna und Ben entschieden, mit prod-plat erstmal nicht weiterzumachen.');
    const r2 = await send('Projekt', r1.conversationId);
    expect(r2.assistantMessage.content).not.toMatch(question);
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.projectName).toBe('prod-plat');
    expect(d.status).toBe('active');
    expect(await app.ok('decisions:list', {})).toHaveLength(1);
    // the topic moved into the project instead of living on next to it under the same name (#188)
    expect(d.topicName).toBeNull();
    expect(app.services.graph.findByName('topic', 'prod-plat')).toBeUndefined();
    expect(app.services.graph.findByName('project', 'prod-plat')).toBeDefined();
  });

  it('understands „Thema“ and „Projekt“ without an LLM too', async () => {
    app.llm.down = true;
    const r1 = await send('Wir haben am 03.03.2026 mit prod-plat entschieden: Pause.');
    expect(r1.assistantMessage.content).toContain('Die Entscheidung ist gespeichert');
    expect(r1.assistantMessage.content).toMatch(question);
    const r3 = await send('Thema', r1.conversationId);
    expect(r3.assistantMessage.content).not.toMatch(question);
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.topicName).toBe('prod-plat');
    expect(d.projectName).toBeNull();
    expect(app.services.graph.findByName('project', 'prod-plat')).toBeFalsy();

    const r4 = await send('Wir haben am 04.03.2026 mit nord-licht entschieden: Start.');
    expect(r4.assistantMessage.content).toMatch(/Ist „nord-licht“ das Thema oder der Name des Projekts\?/);
    await send('Das ist ein Projekt', r4.conversationId);
    const nl = (await app.ok('decisions:list', {})).find((x) => x.projectName === 'nord-licht')!;
    expect(nl.status).toBe('active');
    expect(app.services.graph.findByName('topic', 'nord-licht')).toBeUndefined();
  });

  it('does not ask when the name is already known as a project, and saves the decision with the project', async () => {
    app.services.graph.ensureEntity({ type: 'project', name: 'prod-plat' });
    app.llm.on('ChatIntent', () => complete());
    const r = await send('Wir haben am 3.3.2026 mit Anna und Ben entschieden, mit prod-plat erstmal nicht weiterzumachen.');
    expect(r.assistantMessage.content).not.toMatch(question);
    expect(r.assistantMessage.quickReplies ?? []).toEqual([]);
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.projectName).toBe('prod-plat');
    expect(d.status).toBe('active');
  });

  it('does not ask when the name is already known as a topic', async () => {
    app.services.graph.ensureEntity({ type: 'topic', name: 'prod-plat' });
    app.llm.on('ChatIntent', () => complete());
    const r = await send('Wir haben am 3.3.2026 mit Anna und Ben entschieden, mit prod-plat erstmal nicht weiterzumachen.');
    expect(r.assistantMessage.content).not.toMatch(question);
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.topicName).toBe('prod-plat');
    expect(d.projectName).toBeNull();
  });

  it('does not block a further intent of the same message and stays asked across another request', async () => {
    app.llm.on('ChatIntent', () => ({ intents: [complete(), reminder()] }));
    const r1 = await send('Wir haben am 3.3.2026 mit Anna und Ben entschieden, prod-plat zu pausieren. Erinnere mich am 15.11.2026.');
    expect(r1.assistantMessage.content).toMatch(question);
    expect(r1.assistantMessage.content).not.toContain('Danach erledige ich noch');
    expect(await app.ok('reminders:list', {})).toHaveLength(1);

    // next message with a different request: done immediately, the question stays open
    app.llm.on('ChatIntent', (_s, input) =>
      /^Projekt$/.test(userText(input))
        ? intent({ intent: 'decision_amend', decision: extractedDecision({ topicIsProject: true }) })
        : intent({ intent: 'note_capture', segment: 'Notiz', note: 'Stackit-PoC läuft seit Mai.' }),
    );
    const r2 = await send('Notiz: Stackit-PoC läuft seit Mai.', r1.conversationId);
    expect(r2.assistantMessage.content).toMatch(/Notiz gespeichert/);
    const r3 = await send('Projekt', r1.conversationId);
    expect(r3.assistantMessage.content).not.toMatch(question);
    expect((await app.ok('decisions:list', {}))[0]!.projectName).toBe('prod-plat');
  });
});
