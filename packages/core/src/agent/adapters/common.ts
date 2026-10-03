import type { LlmTransmission } from '@archivist/shared';
import type { AgentMessage } from '../types';

export type FetchLike = typeof fetch;

/** Everything an adapter needs from the LLM client: endpoint, credentials, transport and the transmission log. */
export interface AdapterConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
  /** Every transmission appears in the transmission log (#296, #301). */
  log: (t: Omit<LlmTransmission, 'id' | 'at'>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
}

const AZURE_HOST = /\.azure\.(com|us|cn)$/i;

/** Azure endpoints take the key as `api-key`, every other OpenAI-compatible endpoint as `Authorization: Bearer`; never both. */
export function authHeaders(url: string, apiKey: string): Record<string, string> {
  try {
    if (AZURE_HOST.test(new URL(url).hostname)) return { 'api-key': apiKey };
  } catch {
    // an unparsable URL never gets this far; Bearer is the safe default
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/** Last user text of a request (preview in the transmission log). */
export function previewOf(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'user') return m.content.slice(0, 280);
    if (m.role === 'tool' && m.results.length) return `[Werkzeugergebnis ${m.results[0]!.name}] ${m.results[0]!.content.slice(0, 240)}`;
  }
  return '';
}

/** Is this assistant message replayed with its own provider blocks (same provider and model)? */
export const replayRaw = (message: Extract<AgentMessage, { role: 'assistant' }>, target: { provider: string; model: string }): boolean =>
  message.provider === target.provider && message.model === target.model && message.raw !== undefined && message.raw !== null;

/** Feature switches an endpoint has rejected; kept in memory per endpoint and model so later requests leave them out. */
const rejected = new Map<string, Set<string>>();
export function rejectedFeatures(key: string): Set<string> {
  let set = rejected.get(key);
  if (!set) {
    set = new Set();
    rejected.set(key, set);
  }
  return set;
}

/** Only http(s) links are kept as web sources; duplicates (same URL) are dropped, the first title wins. */
export function uniqueSources(sources: Array<{ url?: string | null; title?: string | null }>): Array<{ url: string; title: string }> {
  const out = new Map<string, { url: string; title: string }>();
  for (const s of sources) {
    const url = s.url?.trim();
    if (!url || !/^https?:\/\//i.test(url) || out.has(url)) continue;
    out.set(url, { url, title: s.title?.trim() || url });
  }
  return [...out.values()];
}

/** IANA time zone of this machine for localized web search results; null if unknown. */
export function userTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.includes('/') ? tz : null;
  } catch {
    return null;
  }
}
