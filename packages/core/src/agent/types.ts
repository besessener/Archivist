import type { AgentAdapterId, AgentEffort, AgentUsage } from '@archivist/shared';

export interface AgentToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface AgentToolResult {
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

/** Provider-neutral history (#295, #297); `raw` keeps the provider's own blocks, replayed only to the same provider and model. */
export type AgentMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      text: string;
      toolCalls: AgentToolCall[];
      provider: AgentAdapterId;
      model: string;
      raw?: unknown;
    }
  /** Results for all tool calls of the preceding assistant message; `note` is an operator hint after them (e.g. a limit was reached). */
  | { role: 'tool'; results: AgentToolResult[]; note?: string };

/** Tool definition as the adapters send it (JSON Schema of the arguments). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause';

export interface TurnRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  effort: AgentEffort;
  /** Remaining token budget of the run; adapters that can tell the model (Claude task budget) pass it on. */
  taskBudget?: number | null;
  purpose: string;
  /** Documents whose metadata or content are part of this request (transmission log, #301). */
  documentIds: string[];
  /** Secrets masked in this request's content so far (transmission log). */
  redactions?: number;
  /** Of `redactions`: personal data. */
  personalRedactions?: number;
  /** Offer the provider's own web search (server-side tool); only in chat runs. */
  webSearch?: boolean;
  /** Groups requests that share a prefix for the provider's prompt cache (OpenAI `prompt_cache_key`): the conversation, else the run. */
  cacheKey?: string;
  signal?: AbortSignal;
}

/** A web page the provider's web search found or the answer cites. */
export interface WebSource {
  url: string;
  title: string;
}

/** What the provider's web search did during one turn (searches run on the provider's side, not as agent tools). */
export interface WebSearchActivity {
  /** Search queries in order; an empty string for a search whose query is unknown. */
  queries: string[];
  /** Pages cited in the answer, else the pages found – without duplicates. */
  sources: WebSource[];
}

export interface TurnResult {
  text: string;
  toolCalls: AgentToolCall[];
  raw: unknown;
  stopReason: StopReason;
  usage: Pick<AgentUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>;
  /** Set when the model declined (stop reason `refusal`). */
  refusal?: { category: string | null; explanation: string | null };
  /** true if the answer arrived as a stream (connection test). */
  streamed: boolean;
  /** Set when the provider searched the web in this turn. */
  web?: WebSearchActivity;
}

export type StreamEvent = { type: 'text'; delta: string };

/** Connection to a model provider; one instance per request configuration. */
export interface ProviderAdapter {
  readonly id: AgentAdapterId;
  readonly model: string;
  turn(req: TurnRequest, onEvent?: (e: StreamEvent) => void): Promise<TurnResult>;
}
