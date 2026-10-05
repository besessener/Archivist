import type { AgentMessage } from '../types';
import { replayRaw } from './common';

/** Output item of the Responses API as far as the adapter reads it. */
export interface OutputItem {
  type?: string;
  id?: string;
  role?: string;
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> }>;
  encrypted_content?: string | null;
  summary?: unknown;
  /** web_search_call: what the search did (search / open_page / find_in_page). */
  action?: { type?: string; query?: string; queries?: string[]; url?: string; sources?: Array<{ type?: string; url?: string }> } | null;
}

type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>;

/** Provider-neutral history → Responses API input items; the latest compaction item stands for everything before it. */
export function toResponsesInput(messages: AgentMessage[], model: string): unknown[] {
  const items = messages.flatMap((message): unknown[] => {
    if (message.role === 'user') return [{ role: 'user', content: message.content }];
    if (message.role === 'tool') return toolOutputs(message);
    if (replayRaw(message, { provider: 'openai', model }) && Array.isArray(message.raw)) return (message.raw as OutputItem[]).flatMap(replayedItem);
    return assistantItems(message);
  });
  const compacted = items.findLastIndex((item) => (item as OutputItem).type === 'compaction');
  return compacted === -1 ? items : items.slice(compacted);
}

function toolOutputs(message: Extract<AgentMessage, { role: 'tool' }>): unknown[] {
  const items: unknown[] = message.results.map((r) => ({
    type: 'function_call_output',
    call_id: r.callId,
    output: r.isError ? `FEHLER: ${r.content}` : r.content,
  }));
  if (message.note) items.push({ role: 'user', content: message.note });
  return items;
}

/** Own output items go back unchanged (reasoning with encrypted content keeps the chain of thought with store:false). */
function replayedItem(item: OutputItem): unknown[] {
  // web search calls go back as they came (id, status, action) so the reasoning before them keeps its successor
  if (item.type === 'reasoning' || item.type === 'web_search_call' || item.type === 'compaction') return [item];
  if (item.type === 'function_call') return [{ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments }];
  if (item.type === 'message') return [{ role: 'assistant', content: textOf([item]) }];
  return [];
}

function assistantItems(message: AssistantMessage): unknown[] {
  const items: unknown[] = message.text.trim() ? [{ role: 'assistant', content: message.text }] : [];
  for (const c of message.toolCalls) items.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
  return items;
}

export function textOf(output: OutputItem[]): string {
  return output
    .filter((i) => i.type === 'message')
    .flatMap((i) => i.content ?? [])
    .filter((c) => c.type === 'output_text' || c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}
