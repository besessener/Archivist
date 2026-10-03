import { AsyncLocalStorage } from 'node:async_hooks';
import type { z } from 'zod';
import { checkLlmBaseUrl, type AgentAdapterId, type LlmTestResult, type LlmTransmission, type LlmUsage } from '@archivist/shared';
import type { AppContext } from '../context';
import { AppError, validationError } from '../util/errors';
import { maskingOf, redactSecrets } from '../util/redact';
import { abortedError } from '../util/llm-errors';
import { MAX_RETRY_AFTER_MS } from '../util/retry-after';
import type { SecretService } from './secret';
import type { SettingsService } from './settings';
import { AnthropicAdapter, detectAdapter, type AdapterConfig } from '../agent/adapters';
import type { FetchLike } from '../agent/adapters/common';
import { EndpointHealth } from './llm/endpoint-health';
import { endpointUrl, postJson, type PostRequest, type PostResponse } from './llm/http';
import { outputLimitFor } from './llm/output-limits';
import { requestEmbeddings } from './llm/embeddings';
import { runConnectionTest, runStructuredTest } from './llm/connection-tests';
import { maskedInput, previewOf } from './llm/prompt-text';
import { ResponsesRunner } from './llm/responses-runner';
import { waitFor } from './llm/retry-wait';
import { structuredAnswer } from './llm/structured';
import { TokenLedger } from './llm/token-ledger';
import { TransmissionLog, type Transmission } from './llm/transmission-log';
import { UsageTally } from './llm/usage';

export type { FetchLike } from '../agent/adapters/common';
export type { LlmOverrides, LlmRequest } from './llm/request-types';
import type { LlmOverrides, LlmRequest } from './llm/request-types';

export { abortedError } from '../util/llm-errors';

/** Every LLM request inside `llmCancelScope.run(signal, …)` uses this signal unless it brings its own (also nested services). */
export const llmCancelScope = new AsyncLocalStorage<AbortSignal>();

interface Connection {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** A request after the privacy gate: input and instructions are cut and masked, ready to send. */
interface PreparedRequest {
  connection: Connection;
  request: LlmRequest;
  sent: string;
  instructions: string;
  redactions: number;
  personalRedactions: number;
  preview: string;
  signal?: AbortSignal;
}

/** One logged transmission: its attempts (retried while `maxAttempts` allows) share one log entry. */
interface Transfer {
  transmission: Omit<Transmission, 'success' | 'requests' | 'note' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>;
  signal?: AbortSignal;
  attempt: (tally: UsageTally) => Promise<string>;
  maxAttempts: (err: unknown) => number;
}

const isTimeout = (err: unknown) => err instanceof AppError && err.category === 'network_error' && /Zeitüberschreitung/.test(err.message);

/** A stored URL from an older version may still be plain http:// on a remote host: nothing is sent to it. */
function assertSecureBaseUrl(baseUrl: string): void {
  const check = checkLlmBaseUrl(baseUrl);
  if (!check.ok) throw validationError(check.message);
}

export type LlmServiceDeps = { ctx: AppContext; settings: SettingsService; secrets: SecretService; fetchImpl?: FetchLike; retryDelayMs?: number };

/** OpenAI-compatible Responses API client: every transmission is logged masked, structured answers are validated with Zod. */
export class LlmService {
  private readonly health: EndpointHealth;
  private readonly transmissions: TransmissionLog;
  private readonly ledger: TokenLedger;
  private readonly responses: ResponsesRunner;

  private readonly fetchImpl: FetchLike;
  private readonly retryDelayMs: number;

  constructor(private readonly deps: LlmServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));
    this.retryDelayMs = deps.retryDelayMs ?? 400;
    this.health = new EndpointHealth(deps.ctx);
    this.transmissions = new TransmissionLog(deps.ctx);
    this.ledger = new TokenLedger(deps.ctx, () => this.deps.settings.get().llm.dailyTokenCap ?? null);
    this.responses = new ResponsesRunner(
      (request) => this.post(request),
      (message, data) => deps.ctx.logger.warn('llm', message, data),
    );
  }

  status() {
    return this.health.status();
  }

  isConfigured(): boolean {
    const llm = this.deps.settings.get().llm;
    return Boolean(llm.baseUrl && llm.model && this.deps.secrets.getApiKey());
  }

  /** Configured AND allowed by the privacy mode (mode „nur lokal“ blocks every external transmission). */
  canUse(): boolean {
    return this.isConfigured() && this.deps.settings.get().privacy.llmMode !== 'local_only';
  }

  /** Background use nobody asked for (e.g. contradiction checks): only in „automatisch“, never in „vorher fragen“ (#201). */
  canUseInBackground(): boolean {
    return this.isConfigured() && this.deps.settings.get().privacy.llmMode === 'auto' && !this.ledger.capReached();
  }

  /** Token use today and this month and the state of the daily limit. */
  usage = (): LlmUsage => this.ledger.summary();

  /** Whether the daily token limit is reached (always false without a limit). */
  tokenCapReached = (): boolean => this.ledger.capReached();

  private connection(overrides: LlmOverrides): Connection {
    const llm = this.deps.settings.get().llm;
    const baseUrl = (overrides.baseUrl ?? llm.baseUrl).trim();
    const model = (overrides.model ?? llm.model).trim();
    const apiKey = overrides.apiKey ?? this.deps.secrets.getApiKey();
    if (!baseUrl || !model || !apiKey) throw new AppError('llm_error', 'Das LLM ist nicht konfiguriert (Base URL, Modell und API-Key erforderlich).');
    assertSecureBaseUrl(baseUrl);
    return { baseUrl, model, apiKey };
  }

  private post(request: PostRequest): Promise<PostResponse> {
    return postJson(this.fetchImpl, request);
  }

  /** Plain text answer via /responses. */
  async complete(request: LlmRequest, overrides: LlmOverrides = {}): Promise<string> {
    const llm = this.deps.settings.get().llm;
    const connection = this.connection(overrides);
    if (!request.bypassPrivacy && this.deps.settings.get().privacy.llmMode === 'local_only') {
      throw new AppError('permission_error', 'Der Datenschutzmodus „nur lokal“ verhindert externe LLM-Aufrufe.');
    }
    const signal = request.signal ?? llmCancelScope.getStore();
    if (signal?.aborted) throw abortedError();
    // the explicit connection test always goes through – it is how the user checks whether the endpoint is back
    if (!request.bypassPrivacy) {
      this.health.assertCircuitClosed();
      this.ledger.assertWithinCap();
    }
    const masking = maskingOf(this.deps.settings.get());
    const input = maskedInput(request, { maxInputChars: llm.maxInputChars, masking });
    const instructions = redactSecrets(request.instructions, masking);
    const prepared: PreparedRequest = {
      connection,
      request,
      sent: input.text,
      instructions: instructions.text,
      redactions: input.count + instructions.count,
      personalRedactions: input.personalData + instructions.personalData,
      preview: previewOf(request, { sent: input.text, masking }),
      signal,
    };
    if (this.adapterId(connection.baseUrl) === 'anthropic') return this.completeViaClaude(prepared);
    return this.completeViaResponses(prepared);
  }

  private transmissionOf(prepared: PreparedRequest, endpoint: string): Transfer['transmission'] {
    return {
      purpose: prepared.request.purpose,
      model: prepared.connection.model,
      endpoint,
      bytes: Buffer.byteLength(prepared.sent, 'utf8') + Buffer.byteLength(prepared.instructions, 'utf8'),
      redactions: prepared.redactions,
      personalRedactions: prepared.personalRedactions,
      documentIds: prepared.request.documentIds ?? [],
      preview: prepared.preview,
    };
  }

  /** Runs the attempts of one transfer, keeps the endpoint status and the circuit breaker, and logs the transmission with its tokens and requests. */
  private async transfer(transfer: Transfer): Promise<string> {
    let success = false;
    const tally = new UsageTally();
    try {
      const text = await this.withRetries(transfer, tally);
      success = true;
      this.health.markReachable();
      return text;
    } catch (err) {
      this.health.markFailed(err, transfer.signal);
      throw err;
    } finally {
      this.transmissions.record({ ...transfer.transmission, ...tally.columns(), success });
    }
  }

  private async withRetries(transfer: Transfer, tally: UsageTally): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await transfer.attempt(tally);
      } catch (err) {
        const retry = err instanceof AppError && err.retryable && attempt < transfer.maxAttempts(err) && !transfer.signal?.aborted;
        const wait = retry ? this.waitBeforeRetry(err, attempt) : null;
        if (wait === null) throw err;
        await waitFor(wait, transfer.signal);
      }
    }
  }

  /** The wait before the next attempt: what the endpoint asked for (Retry-After), else a backoff; null if it asks for more than we wait. */
  private waitBeforeRetry(err: AppError, attempt: number): number | null {
    const asked = err.retryAfterMs;
    if (asked === undefined) return this.retryDelayMs * attempt;
    return asked >= MAX_RETRY_AFTER_MS ? null : asked;
  }

  private completeViaResponses(prepared: PreparedRequest): Promise<string> {
    const { connection, request, signal } = prepared;
    const llm = this.deps.settings.get().llm;
    const call = this.responses.prepare({
      connection,
      instructions: prepared.instructions,
      input: prepared.sent,
      maxOutputTokens: request.maxOutputTokens,
      json: request.json,
      jsonSchema: request.jsonSchema,
      reasoningEffort: llm.reasoningEffort,
      timeoutMs: llm.timeoutMs,
      signal,
    });
    return this.transfer({
      transmission: this.transmissionOf(prepared, call.url),
      signal,
      // a hanging endpoint is asked at most twice (each attempt waits the full timeout), other transient errors three times
      maxAttempts: (err) => (isTimeout(err) ? 2 : 3),
      attempt: call.attempt,
    });
  }

  /** Adapter for the configured endpoint: base URL (or the choice under „Erweitert“) decides (#296). */
  adapterId(baseUrl = this.deps.settings.get().llm.baseUrl): AgentAdapterId {
    return detectAdapter(baseUrl, this.deps.settings.get().agent?.adapter ?? 'auto');
  }

  /** Connection data for the agent adapters; every transmission goes into the transmission log. */
  adapterConfig(overrides: LlmOverrides = {}): AdapterConfig {
    const { baseUrl, model, apiKey } = this.connection(overrides);
    return {
      baseUrl,
      model,
      apiKey,
      timeoutMs: Math.max(this.deps.settings.get().llm.timeoutMs, 120_000),
      fetchImpl: this.fetchImpl,
      log: (transmission) => {
        this.transmissions.record(transmission);
        if (transmission.success) this.health.markReachable();
      },
      warn: (message, data) => this.deps.ctx.logger.warn('llm', message, data),
    };
  }

  /** Delay between retries of agent requests (tests: 0). */
  get retryDelay(): number {
    return this.retryDelayMs;
  }

  /** Plain text via the Claude Messages API, with the same privacy gate, retries and transmission log as /responses. */
  private completeViaClaude(prepared: PreparedRequest): Promise<string> {
    const { connection, request, signal } = prepared;
    const config = this.adapterConfig(connection);
    const adapter = new AnthropicAdapter({ ...config, timeoutMs: this.deps.settings.get().llm.timeoutMs, log: () => undefined });
    return this.transfer({
      transmission: this.transmissionOf(prepared, `${connection.baseUrl} (Messages API)`),
      signal,
      maxAttempts: () => 3,
      attempt: async (tally) => {
        const maxOutputTokens = request.maxOutputTokens ?? 16_000;
        tally.countRequest();
        const { text, usage } = await adapter.completeText({ system: prepared.instructions, text: prepared.sent, maxOutputTokens, signal });
        tally.add(usage);
        if (!text.trim()) throw new AppError('llm_error', 'Das LLM lieferte eine leere Antwort.', { retryable: true });
        return text;
      },
    });
  }

  /** Output limit for a structured answer, only where reasoning tokens cannot eat it: Claude (no thinking) or an explicit thinking depth „none“. */
  private outputLimit(schemaName: string, overrides: LlmOverrides): number | undefined {
    const safe = this.adapterId(overrides.baseUrl) === 'anthropic' || this.deps.settings.get().llm.reasoningEffort === 'none';
    return safe ? outputLimitFor(schemaName) : undefined;
  }

  /** Structured answer validated with Zod: on invalid output exactly one correction request, then an error (nothing runs). */
  completeJson<T extends z.ZodType>(
    schema: T,
    request: Omit<LlmRequest, 'json' | 'jsonSchema' | 'appendix'> & { schemaName: string },
    overrides: LlmOverrides = {},
  ): Promise<z.output<T>> {
    const maxOutputTokens = request.maxOutputTokens ?? this.outputLimit(request.schemaName, overrides);
    return structuredAnswer(
      schema,
      { ...request, maxOutputTokens },
      {
        complete: (llmRequest) => this.complete(llmRequest, overrides),
        warn: (message, data) => this.deps.ctx.logger.warn('llm', message, data),
      },
    );
  }

  /** Embeddings via /embeddings (only if an embedding model is configured). */
  async embeddings(texts: string[], { purpose, documentIds = [] }: { purpose: string; documentIds?: string[] }): Promise<number[][]> {
    const llm = this.deps.settings.get().llm;
    const apiKey = this.deps.secrets.getApiKey();
    if (!llm.baseUrl || !llm.embeddingModel || !apiKey) throw new AppError('llm_error', 'Kein Embedding-Modell konfiguriert.');
    assertSecureBaseUrl(llm.baseUrl);
    return requestEmbeddings(
      {
        url: endpointUrl(llm.baseUrl, 'embeddings'),
        apiKey,
        model: llm.embeddingModel,
        timeoutMs: llm.timeoutMs,
        texts,
        purpose,
        documentIds,
        masking: maskingOf(this.deps.settings.get()),
      },
      {
        post: (request) => this.post(request),
        record: (transmission) => this.transmissions.record(transmission),
        assertWithinCap: () => this.ledger.assertWithinCap(),
      },
    );
  }

  testConnection(overrides: LlmOverrides = {}): Promise<LlmTestResult> {
    return runConnectionTest((request) => this.complete(request, overrides));
  }

  testStructuredAnswer(overrides: LlmOverrides): Promise<{ ok: boolean; message: string }> {
    return runStructuredTest((schema, request) => this.completeJson(schema, request, overrides));
  }

  listTransmissions(limit = 100, offset = 0): LlmTransmission[] {
    return this.transmissions.list({ limit, offset });
  }

  /** Deletes transmission log entries past the retention period; returns how many. */
  pruneTransmissions(now = new Date()): number {
    return this.transmissions.prune(now);
  }
}
