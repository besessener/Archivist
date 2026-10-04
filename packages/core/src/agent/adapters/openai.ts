import type { AgentEffort } from '@archivist/shared';
import { abortedError, mapHttpError } from '../../util/llm-errors';
import { parseRetryAfter } from '../../util/retry-after';
import { AppError } from '../../util/errors';
import type { AgentMessage, AgentToolCall, ProviderAdapter, StopReason, StreamEvent, TurnRequest, TurnResult, WebSearchActivity } from '../types';
import { authHeaders, previewOf, rejectedFeatures, replayRaw, requestAbort, uniqueSources, userTimeZone, type AdapterConfig } from './common';

/** Output item of the Responses API as far as the adapter reads it. */
interface OutputItem {
  type?: string;
  id?: string;
  role?: string;
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> }>;
  encrypted_content?: string | null;
  summary?: unknown;
  /** web_search_call: what the search did (search / open_page / find_in_page). */
  action?: { type?: string; query?: string; queries?: string[]; url?: string; sources?: Array<{ type?: string; url?: string }> } | null;
}

interface ResponseBody {
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: OutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
}

/** Optional parameters a compatible endpoint (Azure OpenAI, Foundry `…/openai/v1`) may reject; `web_search` is the hosted tool. */
const OPTIONAL = ['web_search', 'stream', 'reasoning', 'include', 'max_output_tokens', 'parallel_tool_calls', 'store'] as const;

const UNSUPPORTED_RE = /\b(?:unsupported|unknown|unrecognized|not\s+supported|does\s+not\s+support|invalid)\b/i;

/** OpenAI only knows low/medium/high – xhigh and max are sent as high. */
export function openAiEffort(e: AgentEffort): 'low' | 'medium' | 'high' {
  return e === 'low' || e === 'medium' ? e : 'high';
}

type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>;

/** Provider-neutral history → Responses API input items. */
export function toResponsesInput(messages: AgentMessage[], model: string): unknown[] {
  return messages.flatMap((message): unknown[] => {
    if (message.role === 'user') return [{ role: 'user', content: message.content }];
    if (message.role === 'tool') return toolOutputs(message);
    if (replayRaw(message, { provider: 'openai', model }) && Array.isArray(message.raw)) return (message.raw as OutputItem[]).flatMap(replayedItem);
    return assistantItems(message);
  });
}

function toolOutputs(message: Extract<AgentMessage, { role: 'tool' }>): unknown[] {
  const items: unknown[] = message.results.map((r) => ({
    type: 'function_call_output',
    call_id: r.callId,
    output: r.isError ? `FEHLER: ${r.content}` : r.content,
  }));
  if (message.note) items.push({ role: 'user', content: message.note });
  return items;
}

/** Own output items go back unchanged (reasoning with encrypted content keeps the chain of thought with store:false). */
function replayedItem(item: OutputItem): unknown[] {
  // web search calls go back as they came (id, status, action) so the reasoning before them keeps its successor
  if (item.type === 'reasoning' || item.type === 'web_search_call') return [item];
  if (item.type === 'function_call') return [{ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments }];
  if (item.type === 'message') return [{ role: 'assistant', content: textOf([item]) }];
  return [];
}

function assistantItems(message: AssistantMessage): unknown[] {
  const items: unknown[] = message.text.trim() ? [{ role: 'assistant', content: message.text }] : [];
  for (const c of message.toolCalls) items.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
  return items;
}

function textOf(output: OutputItem[]): string {
  return output
    .filter((i) => i.type === 'message')
    .flatMap((i) => i.content ?? [])
    .filter((c) => c.type === 'output_text' || c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

/** Searches (`web_search_call`) and cited pages (`url_citation`) of one response. */
export function webActivity(output: OutputItem[]): { web?: WebSearchActivity } {
  const calls = output.filter((i) => i.type === 'web_search_call');
  if (!calls.length) return {};
  // open_page / find_in_page belong to the search before them; only searches are listed
  const queries = calls
    .filter((c) => !c.action?.type || c.action.type === 'search')
    .map((c) => c.action?.queries?.filter(Boolean).join(' · ') || c.action?.query || '');
  const cited = uniqueSources(
    output
      .filter((i) => i.type === 'message')
      .flatMap((i) => i.content ?? [])
      .flatMap((c) => c.annotations ?? [])
      .filter((a) => a.type === 'url_citation'),
  );
  const found = uniqueSources(calls.flatMap((c) => c.action?.sources ?? []).map((s) => ({ url: s.url })));
  return { web: { queries: queries.length ? queries : [''], sources: cited.length ? cited : found.slice(0, 8) } };
}

function parseArgs(raw: string | undefined): unknown {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // invalid JSON reaches the tool as such; schema validation returns a correctable error to the model
    return { _invalidJson: raw.slice(0, 500) };
  }
}

/** Optional parameters a 400 answer names as unsupported. */
function rejectedParams(text: string, rejected: Set<string>): string[] {
  if (!UNSUPPORTED_RE.test(text)) return [];
  return OPTIONAL.filter((param) => !rejected.has(param) && new RegExp(`\\b${param.replace('_', '[_ ]')}\\b`, 'i').test(text));
}

async function readJson(response: Response): Promise<ResponseBody> {
  const text = await response.text();
  try {
    return JSON.parse(text) as ResponseBody;
  } catch {
    throw new AppError('llm_error', 'Der LLM-Endpunkt lieferte keine gültige JSON-Antwort.', { details: text.slice(0, 200) });
  }
}

/** Reads a server-sent event stream; returns the final response object. */
async function readStream(response: Response, onEvent?: (e: StreamEvent) => void): Promise<ResponseBody> {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('llm_error', 'Der LLM-Endpunkt lieferte keinen Datenstrom.', { retryable: true });
  const decoder = new TextDecoder();
  let buffer = '';
  let final: ResponseBody | null = null;
  const handle = (chunk: string) => {
    const data = chunk
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!data || data === '[DONE]') return;
    let event: { type?: string; delta?: string; response?: ResponseBody; message?: string };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      return;
    }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') onEvent?.({ type: 'text', delta: event.delta });
    else if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') final = event.response ?? null;
    else if (event.type === 'error') throw new AppError('llm_error', 'Der LLM-Endpunkt meldet einen Fehler.', { details: event.message, retryable: true });
  };
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done) break;
    // line endings may be CRLF (proxies); events are separated by an empty line
    buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
    let separator: number;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      handle(chunk);
    }
  }
  // the last event may end without the empty line
  if (buffer.trim()) handle(buffer);
  if (!final) throw new AppError('llm_error', 'Der Datenstrom des LLM-Endpunkts endete unvollständig.', { retryable: true });
  return final;
}

const retryAfterOf = (response: Response) => parseRetryAfter(response.headers.get('retry-after'), Date.now());

/** OpenAI Responses API with function calling (#297), also Azure OpenAI and Foundry `…/openai/v1`; `store: false`, reasoning replayed encrypted. */
export class OpenAiResponsesAdapter implements ProviderAdapter {
  readonly id = 'openai' as const;
  readonly model: string;

  constructor(private readonly config: AdapterConfig) {
    this.model = config.model;
  }

  private get url(): string {
    let base = this.config.baseUrl;
    while (base.endsWith('/')) base = base.slice(0, -1);
    return `${base}/responses`;
  }

  async turn(req: TurnRequest, onEvent?: (e: StreamEvent) => void): Promise<TurnResult> {
    const rejected = rejectedFeatures(`${this.url}\n${this.model}`);
    let success = false;
    let usage: TurnResult['usage'] | null = null;
    const sent = { bytes: 0 };
    try {
      for (let fallback = 0; ; fallback += 1) {
        const json = JSON.stringify(this.body(req, rejected));
        sent.bytes = Buffer.byteLength(json, 'utf8');
        if (req.signal?.aborted) throw abortedError();
        const abort = requestAbort(req.signal, this.config.timeoutMs);
        try {
          const response = await this.post(json, abort.signal);
          if (response.status === 400 && fallback < OPTIONAL.length) {
            await this.dropRejected(response, rejected);
            continue;
          }
          if (response.status >= 400) throw mapHttpError(response.status, await response.text(), retryAfterOf(response));
          const result = await this.readResult(response, onEvent);
          success = true;
          usage = result.usage;
          return result;
        } catch (err) {
          throw abort.signal.aborted ? abort.error() : err;
        } finally {
          abort.dispose();
        }
      }
    } catch (err) {
      this.config.fail(err, req.signal);
      throw err;
    } finally {
      this.config.log({
        purpose: req.purpose,
        model: this.model,
        endpoint: this.url,
        bytes: sent.bytes,
        redactions: req.redactions ?? 0,
        personalRedactions: req.personalRedactions ?? 0,
        documentIds: req.documentIds,
        preview: previewOf(req.messages),
        success,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
      });
    }
  }

  /** Leaves out the optional parameters a 400 answer names as unsupported; any other 400 is an error. */
  private async dropRejected(response: Response, rejected: Set<string>): Promise<void> {
    const text = await response.text();
    const named = rejectedParams(text, rejected);
    if (!named.length) throw mapHttpError(response.status, text);
    for (const param of named) rejected.add(param);
    this.config.warn('Endpoint rejected optional agent parameters – retrying without them', { params: named });
  }

  /** The request without the parameters this endpoint rejected. */
  private body(req: TurnRequest, rejected: Set<string>): Record<string, unknown> {
    const functions = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
    const full: Record<string, unknown> = {
      model: this.model,
      instructions: req.system,
      input: toResponsesInput(req.messages, this.model),
      tools: functions,
      tool_choice: 'auto',
      store: false,
      stream: true,
      parallel_tool_calls: true,
      reasoning: { effort: openAiEffort(req.effort) },
      include: ['reasoning.encrypted_content'],
      max_output_tokens: req.maxOutputTokens,
    };
    const body = Object.fromEntries(Object.entries(full).filter(([key]) => !rejected.has(key)));
    // hosted web search (only in chat runs); without a location the results would be localized to the United States
    if (req.webSearch && !rejected.has('web_search')) {
      const timeZone = userTimeZone();
      body.tools = [{ type: 'web_search', user_location: { type: 'approximate', ...(timeZone ? { timezone: timeZone } : {}) } }, ...functions];
    }
    return body;
  }

  private async readResult(response: Response, onEvent?: (e: StreamEvent) => void): Promise<TurnResult> {
    const streamed = (response.headers.get('content-type') ?? '').includes('text/event-stream');
    const parsed = streamed ? await readStream(response, onEvent) : await readJson(response);
    if (parsed.error?.message) throw new AppError('llm_error', 'Der LLM-Endpunkt meldet einen Fehler.', { details: parsed.error.message });
    const result = this.toResult(parsed, streamed);
    if (!streamed && result.text) onEvent?.({ type: 'text', delta: result.text });
    return result;
  }

  private toResult(r: ResponseBody, streamed: boolean): TurnResult {
    const output = r.output ?? [];
    const toolCalls: AgentToolCall[] = output
      .filter((i) => i.type === 'function_call')
      .map((i, n) => ({ id: i.call_id ?? `call_${n}`, name: i.name ?? '', args: parseArgs(i.arguments) }));
    const refusal = output.flatMap((i) => i.content ?? []).find((c) => c.type === 'refusal');
    let stopReason: StopReason = toolCalls.length ? 'tool_use' : 'end';
    if (refusal) stopReason = 'refusal';
    else if (r.status === 'incomplete' && r.incomplete_details?.reason === 'max_output_tokens') stopReason = 'max_tokens';
    const cached = r.usage?.input_tokens_details?.cached_tokens ?? 0;
    return {
      text: textOf(output),
      toolCalls,
      raw: output.map(({ id, status, ...rest }) =>
        rest.type === 'reasoning' ? { id, ...rest } : rest.type === 'web_search_call' ? { id, status, ...rest } : (void status, rest),
      ),
      stopReason,
      usage: {
        inputTokens: Math.max(0, (r.usage?.input_tokens ?? 0) - cached),
        outputTokens: r.usage?.output_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      refusal: refusal ? { category: null, explanation: refusal.refusal ?? null } : undefined,
      streamed,
      ...webActivity(output),
    };
  }

  private async post(body: string, signal: AbortSignal): Promise<Response> {
    try {
      return await this.config.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          ...authHeaders(this.url, this.config.apiKey),
        },
        body,
        signal,
      });
    } catch (err) {
      // turn() reports an aborted request as cancellation or timeout
      if (signal.aborted) throw err;
      throw new AppError('network_error', 'Der LLM-Endpunkt ist nicht erreichbar (Netzwerk oder Base URL prüfen).', {
        retryable: true,
        details: (err as Error).message,
      });
    }
  }
}
