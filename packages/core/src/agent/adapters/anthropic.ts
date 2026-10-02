import Anthropic from '@anthropic-ai/sdk';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import { abortedError } from '../../util/llm-errors';
import { AppError } from '../../util/errors';
import type { AgentMessage, AgentToolCall, ProviderAdapter, StopReason, StreamEvent, TurnRequest, TurnResult } from '../types';
import { previewOf, rejectedFeatures, replayRaw, type AdapterConfig } from './common';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

/** Optional features; an endpoint that rejects one gets requests without it from then on (#296). */
type Feature = 'effort' | 'task_budget' | 'compaction' | 'eager_streaming' | 'top_cache' | 'fallbacks';
const FEATURE_MENTIONS: Record<Feature, RegExp> = {
  // the specific features come first: „output_config.task_budget: …“ must switch off the task budget, not the effort
  task_budget: /task[_-]?budget/i,
  eager_streaming: /eager_input_streaming/i,
  compaction: /context_management|compact/i,
  fallbacks: /fallback/i,
  effort: /\beffort\b|output_config/i,
  top_cache: /cache_control/i,
};

/** Minimum total of a Claude task budget. */
const MIN_TASK_BUDGET = 20_000;

/** True for a base URL of the Anthropic Messages API (api.anthropic.com, Foundry `…/anthropic`). */
export function isAnthropicUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return /(^|\.)anthropic\.com$/i.test(u.hostname) || /\/anthropic(\/|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

const isFoundryHost = (baseUrl: string) => {
  try {
    return /\.azure\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
};
const isFirstParty = (baseUrl: string) => {
  try {
    return /(^|\.)anthropic\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
};

/** SDK base URL: without a trailing `/v1` (the SDK appends `/v1/messages`). */
export function sdkBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim();
  while (url.endsWith('/')) url = url.slice(0, -1);
  for (const suffix of ['/v1/messages', '/v1']) if (url.toLowerCase().endsWith(suffix)) url = url.slice(0, -suffix.length);
  return url;
}

/** Provider-neutral history → Messages API messages; consecutive results and texts of the user side form one message. */
export function toAnthropicMessages(messages: AgentMessage[], model: string): MessageParam[] {
  const out: MessageParam[] = [];
  const pushUser = (blocks: ContentBlockParam[]) => {
    const last = out.at(-1);
    if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(...blocks);
    else out.push({ role: 'user', content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') pushUser([{ type: 'text', text: m.content }]);
    else if (m.role === 'tool') {
      pushUser(
        m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.callId,
          content: r.content || '(leer)',
          ...(r.isError ? { is_error: true } : {}),
        })),
      );
      if (m.note) pushUser([{ type: 'text', text: m.note }]);
    } else if (replayRaw(m, 'anthropic', model) && Array.isArray(m.raw) && m.raw.length) {
      // thinking and compaction blocks go back unchanged and in place (append-only history)
      out.push({ role: 'assistant', content: m.raw as ContentBlockParam[] });
    } else {
      const blocks: ContentBlockParam[] = [];
      if (m.text.trim()) blocks.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls)
        blocks.push({ type: 'tool_use', id: c.id.replace(/[^\w-]/g, '_'), name: c.name, input: (c.args ?? {}) });
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    }
  }
  // tool_use ids of other providers were normalized above – the matching results need the same ids
  for (const msg of out)
    if (msg.role === 'user' && Array.isArray(msg.content))
      for (const b of msg.content) if (b.type === 'tool_result') b.tool_use_id = b.tool_use_id.replace(/[^\w-]/g, '_');
  return out;
}

/** SDK error → user-facing error; rate limits, server and connection errors are retryable (the core counts retries). */
function mapError(err: unknown, signal?: AbortSignal): Error {
  if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) return abortedError();
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return new AppError('llm_error', 'Claude hat die Anmeldung abgelehnt (API-Key prüfen).', { details: err.message });
  if (err instanceof Anthropic.NotFoundError)
    return new AppError('llm_error', 'Endpunkt oder Modell (Deployment) wurde nicht gefunden – Base URL und Modellname prüfen.', { details: err.message });
  if (err instanceof Anthropic.RateLimitError) return new AppError('llm_error', 'Das Claude-Limit wurde erreicht.', { retryable: true, details: err.message });
  if (err instanceof Anthropic.InternalServerError)
    return new AppError('llm_error', 'Claude meldet einen Serverfehler.', { retryable: true, details: err.message });
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new AppError('network_error', 'Zeitüberschreitung – Claude antwortet nicht.', { retryable: true, details: err.message });
  if (err instanceof Anthropic.APIConnectionError)
    return new AppError('network_error', 'Der Claude-Endpunkt ist nicht erreichbar (Netzwerk oder Base URL prüfen).', {
      retryable: true,
      details: err.message,
    });
  if (err instanceof Anthropic.BadRequestError) return new AppError('llm_error', 'Claude hat die Anfrage abgelehnt.', { details: err.message });
  if (err instanceof Anthropic.APIError)
    return new AppError('llm_error', 'Claude meldet einen Fehler.', { details: err.message, retryable: (err.status ?? 0) >= 500 });
  if (err instanceof AppError) return err;
  // e.g. tool input JSON the tolerant parser could not read: the turn is re-issued
  return new AppError('llm_error', 'Die Antwort von Claude war unvollständig.', { retryable: true, details: err instanceof Error ? err.message : String(err) });
}

/**
 * Adapter for Claude via the Anthropic Messages API (#296) – directly at Anthropic or through Microsoft Foundry
 * (`https://<resource>.services.ai.azure.com/anthropic`). Tools are native tools, results go back as `tool_result`.
 * Thinking is always on for current models and only steered by `effort`; tool use is never forced (`auto` only).
 * System instructions and tool list are stable and cached; task budget and compaction are used where available.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly firstParty: boolean;

  constructor(private readonly cfg: AdapterConfig) {
    this.model = cfg.model;
    this.firstParty = isFirstParty(cfg.baseUrl);
    const common = { apiKey: cfg.apiKey, baseURL: sdkBaseUrl(cfg.baseUrl), fetch: cfg.fetchImpl as never, maxRetries: 0, timeout: cfg.timeoutMs };
    this.client = isFoundryHost(cfg.baseUrl) ? (new AnthropicFoundry(common) as unknown as Anthropic) : new Anthropic(common);
  }

  private get endpoint(): string {
    return `${sdkBaseUrl(this.cfg.baseUrl)}/v1/messages`;
  }

  private params(req: TurnRequest, off: Set<string>, stream: boolean): Record<string, unknown> {
    const tools = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      ...(stream && !off.has('eager_streaming') ? { eager_input_streaming: true } : {}),
      // the stable tool list is the first cache breakpoint
      ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
    const betas: string[] = [];
    const outputConfig: Record<string, unknown> = {};
    if (!off.has('effort')) outputConfig.effort = req.effort;
    if (this.firstParty && !off.has('task_budget') && req.taskBudget && req.tools.length) {
      outputConfig.task_budget = { type: 'tokens', total: Math.max(MIN_TASK_BUDGET, req.taskBudget) };
      betas.push('task-budgets-2026-03-13');
    }
    const p: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxOutputTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(req.messages, this.model),
      ...(tools.length ? { tools, tool_choice: { type: 'auto' } } : {}),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      // automatic caching of the growing history (last cacheable block)
      ...(!off.has('top_cache') ? { cache_control: { type: 'ephemeral' } } : {}),
    };
    if (!off.has('compaction') && req.tools.length) {
      p.context_management = { edits: [{ type: 'compact_20260112' }] };
      betas.push('compact-2026-01-12');
    }
    // server-side refusal fallback exists only on the Claude API itself (not on Foundry)
    if (this.firstParty && !off.has('fallbacks') && /^claude-(?:opus-5|sonnet-5-5|fable-5-1)/.test(this.model)) {
      p.fallbacks = 'default';
      betas.push('server-side-fallback-2026-07-01');
    }
    if (betas.length) p.betas = betas;
    return p;
  }

  async turn(req: TurnRequest, onEvent?: (e: StreamEvent) => void): Promise<TurnResult> {
    const off = rejectedFeatures(`${this.endpoint}\n${this.model}`);
    let success = false;
    let usage: TurnResult['usage'] | null = null;
    let bytes = 0;
    try {
      for (let fallback = 0; ; fallback += 1) {
        if (req.signal?.aborted) throw abortedError();
        const params = this.params(req, off, true);
        bytes = Buffer.byteLength(JSON.stringify(params), 'utf8');
        try {
          const stream = this.client.beta.messages.stream(params as never, { signal: req.signal });
          let streamed = false;
          stream.on('text', (delta) => {
            streamed = true;
            onEvent?.({ type: 'text', delta });
          });
          const message = await stream.finalMessage();
          success = true;
          const result = this.toResult(message, streamed);
          usage = result.usage;
          return result;
        } catch (err) {
          if (err instanceof Anthropic.BadRequestError && fallback < 6) {
            const feature = (Object.keys(FEATURE_MENTIONS) as Feature[]).find((f) => !off.has(f) && FEATURE_MENTIONS[f].test(err.message));
            if (feature) {
              off.add(feature);
              this.cfg.warn('Claude endpoint rejected an optional feature – retrying without it', { feature });
              continue;
            }
          }
          throw mapError(err, req.signal);
        }
      }
    } finally {
      this.cfg.log({
        purpose: req.purpose,
        model: this.model,
        endpoint: this.endpoint,
        bytes,
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

  private toResult(message: Anthropic.Beta.BetaMessage, streamed: boolean): TurnResult {
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls: AgentToolCall[] = message.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input }));
    const map: Record<string, StopReason> = {
      tool_use: 'tool_use',
      max_tokens: 'max_tokens',
      refusal: 'refusal',
      pause_turn: 'pause',
      model_context_window_exceeded: 'max_tokens',
    };
    const stopReason: StopReason = map[message.stop_reason ?? ''] ?? (toolCalls.length ? 'tool_use' : 'end');
    const details = (message as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
    return {
      text,
      toolCalls,
      raw: message.content,
      stopReason,
      usage: {
        inputTokens: message.usage.input_tokens ?? 0,
        outputTokens: message.usage.output_tokens ?? 0,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      refusal: stopReason === 'refusal' ? { category: details?.category ?? null, explanation: details?.explanation ?? null } : undefined,
      streamed,
    };
  }

  /** Plain text request (classification, summaries) for the rest of Archivist when Claude is configured. */
  async completeText(input: { system: string; text: string; maxOutputTokens: number; signal?: AbortSignal }): Promise<string> {
    try {
      const msg = await this.client.messages.create(
        { model: this.model, max_tokens: input.maxOutputTokens, system: input.system, messages: [{ role: 'user', content: input.text }] },
        { signal: input.signal },
      );
      if (msg.stop_reason === 'refusal') throw new AppError('llm_error', 'Claude hat die Anfrage abgelehnt.');
      return msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    } catch (err) {
      throw mapError(err, input.signal);
    }
  }
}
