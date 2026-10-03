import Anthropic from '@anthropic-ai/sdk';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import { abortedError } from '../../util/llm-errors';
import { AppError } from '../../util/errors';
import type { AgentMessage, AgentToolCall, ProviderAdapter, StopReason, StreamEvent, TurnRequest, TurnResult, WebSearchActivity } from '../types';
import { previewOf, rejectedFeatures, replayRaw, uniqueSources, userTimeZone, type AdapterConfig } from './common';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

/** Optional features; an endpoint that rejects one gets requests without it from then on (#296). */
type Feature = 'web_location' | 'web_search' | 'effort' | 'task_budget' | 'compaction' | 'eager_streaming' | 'top_cache' | 'fallbacks';
const FEATURE_MENTIONS: Record<Feature, RegExp> = {
  // the specific features come first: „output_config.task_budget: …“ must switch off the task budget, not the effort
  web_location: /user_location/i,
  // web search switched off for the organization, or not offered by the endpoint (Bedrock, some Foundry deployments)
  web_search: /web[_ ]?search/i,
  task_budget: /task[_-]?budget/i,
  eager_streaming: /eager_input_streaming/i,
  compaction: /context_management|compact/i,
  fallbacks: /fallback/i,
  effort: /\beffort\b|output_config/i,
  top_cache: /cache_control/i,
};

/** Searches per request; enough for comparisons, a brake for runaway searching. */
export const WEB_SEARCH_MAX_USES = 5;

/** Minimum total of a Claude task budget. */
const MIN_TASK_BUDGET = 20_000;

const FALLBACK_MODELS = /^claude-(?:opus-5|sonnet-5-5|fable-5-1)/;

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

const safeToolId = (id: string) => id.replace(/[^\w-]/g, '_');

/** Tool results with ids normalized like the tool_use ids they answer, then the operator note. */
function toolResultBlocks(message: Extract<AgentMessage, { role: 'tool' }>): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = message.results.map((r) => ({
    type: 'tool_result' as const,
    tool_use_id: safeToolId(r.callId),
    content: r.content || '(leer)',
    ...(r.isError ? { is_error: true } : {}),
  }));
  if (message.note) blocks.push({ type: 'text', text: message.note });
  return blocks;
}

function assistantBlocks(message: Extract<AgentMessage, { role: 'assistant' }>, model: string): ContentBlockParam[] {
  // thinking and compaction blocks go back unchanged and in place (append-only history)
  if (replayRaw(message, { provider: 'anthropic', model }) && Array.isArray(message.raw) && message.raw.length) return message.raw as ContentBlockParam[];
  const blocks: ContentBlockParam[] = [];
  if (message.text.trim()) blocks.push({ type: 'text', text: message.text });
  // tool_use ids of other providers may contain characters the Messages API rejects
  for (const c of message.toolCalls) blocks.push({ type: 'tool_use', id: safeToolId(c.id), name: c.name, input: c.args ?? {} });
  return blocks;
}

/** Provider-neutral history → Messages API messages; consecutive results and texts of the user side form one message. */
export function toAnthropicMessages(messages: AgentMessage[], model: string): MessageParam[] {
  const out: MessageParam[] = [];
  const pushUser = (blocks: ContentBlockParam[]) => {
    const last = out.at(-1);
    if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(...blocks);
    else out.push({ role: 'user', content: blocks });
  };
  for (const message of messages) {
    if (message.role === 'user') pushUser([{ type: 'text', text: message.content }]);
    else if (message.role === 'tool') pushUser(toolResultBlocks(message));
    else {
      const blocks = assistantBlocks(message, model);
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    }
  }
  return out;
}

interface RawBlock {
  type?: string;
  name?: string;
  input?: { query?: unknown } | null;
  content?: unknown;
  citations?: Array<{ type?: string; url?: string; title?: string | null }> | null;
}

/** Searches and sources of the server-side web search in one answer (`server_tool_use`, `web_search_tool_result`, citations). */
export function webActivity(blocks: RawBlock[]): { web?: WebSearchActivity } {
  const queries = blocks
    .filter((b) => b.type === 'server_tool_use' && b.name === 'web_search')
    .map((b) => (typeof b.input?.query === 'string' ? b.input.query : ''));
  if (!queries.length) return {};
  const cited = uniqueSources(blocks.flatMap((b) => (b.type === 'text' ? (b.citations ?? []) : [])).filter((c) => c.type === 'web_search_result_location'));
  const found = uniqueSources(
    blocks.flatMap((b) => (b.type === 'web_search_tool_result' && Array.isArray(b.content) ? (b.content as Array<{ url?: string; title?: string }>) : [])),
  );
  return { web: { queries, sources: cited.length ? cited : found.slice(0, 8) } };
}

/** Streamed tools get eager input streaming; the last tool is the first cache breakpoint. */
function toolParams(req: TurnRequest, off: Set<string>): unknown[] {
  const tools: unknown[] = req.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    ...(off.has('eager_streaming') ? {} : { eager_input_streaming: true }),
    ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
  // basic web search (server tool): available on the Claude API and on Foundry, also for deployments hosted on Azure
  if (req.webSearch && !off.has('web_search')) {
    const timeZone = off.has('web_location') ? null : userTimeZone();
    tools.unshift({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: WEB_SEARCH_MAX_USES,
      ...(timeZone ? { user_location: { type: 'approximate', timezone: timeZone } } : {}),
    });
  }
  return tools;
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

/** Claude via the Messages API (#296), directly or through Microsoft Foundry; thinking steered by `effort`, tool use never forced. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly firstParty: boolean;

  constructor(private readonly config: AdapterConfig) {
    this.model = config.model;
    this.firstParty = isFirstParty(config.baseUrl);
    const common = { apiKey: config.apiKey, baseURL: sdkBaseUrl(config.baseUrl), fetch: config.fetchImpl as never, maxRetries: 0, timeout: config.timeoutMs };
    this.client = isFoundryHost(config.baseUrl) ? (new AnthropicFoundry(common) as unknown as Anthropic) : new Anthropic(common);
  }

  private get endpoint(): string {
    return `${sdkBaseUrl(this.config.baseUrl)}/v1/messages`;
  }

  private params(req: TurnRequest, off: Set<string>): Record<string, unknown> {
    const tools = toolParams(req, off);
    const taskBudget = this.firstParty && !off.has('task_budget') && req.taskBudget && req.tools.length ? req.taskBudget : 0;
    const compaction = !off.has('compaction') && req.tools.length > 0;
    // server-side refusal fallback exists only on the Claude API itself (not on Foundry)
    const fallbacks = this.firstParty && !off.has('fallbacks') && FALLBACK_MODELS.test(this.model);
    const outputConfig = {
      ...(off.has('effort') ? {} : { effort: req.effort }),
      ...(taskBudget ? { task_budget: { type: 'tokens', total: Math.max(MIN_TASK_BUDGET, taskBudget) } } : {}),
    };
    const betas = [taskBudget && 'task-budgets-2026-03-13', compaction && 'compact-2026-01-12', fallbacks && 'server-side-fallback-2026-07-01'].filter(
      (beta): beta is string => Boolean(beta),
    );
    return {
      model: this.model,
      max_tokens: req.maxOutputTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(req.messages, this.model),
      ...(tools.length ? { tools, tool_choice: { type: 'auto' } } : {}),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      // automatic caching of the growing history (last cacheable block)
      ...(off.has('top_cache') ? {} : { cache_control: { type: 'ephemeral' } }),
      ...(compaction ? { context_management: { edits: [{ type: 'compact_20260112' }] } } : {}),
      ...(fallbacks ? { fallbacks: 'default' } : {}),
      ...(betas.length ? { betas } : {}),
    };
  }

  async turn(req: TurnRequest, onEvent?: (e: StreamEvent) => void): Promise<TurnResult> {
    const off = rejectedFeatures(`${this.endpoint}\n${this.model}`);
    let success = false;
    let usage: TurnResult['usage'] | null = null;
    let bytes = 0;
    try {
      for (let fallback = 0; ; fallback += 1) {
        if (req.signal?.aborted) throw abortedError();
        const params = this.params(req, off);
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
              this.config.warn('Claude endpoint rejected an optional feature – retrying without it', { feature });
              continue;
            }
          }
          throw mapError(err, req.signal);
        }
      }
    } finally {
      this.config.log({
        purpose: req.purpose,
        model: this.model,
        endpoint: this.endpoint,
        bytes,
        redactions: req.redactions ?? 0,
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
      ...webActivity(message.content as unknown as RawBlock[]),
    };
  }

  /** Plain text request (classification, summaries) for the rest of Archivist when Claude is configured. */
  async completeText(input: {
    system: string;
    text: string;
    maxOutputTokens: number;
    signal?: AbortSignal;
  }): Promise<{ text: string; usage: Pick<TurnResult['usage'], 'inputTokens' | 'outputTokens' | 'cacheReadTokens'> }> {
    try {
      const message = await this.client.messages.create(
        { model: this.model, max_tokens: input.maxOutputTokens, system: input.system, messages: [{ role: 'user', content: input.text }] },
        { signal: input.signal },
      );
      if (message.stop_reason === 'refusal') throw new AppError('llm_error', 'Claude hat die Anfrage abgelehnt.');
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const usage = message.usage;
      return {
        text,
        usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, cacheReadTokens: usage.cache_read_input_tokens ?? 0 },
      };
    } catch (err) {
      throw mapError(err, input.signal);
    }
  }
}
