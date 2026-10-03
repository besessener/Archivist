import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { intent, userText } from '../helpers/chat-intents';

/** Short ids of the active open items in the prompt („- P1: Titel | …“) by title. */
const promptIds = (input: string) => new Map([...input.matchAll(/^- (P\d+): (.+?) \|/gm)].map((m) => [m[2]!, m[1]!]));

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });
const TITLES = ['Angebot prüfen', 'Vertrag kündigen', 'Bericht schreiben'];

describe('Follow-up question for several new open items in one message', () => {
  const newItems = {
    intents: TITLES.map((title) => intent({ intent: 'open_item_new', segment: title, openItem: { title, responsible: 'ich' } })),
  };

  it('„31.12.2026 für alle drei“ sets the due date of all three items', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /alle drei/.test(userText(input)) ? intent({ intent: 'open_item_update', openItem: { dueAt: '2026-12-31' } }) : newItems,
    );
    const r1 = await send('Neue offene Punkte: Angebot prüfen, Vertrag kündigen, Bericht schreiben');
    expect(r1.assistantMessage.content.match(/Bis wann\?/g)).toHaveLength(3);

    const r2 = await send('Trag für alle drei 31.12.2026 ein', r1.conversationId);

    const items = await app.ok('openItems:list', {});
    expect(items.map((i) => [i.title, i.dueAt?.slice(0, 10)]).sort()).toEqual(TITLES.map((t) => [t, '2026-12-31']).sort());
    for (const t of TITLES) expect(r2.assistantMessage.content).toContain(t);
  });

  it('the LLM is told about all items of the follow-up question', async () => {
    let hint = '';
    app.llm.on('ChatIntent', (_s, input) => {
      if (/alle drei/.test(userText(input))) hint = /Offene Rückfrage: (.*)/.exec(input)?.[1] ?? '';
      return /alle drei/.test(userText(input)) ? intent({ intent: 'smalltalk' }) : newItems;
    });
    const r1 = await send('Neue offene Punkte: Angebot prüfen, Vertrag kündigen, Bericht schreiben');
    await send('Trag für alle drei 31.12.2026 ein', r1.conversationId);
    for (const t of TITLES) expect(hint).toContain(t);
  });

  it('one update per item with its id (same segment) updates every item', async () => {
    app.llm.on('ChatIntent', (_s, input) => {
      if (!/alle drei/.test(userText(input))) return newItems;
      const ids = promptIds(input);
      return {
        intents: TITLES.map((t) =>
          intent({ intent: 'open_item_update', segment: 'Trag für alle drei 31.12.2026 ein', openItem: { targetId: ids.get(t), dueAt: '2026-12-31' } }),
        ),
      };
    });
    const r1 = await send('Neue offene Punkte: Angebot prüfen, Vertrag kündigen, Bericht schreiben');
    await send('Trag für alle drei 31.12.2026 ein', r1.conversationId);

    const items = await app.ok('openItems:list', {});
    expect(items.every((i) => i.dueAt?.startsWith('2026-12-31'))).toBe(true);
  });

  it('an answer naming one item only updates that one; the others stay asked', async () => {
    app.llm.on('ChatIntent', (_s, input) => {
      const t = userText(input);
      if (/^Neue/.test(t)) return newItems;
      const ids = promptIds(input);
      if (/Vertrag/.test(t)) return intent({ intent: 'open_item_update', openItem: { targetId: ids.get('Vertrag kündigen'), dueAt: '2026-11-30' } });
      return intent({ intent: 'open_item_update', openItem: { dueAt: '2026-12-31' } });
    });
    const r1 = await send('Neue offene Punkte: Angebot prüfen, Vertrag kündigen, Bericht schreiben');
    await send('Vertrag bis 30.11.2026', r1.conversationId);
    await send('Rest bis 31.12.2026', r1.conversationId);

    const due = Object.fromEntries((await app.ok('openItems:list', {})).map((i) => [i.title, i.dueAt?.slice(0, 10)]));
    expect(due).toEqual({ 'Angebot prüfen': '2026-12-31', 'Vertrag kündigen': '2026-11-30', 'Bericht schreiben': '2026-12-31' });
  });
});
