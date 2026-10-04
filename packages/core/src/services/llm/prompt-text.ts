import type { z } from 'zod';
import { redactSecrets, type RedactionOptions, type RedactionResult } from '../../util/redact';

/** JSON mode of the Responses API needs the word "json" in the input (instructions don't count), else HTTP 400. */
const JSON_INPUT_HINT = 'Antworte als JSON.\n\n';

/** Share of the limit kept from the end: the user's own message and the final instruction come last (#155). */
const TAIL_SHARE = 0.25;

/** The input masked first and then cut, so an identifier at the cut cannot escape its checksum rule; counts add up. */
export function maskedInput(
  request: { input: string; json?: boolean; appendix?: string },
  limits: { maxInputChars: number; masking: RedactionOptions },
): RedactionResult {
  const body = redactSecrets(request.input, limits.masking);
  const appendix = redactSecrets(request.appendix ?? '', limits.masking);
  const text = preparedInput({ input: body.text, json: request.json, appendix: appendix.text }, limits.maxInputChars);
  return {
    text,
    count: body.count + appendix.count,
    personalData: body.personalData + appendix.personalData,
    kinds: [...new Set([...body.kinds, ...appendix.kinds])],
  };
}

/** The input as sent: cut in the middle to `maxInputChars` (with a note), the appendix after it, and, in JSON mode, naming JSON. */
function preparedInput(request: { input: string; json?: boolean; appendix?: string }, maxInputChars: number): string {
  let input = request.input;
  if (input.length > maxInputChars) {
    const tail = Math.floor(maxInputChars * TAIL_SHARE);
    input = `${input.slice(0, maxInputChars - tail)}\n[… Eingabe auf ${maxInputChars} Zeichen gekürzt, der mittlere Teil fehlt …]\n${input.slice(input.length - tail)}`;
  }
  input += request.appendix ?? '';
  if (request.json && !/json/i.test(input)) input = `${JSON_INPUT_HINT}${input}`;
  return input;
}

/** Instructions for a structured answer: the caller's instructions plus the JSON schema the answer must follow. */
export function structuredInstructions(request: { instructions: string; schemaName: string }, jsonSchema: string): string {
  return `${request.instructions}\n\nAntworte AUSSCHLIESSLICH mit einem einzigen gültigen JSON-Objekt (kein Markdown, kein Fließtext), das dem folgenden JSON-Schema „${request.schemaName}“ entspricht. Unbekannte Werte als null angeben; keine Informationen erfinden.\nJSON-Schema: ${jsonSchema}`;
}

/** Note appended to the input of the single correction request after an invalid structured answer. */
export function correctionNote(issues: string): string {
  return `\n\n---\nDeine vorige Antwort war ungültig (${issues}). Antworte erneut ausschließlich mit gültigem JSON gemäß Schema.`;
}

export function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** The JSON object in a model answer (also inside a Markdown fence or surrounded by prose). */
export function parseJsonAnswer(raw: string): { ok: true; value: unknown } | { ok: false } {
  let text = raw.trim();
  // eslint-disable-next-line sonarjs/super-linear-regex -- a single model answer, length is bounded
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

const PREVIEW_CHARS = 280;
/** Lines of the standard prompt frame that say nothing about the content. */
const PROMPT_FRAME = /^(?:Antworte als JSON\.|Heutiges Datum: .*)$/gm;

/** What the transmission log shows: the caller's own summary of the request, else the sent text without the standard frame; masked, shortened. */
export function previewOf(request: { preview?: string }, context: { sent: string; masking: RedactionOptions }): string {
  const source = request.preview ?? context.sent.replace(PROMPT_FRAME, '');
  const text = redactSecrets(source, context.masking).text.replace(/\s+/g, ' ').trim();
  return text.slice(0, PREVIEW_CHARS);
}
