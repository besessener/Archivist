import { z } from 'zod';
import type { AppErrorInfo, LlmTestResult, LlmTransmission } from '@archivist/shared';
import { desc } from 'drizzle-orm';
import type { AppContext } from '../context';
import { llmTransmissions } from '../db/schema';
import { AppError, toErrorInfo } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { redactSecrets } from '../util/redact';
import type { SecretService } from './secret';
import type { SettingsService } from './settings';

export type FetchLike = typeof fetch;

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

const abortedError = () => new AppError('llm_error', 'Die LLM-Anfrage wurde abgebrochen.');

export interface LlmOverrides {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

interface ResponsesBody {
  output_text?: string;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
}

/**
 * Unambiguous messages about unknown or unsupported parameters: the message must name a parameter
 * AND call it unsupported/unknown. General format errors (e.g. "invalid input format")
 * do not trigger a fallback request but surface as errors.
 */
const UNSUPPORTED_PARAM_PATTERNS = [
  // "Unsupported parameter: 'store'", "Unknown parameter", "Unrecognized request argument supplied: reasoning"
  /\b(?:unsupported|unknown|unrecognized)\s+(?:request\s+)?(?:parameter|argument|field)s?\b/i,
  // "'text.format' is not supported", "reasoning.effort is unsupported"
  /['"`]?\b(?:store|reasoning(?:\.effort)?|text(?:\.format)?|max_output_tokens)\b['"`]?\s+(?:is|are)\s+(?:not\s+supported|unsupported|not\s+recognized|unknown)\b/i,
  // "does not support the 'reasoning' parameter"
  /\bdoes\s+not\s+support\b[^.\n]{0,80}\b(?:parameters?|arguments?|store|reasoning|text\.format|max_output_tokens)\b/i,
  // "Invalid parameter: 'text.format' of type 'json_object' is not supported with this model."
  /['"`]?\b(?:text\.format|response_format)\b['"`]?\s+of\s+type\s+['"`]?\w+['"`]?\s+is\s+not\s+supported\b/i,
];

function isUnsupportedParamError(text: string): boolean {
  return UNSUPPORTED_PARAM_PATTERNS.some((re) => re.test(text));
}

/** Optional request parameters that a compatible endpoint may reject. */
type OptionalParam = 'store' | 'reasoning' | 'text' | 'max_output_tokens';
const OPTIONAL_PARAMS: OptionalParam[] = ['store', 'reasoning', 'text', 'max_output_tokens'];

const PARAM_MENTIONS: Record<OptionalParam, RegExp> = {
  store: /\bstore\b/i,
  reasoning: /\breasoning\b/i,
  text: /\btext\.format\b|\bresponse_format\b|\bjson_object\b|['"`]text['"`]/i,
  max_output_tokens: /\bmax_output_tokens\b/i,
};

/** The optional parameters an "unsupported parameter" error names explicitly. */
function namedParams(text: string): OptionalParam[] {
  return OPTIONAL_PARAMS.filter((p) => PARAM_MENTIONS[p].test(text));
}

/**
 * JSON mode (text.format = json_object) of the Responses API requires the word "json" in the input –
 * the instructions do not count. Without it the endpoint rejects the request with HTTP 400.
 */
const JSON_INPUT_HINT = 'Antworte als JSON.\n\n';

/**
 * OpenAI-compatible client for the Responses API (typed fetch client).
 * - Model, base URL, timeout and reasoning effort are configurable.
 * - Every transmission is logged (masked, truncated) → transparency for the user.
 * - Structured outputs are validated with Zod; invalid outputs never trigger actions.
 */
export class LlmService {
  /**
   * Optional parameters an endpoint (base URL + model) has rejected; later requests leave them out
   * right away instead of re-learning it on every call. Kept in memory only.
   */
  private readonly rejectedParams = new Map<string, Set<OptionalParam>>();

  private lastStatus: { state: 'unknown' | 'ok' | 'error'; lastError: string | null; lastCheckedAt: string | null } = {
    state: 'unknown',
    lastError: null,
    lastCheckedAt: null,
  };

  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly secrets: SecretService,
    private readonly fetchImpl: FetchLike = (...args) => fetch(...args),
    private readonly retryDelayMs = 400,
  ) {}

  status() {
    return { ...this.lastStatus };
  }

  isConfigured(): boolean {
    const s = this.settings.get().llm;
    return Boolean(s.baseUrl && s.model && this.secrets.getApiKey());
  }

  /** Configured AND allowed by the privacy mode (mode „nur lokal“ blocks every external transmission). */
  canUse(): boolean {
    return this.isConfigured() && this.settings.get().privacy.llmMode !== 'local_only';
  }

  private markStatus(ok: boolean, error: string | null): void {
    this.lastStatus = { state: ok ? 'ok' : 'error', lastError: error, lastCheckedAt: nowIso() };
    this.ctx.events.emit('status:changed');
  }

  private endpoint(baseUrl: string, pathPart: string): string {
    // eslint-disable-next-line sonarjs/super-linear-regex -- base URL or a single model answer, length is bounded
    return `${baseUrl.replace(/\/+$/, '')}/${pathPart}`;
  }

  private mapHttpError(status: number, body: string): AppError {
    const snippet = body.replace(/\s+/g, ' ').slice(0, 300);
    if (status === 401 || status === 403)
      return new AppError('llm_error', 'Der LLM-Endpunkt hat die Anmeldung abgelehnt (API-Key prüfen).', { details: `HTTP ${status}: ${snippet}` });
    if (status === 404)
      return new AppError('llm_error', 'Endpunkt oder Modell wurde nicht gefunden (Base URL und Modellname prüfen).', { details: `HTTP 404: ${snippet}` });
    if (status === 429) return new AppError('llm_error', 'Das LLM-Limit wurde erreicht. Bitte später erneut versuchen.', { retryable: true, details: snippet });
    if (status >= 500)
      return new AppError('llm_error', 'Der LLM-Endpunkt meldet einen Serverfehler.', { retryable: true, details: `HTTP ${status}: ${snippet}` });
    return new AppError('llm_error', 'Der LLM-Endpunkt hat die Anfrage abgelehnt.', { details: `HTTP ${status}: ${snippet}` });
  }

  private async post(url: string, apiKey: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; text: string }> {
    if (signal?.aborted) throw abortedError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      if (signal?.aborted) throw abortedError();
      if (controller.signal.aborted)
        throw new AppError('network_error', `Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s – der LLM-Endpunkt antwortet nicht.`, {
          retryable: true,
        });
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new AppError('network_error', 'Der LLM-Endpunkt ist nicht erreichbar (Netzwerk oder Base URL prüfen).', {
        retryable: true,
        details: `${(err as Error).message}${cause?.code ? ` (${cause.code})` : ''}`,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private extractText(body: ResponsesBody): string {
    if (typeof body.output_text === 'string') return body.output_text;
    const parts: string[] = [];
    for (const item of body.output ?? []) {
      if (item.type && item.type !== 'message') continue;
      for (const c of item.content ?? []) if (typeof c.text === 'string' && (!c.type || c.type === 'output_text' || c.type === 'text')) parts.push(c.text);
    }
    return parts.join('');
  }

  /** Plain text answer via /responses. */
  async complete(req: LlmRequest, overrides: LlmOverrides = {}): Promise<string> {
    const cfg = this.settings.get().llm;
    const baseUrl = (overrides.baseUrl ?? cfg.baseUrl).trim();
    const model = (overrides.model ?? cfg.model).trim();
    const apiKey = overrides.apiKey ?? this.secrets.getApiKey();
    if (!baseUrl || !model || !apiKey) {
      throw new AppError('llm_error', 'Das LLM ist nicht konfiguriert (Base URL, Modell und API-Key erforderlich).');
    }
    if (!req.bypassPrivacy && this.settings.get().privacy.llmMode === 'local_only') {
      throw new AppError('permission_error', 'Der Datenschutzmodus „nur lokal“ verhindert externe LLM-Aufrufe.');
    }
    if (req.signal?.aborted) throw abortedError();

    let input = req.input;
    if (input.length > cfg.maxInputChars) input = `${input.slice(0, cfg.maxInputChars)}\n[… Eingabe auf ${cfg.maxInputChars} Zeichen gekürzt]`;
    if (req.json && !/json/i.test(input)) input = `${JSON_INPUT_HINT}${input}`;
    const redacted = redactSecrets(input);
    const redactedInstr = redactSecrets(req.instructions);
    const sent = redacted.text;

    const full: Record<string, unknown> = {
      model,
      instructions: redactedInstr.text,
      input: sent,
      store: false,
      ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
      ...(cfg.reasoningEffort && cfg.reasoningEffort !== 'none' ? { reasoning: { effort: cfg.reasoningEffort } } : {}),
      ...(req.json ? { text: { format: { type: 'json_object' } } } : {}),
    };
    const url = this.endpoint(baseUrl, 'responses');
    const endpointKey = `${url}\n${model}`;
    const rejected = this.rejectedParams.get(endpointKey) ?? new Set<OptionalParam>();
    const without = (params: Set<OptionalParam>) => Object.fromEntries(Object.entries(full).filter(([k]) => !params.has(k as OptionalParam)));
    const bytes = Buffer.byteLength(sent, 'utf8') + Buffer.byteLength(redactedInstr.text, 'utf8');
    let success = false;
    try {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          let res = await this.post(url, apiKey, without(rejected), cfg.timeoutMs, req.signal);
          // Some compatible endpoints do not know optional parameters → retry without exactly the one the error names.
          // store:false is only dropped when the endpoint rejects `store` itself (#150).
          while (res.status === 400 && isUnsupportedParamError(res.text)) {
            const present = OPTIONAL_PARAMS.filter((p) => p in full && !rejected.has(p));
            const named = namedParams(res.text).filter((p) => present.includes(p));
            const drop = named.length > 0 ? named : present.filter((p) => p !== 'store');
            if (drop.length === 0) break;
            for (const p of drop) rejected.add(p);
            this.rejectedParams.set(endpointKey, rejected);
            this.ctx.logger.warn('llm', 'Endpoint rejected optional parameters – retrying without them', { params: drop });
            res = await this.post(url, apiKey, without(rejected), cfg.timeoutMs, req.signal);
          }
          if (res.status >= 400) throw this.mapHttpError(res.status, res.text);
          let parsed: ResponsesBody;
          try {
            parsed = JSON.parse(res.text) as ResponsesBody;
          } catch {
            throw new AppError('llm_error', 'Der LLM-Endpunkt lieferte keine gültige JSON-Antwort.', { details: res.text.slice(0, 200) });
          }
          if (parsed.error?.message) throw new AppError('llm_error', 'Der LLM-Endpunkt meldet einen Fehler.', { details: parsed.error.message });
          const text = this.extractText(parsed);
          if (!text.trim()) {
            throw new AppError(
              'llm_error',
              parsed.status === 'incomplete'
                ? `Die LLM-Antwort ist unvollständig (${parsed.incomplete_details?.reason ?? 'unbekannt'}).`
                : 'Das LLM lieferte eine leere Antwort.',
              { retryable: true },
            );
          }
          success = true;
          this.markStatus(true, null);
          return text;
        } catch (err) {
          if (err instanceof AppError && err.retryable && attempt < 3 && !req.signal?.aborted) {
            await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      // a cancellation by the user says nothing about the state of the endpoint
      if (!req.signal?.aborted) this.markStatus(false, toErrorInfo(err).message);
      throw err;
    } finally {
      this.recordTransmission({
        purpose: req.purpose,
        model,
        endpoint: url,
        bytes,
        redactions: redacted.count + redactedInstr.count,
        documentIds: req.documentIds ?? [],
        preview: sent.slice(0, 280),
        success,
      });
    }
  }

  /**
   * Structured answer: the prompt contains the JSON schema, the answer is validated with Zod.
   * On invalid output exactly one correction request; after that an error (nothing is executed).
   */
  async completeJson<T extends z.ZodType>(
    schema: T,
    req: Omit<LlmRequest, 'json'> & { schemaName: string },
    overrides: LlmOverrides = {},
  ): Promise<z.output<T>> {
    const jsonSchema = JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
    const instructions = `${req.instructions}\n\nAntworte AUSSCHLIESSLICH mit einem einzigen gültigen JSON-Objekt (kein Markdown, kein Fließtext), das dem folgenden JSON-Schema „${req.schemaName}“ entspricht. Unbekannte Werte als null angeben; keine Informationen erfinden.\nJSON-Schema: ${jsonSchema}`;
    let lastIssues = '';
    let lastRaw = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const input =
        attempt === 0
          ? req.input
          : `${req.input}\n\n---\nDeine vorige Antwort war ungültig (${lastIssues}). Antworte erneut ausschließlich mit gültigem JSON gemäß Schema.`;
      const raw = await this.complete({ ...req, instructions, input, json: true }, overrides);
      lastRaw = raw;
      const parsed = this.parseJson(raw);
      const result = parsed.ok ? schema.safeParse(parsed.value) : null;
      if (result?.success) return result.data;
      lastIssues = parsed.ok
        ? (result as z.ZodSafeParseError<unknown>).error.issues
            .slice(0, 6)
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')
        : 'kein gültiges JSON';
      this.ctx.logger.warn('llm', 'Invalid structured LLM output', { schema: req.schemaName, issues: lastIssues, attempt });
    }
    throw new AppError('llm_error', 'Die LLM-Antwort entsprach nicht dem erwarteten Format und wurde verworfen.', {
      details: `${req.schemaName}: ${lastIssues}; Auszug: ${lastRaw.slice(0, 160)}`,
    });
  }

  private parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
    let text = raw.trim();
    // eslint-disable-next-line sonarjs/super-linear-regex -- base URL or a single model answer, length is bounded
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fence?.[1]) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
    } catch {
      return { ok: false };
    }
  }

  /** Embeddings via /embeddings (only if an embedding model is configured). */
  async embeddings(texts: string[], purpose: string, documentIds: string[] = []): Promise<number[][]> {
    const cfg = this.settings.get().llm;
    const apiKey = this.secrets.getApiKey();
    if (!cfg.baseUrl || !cfg.embeddingModel || !apiKey) throw new AppError('llm_error', 'Kein Embedding-Modell konfiguriert.');
    const redacted = texts.map((t) => redactSecrets(t.slice(0, 8000)));
    const url = this.endpoint(cfg.baseUrl, 'embeddings');
    let success = false;
    try {
      const res = await this.post(url, apiKey, { model: cfg.embeddingModel, input: redacted.map((r) => r.text) }, cfg.timeoutMs);
      if (res.status >= 400) throw this.mapHttpError(res.status, res.text);
      const parsed = z.object({ data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().optional() })) }).safeParse(JSON.parse(res.text));
      if (!parsed.success || parsed.data.data.length !== texts.length) throw new AppError('llm_error', 'Unerwartete Embedding-Antwort.');
      success = true;
      return parsed.data.data.map((d) => d.embedding);
    } finally {
      this.recordTransmission({
        purpose,
        model: cfg.embeddingModel,
        endpoint: url,
        bytes: redacted.reduce((a, r) => a + Buffer.byteLength(r.text), 0),
        redactions: redacted.reduce((a, r) => a + r.count, 0),
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

  private recordTransmission(t: Omit<LlmTransmission, 'id' | 'at'>): void {
    try {
      this.ctx.database.db
        .insert(llmTransmissions)
        .values({ id: newId(), at: nowIso(), ...t })
        .run();
      this.ctx.logger.info('llm', 'LLM transmission', { purpose: t.purpose, model: t.model, bytes: t.bytes, redactions: t.redactions, success: t.success });
    } catch {
      /* logging must not make calls fail */
    }
  }

  listTransmissions(limit = 100): LlmTransmission[] {
    return this.ctx.database.db.select().from(llmTransmissions).orderBy(desc(llmTransmissions.at)).limit(limit).all();
  }
}
