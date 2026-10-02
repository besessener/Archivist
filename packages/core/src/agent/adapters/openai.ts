import type { AgentEffort } from '@archivist/shared';
import { abortedError, mapHttpError } from '../../util/llm-errors';
import { AppError } from '../../util/errors';
import type { AgentMessage, AgentToolCall, ProviderAdapter, StopReason, StreamEvent, TurnRequest, TurnResult } from '../types';
import { previewOf, rejectedFeatures, replayRaw, type AdapterConfig } from './common';

/** Output item of the Responses API as far as the adapter reads it. */
interface OutputItem {
  type?: string;
  id?: string;
  role?: string;
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
  encrypted_content?: string | null;
  summary?: unknown;
}

interface ResponseBody {
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: OutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
}

/** Optional parameters a compatible endpoint (Azure OpenAI, Foundry `…/openai/v1`) may reject. */
const OPTIONAL = ['stream', 'reasoning', 'include', 'max_output_tokens', 'parallel_tool_calls', 'store'] as const;

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
        if (item.type === 'reasoning') items.push(item);
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
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!data || data === '[DONE]') continue;
      let ev: { type?: string; delta?: string; response?: ResponseBody; message?: string };
      try {
        ev = JSON.parse(data) as typeof ev;
      } catch {
        continue;
      }
      if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') onEvent?.({ type: 'text', delta: ev.delta });
      else if (ev.type === 'response.completed' || ev.type === 'response.incomplete' || ev.type === 'response.failed') final = ev.response ?? null;
      else if (ev.type === 'error') throw new AppError('llm_error', 'Der LLM-Endpunkt meldet einen Fehler.', { details: ev.message, retryable: true });
    }
  }
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
    const full: Record<string, unknown> = {
      model: this.model,
      instructions: req.system,
      input: toResponsesInput(req.messages, this.model),
      tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
      tool_choice: 'auto',
      store: false,
      stream: true,
      parallel_tool_calls: true,
      reasoning: { effort: openAiEffort(req.effort) },
      include: ['reasoning.encrypted_content'],
      max_output_tokens: req.maxOutputTokens,
    };
    const body = () => Object.fromEntries(Object.entries(full).filter(([k]) => !rejected.has(k)));
    let success = false;
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
      raw: output.map(({ id, status, ...rest }) => (rest.type === 'reasoning' ? { id, ...rest } : (void status, rest))),
      stopReason,
      usage: {
        inputTokens: Math.max(0, (r.usage?.input_tokens ?? 0) - cached),
        outputTokens: r.usage?.output_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      refusal: refusal ? { category: null, explanation: refusal.refusal ?? null } : undefined,
      streamed,
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
