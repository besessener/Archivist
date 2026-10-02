import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => {
  await app.cleanup();
});

const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });
const lastAnswer = async (conversationId: string) => (await app.ok('chat:history', { conversationId })).filter((m) => m.role === 'assistant').at(-1)!;

describe('Chat: link suggestions right after capturing (#283)', () => {
  it('offers up to 3 suggestions under the answer – a mentioned project first; a click confirms (undoable), ignoring keeps the proposal', async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: true });
    const project = (await app.ok('knowledge:createEntity', { type: 'project', name: 'Hausbau' })).entity;
    await app.ok('knowledge:createEntity', { type: 'note', name: 'Bauantrag', description: 'Bauantrag Hausbau: Statik, Grundriss, Baugenehmigung beim Bauamt.' });
    await app.services.jobs.whenIdle();
    app.llm.on('ChatIntent', () => intent({ intent: 'note_capture', note: 'Für den Hausbau fehlt noch die Statik und die Baugenehmigung vom Bauamt.' }));

    const res = await app.ok('chat:send', { text: 'Notiz: Für den Hausbau fehlt noch die Statik und die Baugenehmigung vom Bauamt.' });
    // the answer itself comes without waiting for the suggestions
    expect(res.assistantMessage.actions).toEqual([]);
    await app.services.jobs.whenIdle();

    const answer = await lastAnswer(res.conversationId);
    const offered = answer.actions.filter((a) => a.actionType === 'confirm_relation');
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.length).toBeLessThanOrEqual(3);
    expect(offered[0]!.label).toBe('Das klingt nach Projekt „Hausbau“ – verknüpfen?');
    expect(offered.every((a) => a.proposedParameters.offered === true)).toBe(true);
    const relationId = offered[0]!.proposedParameters.relationId as string;
    expect(app.services.graph.getRelation(relationId)).toMatchObject({ status: 'proposed', method: 'mention', targetEntityId: project.id });
    // ignored suggestions stay in the list of link proposals
    const listed = (await app.ok('links:proposals', {})).items.map((i) => i.relation.id);
    for (const a of offered) expect(listed).toContain(a.proposedParameters.relationId);

    // click: confirmed as the user's decision, undoable
    await app.ok('actions:resolve', { decision: 'approve', actionId: offered[0]!.id, confirmed: true });
    expect(app.services.graph.getRelation(relationId)).toMatchObject({ status: 'confirmed', resolvedByUser: true });
    const entry = (await app.ok('audit:list', {})).find((e) => e.action === 'relation.confirm')!;
    await app.ok('audit:undo', { auditId: entry.id });
    expect(app.services.graph.getRelation(relationId)!.status).toBe('proposed');
  });

  it('nothing is offered when link proposals are switched off', async () => {
    app = await createTestApp({ privacy: 'auto', autoLinks: false });
    await app.ok('knowledge:createEntity', { type: 'project', name: 'Hausbau' });
    app.llm.on('ChatIntent', () => intent({ intent: 'note_capture', note: 'Hausbau: Statik fehlt.' }));
    const res = await app.ok('chat:send', { text: 'Notiz: Hausbau: Statik fehlt.' });
    await app.services.jobs.whenIdle();
    expect((await lastAnswer(res.conversationId)).actions).toEqual([]);
  });
});
