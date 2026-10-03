import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { AgentAdapterId, AppErrorInfo, LlmTestResult, LlmTransmission } from '@archivist/shared';
import type { AppContext } from '../context';
import { AppError, toErrorInfo } from '../util/errors';
import { redactSecrets } from '../util/redact';
import { abortedError, mapHttpError } from '../util/llm-errors';
import type { SecretService } from './secret';
import type { SettingsService } from './settings';
import { AnthropicAdapter, detectAdapter, type AdapterConfig } from '../agent/adapters';
import type { FetchLike } from '../agent/adapters/common';
import { EndpointHealth } from './llm/endpoint-health';
import { endpointUrl, postJson, type PostRequest } from './llm/http';
import { isUnsupportedParamError, paramsToDrop, presentParams, withoutParams, type OptionalParam } from './llm/optional-params';
import { correctionInput, issuesText, parseJsonAnswer, preparedInput, structuredInstructions } from './llm/prompt-text';
import { responsesRequestBody, responsesText } from './llm/responses';
import { TransmissionLog, type Transmission } from './llm/transmission-log';

export type { FetchLike } from '../agent/adapters/common';

export interface LlmRequest {
  instructions: string;
  input: string;
  purpose: string;
  documentIds?: string[];
  json?: boolean;
  /** only for the explicit connection test (sends fixed text only) */
  bypassPrivacy?: boolean;
  maxOutputTokens?: number;
  /** Cancellation by the user: the running request is ended and not retried. */
  signal?: AbortSignal;
}

export { abortedError } from '../util/llm-errors';

/** Every LLM request inside `llmCancelScope.run(signal, …)` uses this signal unless it brings its own (also nested services). */
export const llmCancelScope = new AsyncLocalStorage<AbortSignal>();

export interface LlmOverrides {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

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
  signal?: AbortSignal;
}

/** One logged transmission: its attempts (retried while `maxAttempts` allows) share one log entry. */
interface Transfer {
  transmission: Omit<Transmission, 'success'>;
  signal?: AbortSignal;
  attempt: () => Promise<string>;
  maxAttempts: (err: unknown) => number;
}

const isTimeout = (err: unknown) => err instanceof AppError && err.category === 'network_error' && /Zeitüberschreitung/.test(err.message);

export type LlmServiceDeps = { ctx: AppContext; settings: SettingsService; secrets: SecretService; fetchImpl?: FetchLike; retryDelayMs?: number };

/** OpenAI-compatible Responses API client: every transmission is logged masked, structured answers are validated with Zod. */
export class LlmService {
  /** Optional parameters an endpoint (base URL + model) has rejected; kept in memory so they are not re-learned every call. */
  private readonly rejectedParams = new Map<string, Set<OptionalParam>>();

  private readonly health: EndpointHealth;
  private readonly transmissions: TransmissionLog;

  private readonly ctx: AppContext;
  private readonly settings: SettingsService;
  private readonly secrets: SecretService;
  private readonly fetchImpl: FetchLike;
  private readonly retryDelayMs: number;

  constructor(deps: LlmServiceDeps) {
    ({
      ctx: this.ctx,
      settings: this.settings,
      secrets: this.secrets,
      fetchImpl: this.fetchImpl = (...args) => fetch(...args),
      retryDelayMs: this.retryDelayMs = 400,
    } = deps);
    const { ctx } = deps;
    this.health = new EndpointHealth(ctx);
    this.transmissions = new TransmissionLog(ctx);
  }

  status() {
    return this.health.status();
  }

  isConfigured(): boolean {
    const llm = this.settings.get().llm;
    return Boolean(llm.baseUrl && llm.model && this.secrets.getApiKey());
  }

  /** Configured AND allowed by the privacy mode (mode „nur lokal“ blocks every external transmission). */
  canUse(): boolean {
    return this.isConfigured() && this.settings.get().privacy.llmMode !== 'local_only';
  }

  /** Background use nobody asked for (e.g. contradiction checks): only in „automatisch“, never in „vorher fragen“ (#201). */
  canUseInBackground(): boolean {
    return this.isConfigured() && this.settings.get().privacy.llmMode === 'auto';
  }

  private connection(overrides: LlmOverrides): Connection {
    const llm = this.settings.get().llm;
    const baseUrl = (overrides.baseUrl ?? llm.baseUrl).trim();
    const model = (overrides.model ?? llm.model).trim();
    const apiKey = overrides.apiKey ?? this.secrets.getApiKey();
    if (!baseUrl || !model || !apiKey) throw new AppError('llm_error', 'Das LLM ist nicht konfiguriert (Base URL, Modell und API-Key erforderlich).');
    return { baseUrl, model, apiKey };
  }

  private post(request: PostRequest): Promise<{ status: number; text: string }> {
    return postJson(this.fetchImpl, request);
  }

  /** Plain text answer via /responses. */
  async complete(request: LlmRequest, overrides: LlmOverrides = {}): Promise<string> {
    const llm = this.settings.get().llm;
    const connection = this.connection(overrides);
    if (!request.bypassPrivacy && this.settings.get().privacy.llmMode === 'local_only') {
      throw new AppError('permission_error', 'Der Datenschutzmodus „nur lokal“ verhindert externe LLM-Aufrufe.');
    }
    const signal = request.signal ?? llmCancelScope.getStore();
    if (signal?.aborted) throw abortedError();
    // the explicit connection test always goes through – it is how the user checks whether the endpoint is back
    if (!request.bypassPrivacy) this.health.assertCircuitClosed();
    const input = redactSecrets(preparedInput(request, llm.maxInputChars));
    const instructions = redactSecrets(request.instructions);
    const prepared: PreparedRequest = {
      connection,
      request,
      sent: input.text,
      instructions: instructions.text,
      redactions: input.count + instructions.count,
      signal,
    };
    if (this.adapterId(connection.baseUrl) === 'anthropic') return this.completeViaClaude(prepared);
    return this.completeViaResponses(prepared);
  }

  private transmissionOf(prepared: PreparedRequest, endpoint: string): Omit<Transmission, 'success'> {
    return {
      purpose: prepared.request.purpose,
      model: prepared.connection.model,
      endpoint,
      bytes: Buffer.byteLength(prepared.sent, 'utf8') + Buffer.byteLength(prepared.instructions, 'utf8'),
      redactions: prepared.redactions,
      documentIds: prepared.request.documentIds ?? [],
      preview: prepared.sent.slice(0, 280),
    };
  }

  /** Runs the attempts of one transfer, keeps the endpoint status and the circuit breaker, and logs the transmission. */
  private async transfer(transfer: Transfer): Promise<string> {
    let success = false;
    try {
      const text = await this.withRetries(transfer);
      success = true;
      this.health.markReachable();
      return text;
    } catch (err) {
      this.health.markFailed(err, transfer.signal);
      throw err;
    } finally {
      this.transmissions.record({ ...transfer.transmission, success });
    }
  }

  private async withRetries(transfer: Transfer): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await transfer.attempt();
      } catch (err) {
        const retry = err instanceof AppError && err.retryable && attempt < transfer.maxAttempts(err) && !transfer.signal?.aborted;
        if (!retry) throw err;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
      }
    }
  }

  private completeViaResponses(prepared: PreparedRequest): Promise<string> {
    const llm = this.settings.get().llm;
    const { connection, request, signal } = prepared;
    const body = responsesRequestBody({
      model: connection.model,
      instructions: prepared.instructions,
      input: prepared.sent,
      maxOutputTokens: request.maxOutputTokens,
      reasoningEffort: llm.reasoningEffort,
      json: request.json,
    });
    const url = endpointUrl(connection.baseUrl, 'responses');
    const endpointKey = `${url}\n${connection.model}`;
    const rejected = this.rejectedParams.get(endpointKey) ?? new Set<OptionalParam>();
    const post = () => this.post({ url, apiKey: connection.apiKey, body: withoutParams(body, rejected), timeoutMs: llm.timeoutMs, signal });
    return this.transfer({
      transmission: this.transmissionOf(prepared, url),
      signal,
      // a hanging endpoint is asked at most twice (each attempt waits the full timeout), other transient errors three times
      maxAttempts: (err) => (isTimeout(err) ? 2 : 3),
      attempt: async () => {
        let response = await post();
        // some compatible endpoints do not know optional parameters → retry without exactly the ones the error names
        while (response.status === 400 && isUnsupportedParamError(response.text)) {
          const drop = paramsToDrop(response.text, presentParams(body, rejected));
          if (drop.length === 0) break;
          for (const param of drop) rejected.add(param);
          this.rejectedParams.set(endpointKey, rejected);
          this.ctx.logger.warn('llm', 'Endpoint rejected optional parameters – retrying without them', { params: drop });
          response = await post();
        }
        return responsesText(response);
      },
    });
  }

  /** Adapter for the configured endpoint: base URL (or the choice under „Erweitert“) decides (#296). */
  adapterId(baseUrl = this.settings.get().llm.baseUrl): AgentAdapterId {
    return detectAdapter(baseUrl, this.settings.get().agent?.adapter ?? 'auto');
  }

  /** Connection data for the agent adapters; every transmission goes into the transmission log. */
  adapterConfig(overrides: LlmOverrides = {}): AdapterConfig {
    const { baseUrl, model, apiKey } = this.connection(overrides);
    return {
      baseUrl,
      model,
      apiKey,
      timeoutMs: Math.max(this.settings.get().llm.timeoutMs, 120_000),
      fetchImpl: this.fetchImpl,
      log: (transmission) => {
        this.transmissions.record(transmission);
        if (transmission.success) this.health.markReachable();
      },
      warn: (message, data) => this.ctx.logger.warn('llm', message, data),
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
    const adapter = new AnthropicAdapter({ ...config, timeoutMs: this.settings.get().llm.timeoutMs, log: () => undefined });
    return this.transfer({
      transmission: this.transmissionOf(prepared, `${connection.baseUrl} (Messages API)`),
      signal,
      maxAttempts: () => 3,
      attempt: async () => {
        const maxOutputTokens = request.maxOutputTokens ?? 16_000;
        const text = await adapter.completeText({ system: prepared.instructions, text: prepared.sent, maxOutputTokens, signal });
        if (!text.trim()) throw new AppError('llm_error', 'Das LLM lieferte eine leere Antwort.', { retryable: true });
        return text;
      },
    });
  }

  /** Structured answer validated with Zod: on invalid output exactly one correction request, then an error (nothing runs). */
  async completeJson<T extends z.ZodType>(schema: T, request: Omit<LlmRequest, 'json'> & { schemaName: string }): Promise<z.output<T>> {
    const jsonSchema = JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
    const instructions = structuredInstructions(request, jsonSchema);
    let lastIssues = '';
    let lastRaw = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const input = attempt === 0 ? request.input : correctionInput(request.input, lastIssues);
      const raw = await this.complete({ ...request, instructions, input, json: true });
      lastRaw = raw;
      const parsed = parseJsonAnswer(raw);
      if (!parsed.ok) lastIssues = 'kein gültiges JSON';
      else {
        const result = schema.safeParse(parsed.value);
        if (result.success) return result.data;
        lastIssues = issuesText(result.error);
      }
      this.ctx.logger.warn('llm', 'Invalid structured LLM output', { schema: request.schemaName, issues: lastIssues, attempt });
    }
    throw new AppError('llm_error', 'Die LLM-Antwort entsprach nicht dem erwarteten Format und wurde verworfen.', {
      details: `${request.schemaName}: ${lastIssues}; Auszug: ${lastRaw.slice(0, 160)}`,
    });
  }

  /** Embeddings via /embeddings (only if an embedding model is configured). */
  async embeddings(texts: string[], { purpose, documentIds = [] }: { purpose: string; documentIds?: string[] }): Promise<number[][]> {
    const llm = this.settings.get().llm;
    const apiKey = this.secrets.getApiKey();
    if (!llm.baseUrl || !llm.embeddingModel || !apiKey) throw new AppError('llm_error', 'Kein Embedding-Modell konfiguriert.');
    const redacted = texts.map((text) => redactSecrets(text.slice(0, 8000)));
    const url = endpointUrl(llm.baseUrl, 'embeddings');
    let success = false;
    try {
      const response = await this.post({
        url,
        apiKey,
        body: { model: llm.embeddingModel, input: redacted.map((entry) => entry.text) },
        timeoutMs: llm.timeoutMs,
      });
      if (response.status >= 400) throw mapHttpError(response.status, response.text);
      const embeddingsSchema = z.object({ data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().optional() })) });
      const parsed = embeddingsSchema.safeParse(JSON.parse(response.text));
      if (!parsed.success || parsed.data.data.length !== texts.length) throw new AppError('llm_error', 'Unerwartete Embedding-Antwort.');
      success = true;
      return parsed.data.data.map((entry) => entry.embedding);
    } finally {
      this.transmissions.record({
        purpose,
        model: llm.embeddingModel,
        endpoint: url,
        bytes: redacted.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0),
        redactions: redacted.reduce((sum, entry) => sum + entry.count, 0),
        documentIds,
        preview: redacted[0]?.text.slice(0, 200) ?? '',
        success,
      });
    }
  }

  async testConnection(overrides: LlmOverrides = {}): Promise<LlmTestResult> {
    const started = Date.now();
    try {
      const reply = await this.complete(
        {
          instructions: 'Du bist ein Verbindungstest. Antworte mit genau einem Wort.',
          input: 'Antworte mit dem Wort: OK',
          purpose: 'Verbindungstest',
          maxOutputTokens: 64,
          bypassPrivacy: true,
        },
        overrides,
      );
      return { ok: true, latencyMs: Date.now() - started, message: 'Verbindung erfolgreich.', modelReply: reply.trim().slice(0, 80), error: null };
    } catch (err) {
      const info: AppErrorInfo = toErrorInfo(err);
      return { ok: false, latencyMs: null, message: info.message, modelReply: null, error: info };
    }
  }

  listTransmissions(limit = 100): LlmTransmission[] {
    return this.transmissions.list(limit);
  }
}
