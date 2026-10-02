import type { AgentEffort } from '@archivist/shared';
import { abortedError, mapHttpError } from '../../util/llm-errors';
import { AppError } from '../../util/errors';
import type { AgentMessage, AgentToolCall, ProviderAdapter, StopReason, StreamEvent, TurnRequest, TurnResult, WebSearchActivity } from '../types';
import { previewOf, rejectedFeatures, replayRaw, uniqueSources, userTimeZone, type AdapterConfig } from './common';

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

/** Provider-neutral history → Responses API input items. */
export function toResponsesInput(messages: AgentMessage[], model: string): unknown[] {
  const items: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') items.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') {
      for (const r of m.results) items.push({ type: 'function_call_output', call_id: r.callId, output: r.isError ? `FEHLER: ${r.content}` : r.content });
      if (m.note) items.push({ role: 'user', content: m.note });
    } else if (replayRaw(m, 'openai', model) && Array.isArray(m.raw)) {
      // own output items go back unchanged (reasoning with encrypted content keeps the chain of thought with store:false)
      for (const item of m.raw as OutputItem[]) {
        // web search calls go back as they came (id, status, action) so the reasoning before them keeps its successor
        if (item.type === 'reasoning' || item.type === 'web_search_call') items.push(item);
        else if (item.type === 'function_call') items.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments });
        else if (item.type === 'message') items.push({ role: 'assistant', content: textOf([item]) });
      }
    } else {
      if (m.text.trim()) items.push({ role: 'assistant', content: m.text });
      for (const c of m.toolCalls) items.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    }
  }
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

/** Reads a server-sent event stream; returns the final response object. */
async function readStream(res: Response, onEvent?: (e: StreamEvent) => void): Promise<ResponseBody> {
  const reader = res.body?.getReader();
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
    let ev: { type?: string; delta?: string; response?: ResponseBody; message?: string };
    try {
      ev = JSON.parse(data) as typeof ev;
    } catch {
      return;
    }
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') onEvent?.({ type: 'text', delta: ev.delta });
    else if (ev.type === 'response.completed' || ev.type === 'response.incomplete' || ev.type === 'response.failed') final = ev.response ?? null;
    else if (ev.type === 'error') throw new AppError('llm_error', 'Der LLM-Endpunkt meldet einen Fehler.', { details: ev.message, retryable: true });
  };
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done) break;
    // line endings may be CRLF (proxies); events are separated by an empty line
    buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handle(chunk);
    }
  }
  // the last event may end without the empty line
  if (buffer.trim()) handle(buffer);
  if (!final) throw new AppError('llm_error', 'Der Datenstrom des LLM-Endpunkts endete unvollständig.', { retryable: true });
  return final;
}

/**
 * Adapter for the OpenAI Responses API with native function calling (#297): directly at OpenAI and via Azure OpenAI or
 * Microsoft Foundry (`…/openai/v1`). Tools go as functions, results as `function_call_output` – several per round.
 * `store: false` stays; reasoning items are replayed via `reasoning.encrypted_content`.
 */
export class OpenAiResponsesAdapter implements ProviderAdapter {
  readonly id = 'openai' as const;
  readonly model: string;

  constructor(private readonly cfg: AdapterConfig) {
    this.model = cfg.model;
  }

  private get url(): string {
    let base = this.cfg.baseUrl;
    while (base.endsWith('/')) base = base.slice(0, -1);
    return `${base}/responses`;
  }

  async turn(req: TurnRequest, onEvent?: (e: StreamEvent) => void): Promise<TurnResult> {
    const key = `${this.url}\n${this.model}`;
    const rejected = rejectedFeatures(key);
    const functions = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
    const tz = userTimeZone();
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
    const body = () => {
      const b = Object.fromEntries(Object.entries(full).filter(([k]) => !rejected.has(k)));
      // hosted web search (only in chat runs); without a location the results would be localized to the United States
      if (req.webSearch && !rejected.has('web_search'))
        b.tools = [{ type: 'web_search', user_location: { type: 'approximate', ...(tz ? { timezone: tz } : {}) } }, ...functions];
      return b;
    };
    let success = false;
    let usage: TurnResult['usage'] | null = null;
    const sent = { bytes: 0 };
    try {
      for (let fallback = 0; ; fallback += 1) {
        const json = JSON.stringify(body());
        sent.bytes = Buffer.byteLength(json, 'utf8');
        const res = await this.post(json, req.signal);
        if (res.status === 400 && fallback < OPTIONAL.length) {
          const text = await res.text();
          const named = OPTIONAL.filter((p) => !rejected.has(p) && new RegExp(`\\b${p.replace('_', '[_ ]')}\\b`, 'i').test(text));
          if (UNSUPPORTED_RE.test(text) && named.length) {
            for (const p of named) rejected.add(p);
            this.cfg.warn('Endpoint rejected optional agent parameters – retrying without them', { params: named });
            continue;
          }
          throw mapHttpError(res.status, text);
        }
        if (res.status >= 400) throw mapHttpError(res.status, await res.text());
        const streamed = (res.headers.get('content-type') ?? '').includes('text/event-stream');
        let parsed: ResponseBody;
        if (streamed) parsed = await readStream(res, onEvent);
        else {
          const text = await res.text();
          try {
            parsed = JSON.parse(text) as ResponseBody;
          } catch {
            throw new AppError('llm_error', 'Der LLM-Endpunkt lieferte keine gültige JSON-Antwort.', { details: text.slice(0, 200) });
          }
        }
        if (parsed.error?.message) throw new AppError('llm_error', 'Der LLM-Endpunkt meldet einen Fehler.', { details: parsed.error.message });
        const result = this.toResult(parsed, streamed);
        if (!streamed && result.text) onEvent?.({ type: 'text', delta: result.text });
        success = true;
        usage = result.usage;
        return result;
      }
    } finally {
      this.cfg.log({
        purpose: req.purpose,
        model: this.model,
        endpoint: this.url,
        bytes: sent.bytes,
        redactions: 0,
        documentIds: req.documentIds,
        preview: previewOf(req.messages),
        success,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
      });
    }
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

  private async post(body: string, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw abortedError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.cfg.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'api-key': this.cfg.apiKey,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw abortedError();
      if (controller.signal.aborted)
        throw new AppError('network_error', `Zeitüberschreitung nach ${Math.round(this.cfg.timeoutMs / 1000)} s – der LLM-Endpunkt antwortet nicht.`, {
          retryable: true,
        });
      throw new AppError('network_error', 'Der LLM-Endpunkt ist nicht erreichbar (Netzwerk oder Base URL prüfen).', {
        retryable: true,
        details: (err as Error).message,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
