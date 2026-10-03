import type { AdapterConfig } from '../../packages/core/src/agent/adapters/common';
import type { AgentMessage, ToolSpec, TurnRequest } from '../../packages/core/src/agent/types';

export interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
export type FakeReply = Response | Error | ((sent: SentRequest) => Response);

/** Fake fetch: records every request, answers from the list (the last entry repeats). */
export function fakeFetch(...replies: FakeReply[]) {
  const sent: SentRequest[] = [];
  let replyIndex = 0;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    const request: SentRequest = {
      url: url instanceof Request ? url.url : String(url),
      headers,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    };
    sent.push(request);
    const reply = replies[Math.min(replyIndex, replies.length - 1)]!;
    replyIndex += 1;
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(request) : reply.clone();
  };
  return { sent, fetchImpl };
}

let uniqueCounter = 0;
/** Feature switches an endpoint rejected are remembered per endpoint and model – every test gets its own. */
export const uniqueBase = () => `https://t${(uniqueCounter += 1)}.llm.example.test/openai/v1`;
export const uniqueModel = (model: string) => `${model}-t${(uniqueCounter += 1)}`;

/** Adapter configuration with a test key that records transmission logs and warnings. */
export function adapterSetup(endpoint: { baseUrl: string; model: string; fetchImpl: typeof fetch }) {
  const logs: Array<Record<string, unknown>> = [];
  const failures: unknown[] = [];
  const warns: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const config: AdapterConfig = {
    ...endpoint,
    apiKey: 'sk-test-KEY-0123456789',
    timeoutMs: 10_000,
    log: (entry) => logs.push(entry),
    fail: (err) => failures.push(err),
    warn: (message, data) => warns.push({ message, data }),
  };
  return { config, logs, warns, failures };
}

export const TOOLS: ToolSpec[] = [
  { name: 'find_documents', description: 'Dokumente finden', parameters: { type: 'object', properties: { ext: { type: 'string' } } } },
  { name: 'move_documents', description: 'Dokumente verschieben', parameters: { type: 'object', properties: { folder: { type: 'string' } } } },
];

export function request(messages: AgentMessage[], overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    system: 'Du bist Archivist.',
    messages,
    tools: TOOLS,
    maxOutputTokens: 4_000,
    effort: 'high',
    taskBudget: null,
    purpose: 'Agent',
    documentIds: ['doc-1'],
    ...overrides,
  };
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function sse(events: unknown[], options: { crlf?: boolean; noFinalBlank?: boolean } = {}): string {
  const newline = options.crlf ? '\r\n' : '\n';
  const text = events.map((event) => `event: ${(event as { type: string }).type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`).join('');
  return options.noFinalBlank ? text.slice(0, -newline.length * 2) : text;
}

/** A streamed response whose body arrives in small, arbitrarily cut pieces. */
export function streamed(text: string, pieceSize = 17): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += pieceSize) controller.enqueue(bytes.slice(offset, offset + pieceSize));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export const user = (content: string): AgentMessage => ({ role: 'user', content });
export const toolResults = (note?: string): AgentMessage => ({
  role: 'tool',
  results: [
    { callId: 'c1', name: 'find_documents', content: '2 Dokumente, Ergebnismenge S1', isError: false },
    { callId: 'c2', name: 'move_documents', content: 'Zielordner fehlt', isError: true },
  ],
  ...(note ? { note } : {}),
});

type ClaudeBlock =
  { type: 'text'; text: string } | { type: 'thinking'; thinking: string; signature: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
interface ClaudeAnswer {
  stop?: string;
  stopDetails?: unknown;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

function claudeBlockEvents(block: ClaudeBlock, index: number): unknown[] {
  if (block.type === 'text') {
    const deltas = (block.text.match(/.{1,6}/gs) ?? []).map((part) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } }));
    return [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, ...deltas];
  }
  if (block.type === 'thinking')
    return [
      { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } },
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } },
    ];
  const input = JSON.stringify(block.input);
  const half = Math.floor(input.length / 2);
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input.slice(0, half) } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input.slice(half) } },
  ];
}

/** Server-sent events of the Messages API for one answer (cf. anthropicSse in tests/helpers/harness.ts). */
function claudeSse(blocks: ClaudeBlock[], answer: ClaudeAnswer = {}): string {
  const usage = {
    input_tokens: answer.usage?.input ?? 100,
    output_tokens: 1,
    cache_read_input_tokens: answer.usage?.cacheRead ?? 0,
    cache_creation_input_tokens: answer.usage?.cacheWrite ?? 0,
  };
  const stop = answer.stop ?? (blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn');
  return sse([
    {
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, usage },
    },
    ...blocks.flatMap((block, index) => [...claudeBlockEvents(block, index), { type: 'content_block_stop', index }]),
    {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null, ...(answer.stopDetails ? { stop_details: answer.stopDetails } : {}) },
      usage: { output_tokens: answer.usage?.output ?? 20 },
    },
    { type: 'message_stop' },
  ]);
}

export const claudeStream = (blocks: ClaudeBlock[], answer?: ClaudeAnswer) => () => streamed(claudeSse(blocks, answer), 23);
export const claudeError = (status: number, message: string) =>
  json({ type: 'error', error: { type: status === 529 ? 'overloaded_error' : 'invalid_request_error', message } }, status);
