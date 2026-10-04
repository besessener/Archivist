import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { intent } from '../helpers/chat-intents';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => app.cleanup());

const create = (title: string) => app.ok('openItems:create', { title, priority: 'normal', sourceIds: [], confidence: 0.9 });

describe('Closing an open item with an optional solution comment', () => {
  it('stores the comment, finds the item by it, shows it in the timeline; undo removes it again', async () => {
    const item = await create('Dachdecker beauftragen');

    const closed = await app.ok('openItems:close', {
      id: item.id,
      status: 'resolved',
      resolutionNote: '  Angebot von Firma Ziegelmann angenommen.  ',
      confirmed: true,
    });

    expect(closed).toMatchObject({ status: 'resolved', resolutionNote: 'Angebot von Firma Ziegelmann angenommen.' });
    await app.services.openItems.reindex(item.id);
    const hits = await app.services.search.search('Ziegelmann', { types: ['task'] });
    expect(hits.map((h) => h.id)).toContain(item.id);
    const timeline = await app.ok('timeline:get', {});
    expect(timeline.find((e) => e.id === `task:${item.id}:done`)?.description).toBe('Angebot von Firma Ziegelmann angenommen.');

    const [entry] = (await app.ok('audit:list', { onlyUndoable: true })).filter((a) => a.action === 'open_item.close');
    await app.ok('audit:undo', { auditId: entry!.id });
    expect(app.services.openItems.get(item.id)).toMatchObject({ status: 'open', resolutionNote: null });
    await vi.waitFor(async () => {
      const afterUndo = await app.services.search.search('Ziegelmann', { types: ['task'] });
      expect(afterUndo.map((h) => h.id)).not.toContain(item.id);
    });
  });

  it('closing without a comment works as before', async () => {
    const item = await create('Zahnarzttermin');
    const closed = await app.ok('openItems:close', { id: item.id, status: 'dismissed', confirmed: true });
    expect(closed).toMatchObject({ status: 'dismissed', resolutionNote: null });
  });

  it('the chat takes a solution the user names into the closing card', async () => {
    const item = await create('Dachdecker beauftragen');
    app.llm.on('ChatIntent', () => intent({ intent: 'open_item_close', openItem: { targetHint: 'Dachdecker', resolutionNote: 'Ziegelmann beauftragt' } }));

    const r = await app.ok('chat:send', { text: 'Dachdecker ist erledigt, ich habe Ziegelmann beauftragt.' });

    expect(r.assistantMessage.content).toContain('„Ziegelmann beauftragt“');
    const [card] = r.assistantMessage.actions;
    expect(card!.proposedParameters).toMatchObject({ openItemId: item.id, resolutionNote: 'Ziegelmann beauftragt' });
    await app.ok('actions:resolve', { decision: 'approve', actionId: card!.id, confirmed: true, strongConfirmed: false });
    expect(app.services.openItems.get(item.id)).toMatchObject({ status: 'resolved', resolutionNote: 'Ziegelmann beauftragt' });
  });
});
