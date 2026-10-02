import { afterEach, describe, expect, it } from 'vitest';
import { anthropicEndpointFor, createAdapter, detectAdapter } from '../../packages/core/src/agent/adapters';
import { AnthropicAdapter, isAnthropicUrl, sdkBaseUrl, toAnthropicMessages } from '../../packages/core/src/agent/adapters/anthropic';
import type { AdapterConfig } from '../../packages/core/src/agent/adapters/common';
import { OpenAiResponsesAdapter, openAiEffort, toResponsesInput } from '../../packages/core/src/agent/adapters/openai';
import type { AgentMessage, StreamEvent, ToolSpec, TurnRequest } from '../../packages/core/src/agent/types';
import { AppError } from '../../packages/core/src/util/errors';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, folderOf, scriptedTurns } from '../helpers/agent';

// ---------- fake transport ----------
interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
type Reply = Response | Error | ((sent: Sent) => Response);

/** Fake fetch: records every request, answers from the list (the last entry repeats). */
function fakeFetch(...replies: Reply[]) {
  const sent: Sent[] = [];
  let i = 0;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const s: Sent = {
      url: url instanceof Request ? url.url : String(url),
      headers,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    };
    sent.push(s);
    const r = replies[Math.min(i, replies.length - 1)]!;
    i += 1;
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(s) : r.clone();
  };
  return { sent, fetchImpl: fetchImpl };
}

let seq = 0;
/** Feature switches an endpoint rejected are remembered per endpoint and model – every test gets its own. */
const uniqueBase = () => `https://t${(seq += 1)}.llm.example.test/openai/v1`;
const uniqueModel = (m: string) => `${m}-t${(seq += 1)}`;

function config(baseUrl: string, model: string, fetchImpl: typeof fetch) {
  const logs: Array<Record<string, unknown>> = [];
  const warns: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const cfg: AdapterConfig = {
    baseUrl,
    model,
    apiKey: 'sk-test-KEY-0123456789',
    timeoutMs: 10_000,
    fetchImpl,
    log: (t) => logs.push(t),
    warn: (message, data) => warns.push({ message, data }),
  };
  return { cfg, logs, warns };
}

const TOOLS: ToolSpec[] = [
  { name: 'find_documents', description: 'Dokumente finden', parameters: { type: 'object', properties: { ext: { type: 'string' } } } },
  { name: 'move_documents', description: 'Dokumente verschieben', parameters: { type: 'object', properties: { folder: { type: 'string' } } } },
];

function request(messages: AgentMessage[], o: Partial<TurnRequest> = {}): TurnRequest {
  return {
    system: 'Du bist Archivist.',
    messages,
    tools: TOOLS,
    maxOutputTokens: 4_000,
    effort: 'high',
    taskBudget: null,
    purpose: 'Agent',
    documentIds: ['doc-1'],
    ...o,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (events: unknown[], o: { crlf?: boolean; noFinalBlank?: boolean } = {}) => {
  const nl = o.crlf ? '\r\n' : '\n';
  let text = events.map((e) => `event: ${(e as { type: string }).type}${nl}data: ${JSON.stringify(e)}${nl}${nl}`).join('');
  if (o.noFinalBlank) text = text.slice(0, -nl.length * 2);
  return text;
};
/** A streamed response whose body arrives in small, arbitrarily cut pieces. */
function streamed(text: string, piece = 17): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += piece) c.enqueue(bytes.slice(i, i + piece));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// ---------- shared history ----------
const user = (content: string): AgentMessage => ({ role: 'user', content });
const results = (note?: string): AgentMessage => ({
  role: 'tool',
  results: [
    { callId: 'c1', name: 'find_documents', content: '2 Dokumente, Ergebnismenge S1', isError: false },
    { callId: 'c2', name: 'move_documents', content: 'Zielordner fehlt', isError: true },
  ],
  ...(note ? { note } : {}),
});

describe('OpenAI Responses adapter (#297)', () => {
  const completed = (output: unknown[], usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } }, extra = {}) => ({
    id: 'resp_1',
    status: 'completed',
    output,
    usage,
    ...extra,
  });

  it('openAiEffort: xhigh and max are sent as high', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map((e) => openAiEffort(e as never))).toEqual(['low', 'medium', 'high', 'high', 'high']);
  });

  it('sends model, instructions, input items, function tools and the fixed options', async () => {
    const base = uniqueBase();
    const t = fakeFetch(json(completed([{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }])));
    const { cfg, logs } = config(`${base}/`, 'gpt-5', t.fetchImpl);
    const history: AgentMessage[] = [
      user('Verschiebe alle md'),
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'c1', name: 'find_documents', args: { ext: 'md' } },
          { id: 'c2', name: 'move_documents', args: {} },
        ],
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        raw: [{ type: 'thinking', thinking: 'geheim', signature: 'sig' }],
      },
      results('Technische Grenze erreicht.'),
    ];
    await new OpenAiResponsesAdapter(cfg).turn(request(history, { effort: 'xhigh', maxOutputTokens: 1_234 }));
    const [req] = t.sent;
    expect(req!.url).toBe(`${base}/responses`);
    expect(req!.headers.authorization).toBe('Bearer sk-test-KEY-0123456789');
    expect(req!.headers['api-key']).toBe('sk-test-KEY-0123456789');
    expect(req!.body).toEqual({
      model: 'gpt-5',
      instructions: 'Du bist Archivist.',
      input: [
        { role: 'user', content: 'Verschiebe alle md' },
        { type: 'function_call', call_id: 'c1', name: 'find_documents', arguments: '{"ext":"md"}' },
        { type: 'function_call', call_id: 'c2', name: 'move_documents', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: '2 Dokumente, Ergebnismenge S1' },
        { type: 'function_call_output', call_id: 'c2', output: 'FEHLER: Zielordner fehlt' },
        { role: 'user', content: 'Technische Grenze erreicht.' },
      ],
      tools: TOOLS.map((x) => ({ type: 'function', name: x.name, description: x.description, parameters: x.parameters, strict: false })),
      tool_choice: 'auto',
      store: false,
      stream: true,
      parallel_tool_calls: true,
      reasoning: { effort: 'high' },
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 1_234,
    });
    // a foreign provider's thinking never goes to OpenAI
    expect(JSON.stringify(req!.body)).not.toContain('geheim');
    expect(logs).toEqual([expect.objectContaining({ purpose: 'Agent', model: 'gpt-5', endpoint: `${base}/responses`, documentIds: ['doc-1'], success: true })]);
    expect(logs[0]!.bytes).toBeGreaterThan(100);
    expect(logs[0]!.preview).toContain('[Werkzeugergebnis find_documents]');
  });

  it('replays its own output items (reasoning with encrypted content) for the same model; text and calls otherwise', () => {
    const own: AgentMessage = {
      role: 'assistant',
      text: 'Ich suche.',
      toolCalls: [{ id: 'c1', name: 'find_documents', args: { ext: 'md' } }],
      provider: 'openai',
      model: 'gpt-5',
      raw: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ich suche.' }] },
        { type: 'function_call', call_id: 'c1', name: 'find_documents', arguments: '{"ext":"md"}' },
      ],
    };
    expect(toResponsesInput([own], 'gpt-5')).toEqual([
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
      { role: 'assistant', content: 'Ich suche.' },
      { type: 'function_call', call_id: 'c1', name: 'find_documents', arguments: '{"ext":"md"}' },
    ]);
    // another model of the same provider: reasoning items belong to their model
    expect(toResponsesInput([own], 'gpt-5-mini')).toEqual([
      { role: 'assistant', content: 'Ich suche.' },
      { type: 'function_call', call_id: 'c1', name: 'find_documents', arguments: '{"ext":"md"}' },
    ]);
  });

  it('parses the event stream: text deltas, function calls, usage incl. cached tokens', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', status: 'completed', encrypted_content: 'ENC', summary: [] },
      { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Ich suche jetzt.' }] },
      { type: 'function_call', id: 'fc_1', status: 'completed', call_id: 'call_A', name: 'find_documents', arguments: '{"ext":"md"}' },
      { type: 'function_call', id: 'fc_2', status: 'completed', call_id: 'call_B', name: 'move_documents', arguments: '{"folder":' },
    ];
    const body = sse([
      { type: 'response.created', response: { status: 'in_progress' } },
      { type: 'response.output_text.delta', delta: 'Ich suche ' },
      { type: 'response.output_text.delta', delta: 'jetzt.' },
      { type: 'response.completed', response: completed(output) },
    ]);
    const t = fakeFetch(() => streamed(`${body}data: [DONE]\n\n`));
    const events: StreamEvent[] = [];
    const res = await new OpenAiResponsesAdapter(config(uniqueBase(), 'gpt-5', t.fetchImpl).cfg).turn(request([user('x')]), (e) => events.push(e));
    expect(events).toEqual([
      { type: 'text', delta: 'Ich suche ' },
      { type: 'text', delta: 'jetzt.' },
    ]);
    expect(res.streamed).toBe(true);
    expect(res.text).toBe('Ich suche jetzt.');
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([
      { id: 'call_A', name: 'find_documents', args: { ext: 'md' } },
      // invalid JSON reaches the schema check (correctable error for the model)
      { id: 'call_B', name: 'move_documents', args: { _invalidJson: '{"folder":' } },
    ]);
    expect(res.usage).toEqual({ inputTokens: 70, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 });
    // raw keeps reasoning with its id (replay), other items without id/status
    expect(res.raw).toEqual([
      { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ich suche jetzt.' }] },
      { type: 'function_call', call_id: 'call_A', name: 'find_documents', arguments: '{"ext":"md"}' },
      { type: 'function_call', call_id: 'call_B', name: 'move_documents', arguments: '{"folder":' },
    ]);
  });

  it('reads streams with CRLF line endings and a last event without the empty line', async () => {
    const msg = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fertig' }] }];
    for (const opts of [{ crlf: true }, { noFinalBlank: true }]) {
      const body = sse(
        [
          { type: 'response.output_text.delta', delta: 'fertig' },
          { type: 'response.completed', response: completed(msg) },
        ],
        opts,
      );
      const t = fakeFetch(() => streamed(body, 5));
      const res = await new OpenAiResponsesAdapter(config(uniqueBase(), 'gpt-5', t.fetchImpl).cfg).turn(request([user('x')]));
      expect(res).toMatchObject({ text: 'fertig', stopReason: 'end', streamed: true });
    }
  });

  it('a stream with an error event or without a final response is a retryable error', async () => {
    for (const body of [sse([{ type: 'error', message: 'overloaded' }]), sse([{ type: 'response.output_text.delta', delta: 'abgebr' }])]) {
      const t = fakeFetch(() => streamed(body));
      const err = await new OpenAiResponsesAdapter(config(uniqueBase(), 'gpt-5', t.fetchImpl).cfg).turn(request([user('x')])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).retryable).toBe(true);
    }
  });

  it('plain JSON answers work too (streaming not offered by the endpoint)', async () => {
    const t = fakeFetch(json(completed([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hallo' }] }])));
    const events: StreamEvent[] = [];
    const res = await new OpenAiResponsesAdapter(config(uniqueBase(), 'gpt-5', t.fetchImpl).cfg).turn(request([user('x')]), (e) => events.push(e));
    expect(res).toMatchObject({ text: 'Hallo', streamed: false, stopReason: 'end', toolCalls: [] });
    expect(events).toEqual([{ type: 'text', delta: 'Hallo' }]);
  });

  it('a 400 „Unsupported parameter: reasoning“ is retried without it, and remembered for the endpoint', async () => {
    const base = uniqueBase();
    const ok = json(completed([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]));
    const t = fakeFetch(
      json({ error: { message: "Unsupported parameter: 'reasoning' is not supported with this model.", type: 'invalid_request_error' } }, 400),
      ok,
    );
    const { cfg, warns } = config(base, 'o-compat', t.fetchImpl);
    const res = await new OpenAiResponsesAdapter(cfg).turn(request([user('x')]));
    expect(res.text).toBe('ok');
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]!.body.reasoning).toEqual({ effort: 'high' });
    expect(t.sent[1]!.body).not.toHaveProperty('reasoning');
    expect(t.sent[1]!.body).toHaveProperty('include');
    expect(warns[0]?.data).toEqual({ params: ['reasoning'] });
    // a new adapter for the same endpoint and model leaves it out from the start
    await new OpenAiResponsesAdapter(cfg).turn(request([user('y')]));
    expect(t.sent).toHaveLength(3);
    expect(t.sent[2]!.body).not.toHaveProperty('reasoning');
    // another model at the same endpoint still gets it
    await new OpenAiResponsesAdapter({ ...cfg, model: 'gpt-5' }).turn(request([user('z')]));
    expect(t.sent[3]!.body).toHaveProperty('reasoning');
  });

  it('another 400 is not retried', async () => {
    const t = fakeFetch(json({ error: { message: 'Invalid value for input' } }, 400));
    const err = (await new OpenAiResponsesAdapter(config(uniqueBase(), 'gpt-5', t.fetchImpl).cfg)
      .turn(request([user('x')]))
      .catch((e: unknown) => e)) as AppError;
    expect(err.message).toBe('Der LLM-Endpunkt hat die Anfrage abgelehnt.');
    expect(err.retryable).toBe(false);
    expect(t.sent).toHaveLength(1);
  });

  it('maps HTTP 401/429/500 and network errors (retryable flags)', async () => {
    const cases: Array<[Reply, RegExp, boolean]> = [
      [json({ error: { message: 'bad key' } }, 401), /Anmeldung abgelehnt \(API-Key prüfen\)/, false],
      [json({ error: { message: 'slow down' } }, 429), /LLM-Limit wurde erreicht/, true],
      [json({ error: { message: 'boom' } }, 500), /Serverfehler/, true],
      [json({ error: { message: 'no deployment' } }, 404), /nicht gefunden/, false],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), /nicht erreichbar/, true],
    ];
    for (const [reply, message, retryable] of cases) {
      const t = fakeFetch(reply);
      const { cfg, logs } = config(uniqueBase(), 'gpt-5', t.fetchImpl);
      const err = (await new OpenAiResponsesAdapter(cfg).turn(request([user('x')])).catch((e: unknown) => e)) as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.message).toMatch(message);
      expect(err.retryable).toBe(retryable);
      // failed transmissions are logged as such
      expect(logs.at(-1)).toMatchObject({ success: false });
    }
  });

  it('an aborted request is reported as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const t = fakeFetch(json(completed([])));
    const err = (await new OpenAiResponsesAdapter(config(uniqueBase(), 'gpt-5', t.fetchImpl).cfg)
      .turn(request([user('x')], { signal: controller.signal }))
      .catch((e: unknown) => e)) as AppError;
    expect(err.message).toBe('Die LLM-Anfrage wurde abgebrochen.');
    expect(t.sent).toHaveLength(0);
  });

  it('refusal and incomplete/max_output_tokens', async () => {
    const refusal = fakeFetch(json(completed([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Dabei helfe ich nicht.' }] }])));
    const r = await new OpenAiResponsesAdapter(config(uniqueBase(), 'gpt-5', refusal.fetchImpl).cfg).turn(request([user('x')]));
    expect(r.stopReason).toBe('refusal');
    expect(r.refusal).toEqual({ category: null, explanation: 'Dabei helfe ich nicht.' });

    const cut = fakeFetch(
      json(
        completed(
          [{ type: 'function_call', call_id: 'c1', name: 'move_documents', arguments: '{"folder":"a"}' }],
          { input_tokens: 10, output_tokens: 4_000, input_tokens_details: { cached_tokens: 0 } },
          { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
        ),
      ),
    );
    const c = await new OpenAiResponsesAdapter(config(uniqueBase(), 'gpt-5', cut.fetchImpl).cfg).turn(request([user('x')]));
    expect(c.stopReason).toBe('max_tokens');
    expect(c.toolCalls).toHaveLength(1);
  });

  it('an error object in the body is an error', async () => {
    const t = fakeFetch(json({ status: 'failed', error: { message: 'content filter' }, output: [] }));
    const err = (await new OpenAiResponsesAdapter(config(uniqueBase(), 'gpt-5', t.fetchImpl).cfg)
      .turn(request([user('x')]))
      .catch((e: unknown) => e)) as AppError;
    expect(err.options.details).toBe('content filter');
  });
});

// ---------- Claude ----------
type Block =
  { type: 'text'; text: string } | { type: 'thinking'; thinking: string; signature: string } | { type: 'tool_use'; id: string; name: string; input: unknown };

/** Server-sent events of the Messages API for one answer (cf. anthropicSse in tests/helpers/harness.ts). */
function claudeSse(
  blocks: Block[],
  o: { stop?: string; stopDetails?: unknown; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } = {},
): string {
  const usage = {
    input_tokens: o.usage?.input ?? 100,
    output_tokens: 1,
    cache_read_input_tokens: o.usage?.cacheRead ?? 0,
    cache_creation_input_tokens: o.usage?.cacheWrite ?? 0,
  };
  const events: unknown[] = [
    {
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, usage },
    },
  ];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const part of b.text.match(/.{1,6}/gs) ?? []) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
    } else if (b.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      const js = JSON.stringify(b.input);
      const half = Math.floor(js.length / 2);
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: js.slice(0, half) } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: js.slice(half) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  const stop = o.stop ?? (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  events.push({
    type: 'message_delta',
    delta: { stop_reason: stop, stop_sequence: null, ...(o.stopDetails ? { stop_details: o.stopDetails } : {}) },
    usage: { output_tokens: o.usage?.output ?? 20 },
  });
  events.push({ type: 'message_stop' });
  return sse(events);
}
const claudeStream = (blocks: Block[], o?: Parameters<typeof claudeSse>[1]) => () => streamed(claudeSse(blocks, o), 23);
const claudeError = (status: number, message: string) =>
  json({ type: 'error', error: { type: status === 529 ? 'overloaded_error' : 'invalid_request_error', message } }, status);

describe('Claude adapter via the Anthropic SDK (#296)', () => {
  it('first party: URL, headers and body of a request with tools', async () => {
    const model = uniqueModel('claude-opus-5-5');
    const t = fakeFetch(claudeStream([{ type: 'text', text: 'ok' }]));
    const { cfg, logs } = config('https://api.anthropic.com/v1/', model, t.fetchImpl);
    await new AnthropicAdapter(cfg).turn(request([user('Verschiebe alle md')], { taskBudget: 5_000, effort: 'xhigh' }));
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
    const adapter = new AnthropicAdapter(config('https://api.anthropic.com', uniqueModel('claude-sonnet-5'), t.fetchImpl).cfg);
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
    const { cfg } = config('https://res.services.ai.azure.com/anthropic/', uniqueModel('claude-opus-5-5'), t.fetchImpl);
    await new AnthropicAdapter(cfg).turn(request([user('x')], { taskBudget: 50_000 }));
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
      results('Technische Grenze erreicht.'),
    ];
    const t = fakeFetch(claudeStream([{ type: 'text', text: 'ok' }]));
    await new AnthropicAdapter(config('https://api.anthropic.com', model, t.fetchImpl).cfg).turn(request(history));
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
          { type: 'tool_use', id: 'toolu_1', name: 'find_documents', input: { ext: ['md', 'txt'], folder: 'work/misc' } },
        ],
        { usage: { input: 120, output: 33, cacheRead: 4_000, cacheWrite: 900 } },
      ),
    );
    const events: StreamEvent[] = [];
    const res = await new AnthropicAdapter(config('https://api.anthropic.com', uniqueModel('claude-opus-5-5'), t.fetchImpl).cfg).turn(
      request([user('x')]),
      (e) => events.push(e),
    );
    expect(events.map((e) => e.delta).join('')).toBe('Ich suche die Dateien.');
    expect(events.length).toBeGreaterThan(1);
    expect(res).toMatchObject({
      text: 'Ich suche die Dateien.',
      stopReason: 'tool_use',
      streamed: true,
      toolCalls: [{ id: 'toolu_1', name: 'find_documents', args: { ext: ['md', 'txt'], folder: 'work/misc' } }],
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
      return new AnthropicAdapter(config('https://api.anthropic.com', uniqueModel('claude-haiku-4'), t.fetchImpl).cfg).turn(request([user('x')]));
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
    const { cfg, warns } = config('https://api.anthropic.com', model, t.fetchImpl);
    const res = await new AnthropicAdapter(cfg).turn(request([user('x')], { taskBudget: 100_000 }));
    expect(res.text).toBe('ok');
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]!.body.output_config).toHaveProperty('task_budget');
    expect(t.sent[1]!.body.output_config).toEqual({ effort: 'high' });
    expect(t.sent[1]!.headers['anthropic-beta']).not.toContain('task-budgets');
    expect(warns.map((w) => w.data)).toEqual([{ feature: 'task_budget' }]);
    await new AnthropicAdapter(cfg).turn(request([user('y')], { taskBudget: 100_000 }));
    expect(t.sent[2]!.body.output_config).toEqual({ effort: 'high' });
  });

  it('a 400 about context management switches compaction off; an unrelated 400 is not retried', async () => {
    const model = uniqueModel('claude-opus-5-5');
    const t = fakeFetch(claudeError(400, 'context_management: Unexpected value'), claudeStream([{ type: 'text', text: 'ok' }]));
    await new AnthropicAdapter(config('https://api.anthropic.com', model, t.fetchImpl).cfg).turn(request([user('x')]));
    expect(t.sent[1]!.body).not.toHaveProperty('context_management');
    expect(t.sent[1]!.headers['anthropic-beta']).not.toContain('compact-2026-01-12');

    const other = fakeFetch(claudeError(400, 'messages.0.content: Field required'));
    const err = (await new AnthropicAdapter(config('https://api.anthropic.com', uniqueModel('claude-opus-5-5'), other.fetchImpl).cfg)
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
      const { cfg, logs } = config('https://api.anthropic.com', uniqueModel('claude-opus-5-5'), t.fetchImpl);
      const err = (await new AnthropicAdapter(cfg).turn(request([user('x')])).catch((e: unknown) => e)) as AppError;
      expect(err, `HTTP ${status}`).toBeInstanceOf(AppError);
      expect(err.message, `HTTP ${status}`).toMatch(message);
      expect(err.retryable, `HTTP ${status}`).toBe(retryable);
      // the SDK must not retry on its own: the core counts retries
      expect(t.sent, `HTTP ${status}`).toHaveLength(1);
      expect(logs.at(-1)).toMatchObject({ success: false });
    }
    const down = fakeFetch(new TypeError('fetch failed'));
    const err = (await new AnthropicAdapter(config('https://api.anthropic.com', uniqueModel('claude-opus-5-5'), down.fetchImpl).cfg)
      .turn(request([user('x')]))
      .catch((e: unknown) => e)) as AppError;
    expect(err.message).toMatch(/nicht erreichbar/);
    expect(err.retryable).toBe(true);
  });
});

describe('web search of the provider', () => {
  /** Claude: a search (server_tool_use), its results and a text with a citation, as the Messages API streams them. */
  function claudeWebSse(): string {
    const usage = { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    return sse([
      {
        type: 'message_start',
        message: { id: 'msg_w', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, usage },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"Elterngeld 2026"}' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            { type: 'web_search_result', url: 'https://example.org/eg', title: 'Elterngeld', encrypted_content: 'ENC1', page_age: null },
            { type: 'web_search_result', url: 'https://example.org/other', title: 'Anderes', encrypted_content: 'ENC2', page_age: null },
          ],
        },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '', citations: [] } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Es gibt 14 Monate.' } },
      {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'citations_delta',
          citation: { type: 'web_search_result_location', url: 'https://example.org/eg', title: 'Elterngeld', encrypted_index: 'IDX', cited_text: '14 Monate' },
        },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
      },
      { type: 'message_stop' },
    ]);
  }

  it('Claude: offers the basic web search tool first (custom tools keep the cache breakpoint) only when asked', async () => {
    const t = fakeFetch(claudeStream([{ type: 'text', text: 'ok' }]));
    const adapter = new AnthropicAdapter(config('https://api.anthropic.com', uniqueModel('claude-opus-5-5'), t.fetchImpl).cfg);
    await adapter.turn(request([user('x')]));
    expect((t.sent[0]!.body.tools as Array<{ name: string }>).map((x) => x.name)).toEqual(['find_documents', 'move_documents']);
    await adapter.turn(request([user('x')], { webSearch: true }));
    const tools = t.sent[1]!.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
    expect(tools[0]).not.toHaveProperty('cache_control');
    expect(tools.at(-1)).toMatchObject({ name: 'move_documents', cache_control: { type: 'ephemeral' } });
  });

  it('Claude: reads searches and cited pages; the raw blocks (with encrypted content) stay for the replay', async () => {
    const t = fakeFetch(() => streamed(claudeWebSse(), 29));
    const res = await new AnthropicAdapter(config('https://api.anthropic.com', uniqueModel('claude-opus-5-5'), t.fetchImpl).cfg).turn(
      request([user('Elterngeld?')], { webSearch: true }),
    );
    expect(res.text).toBe('Es gibt 14 Monate.');
    expect(res.toolCalls).toEqual([]);
    expect(res.stopReason).toBe('end');
    expect(res.web).toEqual({ queries: ['Elterngeld 2026'], sources: [{ url: 'https://example.org/eg', title: 'Elterngeld' }] });
    expect(res.raw).toEqual([
      expect.objectContaining({ type: 'server_tool_use', id: 'srvtoolu_1', input: { query: 'Elterngeld 2026' } }),
      expect.objectContaining({ type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1' }),
      expect.objectContaining({ type: 'text', text: 'Es gibt 14 Monate.' }),
    ]);
  });

  it('Claude: without citations the found pages are the sources', async () => {
    const { webActivity } = await import('../../packages/core/src/agent/adapters/anthropic');
    expect(
      webActivity([
        { type: 'server_tool_use', name: 'web_search', input: { query: 'a' } },
        {
          type: 'web_search_tool_result',
          content: [
            { url: 'https://a.example/x', title: 'A' },
            { url: 'https://a.example/x', title: 'dupe' },
          ],
        },
        { type: 'text' },
      ]),
    ).toEqual({ web: { queries: ['a'], sources: [{ url: 'https://a.example/x', title: 'A' }] } });
    // an error result (max_uses_exceeded) is no list – no sources, the search still counts
    expect(
      webActivity([
        { type: 'server_tool_use', name: 'web_search', input: {} },
        { type: 'web_search_tool_result', content: { error_code: 'max_uses_exceeded' } },
      ]),
    ).toEqual({
      web: { queries: [''], sources: [] },
    });
    expect(webActivity([{ type: 'text' }])).toEqual({});
  });

  it('Claude: a 400 „web search is not enabled“ is retried without the tool and remembered', async () => {
    const model = uniqueModel('claude-opus-5-5');
    const t = fakeFetch(claudeError(400, 'Web search is not enabled for this organization.'), claudeStream([{ type: 'text', text: 'ok' }]));
    const { cfg, warns } = config('https://api.anthropic.com', model, t.fetchImpl);
    const res = await new AnthropicAdapter(cfg).turn(request([user('x')], { webSearch: true }));
    expect(res.text).toBe('ok');
    expect((t.sent[1]!.body.tools as Array<{ name: string }>).map((x) => x.name)).toEqual(['find_documents', 'move_documents']);
    expect(warns.map((w) => w.data)).toEqual([{ feature: 'web_search' }]);
    await new AnthropicAdapter(cfg).turn(request([user('y')], { webSearch: true }));
    expect(t.sent).toHaveLength(3);
    expect((t.sent[2]!.body.tools as Array<{ name: string }>)[0]!.name).toBe('find_documents');
  });

  it('Claude: a 400 about user_location keeps the search but drops the location', async () => {
    const t = fakeFetch(claudeError(400, 'tools.0.user_location.timezone: invalid'), claudeStream([{ type: 'text', text: 'ok' }]));
    await new AnthropicAdapter(config('https://api.anthropic.com', uniqueModel('claude-opus-5-5'), t.fetchImpl).cfg).turn(
      request([user('x')], { webSearch: true }),
    );
    const tool = (t.sent[1]!.body.tools as Array<Record<string, unknown>>)[0]!;
    expect(tool.name).toBe('web_search');
    expect(tool).not.toHaveProperty('user_location');
  });

  it('OpenAI: offers the hosted web_search tool with an approximate location only when asked', async () => {
    const t = fakeFetch(json({ status: 'completed', output: [] }));
    const adapter = new OpenAiResponsesAdapter(config(uniqueBase(), uniqueModel('gpt-5'), t.fetchImpl).cfg);
    await adapter.turn(request([user('x')]));
    expect((t.sent[0]!.body.tools as Array<{ type: string }>).every((x) => x.type === 'function')).toBe(true);
    await adapter.turn(request([user('x')], { webSearch: true }));
    const tools = t.sent[1]!.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: 'web_search', user_location: { type: 'approximate' } });
    expect(tools.slice(1).map((x) => x.name)).toEqual(['find_documents', 'move_documents']);
  });

  it('OpenAI: reads web_search_call items and url citations; the calls are replayed with id and status', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
      {
        type: 'web_search_call',
        id: 'ws_1',
        status: 'completed',
        action: { type: 'search', query: 'Kindergeld 2026', sources: [{ type: 'url', url: 'https://example.org/kg' }] },
      },
      { type: 'web_search_call', id: 'ws_2', status: 'completed', action: { type: 'open_page', url: 'https://example.org/kg' } },
      {
        type: 'message',
        id: 'msg_1',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: '255 € im Monat.',
            annotations: [{ type: 'url_citation', url: 'https://example.org/kg', title: 'Kindergeld', start_index: 0, end_index: 5 }],
          },
        ],
      },
    ];
    const model = uniqueModel('gpt-5');
    const t = fakeFetch(json({ status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } }));
    const res = await new OpenAiResponsesAdapter(config(uniqueBase(), model, t.fetchImpl).cfg).turn(request([user('Kindergeld?')], { webSearch: true }));
    expect(res.text).toBe('255 € im Monat.');
    expect(res.web).toEqual({ queries: ['Kindergeld 2026'], sources: [{ url: 'https://example.org/kg', title: 'Kindergeld' }] });
    const input = toResponsesInput([user('Kindergeld?'), { role: 'assistant', text: res.text, toolCalls: [], provider: 'openai', model, raw: res.raw }], model);
    expect(input).toEqual([
      { role: 'user', content: 'Kindergeld?' },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
      output[1],
      output[2],
      { role: 'assistant', content: '255 € im Monat.' },
    ]);
  });

  it('OpenAI: an endpoint without web search is asked again without the tool', async () => {
    const t = fakeFetch(
      json({ error: { message: "Tool type 'web_search' is not supported with this model." } }, 400),
      json({ status: 'completed', output: [] }),
    );
    const { cfg, warns } = config(uniqueBase(), uniqueModel('gpt-4.1'), t.fetchImpl);
    await new OpenAiResponsesAdapter(cfg).turn(request([user('x')], { webSearch: true }));
    expect(t.sent).toHaveLength(2);
    expect((t.sent[1]!.body.tools as Array<{ type: string }>).every((x) => x.type === 'function')).toBe(true);
    expect(warns[0]!.data).toEqual({ params: ['web_search'] });
  });
});

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
    const { cfg } = config('https://api.anthropic.com', 'claude-opus-5-5', fakeFetch(json({})).fetchImpl);
    expect(createAdapter('anthropic', cfg)).toBeInstanceOf(AnthropicAdapter);
    expect(createAdapter('openai', cfg)).toBeInstanceOf(OpenAiResponsesAdapter);
  });
});

// ---------- the same agent scenario through both adapters (#297) ----------
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
    const a = await archived(app, 'folien-q1.md', '# Q1', 'work/misc');
    const b = await archived(app, 'folien-q2.md', '# Q2', 'work/misc');
    const other = await archived(app, 'notiz.txt', 'Notiz', 'work/misc');
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
    const a = await archived(app, 'a.md', 'A', 'work/misc');
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
