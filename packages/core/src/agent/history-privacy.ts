import type { AgentMessage } from './types';

const DOC_REF_RE = /\bD\d{1,5}\b/g;

export const WITHHELD_RESULT = 'Ergebnis ausgeblendet: Es nannte Dokumente, die inzwischen nicht mehr für die Übertragung freigegeben sind.';
export const WITHHELD_TEXT = '[Antwort ausgeblendet: Sie nannte Dokumente, die inzwischen nicht mehr freigegeben sind.]';

const mentions = (text: string, withdrawn: ReadonlySet<string>) => [...text.matchAll(DOC_REF_RE)].some((m) => withdrawn.has(m[0]));

/** Replay filter (#202, #301): results and answers naming withdrawn documents are replaced, provider blocks dropped except the open newest. */
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
