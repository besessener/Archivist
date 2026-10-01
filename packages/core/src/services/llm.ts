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
  /** nur für den ausdrücklichen Verbindungstest (sendet ausschließlich festen Text) */
  bypassPrivacy?: boolean;
  maxOutputTokens?: number;
  /** Abbruch durch den Benutzer: laufende Anfrage wird beendet, es folgt keine Wiederholung. */
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
 * Eindeutige Meldungen zu unbekannten bzw. nicht unterstützten Parametern: Die Meldung muss einen Parameter
 * benennen UND ihn als nicht unterstützt/unbekannt bezeichnen. Allgemeine Formatfehler (z. B. „invalid input format“)
 * lösen keine Ersatzanfrage aus, sondern werden als Fehler sichtbar.
 */
const UNSUPPORTED_PARAM_PATTERNS = [
  // „Unsupported parameter: 'store'“, „Unknown parameter“, „Unrecognized request argument supplied: reasoning“
  /\b(?:unsupported|unknown|unrecognized)\s+(?:request\s+)?(?:parameter|argument|field)s?\b/i,
  // „'text.format' is not supported“, „reasoning.effort is unsupported“
  /['"`]?\b(?:store|reasoning(?:\.effort)?|text(?:\.format)?|max_output_tokens)\b['"`]?\s+(?:is|are)\s+(?:not\s+supported|unsupported|not\s+recognized|unknown)\b/i,
  // „does not support the 'reasoning' parameter“
  /\bdoes\s+not\s+support\b[^.\n]{0,80}\b(?:parameters?|arguments?|store|reasoning|text\.format|max_output_tokens)\b/i,
];

function isUnsupportedParamError(text: string): boolean {
  return UNSUPPORTED_PARAM_PATTERNS.some((re) => re.test(text));
}

/**
 * OpenAI-kompatibler Client für die Responses API (typisierter Fetch-Client).
 * - Modell, Base URL, Timeout und reasoning effort sind konfigurierbar.
 * - Jede Übertragung wird (maskiert, gekürzt) protokolliert → Transparenz für den Benutzer.
 * - Strukturierte Ausgaben werden mit Zod validiert; ungültige Ausgaben lösen nie Aktionen aus.
 */
export class LlmService {
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

  /** Konfiguriert UND vom Datenschutzmodus erlaubt (Modus „nur lokal“ sperrt jede externe Übertragung). */
  canUse(): boolean {
    return this.isConfigured() && this.settings.get().privacy.llmMode !== 'local_only';
  }

  private markStatus(ok: boolean, error: string | null): void {
    this.lastStatus = { state: ok ? 'ok' : 'error', lastError: error, lastCheckedAt: nowIso() };
    this.ctx.events.emit('status:changed');
  }

  private endpoint(baseUrl: string, pathPart: string): string {
    // eslint-disable-next-line sonarjs/super-linear-regex -- Base-URL bzw. einzelne Modellantwort, Länge begrenzt
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

  /** Einfache Textantwort über /responses. */
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
    const bytes = Buffer.byteLength(sent, 'utf8') + Buffer.byteLength(redactedInstr.text, 'utf8');
    let success = false;
    try {
      let attempt = 0;
      let body = full;
      for (;;) {
        attempt += 1;
        try {
          let res = await this.post(url, apiKey, body, cfg.timeoutMs, req.signal);
          if (res.status === 400 && body === full && isUnsupportedParamError(res.text)) {
            // manche kompatible Endpunkte kennen optionale Parameter nicht → ohne diese erneut versuchen
            const { store: _s, reasoning: _r, text: _t, max_output_tokens: _m, ...minimal } = full;
            void _s;
            void _r;
            void _t;
            void _m;
            body = minimal;
            res = await this.post(url, apiKey, body, cfg.timeoutMs, req.signal);
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
      // ein Abbruch durch den Benutzer sagt nichts über den Zustand des Endpunkts
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
   * Strukturierte Antwort: Prompt enthält das JSON-Schema, die Antwort wird mit Zod validiert.
   * Bei ungültiger Ausgabe genau eine Korrekturanfrage; danach Fehler (es wird nichts ausgeführt).
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
      this.ctx.logger.warn('llm', 'Ungültige strukturierte LLM-Ausgabe', { schema: req.schemaName, issues: lastIssues, attempt });
    }
    throw new AppError('llm_error', 'Die LLM-Antwort entsprach nicht dem erwarteten Format und wurde verworfen.', {
      details: `${req.schemaName}: ${lastIssues}; Auszug: ${lastRaw.slice(0, 160)}`,
    });
  }

  private parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
    let text = raw.trim();
    // eslint-disable-next-line sonarjs/super-linear-regex -- Base-URL bzw. einzelne Modellantwort, Länge begrenzt
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

  /** Embeddings über /embeddings (nur wenn ein Embedding-Modell konfiguriert ist). */
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
      this.ctx.logger.info('llm', 'LLM-Übertragung', { purpose: t.purpose, model: t.model, bytes: t.bytes, redactions: t.redactions, success: t.success });
    } catch {
      /* Protokollierung darf Aufrufe nicht scheitern lassen */
    }
  }

  listTransmissions(limit = 100): LlmTransmission[] {
    return this.ctx.database.db.select().from(llmTransmissions).orderBy(desc(llmTransmissions.at)).limit(limit).all();
  }
}
