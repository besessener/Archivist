import { z } from 'zod';
import { AppError } from '../../util/errors';
import { correctionNote, issuesText, parseJsonAnswer, schemaText, structuredInstructions } from './prompt-text';
import type { StrictSchema } from './responses';
import { toStrictJsonSchema } from './strict-schema';

interface StructuredRequest {
  instructions: string;
  input: string;
  purpose: string;
  schemaName: string;
  documentIds?: string[];
  bypassPrivacy?: boolean;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

interface CompletionRequest extends StructuredRequest {
  json: true;
  jsonSchema: StrictSchema | null;
  schemaText: string;
  appendix?: string;
}

/** `text.format` name: letters, digits, `_` and `-`, at most 64 characters. */
const formatName = (schemaName: string) => schemaName.replace(/[^\w-]/g, '_').slice(0, 64);

/** Asks for an answer in the shape of `schema` (Structured Outputs, else JSON mode), validated with Zod; one correction request on invalid output. */
export async function structuredAnswer<T extends z.ZodType>(
  schema: T,
  request: StructuredRequest,
  deps: {
    complete: (request: CompletionRequest) => Promise<string>;
    warn: (message: string, data: Record<string, unknown>) => void;
    malformed: (error: AppError, signal?: AbortSignal) => void;
  },
): Promise<z.output<T>> {
  const instructions = structuredInstructions(request);
  const schemaHint = schemaText(JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })));
  const strict = toStrictJsonSchema(schema);
  const jsonSchema = strict && { name: formatName(request.schemaName), schema: strict };
  let lastIssues = '';
  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const appendix = attempt === 0 ? undefined : correctionNote(lastIssues);
    lastRaw = await deps.complete({ ...request, instructions, json: true, jsonSchema, schemaText: schemaHint, appendix });
    const parsed = parseJsonAnswer(lastRaw);
    if (!parsed.ok) lastIssues = 'kein gültiges JSON';
    else {
      const result = schema.safeParse(parsed.value);
      if (result.success) return result.data;
      lastIssues = issuesText(result.error);
    }
    deps.warn('Invalid structured LLM output', { schema: request.schemaName, issues: lastIssues, attempt });
  }
  const error = new AppError('llm_error', 'Die LLM-Antwort entsprach nicht dem erwarteten Format und wurde verworfen.', {
    details: `${request.schemaName}: ${lastIssues}; Auszug: ${lastRaw.slice(0, 160)}`,
  });
  deps.malformed(error, request.signal);
  throw error;
}
