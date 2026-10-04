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

describe('Undo of an agent run that treated duplicates', () => {
  it('reverts the relation, tag, subfolder move and entry merge of the whole run', async () => {
    const keep = await archived(app, { name: 'vertrag-final.txt', content: 'Vertrag neu', folder: 'Privat/vertraege' });
    const old = await archived(app, { name: 'vertrag-entwurf.txt', content: 'Vertrag alt', folder: 'Privat/vertraege' });
    const keepItem = await app.ok('openItems:create', { title: 'Vertrag unterschreiben', priority: 'normal', sourceIds: [], confidence: 0.9 });
    const dupItem = await app.ok('openItems:create', { title: 'Vertrag unterschreiben!', priority: 'normal', sourceIds: [], confidence: 0.9 });
    const originalPath = app.services.documents.getRow(old).archiveRelPath;
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'vertrag' } }] },
      ({ body }) => {
        const text = JSON.stringify(body.input);
        const docRef = (name: string) => new RegExp(`(D\\d+)[^\\n]*${name}`).exec(text.replaceAll('\\n', '\n'))![1]!;
        return {
          calls: [
            {
              name: 'mark_duplicates',
              args: { keep: docRef('vertrag-final'), duplicates: [docRef('vertrag-entwurf')], as: 'older_version', action: 'subfolder' },
            },
            { name: 'list_entries', args: { kind: 'open_item' } },
          ],
        };
      },
      ({ body }) => {
        const refs = [...JSON.stringify(body.input).matchAll(/(K\d+): /g)].map((m) => m[1]!);
        return { calls: [{ name: 'merge_entries', args: { kind: 'open_item', keep: refs[0]!, duplicate: refs[1]! } }] };
      },
      { text: 'Erledigt.' },
    );

    const res = await app.ok('chat:send', { text: 'Räum die doppelten Verträge auf' });

    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect(run.steps.map((s) => s.tool)).toEqual(['find_documents', 'list_entries', 'mark_duplicates', 'merge_entries']);
    expect(app.services.documents.getRow(old).archiveRelPath).toContain('Ältere Versionen');
    expect(app.services.graph.relationsOf(keep, { types: ['supersedes'] })).toHaveLength(1);
    expect([keepItem.id, dupItem.id].filter((id) => app.services.openItems.get(id).status === 'dismissed')).toHaveLength(1);

    const undo = await app.ok('agent:undoRun', { runId: run.id });

    expect(undo.failed).toBe(0);
    expect(app.services.documents.getRow(old)).toMatchObject({ archiveRelPath: originalPath });
    expect(app.services.documents.getRow(old).tags).not.toContain('ältere Version');
    expect(app.services.graph.relationsOf(keep, { types: ['supersedes'] })).toEqual([]);
    expect(app.services.openItems.get(keepItem.id).status).toBe('open');
    expect(app.services.openItems.get(dupItem.id).status).toBe('open');
  });
});
