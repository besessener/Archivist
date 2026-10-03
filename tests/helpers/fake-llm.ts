type Responder = (schema: string, input: string, body: Record<string, unknown>) => unknown;
type Body = Record<string, unknown>;
type Provider = 'openai' | 'anthropic';

/** One scripted model turn of the agent: tool calls and/or text. */
export interface AgentTurn {
  calls?: Array<{ name: string; args?: Record<string, unknown>; id?: string }>;
  text?: string;
  usage?: { input?: number; output?: number; cached?: number };
  refusal?: string;
  /** stop at the output limit (OpenAI: incomplete/max_output_tokens) */
  truncated?: boolean;
  /** OpenAI only: a hosted web search before the text, which then cites the page */
  web?: { query: string; url: string; title: string };
}
export type AgentScript = (request: { body: Body; round: number; tools: string[]; provider: Provider }) => AgentTurn;

/** Successive turns; the last one repeats. Each entry may also be a function of the request. */
export function scriptedTurns(...turns: Array<AgentTurn | ((request: Parameters<AgentScript>[0]) => AgentTurn)>): AgentScript {
  let turnIndex = 0;
  return (request) => {
    const turn = turns[Math.min(turnIndex, turns.length - 1)]!;
    turnIndex += 1;
    return typeof turn === 'function' ? turn(request) : turn;
  };
}

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function headersOf(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
  return headers;
}

/** Server-sent events of the Anthropic Messages API for one turn. */
function anthropicSse(turn: AgentTurn, model: string): string {
  const usage = {
    input_tokens: turn.usage?.input ?? 100,
    output_tokens: turn.usage?.output ?? 20,
    cache_read_input_tokens: turn.usage?.cached ?? 0,
    cache_creation_input_tokens: 0,
  };
  const blocks = [
    ...(turn.text ? [{ start: { type: 'text', text: '' }, delta: { type: 'text_delta', text: turn.text } }] : []),
    ...(turn.calls ?? []).map((toolCall, callIndex) => ({
      start: { type: 'tool_use', id: toolCall.id ?? `toolu_${callIndex}_${callIndex + (turn.text ? 1 : 0)}`, name: toolCall.name, input: {} },
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolCall.args ?? {}) },
    })),
  ];
  const stop = turn.refusal ? 'refusal' : turn.truncated ? 'max_tokens' : turn.calls?.length ? 'tool_use' : 'end_turn';
  const events = [
    {
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
    },
    ...blocks.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.start },
      { type: 'content_block_delta', index, delta: block.delta },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
    { type: 'message_stop' },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** A complete (non-streamed) Messages API answer for one turn. */
function anthropicMessage(turn: AgentTurn, model: unknown) {
  const content = [
    ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
    ...(turn.calls ?? []).map((toolCall, callIndex) => ({
      type: 'tool_use',
      id: toolCall.id ?? `toolu_${callIndex}`,
      name: toolCall.name,
      input: toolCall.args ?? {},
    })),
  ];
  const stopReason = turn.calls?.length ? 'tool_use' : 'end_turn';
  return { id: 'msg_1', type: 'message', role: 'assistant', model, content, stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 5 } };
}

/** Output items of a Responses API answer for one turn: calls, the web search, the text and a refusal. */
function responsesOutput(turn: AgentTurn, round: number): unknown[] {
  const { web } = turn;
  const functionCalls = (turn.calls ?? []).map((toolCall, callIndex) => ({
    type: 'function_call',
    id: `fc_${callIndex}`,
    call_id: toolCall.id ?? `call_${round}_${callIndex}`,
    name: toolCall.name,
    arguments: JSON.stringify(toolCall.args ?? {}),
  }));
  const webSearch = web
    ? [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: web.query, sources: [{ type: 'url', url: web.url }] } }]
    : [];
  const citation = web ? { annotations: [{ type: 'url_citation', url: web.url, title: web.title, start_index: 0, end_index: 1 }] } : {};
  const message = turn.text ? [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: turn.text, ...citation }] }] : [];
  const refusal = turn.refusal ? [{ type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'refusal', refusal: turn.refusal }] }] : [];
  return [...functionCalls, ...webSearch, ...message, ...refusal];
}

function responsesAgentAnswer(turn: AgentTurn, round: number) {
  return {
    id: 'resp_agent',
    status: turn.truncated ? 'incomplete' : 'completed',
    incomplete_details: turn.truncated ? { reason: 'max_output_tokens' } : null,
    output: responsesOutput(turn, round),
    usage: {
      input_tokens: turn.usage?.input ?? 100,
      output_tokens: turn.usage?.output ?? 20,
      input_tokens_details: { cached_tokens: turn.usage?.cached ?? 0 },
    },
  };
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

  on(schema: string, responder: Responder) {
    this.responders.set(schema, responder);
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

  private async respond(url: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (this.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const target = url instanceof Request ? url.url : String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body;
    if (this.status !== 200) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: this.status });
    if (target.endsWith('/embeddings')) return this.embeddings(body);
    const toolNames = Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>).map((tool) => tool.name ?? '') : [];
    // the SDK posts beta requests to `/v1/messages?beta=true`
    if (target.split('?')[0]!.endsWith('/v1/messages')) {
      if (!toolNames.length && !body.stream) return this.claudeText(body);
      return this.claudeAgent(body, { toolNames, init });
    }
    if (!target.endsWith('/responses')) return new Response('not found', { status: 404 });
    if (!toolNames.length) return this.responsesText(body);
    const turn = this.agentTurn(body, { toolNames, init }, 'openai');
    return jsonResponse(responsesAgentAnswer(turn, this.agentRequests.length));
  }

  private async embeddings(body: Body): Promise<Response> {
    const texts = Array.isArray(body.input) ? (body.input as string[]) : [];
    this.embeddingRequests.push(texts);
    if (!this.embed) return new Response('not found', { status: 404 });
    const vectors = await this.embed(texts);
    return jsonResponse({ data: vectors.map((embedding, index) => ({ embedding, index })) });
  }

  /** Plain text request via Claude (classification, summaries): the same responders as /responses. */
  private async claudeText(body: Body): Promise<Response> {
    const messages = (body.messages as Array<{ content?: unknown }> | undefined) ?? [];
    const first = messages[0]?.content;
    const text = await this.textAnswer(
      typeof body.system === 'string' ? body.system : '',
      typeof first === 'string' ? first : JSON.stringify(first ?? ''),
      body,
    );
    return jsonResponse({
      id: 'msg_text',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  }

  /** Anthropic Messages API (Claude adapter, also via Microsoft Foundry). */
  private claudeAgent(body: Body, request: { toolNames: string[]; init?: RequestInit }): Response {
    const turn = this.agentTurn(body, request, 'anthropic');
    if (!body.stream) return jsonResponse(anthropicMessage(turn, body.model));
    return new Response(anthropicSse(turn, String(body.model)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  private async responsesText(body: Body): Promise<Response> {
    const instructions = typeof body.instructions === 'string' ? body.instructions : '';
    const rawInput = typeof body.input === 'string' ? body.input : JSON.stringify(body.input ?? '');
    // like the OpenAI Responses API: JSON mode requires the word "json" in the input (instructions do not count)
    if (body.text && !/json/i.test(rawInput))
      return new Response(
        JSON.stringify({ error: { message: "Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'." } }),
        { status: 400 },
      );
    const text = await this.textAnswer(instructions, rawInput, body);
    return jsonResponse({ id: 'resp_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
  }

  /** Records an agent request and returns the turn that answers it: probe, script or plain "OK". */
  private agentTurn(body: Body, request: { toolNames: string[]; init?: RequestInit }, provider: Provider): AgentTurn {
    this.agentRequests.push(body);
    this.agentHeaders.push(headersOf(request.init));
    const round = this.agentRequests.length;
    return this.probe(body, request.toolNames) ?? this.agent?.({ body, round, tools: request.toolNames, provider }) ?? { text: 'OK' };
  }

  /** Answers the tool-calling probe of the connection test like a capable endpoint. */
  private probe(body: Body, tools: string[]): AgentTurn | null {
    if (tools.length !== 1 || tools[0] !== 'echo') return null;
    if (!this.toolCalling) return { text: 'Ich rufe keine Werkzeuge auf.' };
    const asText = JSON.stringify(body.input ?? body.messages ?? '');
    return /tool_result|function_call_output/.test(asText) ? { text: 'OK' } : { calls: [{ name: 'echo', args: { text: 'archivist' } }] };
  }

  /** Answers a plain text request (no tools) with the responder of its JSON schema. */
  private async textAnswer(instructions: string, rawInput: string, body: Body): Promise<string> {
    // the technical JSON hint of the client is not part of what the tests check
    const input = rawInput.replace(/^Antworte als JSON\.\n\n/, '');
    const schema = /JSON-Schema „(\w+)“/.exec(instructions)?.[1] ?? 'plain';
    this.calls.push({ schema, input, instructions });
    if (this.raw !== null) return this.raw;
    const answer = await this.responderAnswer(schema, input, body);
    return typeof answer === 'string' ? answer : JSON.stringify(answer);
  }

  private defaultAnswer(schema: string): unknown {
    if (schema === 'ConnectionTest') return { ok: true };
    return schema === 'plain' ? 'OK' : { error: `no responder for ${schema}` };
  }

  private async responderAnswer(schema: string, input: string, body: Body): Promise<unknown> {
    const responder = this.responders.get(schema);
    if (!responder) return this.defaultAnswer(schema);
    const answer = await responder(schema, input.replace(/Bisheriger Verlauf[\s\S]*?\n\n(?=Nachricht des Benutzers:)/, ''), body);
    // tests may answer ChatIntent with a single intent; the analysis expects {intents: [...]}
    return schema === 'ChatIntent' && answer && typeof answer === 'object' && 'intent' in answer ? { intents: [answer] } : answer;
  }
}
