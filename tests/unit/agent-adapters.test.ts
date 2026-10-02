import { afterEach, describe, expect, it } from 'vitest';
import { anthropicEndpointFor, createAdapter, detectAdapter } from '../../packages/core/src/agent/adapters';
import { AnthropicAdapter, isAnthropicUrl, sdkBaseUrl } from '../../packages/core/src/agent/adapters/anthropic';
import { OpenAiResponsesAdapter } from '../../packages/core/src/agent/adapters/openai';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, folderOf, scriptedTurns } from '../helpers/agent';
import { adapterSetup, fakeFetch, json } from '../helpers/adapter-transport';

describe('adapter choice (#296)', () => {
  it('detectAdapter and isAnthropicUrl', () => {
    expect(detectAdapter('https://api.anthropic.com')).toBe('anthropic');
    expect(detectAdapter('https://api.anthropic.com/v1/messages')).toBe('anthropic');
    expect(detectAdapter('https://res.services.ai.azure.com/anthropic')).toBe('anthropic');
    expect(detectAdapter('https://api.openai.com/v1')).toBe('openai');
    expect(detectAdapter('https://foundry-portfolio-ger.openai.azure.com/openai/v1')).toBe('openai');
    expect(detectAdapter('kein url')).toBe('openai');
    expect(detectAdapter('https://api.openai.com/v1', 'anthropic')).toBe('anthropic');
    expect(detectAdapter('https://api.anthropic.com', 'openai')).toBe('openai');
    expect(isAnthropicUrl('https://evil-anthropic.com')).toBe(false);
    expect(isAnthropicUrl('https://api.anthropic.com.evil.example')).toBe(false);
    expect(isAnthropicUrl('https://proxy.example/anthropic/v1')).toBe(true);
    expect(isAnthropicUrl('https://proxy.example/anthropicx')).toBe(false);
  });

  it('anthropicEndpointFor: the Anthropic endpoint of the same Azure resource', () => {
    expect(anthropicEndpointFor('https://foundry-portfolio-ger.openai.azure.com/openai/v1')).toBe(
      'https://foundry-portfolio-ger.services.ai.azure.com/anthropic',
    );
    expect(anthropicEndpointFor('https://res.cognitiveservices.azure.com/openai/v1')).toBe('https://res.services.ai.azure.com/anthropic');
    expect(anthropicEndpointFor('https://res.services.ai.azure.com/models')).toBe('https://res.services.ai.azure.com/anthropic');
    expect(anthropicEndpointFor('https://api.openai.com/v1')).toBeNull();
    expect(anthropicEndpointFor('nicht gültig')).toBeNull();
  });

  it('sdkBaseUrl: without /v1 and /v1/messages (the SDK appends them)', () => {
    expect(sdkBaseUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com');
    expect(sdkBaseUrl('https://api.anthropic.com/v1/')).toBe('https://api.anthropic.com');
    expect(sdkBaseUrl('  https://res.services.ai.azure.com/anthropic/v1/messages  ')).toBe('https://res.services.ai.azure.com/anthropic');
    expect(sdkBaseUrl('https://res.services.ai.azure.com/anthropic/')).toBe('https://res.services.ai.azure.com/anthropic');
  });

  it('createAdapter builds the matching adapter', () => {
    const { config } = adapterSetup({ baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', fetchImpl: fakeFetch(json({})).fetchImpl });
    expect(createAdapter('anthropic', config)).toBeInstanceOf(AnthropicAdapter);
    expect(createAdapter('openai', config)).toBeInstanceOf(OpenAiResponsesAdapter);
  });
});

const PROVIDERS = [
  { name: 'OpenAI-compatible (Responses API)', id: 'openai', opts: {} },
  { name: 'Claude (Messages API)', id: 'anthropic', opts: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' } },
] as const;

/** Tool results of the last agent request, in the provider's own format. */
function lastResults(app: TestApp, provider: 'openai' | 'anthropic'): string[] {
  const last = app.llm.agentRequests.at(-1)!;
  if (provider === 'openai')
    return ((last.input as Array<{ type?: string; output?: string }>) ?? []).filter((i) => i.type === 'function_call_output').map((i) => i.output ?? '');
  const messages = last.messages as Array<{ role: string; content: Array<{ type: string; content?: string }> }>;
  return messages.flatMap((m) => (m.role === 'user' ? m.content.filter((b) => b.type === 'tool_result').map((b) => b.content ?? '') : []));
}

describe.each(PROVIDERS)('agent scenario find → move → done via $name', ({ id, opts }) => {
  let app: TestApp;
  afterEach(async () => {
    await app.cleanup();
  });

  it('finds the md files, moves them and reports', async () => {
    app = await agentApp(opts);
    const a = await archived(app, { name: 'folien-q1.md', content: '# Q1', folder: 'work/misc' });
    const b = await archived(app, { name: 'folien-q2.md', content: '# Q2', folder: 'work/misc' });
    const other = await archived(app, { name: 'notiz.txt', content: 'Notiz', folder: 'work/misc' });
    app.llm.agent = scriptedTurns(
      ({ provider }) => {
        expect(provider).toBe(id);
        return { calls: [{ name: 'find_documents', args: { ext: ['md'] } }] };
      },
      () => {
        expect(lastResults(app, id).join('\n')).toContain('Ergebnismenge S1');
        return { calls: [{ name: 'move_documents', args: { documents: ['S1'], folder: 'work/presentations' } }] };
      },
      () => {
        expect(lastResults(app, id).join('\n')).toContain('Verschoben nach work/presentations: 2 erfolgreich');
        return { text: 'Ich habe 2 Dateien nach work/presentations verschoben.' };
      },
    );
    const res = await app.ok('chat:send', { text: 'Verschiebe alle md nach presentations' });
    expect(res.assistantMessage.content).toBe('Ich habe 2 Dateien nach work/presentations verschoben.');
    expect(folderOf(app, a)).toBe('work/presentations');
    expect(folderOf(app, b)).toBe('work/presentations');
    expect(folderOf(app, other)).toBe('work/misc');
    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect(run).toMatchObject({ status: 'done', provider: id, undoable: 2 });
    expect(run.steps.map((s) => [s.tool, s.outcome])).toEqual([
      ['find_documents', 'ok'],
      ['move_documents', 'ok'],
    ]);
    expect(run.usage.requests).toBe(3);
    expect(app.services.agent.capability()).toMatchObject({ adapter: id, toolCalling: true });
    // every agent request (the probe included) went to the provider's own API
    for (const body of app.llm.agentRequests) expect(id === 'openai' ? 'input' in body : 'messages' in body).toBe(true);
  });
});

describe('web search in chat (service)', () => {
  let app: TestApp;
  afterEach(async () => {
    await app.cleanup();
  });

  it('chat runs offer the web search, the answer lists the web sources and the run shows the search', async () => {
    app = await agentApp();
    app.llm.agent = scriptedTurns({
      text: 'Der Grundfreibetrag 2026 liegt laut Bundesfinanzministerium bei 12.348 €.',
      web: { query: 'Grundfreibetrag 2026', url: 'https://example.org/grundfreibetrag', title: 'Grundfreibetrag [BMF]' },
    });
    const res = await app.ok('chat:send', { text: 'Wie hoch ist der Grundfreibetrag 2026? Such im Internet.' });
    const body = app.llm.agentRequests.at(-1)!;
    expect((body.tools as Array<{ type: string }>)[0]).toMatchObject({ type: 'web_search' });
    expect(String(body.instructions)).toContain('Websuche (web_search) ist verfügbar');
    expect(res.assistantMessage.content).toBe(
      'Der Grundfreibetrag 2026 liegt laut Bundesfinanzministerium bei 12.348 €.\n\n**Quellen aus dem Web**\n- [Grundfreibetrag BMF](https://example.org/grundfreibetrag)',
    );
    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect(run.steps.map((s) => [s.tool, s.label, s.outcome])).toEqual([['web_search', 'Websuche: „Grundfreibetrag 2026“', 'ok']]);
  });

  it('switched off in the settings: no web search tool and no hint in the instructions', async () => {
    app = await agentApp();
    app.services.settings.update({ agent: { webSearch: false } });
    app.llm.agent = scriptedTurns({ text: 'Das weiß ich nicht.' });
    await app.ok('chat:send', { text: 'Wie hoch ist der Grundfreibetrag 2026?' });
    const body = app.llm.agentRequests.at(-1)!;
    expect((body.tools as Array<{ type: string }>).every((t) => t.type === 'function')).toBe(true);
    expect(String(body.instructions)).not.toContain('web_search');
  });
});

describe('switching the provider within a conversation (#297)', () => {
  let app: TestApp;
  afterEach(async () => {
    await app.cleanup();
  });

  it('keeps the neutral history: the other provider gets text and tool calls instead of foreign raw blocks', async () => {
    app = await agentApp();
    const a = await archived(app, { name: 'a.md', content: 'A', folder: 'work/misc' });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'find_documents', args: { ext: 'md' } }], text: 'Ich suche.' }, { text: 'Gefunden: D1.' });
    const first = await app.ok('chat:send', { text: 'Welche md-Dateien gibt es?' });
    expect(first.assistantMessage.content).toBe('Gefunden: „a“.');
    const stored = app.services.agent.historyOf(first.conversationId);
    expect(stored.filter((m) => m.role === 'assistant').every((m) => m.role === 'assistant' && m.provider === 'openai')).toBe(true);

    app.services.settings.update({ llm: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' } });
    const before = app.llm.agentRequests.length;
    app.llm.agent = scriptedTurns({ calls: [{ name: 'move_documents', args: { documents: ['D1'], folder: 'work/slides' } }] }, { text: 'Verschoben.' });
    const second = await app.ok('chat:send', { conversationId: first.conversationId, text: 'Verschieb sie nach work/slides' });
    expect(second.assistantMessage.content).toBe('Verschoben.');
    expect(folderOf(app, a)).toBe('work/slides');

    const claudeReqs = app.llm.agentRequests.slice(before).filter((b) => Array.isArray(b.messages) && (b.tools as unknown[]).length > 1);
    const firstClaude = claudeReqs[0]!;
    const messages = firstClaude.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    // the earlier OpenAI turn arrives as text + tool_use, its result as tool_result with the same id
    const assistant = messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(assistant.content[1]).toMatchObject({ name: 'find_documents', input: { ext: 'md' } });
    const callId = assistant.content[1]!.id as string;
    expect(messages.some((m) => m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === callId))).toBe(true);
    // roles alternate as the Messages API demands
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(JSON.stringify(messages)).not.toMatch(/"type":"(?:function_call|reasoning|message)"/);

    const runs = await app.ok('agent:runs', { conversationId: first.conversationId, limit: 10 });
    expect(runs.map((r) => r.provider).toSorted()).toEqual(['anthropic', 'openai']);
  });
});
