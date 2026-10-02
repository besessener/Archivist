import type { AgentMessage } from './types';

const DOC_REF_RE = /\bD\d{1,5}\b/g;

export const WITHHELD_RESULT = 'Ergebnis ausgeblendet: Es nannte Dokumente, die inzwischen nicht mehr für die Übertragung freigegeben sind.';
export const WITHHELD_TEXT = '[Antwort ausgeblendet: Sie nannte Dokumente, die inzwischen nicht mehr freigegeben sind.]';

const mentions = (text: string, withdrawn: ReadonlySet<string>) => [...text.matchAll(DOC_REF_RE)].some((m) => withdrawn.has(m[0]));

/**
 * Earlier turns of a conversation are sent again with every request. A document excluded or locked after it was read
 * must not travel along in them (#202, #301): tool results and answers that name it are replaced before the replay.
 * Provider blocks (thinking, reasoning) can quote it without naming it, so they are all dropped – except for a newest
 * answer with open tool calls, which the provider needs unchanged to continue.
 */
export function withholdWithdrawn(history: readonly AgentMessage[], withdrawn: ReadonlySet<string>): AgentMessage[] {
  if (!withdrawn.size) return [...history];
  const lastAssistant = history.findLastIndex((m) => m.role === 'assistant');
  return history.map((m, i) => {
    if (m.role === 'tool') {
      if (!m.results.some((r) => mentions(r.content, withdrawn))) return m;
      return { ...m, results: m.results.map((r) => (mentions(r.content, withdrawn) ? { ...r, content: WITHHELD_RESULT } : r)) };
    }
    if (m.role !== 'assistant') return m;
    const text = mentions(m.text, withdrawn) ? WITHHELD_TEXT : m.text;
    if (i === lastAssistant && m.toolCalls.length) return { ...m, text };
    return { ...m, text, raw: undefined };
  });
}
