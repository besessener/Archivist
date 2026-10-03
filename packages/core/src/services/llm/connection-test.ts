import { z } from 'zod';
import type { AppErrorInfo, LlmTestResult } from '@archivist/shared';
import { toErrorInfo } from '../../util/errors';

type Overrides = { baseUrl?: string; model?: string; apiKey?: string };
type TextRequest = { instructions: string; input: string; purpose: string; maxOutputTokens: number; bypassPrivacy: boolean };
type JsonRequest = { instructions: string; input: string; purpose: string; schemaName: string; bypassPrivacy: boolean };
type Complete = (request: TextRequest, overrides: Overrides) => Promise<string>;
type CompleteJson = (schema: z.ZodType<{ ok: boolean }>, request: JsonRequest, overrides: Overrides) => Promise<unknown>;

/** Plain text round trip with fixed text; goes through even in „nur lokal“ because the user asked for it. */
export async function runConnectionTest(complete: Complete, overrides: Overrides): Promise<LlmTestResult> {
  const started = Date.now();
  try {
    const reply = await complete(
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

/** Structured (JSON) answer with fixed text. */
export async function runStructuredTest(completeJson: CompleteJson, overrides: Overrides): Promise<{ ok: boolean; message: string }> {
  try {
    await completeJson(
      z.object({ ok: z.boolean() }),
      {
        instructions: 'Du bist ein Verbindungstest. Antworte mit einem JSON-Objekt, bei dem ok true ist.',
        input: 'Antworte mit {"ok": true}.',
        purpose: 'Verbindungstest (strukturierte Antwort)',
        schemaName: 'ConnectionTest',
        bypassPrivacy: true,
      },
      overrides,
    );
    return { ok: true, message: 'Strukturierte Antworten funktionieren.' };
  } catch (err) {
    return { ok: false, message: toErrorInfo(err).message };
  }
}
