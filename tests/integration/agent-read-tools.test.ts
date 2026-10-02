import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECTION_CHARS } from '../../packages/core/src/agent/tools/read';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, scriptedTurns } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

/** Tool results of the latest agent request, in call order. */
const outputs = () =>
  ((app.llm.agentRequests.at(-1)?.input as Array<{ type?: string; output?: string }>) ?? [])
    .filter((i) => i.type === 'function_call_output')
    .map((i) => i.output ?? '');

/** Runs the given tool calls in one round and returns their results. */
async function call(...calls: Array<{ name: string; args: Record<string, unknown> }>): Promise<string[]> {
  let seen: string[] = [];
  app.llm.agent = scriptedTurns({ calls }, () => {
    seen = outputs();
    return { text: 'Fertig.' };
  });
  await app.ok('chat:send', { text: 'Zeig mir das bitte' });
  return seen;
}

async function corpus() {
  const invoice = await archived(app, {
    name: 'rechnung-maler.txt',
    content: 'Malerarbeiten 1.200 Euro',
    folder: 'private/finanzen',
    docType: 'Rechnung',
    documentDate: '2025-04-10',
    persons: ['Maler Schulz'],
  });
  const contract = await archived(app, {
    name: 'mietvertrag.txt',
    content: 'Mietvertrag Wohnung',
    folder: 'private/wohnen',
    docType: 'Vertrag',
    documentDate: '2024-01-01',
  });
  const slides = await archived(app, {
    name: 'folien.md',
    content: `# Folien\n${'x'.repeat(5_000)}`,
    folder: 'work/slides',
    docType: 'Präsentation',
    documentDate: '2026-02-01',
  });
  await app.ok('documents:bulkUpdate', { ids: [invoice], project: 'Renovierung', addTags: ['handwerker'], confirmed: true });
  return { invoice, contract, slides };
}

describe('find_documents: every filter, paging with total and result sets (#303)', () => {
  it('filters by project, person, tag, type, business date, size and folder', async () => {
    await corpus();
    const [project, person, tag, type, dated, big, folder] = await call(
      { name: 'find_documents', args: { project: 'Renovierung' } },
      { name: 'find_documents', args: { person: 'schulz' } },
      { name: 'find_documents', args: { tag: 'handwerker' } },
      { name: 'find_documents', args: { docType: 'Vertrag' } },
      { name: 'find_documents', args: { from: '2025-01-01', to: '2025-12-31' } },
      { name: 'find_documents', args: { minKb: 4 } },
      { name: 'find_documents', args: { folder: 'private' } },
    );
    expect(project).toMatch(/^1 Dokument/);
    expect(project).toContain('rechnung-maler');
    expect(person).toContain('rechnung-maler');
    expect(tag).toContain('rechnung-maler');
    expect(type).toMatch(/^1 Dokument/);
    expect(type).toContain('mietvertrag');
    expect(dated).toMatch(/^1 Dokument/);
    expect(dated).toContain('rechnung-maler');
    expect(big).toMatch(/^1 Dokument/);
    expect(big).toContain('folien');
    expect(folder).toMatch(/^2 Dokument/);
    expect(folder).not.toContain('folien');
  });

  it('sorts, pages with the total and narrows within an earlier result set', async () => {
    await corpus();
    const [byName, page2, within] = await call(
      { name: 'find_documents', args: { sort: 'name', pageSize: 1 } },
      { name: 'find_documents', args: { sort: 'name', pageSize: 1, page: 2 } },
      { name: 'find_documents', args: { within: 'S1', folder: 'work' } },
    );
    expect(byName).toContain('3 Dokument(e)');
    expect(byName).toContain('Seite 1/3');
    expect(byName).toContain('folien');
    expect(page2).toContain('Seite 2/3');
    expect(page2).toContain('mietvertrag');
    expect(page2).not.toContain('folien');
    // the result set stands for ALL hits, not just the shown page
    expect(within).toMatch(/^1 Dokument/);
    expect(within).toContain('folien');
  });

  it('nothing found is a plain answer, not an error', async () => {
    await corpus();
    const [none] = await call({ name: 'find_documents', args: { ext: 'pptx' } });
    expect(none).toBe('Keine Dokumente gefunden.');
  });
});

describe('Other read tools (#303)', () => {
  it('read_document pages through sections; section 2 holds the rest of the text', async () => {
    await archived(app, { name: 'lang.txt', content: `${'a'.repeat(SECTION_CHARS)}ENDE-DES-TEXTS`, folder: 'private/misc' });
    const [, first, second] = await call(
      { name: 'find_documents', args: { name: 'lang' } },
      { name: 'read_document', args: { id: 'D1' } },
      { name: 'read_document', args: { id: 'D1', section: 2 } },
    );
    expect(first).toContain('Abschnitt 1/2');
    expect(first).not.toContain('ENDE-DES-TEXTS');
    expect(second).toContain('Abschnitt 2/2');
    expect(second).toContain('ENDE-DES-TEXTS');
  });

  it('search names the section of the hit', async () => {
    const filler = Array.from({ length: 800 }, (_, i) => `Absatz ${i} über die Bedienung.`).join(' ');
    await archived(app, { name: 'handbuch.txt', content: `${filler} Die Garantie gilt fünf Jahre.`, folder: 'private/misc' });
    const [hit] = await call({ name: 'search', args: { query: 'Garantie fünf Jahre' } });
    expect(hit).toContain('handbuch');
    // the hit lies near the end, not in the first section
    expect(hit).toMatch(/Fundstelle \(Abschnitt [3-9]\)/);
  });

  it('list_entries lists decisions with filters and pages; timeline is chronological', async () => {
    for (const [title, date] of [
      ['Wir streichen die Küche weiß', '2026-03-01'],
      ['Wir kaufen ein Lastenrad', '2026-01-15'],
    ] as const)
      await app.ok('decisions:create', {
        decisionText: title,
        title,
        topic: 'Haushalt',
        decidedAt: date,
        participants: ['Anna'],
        alternatives: [],
        unknownFields: [],
        sourceIds: [],
        confidence: 0.9,
      });
    const [all, filtered, timeline] = await call(
      { name: 'list_entries', args: { kind: 'decision', topic: 'haushalt' } },
      { name: 'list_entries', args: { kind: 'decision', query: 'lastenrad' } },
      { name: 'timeline', args: { topic: 'Haushalt' } },
    );
    expect(all).toMatch(/^2 Einträge/);
    expect(filtered).toMatch(/^1 Einträge/);
    expect(filtered).toContain('Lastenrad');
    expect(timeline).toContain('Lastenrad');
    expect(timeline).toContain('Küche');
  });

  it('related uses the same list as „Verwandte Einträge“ in the user interface, with the reason', async () => {
    const a = await archived(app, { name: 'angebot.txt', content: 'Angebot Dach', folder: 'private/haus' });
    const b = await archived(app, { name: 'auftrag.txt', content: 'Auftrag Dach', folder: 'private/haus' });
    await app.ok('documents:bulkUpdate', { ids: [a, b], project: 'Dachsanierung', confirmed: true });
    const ui = await app.ok('knowledge:related', { id: a });
    const [, related] = await call({ name: 'find_documents', args: { name: 'angebot' } }, { name: 'related', args: { id: 'D1' } });
    expect(ui.total).toBeGreaterThan(0);
    expect(related).toContain(`${ui.total} verwandte Einträge`);
    expect(related).toContain('auftrag');
    expect(related).toContain('gleiches Projekt');
  });
});

describe('Entries that stem only from documents not shared (#301)', () => {
  it('are listed without their content', async () => {
    const doc = await archived(app, { name: 'befund.txt', content: 'Befund', folder: 'private/gesundheit' });
    await app.ok('documents:setLlmExcluded', { id: doc, excluded: true });
    await app.ok('decisions:create', {
      decisionText: 'Therapie mit Medikament X beginnen',
      title: 'Therapie X',
      decidedAt: '2026-03-01',
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [doc],
      confidence: 0.9,
    });
    const [list] = await call({ name: 'list_entries', args: { kind: 'decision' } });
    expect(list).toContain('nicht freigegeben');
    expect(list).not.toContain('Medikament');
  });
});
