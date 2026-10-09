import type { AgentEffort } from '@archivist/shared';
import type { AnthropicAdapter } from '../../agent/adapters';
import { AppError } from '../../util/errors';
import type { ResponsesCall, ResponsesRunner } from './responses-runner';
import type { PreparedRequest, Transfer } from './transfer-types';

const isTimeout = (err: unknown) => err instanceof AppError && err.category === 'network_error' && /Zeitüberschreitung/.test(err.message);

function transmissionOf(prepared: PreparedRequest, endpoint: string): Transfer['transmission'] {
  return {
    purpose: prepared.request.purpose,
    model: prepared.connection.model,
    endpoint,
    // the schema text counts although an enforced response format leaves it out: the size is an upper bound
    bytes: Buffer.byteLength(prepared.sent + prepared.instructions + prepared.schemaText, 'utf8'),
    redactions: prepared.redactions,
    personalRedactions: prepared.personalRedactions,
    documentIds: prepared.request.documentIds ?? [],
    preview: prepared.preview,
  };
}

export interface ResponsesTransferOptions {
  runner: ResponsesRunner;
  llm: Pick<ResponsesCall, 'reasoningEffort' | 'timeoutMs'>;
}

/** Plain text via /responses. */
export function responsesTransfer(prepared: PreparedRequest, { runner, llm }: ResponsesTransferOptions): Transfer {
  const { connection, request, signal } = prepared;
  const call = runner.prepare({
    connection,
    instructions: prepared.instructions,
    schemaText: prepared.schemaText,
    input: prepared.sent,
    maxOutputTokens: request.maxOutputTokens,
    json: request.json,
    jsonSchema: request.jsonSchema,
    reasoningEffort: llm.reasoningEffort,
    timeoutMs: llm.timeoutMs,
    signal,
  });
  return {
    transmission: transmissionOf(prepared, call.url),
    source: connection.source,
    signal,
    // a hanging endpoint is asked at most twice (each attempt waits the full timeout), other transient errors three times
    maxAttempts: (err) => (isTimeout(err) ? 2 : 3),
    attempt: call.attempt,
  };
}

export interface ClaudeTransferOptions {
  adapter: Pick<AnthropicAdapter, 'completeText'>;
  effort: AgentEffort;
}

/** Plain text via the Claude Messages API, with the same privacy gate, retries and transmission log as /responses. */
export function claudeTransfer(prepared: PreparedRequest, { adapter, effort }: ClaudeTransferOptions): Transfer {
  const { connection, request, signal } = prepared;
  return {
    transmission: transmissionOf(prepared, `${connection.baseUrl} (Messages API)`),
    source: connection.source,
    signal,
    maxAttempts: () => 3,
    attempt: async (tally) => {
      const maxOutputTokens = request.maxOutputTokens ?? 16_000;
      tally.countRequest();
      const { text, usage } = await adapter.completeText({
        system: prepared.instructions,
        schemaText: prepared.schemaText,
        jsonSchema: request.jsonSchema?.schema ?? null,
        text: prepared.sent,
        maxOutputTokens,
        effort,
        signal,
      });
      tally.add(usage);
      if (!text.trim()) throw new AppError('llm_error', 'Das LLM lieferte eine leere Antwort.', { retryable: true });
      return text;
    },
  };
}
