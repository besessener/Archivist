import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contradictionTools } from '../../packages/core/src/agent/tools/contradictions';
import { riskOf } from '../../packages/core/src/agent/registry';
import { contradictions } from '../../packages/core/src/db/schema';
import { intent } from '../helpers/chat-intents';
import { emptyToolContext } from '../helpers/agent';
import { createTestApp, type TestApp } from '../helpers/harness';
import { toolDepsOf } from '../helpers/tool-deps';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => app.cleanup());

function seed(id: string, title: string, description: string) {
  app.services.ctx.database.db
    .insert(contradictions)
    .values({ id, title, description, affectedEntityIds: ['d-a', 'd-b'], dedupeKey: `seed:${id}`, createdAt: '2026-10-01T08:00:00.000Z' })
    .run();
}

const status = (id: string) => app.services.contradictions.get(id).status;

describe('Resolving contradictions from the chat', () => {
  it('proposes a card for the named contradiction and resolves it only after confirmation', async () => {
    seed('c-1', 'Kündigungsfrist: drei oder sechs Monate', 'Zwei Entscheidungen nennen unterschiedliche Fristen.');
    seed('c-2', 'Meeting dienstags oder donnerstags', 'Zwei Termine für dasselbe Meeting.');
    app.llm.on('ChatIntent', () => intent({ intent: 'contradiction_resolve', contradictionResolution: 'false_positive', query: 'Kündigungsfrist' }));

    const reply = await app.ok('chat:send', { text: 'Der Widerspruch zur Kündigungsfrist ist ein Fehlalarm' });

    const [card] = reply.assistantMessage.actions ?? [];
    expect(card).toMatchObject({ actionType: 'resolve_contradiction', status: 'proposed' });
    expect(status('c-1')).toBe('detected');
    await app.ok('actions:resolve', { actionId: card!.id, decision: 'approve', confirmed: true });
    expect(status('c-1')).toBe('false_positive');
    expect(status('c-2')).toBe('detected');
  });

  it('asks which one is meant when the request does not single out a contradiction', async () => {
    seed('c-1', 'Kündigungsfrist: drei oder sechs Monate', 'Fristen.');
    seed('c-2', 'Meeting dienstags oder donnerstags', 'Termine.');
    app.llm.on('ChatIntent', () => intent({ intent: 'contradiction_resolve', contradictionResolution: 'resolved', query: 'Urlaub' }));

    const reply = await app.ok('chat:send', { text: 'Der Widerspruch ist geklärt' });

    expect(reply.assistantMessage.content).toContain('Welchen Widerspruch meinst du?');
    expect(reply.assistantMessage.actions ?? []).toHaveLength(0);
  });
});

describe('Resolving contradictions with the agent tools', () => {
  it('lists open contradictions and only proposes the resolution', async () => {
    seed('c-1', 'Kündigungsfrist: drei oder sechs Monate', 'Zwei Entscheidungen nennen unterschiedliche Fristen.');
    const tools = new Map(contradictionTools(toolDepsOf(app)).map((tool) => [tool.name, tool]));
    const ctx = emptyToolContext();
    const run = (name: string, args: unknown) => tools.get(name)!.run(tools.get(name)!.schema.parse(args), ctx);

    expect((await run('list_contradictions', {})).content).toContain('c-1');
    expect(riskOf(tools.get('resolve_contradiction')!, {})).toBe('write');
    const proposed = await run('resolve_contradiction', { contradiction: 'c-1', resolution: 'resolved' });

    expect(proposed.isError).toBeUndefined();
    expect(ctx.actionIds).toHaveLength(1);
    expect(status('c-1')).toBe('detected');
    await app.ok('actions:resolve', { actionId: ctx.actionIds[0]!, decision: 'approve', confirmed: true });
    expect(status('c-1')).toBe('resolved');
    expect((await run('list_contradictions', {})).content).toBe('Es gibt keine offenen Widersprüche.');
  });
});
