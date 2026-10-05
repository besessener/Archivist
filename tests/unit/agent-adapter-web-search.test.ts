import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../../packages/core/src/agent/adapters/anthropic';
import { OpenAiResponsesAdapter, toResponsesInput } from '../../packages/core/src/agent/adapters/openai';
import { adapterSetup, claudeError, claudeStream, fakeFetch, json, request, sse, streamed, uniqueBase, uniqueModel, user } from '../helpers/adapter-transport';

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

  it('Claude: offers the filtering web search tool first (custom tools keep the cache breakpoint) only when asked', async () => {
    const t = fakeFetch(claudeStream([{ type: 'text', text: 'ok' }]));
    const adapter = new AnthropicAdapter(
      adapterSetup({ baseUrl: 'https://api.anthropic.com', model: uniqueModel('claude-opus-5-5'), fetchImpl: t.fetchImpl }).config,
    );
    await adapter.turn(request([user('x')]));
    expect((t.sent[0]!.body.tools as Array<{ name: string }>).map((x) => x.name)).toEqual(['find_documents', 'move_documents']);
    await adapter.turn(request([user('x')], { webSearch: true }));
    const tools = t.sent[1]!.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
    expect(tools[0]).not.toHaveProperty('cache_control');
    expect(tools.at(-1)).toMatchObject({ name: 'move_documents', cache_control: { type: 'ephemeral' } });
  });

  it('Claude: a model or deployment without result filtering gets the basic web search, remembered', async () => {
    const model = uniqueModel('claude-haiku-4-5');
    const t = fakeFetch(
      claudeError(400, "tools.0: web_search_20260209 requires programmatic tool calling; set allowed_callers to ['direct']"),
      claudeStream([{ type: 'text', text: 'ok' }]),
    );
    const { config, warns } = adapterSetup({ baseUrl: 'https://api.anthropic.com', model, fetchImpl: t.fetchImpl });
    await new AnthropicAdapter(config).turn(request([user('x')], { webSearch: true }));
    await new AnthropicAdapter(config).turn(request([user('y')], { webSearch: true }));
    const firstTool = (index: number) => (t.sent[index]!.body.tools as Array<Record<string, unknown>>)[0];
    expect([firstTool(0)!.type, firstTool(1)!.type, firstTool(2)!.type]).toEqual(['web_search_20260209', 'web_search_20250305', 'web_search_20250305']);
    expect(firstTool(1)).toMatchObject({ name: 'web_search', max_uses: 5 });
    expect(warns.map((w) => w.data)).toEqual([{ feature: 'web_dynamic' }]);
  });

  it('Claude: reads searches and cited pages; the raw blocks (with encrypted content) stay for the replay', async () => {
    const t = fakeFetch(() => streamed(claudeWebSse(), 29));
    const res = await new AnthropicAdapter(
      adapterSetup({ baseUrl: 'https://api.anthropic.com', model: uniqueModel('claude-opus-5-5'), fetchImpl: t.fetchImpl }).config,
    ).turn(request([user('Elterngeld?')], { webSearch: true }));
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
    const { config, warns } = adapterSetup({ baseUrl: 'https://api.anthropic.com', model: model, fetchImpl: t.fetchImpl });
    const res = await new AnthropicAdapter(config).turn(request([user('x')], { webSearch: true }));
    expect(res.text).toBe('ok');
    expect((t.sent[1]!.body.tools as Array<{ name: string }>).map((x) => x.name)).toEqual(['find_documents', 'move_documents']);
    expect(warns.map((w) => w.data)).toEqual([{ feature: 'web_search' }]);
    await new AnthropicAdapter(config).turn(request([user('y')], { webSearch: true }));
    expect(t.sent).toHaveLength(3);
    expect((t.sent[2]!.body.tools as Array<{ name: string }>)[0]!.name).toBe('find_documents');
  });

  it('Claude: a 400 about user_location keeps the search but drops the location', async () => {
    const t = fakeFetch(claudeError(400, 'tools.0.user_location.timezone: invalid'), claudeStream([{ type: 'text', text: 'ok' }]));
    await new AnthropicAdapter(
      adapterSetup({ baseUrl: 'https://api.anthropic.com', model: uniqueModel('claude-opus-5-5'), fetchImpl: t.fetchImpl }).config,
    ).turn(request([user('x')], { webSearch: true }));
    const tool = (t.sent[1]!.body.tools as Array<Record<string, unknown>>)[0]!;
    expect(tool.name).toBe('web_search');
    expect(tool).not.toHaveProperty('user_location');
  });

  it('OpenAI: offers the hosted web_search tool with an approximate location only when asked', async () => {
    const t = fakeFetch(json({ status: 'completed', output: [] }));
    const adapter = new OpenAiResponsesAdapter(adapterSetup({ baseUrl: uniqueBase(), model: uniqueModel('gpt-5'), fetchImpl: t.fetchImpl }).config);
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
    const res = await new OpenAiResponsesAdapter(adapterSetup({ baseUrl: uniqueBase(), model: model, fetchImpl: t.fetchImpl }).config).turn(
      request([user('Kindergeld?')], { webSearch: true }),
    );
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
    const { config, warns } = adapterSetup({ baseUrl: uniqueBase(), model: uniqueModel('gpt-4.1'), fetchImpl: t.fetchImpl });
    await new OpenAiResponsesAdapter(config).turn(request([user('x')], { webSearch: true }));
    expect(t.sent).toHaveLength(2);
    expect((t.sent[1]!.body.tools as Array<{ type: string }>).every((x) => x.type === 'function')).toBe(true);
    expect(warns[0]!.data).toEqual({ params: ['web_search'] });
  });
});
