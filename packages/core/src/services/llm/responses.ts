import { AppError } from '../../util/errors';
import { mapHttpError } from '../../util/llm-errors';

interface ResponsesBody {
  output_text?: string;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
}

/** Full request body for /responses; optional parameters may be left out later when the endpoint rejects them. */
export function responsesRequestBody(request: {
  model: string;
  instructions: string;
  input: string;
  maxOutputTokens?: number;
  reasoningEffort: string | null;
  json?: boolean;
}): Record<string, unknown> {
  const { model, instructions, input, maxOutputTokens, reasoningEffort, json } = request;
  return {
    model,
    instructions,
    input,
    store: false,
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    ...(reasoningEffort && reasoningEffort !== 'none' ? { reasoning: { effort: reasoningEffort } } : {}),
    ...(json ? { text: { format: { type: 'json_object' } } } : {}),
  };
}

const isOutputText = (part: { type?: string; text?: string }): part is { type?: string; text: string } =>
  typeof part.text === 'string' && (!part.type || part.type === 'output_text' || part.type === 'text');

function extractText(body: ResponsesBody): string {
  if (typeof body.output_text === 'string') return body.output_text;
  return (body.output ?? [])
    .filter((item) => !item.type || item.type === 'message')
    .flatMap((item) => (item.content ?? []).filter(isOutputText).map((part) => part.text))
    .join('');
}

function parseBody(text: string): ResponsesBody {
  try {
    return JSON.parse(text) as ResponsesBody;
  } catch {
    throw new AppError('llm_error', 'Der LLM-Endpunkt lieferte keine gültige JSON-Antwort.', { details: text.slice(0, 200) });
  }
}

/** Answer text of a /responses call; HTTP errors, invalid JSON, reported errors and empty answers throw. */
export function responsesText(response: { status: number; text: string }): string {
  if (response.status >= 400) throw mapHttpError(response.status, response.text);
  const parsed = parseBody(response.text);
  if (parsed.error?.message) throw new AppError('llm_error', 'Der LLM-Endpunkt meldet einen Fehler.', { details: parsed.error.message });
  const text = extractText(parsed);
  if (text.trim()) return text;
  throw new AppError(
    'llm_error',
    parsed.status === 'incomplete'
      ? `Die LLM-Antwort ist unvollständig (${parsed.incomplete_details?.reason ?? 'unbekannt'}).`
      : 'Das LLM lieferte eine leere Antwort.',
    { retryable: true },
  );
}
