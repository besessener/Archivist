import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHandlers, createIpcDispatcher, createServices, type HostApi, type SecretCipher, type Services } from '../../packages/core/src';
import type { IpcChannel, IpcInput, IpcOutput, Result } from '@archivist/shared';

export const MIGRATIONS = path.resolve(__dirname, '../../packages/core/migrations');

/** Insecure test cipher (tests only), replaces Electron safeStorage. */
export class TestCipher implements SecretCipher {
  constructor(private readonly available = true) {}
  isAvailable() {
    return this.available;
  }
  backend() {
    return 'test';
  }
  encrypt(plain: string) {
    return Buffer.from(`enc:${Buffer.from(plain).toString('base64').split('').reverse().join('')}`);
  }
  decrypt(data: Buffer) {
    const s = data.toString();
    if (!s.startsWith('enc:')) throw new Error('bad');
    return Buffer.from(s.slice(4).split('').reverse().join(''), 'base64').toString();
  }
}

type Responder = (schema: string, input: string, body: Record<string, unknown>) => unknown;

/** One scripted model turn of the agent: tool calls and/or text. */
export interface AgentTurn {
  calls?: Array<{ name: string; args?: Record<string, unknown>; id?: string }>;
  text?: string;
  usage?: { input?: number; output?: number; cached?: number };
  refusal?: string;
  /** stop at the output limit (OpenAI: incomplete/max_output_tokens) */
  truncated?: boolean;
}
export type AgentScript = (req: { body: Record<string, unknown>; round: number; tools: string[]; provider: 'openai' | 'anthropic' }) => AgentTurn;

/** Successive turns; the last one repeats. Each entry may also be a function of the request. */
export function scriptedTurns(...turns: Array<AgentTurn | ((req: Parameters<AgentScript>[0]) => AgentTurn)>): AgentScript {
  let i = 0;
  return (req) => {
    const t = turns[Math.min(i, turns.length - 1)]!;
    i += 1;
    return typeof t === 'function' ? t(req) : t;
  };
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (out[k] = v));
  return out;
}

/** Server-sent events of the Anthropic Messages API for one turn. */
function anthropicSse(turn: AgentTurn, model: string): string {
  const events: unknown[] = [];
  const usage = {
    input_tokens: turn.usage?.input ?? 100,
    output_tokens: turn.usage?.output ?? 20,
    cache_read_input_tokens: turn.usage?.cached ?? 0,
    cache_creation_input_tokens: 0,
  };
  events.push({
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
  });
  let index = 0;
  if (turn.text) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: turn.text } });
    events.push({ type: 'content_block_stop', index });
    index += 1;
  }
  for (const [n, c] of (turn.calls ?? []).entries()) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: c.id ?? `toolu_${n}_${index}`, name: c.name, input: {} } });
    events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.args ?? {}) } });
    events.push({ type: 'content_block_stop', index });
    index += 1;
  }
  const stop = turn.refusal ? 'refusal' : turn.truncated ? 'max_tokens' : turn.calls?.length ? 'tool_use' : 'end_turn';
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  events.push({ type: 'message_stop' });
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** Scriptable fake endpoint for the Responses API. */
export class FakeLlm {
  calls: Array<{ schema: string; input: string; instructions: string }> = [];
  responders = new Map<string, Responder>();
  down = false;
  status = 200;
  raw: string | null = null;
  /** Texts sent to /embeddings (one entry per request). */
  embeddingRequests: string[][] = [];
  /** Answers /embeddings; without it the endpoint replies 404. */
  embed: ((texts: string[]) => number[][] | Promise<number[][]>) | null = null;
  /** Scripted agent (requests with tools); without it the tool-calling probe gets plain text (no native tool calling). */
  agent: AgentScript | null = null;
  /** Request bodies of agent requests (with tools), in order – for contract and privacy checks. */
  agentRequests: Array<Record<string, unknown>> = [];
  /** Request headers of agent requests. */
  agentHeaders: Array<Record<string, string>> = [];

  /** false: the endpoint answers tool requests with plain text only (no native tool calling). */
  toolCalling = true;

  /** Answers the tool-calling probe of the connection test like a capable endpoint. */
  private probe(body: Record<string, unknown>, tools: string[]): AgentTurn | null {
    if (tools.length !== 1 || tools[0] !== 'echo') return null;
    if (!this.toolCalling) return { text: 'Ich rufe keine Werkzeuge auf.' };
    const asText = JSON.stringify(body.input ?? body.messages ?? '');
    return /tool_result|function_call_output/.test(asText) ? { text: 'OK' } : { calls: [{ name: 'echo', args: { text: 'archivist' } }] };
  }

  on(schema: string, fn: Responder) {
    this.responders.set(schema, fn);
    return this;
  }

  /** Like real fetch: an aborted signal rejects the pending request, even while a responder still works. */
  fetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    if (!signal) return this.respond(url, init);
    if (signal.aborted) return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      this.respond(url, init)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  };

  private respond = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const u = url instanceof Request ? url.url : String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    if (this.status !== 200) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: this.status });
    if (u.endsWith('/embeddings')) {
      const texts = Array.isArray(body.input) ? (body.input as string[]) : [];
      this.embeddingRequests.push(texts);
      if (!this.embed) return new Response('not found', { status: 404 });
      const vectors = await this.embed(texts);
      return new Response(JSON.stringify({ data: vectors.map((embedding, index) => ({ embedding, index })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const toolNames = Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>).map((t) => t.name ?? '') : [];
    if (u.endsWith('/v1/messages')) {
      // Anthropic Messages API (Claude adapter, also via Microsoft Foundry)
      this.agentRequests.push(body);
      this.agentHeaders.push(headersOf(init));
      const turn = this.probe(body, toolNames) ??
        this.agent?.({ body, round: this.agentRequests.length, tools: toolNames, provider: 'anthropic' }) ?? { text: 'OK' };
      if (!body.stream) {
        const content = [
          ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
          ...(turn.calls ?? []).map((c, n) => ({ type: 'tool_use', id: c.id ?? `toolu_${n}`, name: c.name, input: c.args ?? {} })),
        ];
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content,
            stop_reason: turn.calls?.length ? 'tool_use' : 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(anthropicSse(turn, String(body.model)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (u.endsWith('/responses') && toolNames.length) {
      this.agentRequests.push(body);
      this.agentHeaders.push(headersOf(init));
      const turn = this.probe(body, toolNames) ??
        this.agent?.({ body, round: this.agentRequests.length, tools: toolNames, provider: 'openai' }) ?? { text: 'OK' };
      const output = [
        ...(turn.calls ?? []).map((c, n) => ({
          type: 'function_call',
          id: `fc_${n}`,
          call_id: c.id ?? `call_${this.agentRequests.length}_${n}`,
          name: c.name,
          arguments: JSON.stringify(c.args ?? {}),
        })),
        ...(turn.text ? [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: turn.text }] }] : []),
        ...(turn.refusal ? [{ type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'refusal', refusal: turn.refusal }] }] : []),
      ];
      return new Response(
        JSON.stringify({
          id: 'resp_agent',
          status: turn.truncated ? 'incomplete' : 'completed',
          incomplete_details: turn.truncated ? { reason: 'max_output_tokens' } : null,
          output,
          usage: {
            input_tokens: turn.usage?.input ?? 100,
            output_tokens: turn.usage?.output ?? 20,
            input_tokens_details: { cached_tokens: turn.usage?.cached ?? 0 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.endsWith('/responses')) {
      const instructions = typeof body.instructions === 'string' ? body.instructions : '';
      const rawInput = typeof body.input === 'string' ? body.input : JSON.stringify(body.input ?? '');
      // like the OpenAI Responses API: JSON mode requires the word "json" in the input (instructions do not count)
      if (body.text && !/json/i.test(rawInput))
        return new Response(
          JSON.stringify({
            error: { message: "Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'." },
          }),
          { status: 400 },
        );
      // the technical JSON hint of the client is not part of what the tests check
      const input = rawInput.replace(/^Antworte als JSON\.\n\n/, '');
      const schema = /JSON-Schema „(\w+)“/.exec(instructions)?.[1] ?? 'plain';
      this.calls.push({ schema, input, instructions });
      let text: string;
      if (this.raw !== null) text = this.raw;
      else {
        const fn = this.responders.get(schema);
        let out = fn
          ? await fn(schema, input.replace(/Bisheriger Verlauf[\s\S]*?\n\n(?=Nachricht des Benutzers:)/, ''), body)
          : schema === 'plain'
            ? 'OK'
            : { error: `no responder for ${schema}` };
        // For simplicity tests return a single intent; the analysis expects {intents: [...]}
        if (schema === 'ChatIntent' && out && typeof out === 'object' && 'intent' in out) out = { intents: [out] };
        text = typeof out === 'string' ? out : JSON.stringify(out);
      }
      return new Response(
        JSON.stringify({ id: 'resp_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  };
}

export interface TestApp {
  root: string;
  home: string;
  services: Services;
  llm: FakeLlm;
  call<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<Result<IpcOutput<C>>>;
  ok<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcOutput<C>>;
  dispatch: ReturnType<typeof createIpcDispatcher>;
  host: HostApi & { opened: string[] };
  file(rel: string, content: string | Buffer): string;
  cleanup(): Promise<void>;
}

export interface TestAppOptions {
  configured?: boolean;
  privacy?: 'auto' | 'confirm' | 'local_only';
  scanEnabled?: boolean;
  /** Agent mode (#294); off by default so that the rule-based chat tests keep their intent scripts. */
  agent?: boolean;
  workerFile?: string | null;
  dataRoot?: string;
}

/** Complete application (services + dispatcher) in a temporary directory. */
export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const root = opts.dataRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-test-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const llm = new FakeLlm();
  const services = createServices({
    dataRoot: path.join(root, 'Archivist'),
    migrationsFolder: MIGRATIONS,
    cipher: new TestCipher(),
    fetchImpl: llm.fetch,
    workerFile: opts.workerFile ?? null,
    jobConcurrency: 1,
    llmRetryDelayMs: 0,
    jobRetryDelayMs: 0,
  });
  if (opts.configured !== false) {
    services.settings.update({
      llm: { baseUrl: 'https://llm.example.test/openai/v1', model: 'test-model' },
      privacy: { llmMode: opts.privacy ?? 'auto' },
      agent: { enabled: opts.agent ?? false },
      setupCompleted: true,
    });
    services.secrets.setApiKey('sk-test-SECRET-0123456789abcdef');
  }
  if (opts.scanEnabled) services.settings.update({ scan: { enabled: true } });
  const opened: string[] = [];
  const host = {
    version: 'test',
    platform: process.platform,
    opened,
    selectDirectory: async () => null,
    openPath: async (p: string) => {
      opened.push(p);
      return '';
    },
    revealPath: (p: string) => void opened.push(p),
  };
  const handlers = createHandlers(services, host);
  const dispatch = createIpcDispatcher(handlers);
  services.jobs.start();
  return {
    root,
    home,
    services,
    llm,
    dispatch,
    host,
    call: ((channel: IpcChannel, input?: unknown) => dispatch(channel, input ?? {})) as TestApp['call'],
    ok: (async (channel: IpcChannel, input?: unknown) => {
      const r = await dispatch(channel, input ?? {});
      if (!r.ok) throw new Error(`${channel}: ${r.error.message} ${r.error.details ?? ''}`);
      return r.data;
    }) as TestApp['ok'],
    file(rel, content) {
      const p = path.join(home, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return p;
    },
    async cleanup() {
      await services.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
