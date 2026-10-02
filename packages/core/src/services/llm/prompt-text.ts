import type { z } from 'zod';

/** JSON mode of the Responses API needs the word "json" in the input (instructions don't count), else HTTP 400. */
const JSON_INPUT_HINT = 'Antworte als JSON.\n\n';

/** The input as sent: cut to `maxInputChars` (with a note) and, in JSON mode, naming JSON. */
export function preparedInput(request: { input: string; json?: boolean }, maxInputChars: number): string {
  let input = request.input;
  if (input.length > maxInputChars) input = `${input.slice(0, maxInputChars)}\n[… Eingabe auf ${maxInputChars} Zeichen gekürzt]`;
  if (request.json && !/json/i.test(input)) input = `${JSON_INPUT_HINT}${input}`;
  return input;
}

/** Instructions for a structured answer: the caller's instructions plus the JSON schema the answer must follow. */
export function structuredInstructions(request: { instructions: string; schemaName: string }, jsonSchema: string): string {
  return `${request.instructions}\n\nAntworte AUSSCHLIESSLICH mit einem einzigen gültigen JSON-Objekt (kein Markdown, kein Fließtext), das dem folgenden JSON-Schema „${request.schemaName}“ entspricht. Unbekannte Werte als null angeben; keine Informationen erfinden.\nJSON-Schema: ${jsonSchema}`;
}

/** Input of the single correction request after an invalid structured answer. */
export function correctionInput(input: string, issues: string): string {
  return `${input}\n\n---\nDeine vorige Antwort war ungültig (${issues}). Antworte erneut ausschließlich mit gültigem JSON gemäß Schema.`;
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
