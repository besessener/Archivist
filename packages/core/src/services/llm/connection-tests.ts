import { z } from 'zod';
import type { AppErrorInfo, LlmTestResult } from '@archivist/shared';
import { toErrorInfo } from '../../util/errors';

interface TestRequest {
  instructions: string;
  input: string;
  purpose: string;
  bypassPrivacy: true;
  maxOutputTokens?: number;
}

/** Plain request with a 64-token output limit; the answer is one word, so the limit costs nothing. */
export async function runConnectionTest(complete: (request: TestRequest) => Promise<string>): Promise<LlmTestResult> {
  const started = Date.now();
  try {
    const reply = await complete({
      instructions: 'Du bist ein Verbindungstest. Antworte mit genau einem Wort.',
      input: 'Antworte mit dem Wort: OK',
      purpose: 'Verbindungstest',
      maxOutputTokens: 64,
      bypassPrivacy: true,
    });
    return { ok: true, latencyMs: Date.now() - started, message: 'Verbindung erfolgreich.', modelReply: reply.trim().slice(0, 80), error: null };
  } catch (err) {
    const info: AppErrorInfo = toErrorInfo(err);
    return { ok: false, latencyMs: null, message: info.message, modelReply: null, error: info };
  }
}

/** Same path as every feature (completeJson); deliberately no output limit, so reasoning tokens cannot cut the answer short. */
export async function runStructuredTest(
  completeJson: (schema: z.ZodType<{ ok: boolean }>, request: TestRequest & { schemaName: string }) => Promise<unknown>,
): Promise<{ ok: boolean; message: string }> {
  try {
    await completeJson(z.object({ ok: z.boolean() }), {
      instructions: 'Du bist ein Verbindungstest. Antworte mit einem JSON-Objekt, bei dem ok true ist.',
      input: 'Antworte mit {"ok": true}.',
      purpose: 'Verbindungstest (strukturierte Antwort)',
      schemaName: 'ConnectionTest',
      bypassPrivacy: true,
    });
    return { ok: true, message: 'Strukturierte Antworten funktionieren.' };
  } catch (err) {
    return { ok: false, message: toErrorInfo(err).message };
  }
}
