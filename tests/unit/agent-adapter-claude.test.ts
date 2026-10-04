import { describe, expect, it } from 'vitest';
import { AnthropicAdapter, toAnthropicMessages } from '../../packages/core/src/agent/adapters/anthropic';
import type { AgentMessage, StreamEvent } from '../../packages/core/src/agent/types';
import { AppError } from '../../packages/core/src/util/errors';
import { TOOLS, adapterSetup, claudeError, claudeStream, fakeFetch, request, toolResults, uniqueModel, user } from '../helpers/adapter-transport';

describe('Claude adapter via the Anthropic SDK (#296)', () => {
  it('first party: URL, headers and body of a request with tools', async () => {
    const model = uniqueModel('claude-opus-5-5');
    const t = fakeFetch(claudeStream([{ type: 'text', text: 'ok' }]));
    const { config, logs } = adapterSetup({ baseUrl: 'https://api.anthropic.com/v1/', model: model, fetchImpl: t.fetchImpl });
    await new AnthropicAdapter(config).turn(request([user('Verschiebe alle md')], { taskBudget: 5_000, effort: 'xhigh' }));
    const [req] = t.sent;
    expect(req!.url.split('?')[0]).toBe('https://api.anthropic.com/v1/messages');
    expect(req!.headers['anthropic-version']).toBe('2023-06-01');
    expect(req!.headers['x-api-key']).toBe('sk-test-KEY-0123456789');
    const betas = req!.headers['anthropic-beta']!.split(',');
    expect(betas).toContain('compact-2026-01-12');
    expect(betas).toContain('task-budgets-2026-03-13');
    expect(req!.body).toMatchObject({
      model,
      max_tokens: 4_000,
      stream: true,
      system: [{ type: 'text', text: 'Du bist Archivist.', cache_control: { type: 'ephemeral' } }],
      tools: [
        { name: 'find_documents', description: 'Dokumente finden', input_schema: TOOLS[0]!.parameters, eager_input_streaming: true },
        { name: 'move_documents', description: 'Dokumente verschieben', input_schema: TOOLS[1]!.parameters, cache_control: { type: 'ephemeral' } },
      ],
      tool_choice: { type: 'auto' },
      output_config: { effort: 'xhigh', task_budget: { type: 'tokens', total: 20_000 } },
      cache_control: { type: 'ephemeral' },
      context_management: { edits: [{ type: 'compact_20260112' }] },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Verschiebe alle md' }] }],
    });
    // only the last tool is the cache breakpoint; betas travel as header, not in the body
    expect((req!.body.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty('cache_control');
    expect(req!.body).not.toHaveProperty('betas');
    expect(logs[0]).toMatchObject({ endpoint: 'https://api.anthropic.com/v1/messages', model, success: true, documentIds: ['doc-1'] });
  });

  it('a larger remaining budget is passed on as it is; without tools there is no task budget and no compaction', async () => {
    const t = fakeFetch(claudeStream([{ type: 'text', text: 'ok' }]));
    const adapter = new AnthropicAdapter(
      adapterSetup({ baseUrl: 'https://api.anthropic.com', model: uniqueModel('claude-sonnet-5'), fetchImpl: t.fetchImpl }).config,
    );
    await adapter.turn(request([user('x')], { taskBudget: 750_000 }));
    expect((t.sent[0]!.body.output_config as Record<string, unknown>).task_budget).toEqual({ type: 'tokens', total: 750_000 });
    await adapter.turn(request([user('x')], { taskBudget: 750_000, tools: [] }));
    expect(t.sent[1]!.body).not.toHaveProperty('tools');
    expect(t.sent[1]!.body).not.toHaveProperty('tool_choice');
    expect(t.sent[1]!.body).not.toHaveProperty('context_management');
    expect(t.sent[1]!.body.output_config).toEqual({ effort: 'high' });
    expect(t.sent[1]!.headers['anthropic-beta']).toBeUndefined();
  });

  it('Microsoft Foundry: …/anthropic → …/anthropic/v1/messages with the api key; no task budget there', async () => {
    const t = fakeFetch(claudeStream([{ type: 'text', text: 'ok' }]));
    const { config } = adapterSetup({ baseUrl: 'https://res.services.ai.azure.com/anthropic/', model: uniqueModel('claude-opus-5-5'), fetchImpl: t.fetchImpl });
    await new AnthropicAdapter(config).turn(request([user('x')], { taskBudget: 50_000 }));
    const [req] = t.sent;
    expect(req!.url.split('?')[0]).toBe('https://res.services.ai.azure.com/anthropic/v1/messages');
    expect(req!.headers['x-api-key']).toBe('sk-test-KEY-0123456789');
    expect(req!.headers['anthropic-beta']).toBe('compact-2026-01-12');
    expect(req!.body.output_config).toEqual({ effort: 'high' });
    expect(req!.body).not.toHaveProperty('fallbacks');
  });

  it('messages: several results in ONE user message, the note after them, own thinking blocks replayed unchanged', async () => {
    const model = uniqueModel('claude-opus-5-5');
    const raw = [
      { type: 'thinking', thinking: 'Ich sollte zuerst suchen.', signature: 'SIG==' },
      { type: 'tool_use', id: 'c1', name: 'find_documents', input: { ext: 'md' } },
      { type: 'tool_use', id: 'c2', name: 'move_documents', input: {} },
    ];
    const history: AgentMessage[] = [
      user('Verschiebe alle md'),
      { role: 'assistant', text: '', toolCalls: [], provider: 'anthropic', model, raw },
      toolResults('Technische Grenze erreicht.'),
    ];
    const t = fakeFetch(claudeStream([{ type: 'text', text: 'ok' }]));
    await new AnthropicAdapter(adapterSetup({ baseUrl: 'https://api.anthropic.com', model: model, fetchImpl: t.fetchImpl }).config).turn(request(history));
    expect(t.sent[0]!.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Verschiebe alle md' }] },
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: '2 Dokumente, Ergebnismenge S1' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'Zielordner fehlt', is_error: true },
          { type: 'text', text: 'Technische Grenze erreicht.' },
        ],
      },
    ]);
  });

  it('toAnthropicMessages: another provider’s message becomes text + tool_use with valid ids; empty results are marked', () => {
    const history: AgentMessage[] = [
      user('a'),
      {
        role: 'assistant',
        text: 'Ich suche.',
        toolCalls: [{ id: 'call:1/x', name: 'find_documents', args: { ext: 'md' } }],
        provider: 'openai',
        model: 'gpt-5',
        raw: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' }],
      },
      { role: 'tool', results: [{ callId: 'call:1/x', name: 'find_documents', content: '', isError: false }] },
      user('weiter'),
    ];
    expect(toAnthropicMessages(history, 'claude-opus-5-5')).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Ich suche.' },
          { type: 'tool_use', id: 'call_1_x', name: 'find_documents', input: { ext: 'md' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1_x', content: '(leer)' },
          { type: 'text', text: 'weiter' },
        ],
      },
    ]);
    // the same model of another provider would not get foreign raw blocks either
    expect(JSON.stringify(toAnthropicMessages(history, 'gpt-5'))).not.toContain('ENC');
  });

  it('parses the stream: text deltas, tool_use with input_json_delta, thinking, usage incl. cache tokens', async () => {
    const t = fakeFetch(
      claudeStream(
        [
          { type: 'thinking', thinking: 'Erst suchen.', signature: 'SIG' },
          { type: 'text', text: 'Ich suche die Dateien.' },
          { type: 'tool_use', id: 'toolu_1', name: 'find_documents', input: { ext: ['md', 'txt'], folder: 'Arbeit/misc' } },
        ],
        { usage: { input: 120, output: 33, cacheRead: 4_000, cacheWrite: 900 } },
      ),
    );
    const events: StreamEvent[] = [];
    const res = await new AnthropicAdapter(
      adapterSetup({ baseUrl: 'https://api.anthropic.com', model: uniqueModel('claude-opus-5-5'), fetchImpl: t.fetchImpl }).config,
    ).turn(request([user('x')]), (e) => events.push(e));
    expect(events.map((e) => e.delta).join('')).toBe('Ich suche die Dateien.');
    expect(events.length).toBeGreaterThan(1);
    expect(res).toMatchObject({
      text: 'Ich suche die Dateien.',
      stopReason: 'tool_use',
      streamed: true,
      toolCalls: [{ id: 'toolu_1', name: 'find_documents', args: { ext: ['md', 'txt'], folder: 'Arbeit/misc' } }],
      usage: { inputTokens: 120, outputTokens: 33, cacheReadTokens: 4_000, cacheWriteTokens: 900 },
    });
    expect(res.refusal).toBeUndefined();
    // raw = the content blocks as they came (thinking with signature, for the replay)
    expect(res.raw).toEqual([
      { type: 'thinking', thinking: 'Erst suchen.', signature: 'SIG' },
      expect.objectContaining({ type: 'text', text: 'Ich suche die Dateien.' }),
      expect.objectContaining({ type: 'tool_use', id: 'toolu_1', name: 'find_documents' }),
    ]);
  });

  it('stop reasons: end_turn, max_tokens, pause_turn, refusal with stop_details', async () => {
    const run = async (stop: string, stopDetails?: unknown) => {
      const t = fakeFetch(claudeStream([{ type: 'text', text: 'x' }], { stop, stopDetails }));
      return new AnthropicAdapter(
        adapterSetup({ baseUrl: 'https://api.anthropic.com', model: uniqueModel('claude-haiku-4'), fetchImpl: t.fetchImpl }).config,
      ).turn(request([user('x')]));
    };
    expect((await run('end_turn')).stopReason).toBe('end');
    expect((await run('max_tokens')).stopReason).toBe('max_tokens');
    expect((await run('pause_turn')).stopReason).toBe('pause');
    const refused = await run('refusal', { type: 'refusal', category: 'cyber', explanation: 'Nicht erlaubt.' });
    expect(refused.stopReason).toBe('refusal');
    expect(refused.refusal).toEqual({ category: 'cyber', explanation: 'Nicht erlaubt.' });
  });

  it('feature fallback: a 400 about task_budget is retried without it (effort stays) and remembered', async () => {
    const model = uniqueModel('claude-opus-5-5');
    const t = fakeFetch(claudeError(400, 'output_config.task_budget: Extra inputs are not permitted'), claudeStream([{ type: 'text', text: 'ok' }]));
    const { config, warns } = adapterSetup({ baseUrl: 'https://api.anthropic.com', model: model, fetchImpl: t.fetchImpl });
    const res = await new AnthropicAdapter(config).turn(request([user('x')], { taskBudget: 100_000 }));
    expect(res.text).toBe('ok');
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]!.body.output_config).toHaveProperty('task_budget');
    expect(t.sent[1]!.body.output_config).toEqual({ effort: 'high' });
    expect(t.sent[1]!.headers['anthropic-beta']).not.toContain('task-budgets');
    expect(warns.map((w) => w.data)).toEqual([{ feature: 'task_budget' }]);
    await new AnthropicAdapter(config).turn(request([user('y')], { taskBudget: 100_000 }));
    expect(t.sent[2]!.body.output_config).toEqual({ effort: 'high' });
  });

  it('a 400 about context management switches compaction off; an unrelated 400 is not retried', async () => {
    const model = uniqueModel('claude-opus-5-5');
    const t = fakeFetch(claudeError(400, 'context_management: Unexpected value'), claudeStream([{ type: 'text', text: 'ok' }]));
    await new AnthropicAdapter(adapterSetup({ baseUrl: 'https://api.anthropic.com', model: model, fetchImpl: t.fetchImpl }).config).turn(request([user('x')]));
    expect(t.sent[1]!.body).not.toHaveProperty('context_management');
    expect(t.sent[1]!.headers['anthropic-beta']).not.toContain('compact-2026-01-12');

    const other = fakeFetch(claudeError(400, 'messages.0.content: Field required'));
    const err = (await new AnthropicAdapter(
      adapterSetup({ baseUrl: 'https://api.anthropic.com', model: uniqueModel('claude-opus-5-5'), fetchImpl: other.fetchImpl }).config,
    )
      .turn(request([user('x')]))
      .catch((e: unknown) => e)) as AppError;
    expect(err.message).toBe('Claude hat die Anfrage abgelehnt.');
    expect(err.retryable).toBe(false);
    expect(other.sent).toHaveLength(1);
  });

  it('maps errors: 401 names the API key, 429/529/500 are retryable, 404 names model/deployment', async () => {
    const cases: Array<[number, RegExp, boolean]> = [
      [401, /API-Key/, false],
      [403, /API-Key/, false],
      [404, /nicht gefunden/, false],
      [429, /Claude-Limit/, true],
      [529, /Serverfehler/, true],
      [500, /Serverfehler/, true],
    ];
    for (const [status, message, retryable] of cases) {
      const t = fakeFetch(claudeError(status, 'nope'));
      const { config, logs, failures } = adapterSetup({ baseUrl: 'https://api.anthropic.com', model: uniqueModel('claude-opus-5-5'), fetchImpl: t.fetchImpl });
      const err = (await new AnthropicAdapter(config).turn(request([user('x')])).catch((e: unknown) => e)) as AppError;
      expect(err, `HTTP ${status}`).toBeInstanceOf(AppError);
      expect(err.message, `HTTP ${status}`).toMatch(message);
      expect(err.retryable, `HTTP ${status}`).toBe(retryable);
      expect(err.options.httpStatus, `HTTP ${status}`).toBe(retryable ? status : undefined);
      // the SDK must not retry on its own: the core counts retries
      expect(t.sent, `HTTP ${status}`).toHaveLength(1);
      expect(logs.at(-1)).toMatchObject({ success: false });
      expect(failures, `HTTP ${status}`).toEqual([err]);
    }
    const down = fakeFetch(new TypeError('fetch failed'));
    const err = (await new AnthropicAdapter(
      adapterSetup({ baseUrl: 'https://api.anthropic.com', model: uniqueModel('claude-opus-5-5'), fetchImpl: down.fetchImpl }).config,
    )
      .turn(request([user('x')]))
      .catch((e: unknown) => e)) as AppError;
    expect(err.message).toMatch(/nicht erreichbar/);
    expect(err.retryable).toBe(true);
  });
});
