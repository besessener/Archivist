import type Anthropic from '@anthropic-ai/sdk';
import type { AgentEffort, ReasoningEffort } from '@archivist/shared';
import { AppError } from '../../util/errors';
import type { TurnResult } from '../types';
import { claudeError } from './anthropic-errors';
import { withFeatureFallback } from './anthropic-features';
import type { AdapterConfig } from './common';

export interface ClaudeTextInput {
  system: string;
  /** The schema as text; appended to `system` only when `jsonSchema` cannot go out as the response format. */
  schemaText: string;
  jsonSchema: Record<string, unknown> | null;
  text: string;
  maxOutputTokens: number;
  effort: AgentEffort;
  signal?: AbortSignal;
}

export type ClaudeTextUsage = Pick<TurnResult['usage'], 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>;

/** Thinking depth of plain requests: the setting where Claude knows it, else `low` (current Claude models cannot switch thinking off). */
export function claudeTextEffort(setting: ReasoningEffort | null): AgentEffort {
  return setting === null || setting === 'none' || setting === 'minimal' ? 'low' : setting;
}

/** Request body: cached instructions, the thinking depth and, where accepted, the schema as enforced response format. */
export function claudeTextParams(model: string, input: ClaudeTextInput, off: Set<string>): Anthropic.MessageCreateParamsNonStreaming {
  const format = input.jsonSchema && !off.has('json_format') ? { type: 'json_schema' as const, schema: input.jsonSchema } : null;
  const outputConfig = { ...(off.has('effort') ? {} : { effort: input.effort }), ...(format ? { format } : {}) };
  return {
    model,
    max_tokens: input.maxOutputTokens,
    system: [{ type: 'text', text: format ? input.system : input.system + input.schemaText, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: input.text }],
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
  };
}

/** One plain Claude request (classification, summaries); rejected optional features are left out from then on. */
export async function completeClaudeText(
  call: { client: Anthropic; model: string; off: Set<string>; warn: AdapterConfig['warn'] },
  input: ClaudeTextInput,
): Promise<{ text: string; usage: ClaudeTextUsage }> {
  try {
    const message = await withFeatureFallback(call.off, {
      warn: call.warn,
      send: () => call.client.messages.create(claudeTextParams(call.model, input, call.off), { signal: input.signal }),
    });
    if (message.stop_reason === 'refusal') throw new AppError('llm_error', 'Claude hat die Anfrage abgelehnt.');
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const usage = message.usage;
    // the log has no column for cache writes: they count as input, like on an endpoint without a cache
    const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    return { text, usage: { inputTokens, outputTokens: usage.output_tokens ?? 0, cacheReadTokens: usage.cache_read_input_tokens ?? 0 } };
  } catch (err) {
    throw claudeError(err, input.signal);
  }
}
