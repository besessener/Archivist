import { describe, expect, it } from 'vitest';
import { OpenAiResponsesAdapter, openAiEffort, toResponsesInput } from '../../packages/core/src/agent/adapters/openai';
import type { AgentMessage, StreamEvent } from '../../packages/core/src/agent/types';
import { AppError } from '../../packages/core/src/util/errors';
import { TOOLS, adapterSetup, fakeFetch, json, request, toolResults, sse, streamed, uniqueBase, user, type FakeReply } from '../helpers/adapter-transport';

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

  it('sends the key only as api-key to an Azure endpoint (#209)', async () => {
    const t = fakeFetch(json(completed([{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }])));
    const { config } = adapterSetup({ baseUrl: 'https://resource.openai.azure.com/openai/v1', model: 'gpt-5', fetchImpl: t.fetchImpl });
    await new OpenAiResponsesAdapter(config).turn(request([user('Hallo')]));
    expect(t.sent[0]!.headers['api-key']).toBe('sk-test-KEY-0123456789');
    expect(t.sent[0]!.headers).not.toHaveProperty('authorization');
  });

  it('sends model, instructions, input items, function tools and the fixed options', async () => {
    const base = uniqueBase();
    const t = fakeFetch(json(completed([{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }])));
    const { config, logs } = adapterSetup({ baseUrl: `${base}/`, model: 'gpt-5', fetchImpl: t.fetchImpl });
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
      toolResults('Technische Grenze erreicht.'),
    ];
    await new OpenAiResponsesAdapter(config).turn(request(history, { effort: 'xhigh', maxOutputTokens: 1_234 }));
    const [req] = t.sent;
    expect(req!.url).toBe(`${base}/responses`);
    expect(req!.headers.authorization).toBe('Bearer sk-test-KEY-0123456789');
    expect(req!.headers).not.toHaveProperty('api-key');
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
    const res = await new OpenAiResponsesAdapter(adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: t.fetchImpl }).config).turn(
      request([user('x')]),
      (e) => events.push(e),
    );
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
      const res = await new OpenAiResponsesAdapter(adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: t.fetchImpl }).config).turn(
        request([user('x')]),
      );
      expect(res).toMatchObject({ text: 'fertig', stopReason: 'end', streamed: true });
    }
  });

  it('a stream with an error event or without a final response is a retryable error', async () => {
    for (const body of [sse([{ type: 'error', message: 'overloaded' }]), sse([{ type: 'response.output_text.delta', delta: 'abgebr' }])]) {
      const t = fakeFetch(() => streamed(body));
      const { config, failures } = adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: t.fetchImpl });
      const err = await new OpenAiResponsesAdapter(config).turn(request([user('x')])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).retryable).toBe(true);
      expect(failures).toEqual([err]);
    }
  });

  it('plain JSON answers work too (streaming not offered by the endpoint)', async () => {
    const t = fakeFetch(json(completed([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hallo' }] }])));
    const events: StreamEvent[] = [];
    const res = await new OpenAiResponsesAdapter(adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: t.fetchImpl }).config).turn(
      request([user('x')]),
      (e) => events.push(e),
    );
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
    const { config, warns } = adapterSetup({ baseUrl: base, model: 'o-compat', fetchImpl: t.fetchImpl });
    const res = await new OpenAiResponsesAdapter(config).turn(request([user('x')]));
    expect(res.text).toBe('ok');
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]!.body.reasoning).toEqual({ effort: 'high' });
    expect(t.sent[1]!.body).not.toHaveProperty('reasoning');
    expect(t.sent[1]!.body).toHaveProperty('include');
    expect(warns[0]?.data).toEqual({ params: ['reasoning'] });
    // a new adapter for the same endpoint and model leaves it out from the start
    await new OpenAiResponsesAdapter(config).turn(request([user('y')]));
    expect(t.sent).toHaveLength(3);
    expect(t.sent[2]!.body).not.toHaveProperty('reasoning');
    // another model at the same endpoint still gets it
    await new OpenAiResponsesAdapter({ ...config, model: 'gpt-5' }).turn(request([user('z')]));
    expect(t.sent[3]!.body).toHaveProperty('reasoning');
  });

  it('another 400 is not retried', async () => {
    const t = fakeFetch(json({ error: { message: 'Invalid value for input' } }, 400));
    const err = (await new OpenAiResponsesAdapter(adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: t.fetchImpl }).config)
      .turn(request([user('x')]))
      .catch((e: unknown) => e)) as AppError;
    expect(err.message).toBe('Der LLM-Endpunkt hat die Anfrage abgelehnt.');
    expect(err.retryable).toBe(false);
    expect(t.sent).toHaveLength(1);
  });

  it('maps HTTP 401/429/500 and network errors (retryable flags)', async () => {
    const cases: Array<[FakeReply, RegExp, boolean]> = [
      [json({ error: { message: 'bad key' } }, 401), /Anmeldung abgelehnt \(API-Key prüfen\)/, false],
      [json({ error: { message: 'slow down' } }, 429), /LLM-Limit wurde erreicht/, true],
      [json({ error: { message: 'boom' } }, 500), /Serverfehler/, true],
      [json({ error: { message: 'no deployment' } }, 404), /nicht gefunden/, false],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), /nicht erreichbar/, true],
    ];
    for (const [reply, message, retryable] of cases) {
      const t = fakeFetch(reply);
      const { config, logs } = adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: t.fetchImpl });
      const err = (await new OpenAiResponsesAdapter(config).turn(request([user('x')])).catch((e: unknown) => e)) as AppError;
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
    const err = (await new OpenAiResponsesAdapter(adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: t.fetchImpl }).config)
      .turn(request([user('x')], { signal: controller.signal }))
      .catch((e: unknown) => e)) as AppError;
    expect(err.message).toBe('Die LLM-Anfrage wurde abgebrochen.');
    expect(t.sent).toHaveLength(0);
  });

  /** One text delta, then the stream stalls until the request is aborted (as fetch errors the body then). */
  const stallingStream: typeof fetch = async (_url, init) => {
    const signal = init!.signal!;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse([{ type: 'response.output_text.delta', delta: 'Hal' }])));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  it('„Stopp“ still cancels the request while the answer is streaming', async () => {
    const controller = new AbortController();
    const { config } = adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: stallingStream });
    const err = (await new OpenAiResponsesAdapter(config)
      .turn(request([user('x')], { signal: controller.signal }), () => controller.abort())
      .catch((e: unknown) => e)) as AppError;
    expect(err.message).toBe('Die LLM-Anfrage wurde abgebrochen.');
  });

  it('the timeout still applies while the answer is streaming', async () => {
    const { config } = adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: stallingStream });
    const err = (await new OpenAiResponsesAdapter({ ...config, timeoutMs: 50 }).turn(request([user('x')])).catch((e: unknown) => e)) as AppError;
    expect(err.message).toMatch(/Zeitüberschreitung/);
    expect(err.retryable).toBe(true);
  });

  it('the timeout bounds a pause in the stream, not the whole answer', async () => {
    const events = [
      ...Array.from({ length: 50 }, () => ({ type: 'response.output_text.delta', delta: 'a' })),
      {
        type: 'response.completed',
        response: completed([{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'a'.repeat(50) }] }]),
      },
    ];
    const slowStream: typeof fetch = async (_url, init) => {
      let next = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
        },
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (next < events.length) controller.enqueue(new TextEncoder().encode(sse([events[next++]])));
          else controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const { config } = adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: slowStream });
    // 50 chunks 25 ms apart outlast the 1 s timeout as a whole, while no single pause comes near it
    const result = await new OpenAiResponsesAdapter({ ...config, timeoutMs: 1_000 }).turn(request([user('x')]));
    expect(result.text).toBe('a'.repeat(50));
  });

  it('refusal and incomplete/max_output_tokens', async () => {
    const refusal = fakeFetch(json(completed([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Dabei helfe ich nicht.' }] }])));
    const r = await new OpenAiResponsesAdapter(adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: refusal.fetchImpl }).config).turn(
      request([user('x')]),
    );
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
    const c = await new OpenAiResponsesAdapter(adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: cut.fetchImpl }).config).turn(
      request([user('x')]),
    );
    expect(c.stopReason).toBe('max_tokens');
    expect(c.toolCalls).toHaveLength(1);
  });

  it('an error object in the body is an error', async () => {
    const t = fakeFetch(json({ status: 'failed', error: { message: 'content filter' }, output: [] }));
    const err = (await new OpenAiResponsesAdapter(adapterSetup({ baseUrl: uniqueBase(), model: 'gpt-5', fetchImpl: t.fetchImpl }).config)
      .turn(request([user('x')]))
      .catch((e: unknown) => e)) as AppError;
    expect(err.options.details).toBe('content filter');
  });
});
