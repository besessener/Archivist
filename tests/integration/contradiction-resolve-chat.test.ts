import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contradictionTools } from '../../packages/core/src/agent/tools/contradictions';
import { entryRows } from '../../packages/core/src/agent/tools/read-entry-rows';
import { riskOf } from '../../packages/core/src/agent/registry';
import { contradictions } from '../../packages/core/src/db/schema';
import { intent } from '../helpers/chat-intents';
import { archived, emptyToolContext } from '../helpers/agent';
import { createTestApp, type TestApp } from '../helpers/harness';
import { toolDepsOf } from '../helpers/tool-deps';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => app.cleanup());

function seed(id: string, title: string, description: string, affected: { ids: string[]; sourceIds?: string[] } = { ids: ['d-a', 'd-b'] }) {
  app.services.ctx.database.db
    .insert(contradictions)
    .values({
      id,
      title,
      description,
      affectedEntityIds: affected.ids,
      sourceIds: affected.sourceIds ?? [],
      dedupeKey: `seed:${id}`,
      createdAt: '2026-10-01T08:00:00.000Z',
    })
    .run();
}

const status = (id: string) => app.services.contradictions.get(id).status;

async function decision(title: string, decisionText: string): Promise<string> {
  const created = await app.ok('decisions:create', {
    title,
    decisionText,
    // a topic of its own: complete, so active, and no contradiction check pairs it with another one
    topic: title,
    decidedAt: '2026-03-01',
    participants: [],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
  });
  return created.id;
}

function agentTools() {
  const tools = new Map(contradictionTools(toolDepsOf(app)).map((tool) => [tool.name, tool]));
  const ctx = emptyToolContext();
  const run = (name: string, args: unknown) => tools.get(name)!.run(tools.get(name)!.schema.parse(args), ctx);
  const label = (name: string, args: unknown) => tools.get(name)!.label(tools.get(name)!.schema.parse(args));
  return { tools, ctx, run, label };
}

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

  it('tells apart contradictions of the same topic by their decisions when asking which one is meant', async () => {
    const [rentA, rentB, carA, carB] = [
      await decision('Miete senken', 'Wir senken die Miete.'),
      await decision('Miete erhöhen', 'Wir erhöhen die Miete.'),
      await decision('Auto behalten', 'Wir behalten das Auto.'),
      await decision('Auto verkaufen', 'Wir verkaufen das Auto.'),
    ];
    seed('c-1', 'Mögliche widersprüchliche Entscheidungen zu „Wohnen“', 'Miete.', { ids: [rentA, rentB] });
    seed('c-2', 'Mögliche widersprüchliche Entscheidungen zu „Wohnen“', 'Auto.', { ids: [carA, carB] });
    app.llm.on('ChatIntent', () => intent({ intent: 'contradiction_resolve', contradictionResolution: 'resolved', query: 'Wohnen' }));

    const reply = await app.ok('chat:send', { text: 'Der Widerspruch zu Wohnen ist geklärt' });

    const lines = reply.assistantMessage.content.split('\n').filter((line) => line.startsWith('•'));
    expect(lines).toHaveLength(2);
    expect(new Set(lines).size).toBe(2);
    expect(lines.join('\n')).toContain('Miete senken');
    expect(lines.join('\n')).toContain('Auto verkaufen');
  });

  it('words the prepared card as a proper German sentence', async () => {
    seed('c-1', 'Kündigungsfrist: drei oder sechs Monate', 'Fristen.');
    app.llm.on('ChatIntent', () => intent({ intent: 'contradiction_resolve', contradictionResolution: 'resolved', query: 'Kündigungsfrist' }));

    const reply = await app.ok('chat:send', { text: 'Der Widerspruch zur Kündigungsfrist ist geklärt' });

    expect(reply.assistantMessage.content).toContain('Ich habe vorbereitet, ihn als aufgelöst zu markieren.');
    expect(reply.assistantMessage.actions?.[0]?.label).toBe('Widerspruch „Kündigungsfrist: drei oder sechs Monate“ als aufgelöst markieren');
  });
});

describe('Resolving contradictions with the agent tools', () => {
  it('lists open contradictions and only proposes the resolution', async () => {
    seed('c-1', 'Kündigungsfrist: drei oder sechs Monate', 'Zwei Entscheidungen nennen unterschiedliche Fristen.');
    const tools = new Map(contradictionTools(toolDepsOf(app)).map((tool) => [tool.name, tool]));
    const ctx = emptyToolContext();
    const run = (name: string, args: unknown) => tools.get(name)!.run(tools.get(name)!.schema.parse(args), ctx);

    expect((await run('list_contradictions', {})).content).toContain('c-1');
    expect(riskOf(tools.get('resolve_contradiction')!, {}, ctx)).toBe('write');
    const proposed = await run('resolve_contradiction', { contradiction: 'c-1', resolution: 'resolved' });

    expect(proposed.isError).toBeUndefined();
    expect(ctx.actionIds).toHaveLength(1);
    expect(status('c-1')).toBe('detected');
    await app.ok('actions:resolve', { actionId: ctx.actionIds[0]!, decision: 'approve', confirmed: true });
    expect(status('c-1')).toBe('resolved');
    expect((await run('list_contradictions', {})).content).toBe('Es gibt keine offenen Widersprüche.');
  });

  it('labels the proposal step as a proper German sentence', () => {
    const { label } = agentTools();

    expect(label('resolve_contradiction', { contradiction: 'c-1', resolution: 'resolved' })).toBe('Schlage vor, einen Widerspruch als aufgelöst zu markieren');
    expect(label('resolve_contradiction', { contradiction: 'c-1', resolution: 'acknowledged' })).toBe('Schlage vor, einen Widerspruch zur Kenntnis zu nehmen');
  });

  it('does not send the title or excerpt of a contradiction whose document was excluded afterwards (#370)', async () => {
    const secret = await archived(app, { name: 'geheim.txt', content: 'Geheime Gehaltsabrechnung 2025 Betrag 9999.', folder: 'Privat/finanzen' });
    const open = await archived(app, { name: 'offen.txt', content: 'Gehaltsabrechnung 2025 Betrag 5000.', folder: 'Privat/finanzen' });
    seed(
      'c-1',
      'Mögliche Widersprüche zwischen „geheim“ und „offen“',
      'Beträge.\n\n1. geheim: Geheime Gehaltsabrechnung 2025 Betrag 9999.\n2. offen: Betrag 5000.',
      {
        ids: [secret, open],
        sourceIds: [secret, open],
      },
    );
    seed('c-2', 'Meeting dienstags oder donnerstags', 'Zwei Termine für dasselbe Meeting.');
    await app.ok('documents:setLlmExcluded', { id: secret, excluded: true });
    const { run } = agentTools();

    const listed = (await run('list_contradictions', {})).content;

    expect(listed).not.toContain('geheim');
    expect(listed).not.toContain('9999');
    expect(listed).toContain('c-1');
    expect(listed).toContain('[nicht freigegeben]');
    expect(listed).toContain('Meeting dienstags oder donnerstags');
    expect((await run('resolve_contradiction', { contradiction: 'c-1', resolution: 'false_positive' })).content).not.toContain('geheim');
  });

  it('does not show the contradiction notice of a document excluded afterwards among the entries either', async () => {
    const secret = await archived(app, { name: 'geheim.txt', content: 'Geheime Gehaltsabrechnung 2025 Betrag 9999.', folder: 'Privat/finanzen' });
    const open = await archived(app, { name: 'offen.txt', content: 'Gehaltsabrechnung 2025 Betrag 5000.', folder: 'Privat/finanzen' });
    app.services.insights.upsert({
      kind: 'contradiction',
      title: 'Mögliche Widersprüche zwischen „geheim“ und „offen“',
      explanation: '1. geheim: Geheime Gehaltsabrechnung 2025 Betrag 9999.',
      confidence: 0.8,
      affected: [],
      sourceIds: [secret, open],
      dedupeKey: 'contradiction:c-1',
    });
    await app.ok('documents:setLlmExcluded', { id: secret, excluded: true });

    const rows = entryRows(toolDepsOf(app), { kind: 'insight', status: null, topic: null, project: null, query: null, from: null, to: null });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('nicht freigegeben');
    expect(rows[0]!.text).not.toContain('geheim');
    expect(rows[0]!.text).not.toContain('9999');
  });

  it('lists the decisions of a contradiction with their refs', async () => {
    const older = await decision('Kündigungsfrist drei Monate', 'Die Frist beträgt drei Monate.');
    const newer = await decision('Kündigungsfrist sechs Monate', 'Die Frist beträgt sechs Monate.');
    seed('c-1', 'Mögliche widersprüchliche Entscheidungen zu „Wohnen“', 'Fristen.', { ids: [older, newer] });
    const { run, ctx } = agentTools();

    const listed = (await run('list_contradictions', {})).content;

    expect(listed).toContain(`${ctx.refs.entry(older)} „Kündigungsfrist drei Monate“`);
    expect(listed).toContain(`${ctx.refs.entry(newer)} „Kündigungsfrist sechs Monate“`);
  });
});

describe('Superseding a decision while resolving a contradiction with the agent (#370)', () => {
  async function pairWithUnrelated() {
    const older = await decision('Kündigungsfrist drei Monate', 'Die Frist beträgt drei Monate.');
    const newer = await decision('Kündigungsfrist sechs Monate', 'Die Frist beträgt sechs Monate.');
    const julyLeave = await decision('Urlaub im Juli', 'Wir fahren im Juli in den Urlaub.');
    const augustLeave = await decision('Urlaub im August', 'Wir fahren im August in den Urlaub.');
    seed('c-1', 'Kündigungsfrist', 'Fristen.', { ids: [older, newer] });
    return { older, newer, julyLeave, augustLeave };
  }

  it('refuses decisions that do not belong to the contradiction', async () => {
    const { julyLeave, augustLeave } = await pairWithUnrelated();
    const { run, ctx } = agentTools();

    const result = await run('resolve_contradiction', {
      contradiction: 'c-1',
      resolution: 'resolved',
      older: ctx.refs.entry(julyLeave),
      newer: ctx.refs.entry(augustLeave),
    });

    expect(result.isError).toBe(true);
    expect(ctx.actionIds).toHaveLength(0);
  });

  it('refuses a supersede with any resolution other than resolved', async () => {
    const { older, newer } = await pairWithUnrelated();
    const { run, ctx } = agentTools();

    const result = await run('resolve_contradiction', {
      contradiction: 'c-1',
      resolution: 'false_positive',
      older: ctx.refs.entry(older),
      newer: ctx.refs.entry(newer),
    });

    expect(result.isError).toBe(true);
    expect(ctx.actionIds).toHaveLength(0);
  });

  it('refuses a decision that is no longer active', async () => {
    const { older, newer } = await pairWithUnrelated();
    app.services.decisions.revoke(older, { confirmed: true });
    const { run, ctx } = agentTools();

    const result = await run('resolve_contradiction', {
      contradiction: 'c-1',
      resolution: 'resolved',
      older: ctx.refs.entry(older),
      newer: ctx.refs.entry(newer),
    });

    expect(result.isError).toBe(true);
    expect(ctx.actionIds).toHaveLength(0);
  });

  it('names the supersede on the card and supersedes only after confirmation', async () => {
    const { older, newer } = await pairWithUnrelated();
    const { run, ctx } = agentTools();

    const result = await run('resolve_contradiction', {
      contradiction: 'c-1',
      resolution: 'resolved',
      older: ctx.refs.entry(older),
      newer: ctx.refs.entry(newer),
    });

    expect(result.isError).toBeUndefined();
    const card = app.services.actions.get(ctx.actionIds[0]!);
    expect(card.label).toContain('„Kündigungsfrist sechs Monate“ ersetzt „Kündigungsfrist drei Monate“');
    expect(card.affectedEntities.map((entity) => entity.id)).toEqual(['c-1', older, newer]);
    expect(app.services.decisions.get(older).status).not.toBe('superseded');
    await app.ok('actions:resolve', { actionId: card.id, decision: 'approve', confirmed: true });
    expect(app.services.decisions.get(older).status).toBe('superseded');
    expect(status('c-1')).toBe('resolved');
  });

  it('never supersedes decisions outside the contradiction, whoever asks', async () => {
    const { julyLeave, augustLeave } = await pairWithUnrelated();

    const attempt = app.call('contradictions:resolve', {
      id: 'c-1',
      resolution: 'false_positive',
      confirmed: true,
      supersedeOldDecisionId: julyLeave,
      supersedeNewDecisionId: augustLeave,
    });

    expect((await attempt).ok).toBe(false);
    expect(app.services.decisions.get(julyLeave).status).not.toBe('superseded');
    expect(status('c-1')).toBe('detected');
  });
});
