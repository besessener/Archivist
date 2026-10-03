import { ASK_USER } from './ask-user';
import { NOT_RUN, errorResult } from './tool-executor';
import type { AgentMessage, AgentToolCall } from './types';

/** Upper bound for the history that goes to the model (characters of the serialized messages). */
const MAX_HISTORY_CHARS = 600_000;

/** Unanswered tool calls of the last assistant message (e.g. a question to the user). */
export function pendingCalls(history: AgentMessage[]): AgentToolCall[] {
  const lastAssistant = history.findLastIndex((m) => m.role === 'assistant');
  if (lastAssistant === -1) return [];
  const assistant = history[lastAssistant] as Extract<AgentMessage, { role: 'assistant' }>;
  const answered = new Set(history.slice(lastAssistant + 1).flatMap((m) => (m.role === 'tool' ? m.results.map((r) => r.callId) : [])));
  return assistant.toolCalls.filter((c) => !answered.has(c.id));
}

/** The newest part of the history that fits; always starts with a user message (never in the middle of tool results). */
export function historyWindow(history: AgentMessage[], maxChars = MAX_HISTORY_CHARS): AgentMessage[] {
  let size = 0;
  let start = history.length;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    size += JSON.stringify(history[i]).length;
    if (size > maxChars) break;
    start = i;
  }
  while (start < history.length && history[start]!.role !== 'user') start += 1;
  if (start < history.length) return history.slice(start);
  // the request alone exceeds the window: start at its user message, as tool results without their calls are rejected
  const lastUser = history.findLastIndex((m) => m.role === 'user');
  return lastUser === -1 ? history.slice(-1) : history.slice(lastUser);
}

/** The user's (masked) message as the next turn; the answer to an open question becomes its tool result (#295). */
export function userTurn(pending: AgentToolCall[], masked: string): { messages: AgentMessage[]; answersQuestion: boolean } {
  if (!pending.length) return { messages: [{ role: 'user', content: masked }], answersQuestion: false };
  const answersQuestion = pending.some((c) => c.name === ASK_USER);
  const results = pending.map((c) =>
    c.name === ASK_USER ? { callId: c.id, name: c.name, content: `Antwort des Benutzers: ${masked}`, isError: false } : errorResult(c, NOT_RUN),
  );
  const messages: AgentMessage[] = [{ role: 'tool', results }];
  if (!answersQuestion) messages.push({ role: 'user', content: masked });
  return { messages, answersQuestion };
}
