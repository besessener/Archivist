import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.services.settings.update({ llm: { embeddingModel: 'test-embedding' } });
  app.llm.embed = (texts) => texts.map(() => [1, 0, 0]);
});
afterEach(async () => {
  await app.cleanup();
});

describe('Local vectors next to remote ones (#173)', () => {
  it('keeps an entry findable by the local vector pass when the endpoint is gone', async () => {
    const note = await app.services.notes.create({ title: 'Mietvertrag', content: 'Mietvertrag Hauptstrasse Wohnung' });
    await app.services.jobs.whenIdle();
    await app.services.search.index({
      type: 'note',
      id: note.id,
      title: 'Mietvertrag',
      content: 'Mietvertrag Hauptstrasse Wohnung',
      allowRemoteEmbedding: true,
    });
    expect(app.llm.embeddingRequests.length).toBeGreaterThan(0);

    app.llm.down = true;
    // a typo: the keyword pass finds nothing, only the character trigrams of the local vector do
    const hits = await app.services.search.search('Mietvertrg Wohnnug', { limit: 5 });

    expect(hits.map((hit) => hit.id)).toContain(note.id);
  });

  it('lets the re-embedding job add the missing local vector to older remote entries', async () => {
    const note = await app.services.notes.create({ title: 'Notiz', content: 'Inhalt der Notiz' });
    await app.services.search.index({ type: 'note', id: note.id, title: 'Notiz', content: 'Inhalt der Notiz', allowRemoteEmbedding: true });
    expect(app.services.search.entriesWithOtherModel('test-embedding')).toEqual([]);
  });

  it('embeds own records remotely in the automatic mode, but never in the mode „vorher fragen“ (#173)', async () => {
    await app.services.search.index({ type: 'event', id: 'e1', title: 'Umzug', content: 'Umzug im Mai' });
    expect(app.llm.embeddingRequests.flat().some((text) => text.includes('Umzug'))).toBe(true);

    await app.ok('settings:update', { privacy: { llmMode: 'confirm' } });
    const before = app.llm.embeddingRequests.length;
    await app.services.search.index({ type: 'event', id: 'e2', title: 'Geheim', content: 'Vertrauliches Ereignis' });
    expect(app.llm.embeddingRequests).toHaveLength(before);
  });
});
