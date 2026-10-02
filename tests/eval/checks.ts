import type { AgentLimits, AgentMode, AgentRun, AgentRunStatus } from '@archivist/shared';
import type { Services } from '../../packages/core/src';
import type { EvalDoc } from './fixture';

/** Stories of Epic #294 the tasks belong to. */
export const STORIES = [
  '#295',
  '#296',
  '#297',
  '#298',
  '#299',
  '#300',
  '#301',
  '#302',
  '#303',
  '#304',
  '#305',
  '#306',
  '#307',
  '#308',
  '#309',
  '#310',
  '#311',
  '#312',
  '#313',
  '#314',
  '#315',
] as const;
export type Story = (typeof STORIES)[number];

/** One answer of the agent as the chat shows it. */
export interface Reply {
  content: string;
  status: AgentRunStatus | null;
  runId: string | null;
  actionIds: string[];
  quickReplies: string[];
}

/** A user message; a function decides on the follow-up from the previous answer (null = no further message). */
export type Message = string | ((prev: Reply) => string | null);

export interface SetupContext {
  services: Services;
  ids: Record<string, string>;
}

export interface EvalTask {
  id: string;
  story: Story;
  /** What is evaluated, in one line (German, shown in the report). */
  title: string;
  /** Chat messages, sent one after another into the same conversation. */
  messages?: Message[];
  /** Instead of chat: a background run of this kind (inbox: all inbox documents of the fixture). */
  background?: 'inbox' | 'archive_check' | 'links';
  mode?: AgentMode;
  agent?: { massActionThreshold?: number; chatLimits?: Partial<AgentLimits> };
  /** Additional documents (on top of the base archive) and setup steps, all without LLM. */
  fixture?: { docs?: EvalDoc[]; setup?: (s: SetupContext) => void | Promise<void> };
  check: (c: CheckContext) => CheckResult | Promise<CheckResult>;
}

export interface CheckResult {
  pass: boolean;
  reasons: string[];
}

// ---------- snapshot of the archive ----------
export interface DocState {
  archiveRelPath: string | null;
  status: string;
  title: string;
  topic: string | null;
  project: string | null;
  docType: string | null;
  documentDate: string | null;
  tags: string[];
  persons: string[];
  llmStatus: string;
}

export interface Snapshot {
  docs: Record<string, DocState>;
  reminders: Array<{ id: string; title: string; remindAt: string; targetId: string | null; status: string }>;
  openItems: Array<{ id: string; title: string; dueAt: string | null; status: string }>;
  decisions: Array<{ id: string; title: string; text: string }>;
  notes: Array<{ id: string; name: string; description: string }>;
  events: Array<{ id: string; title: string }>;
  cases: Array<{ id: string; name: string }>;
  memory: Array<{ id: string; kind: string; name: string; content: string; data: unknown; enabled: boolean }>;
  /** id|source|target|type|status of every relation touching a document or case */
  relations: string[];
  proposals: Array<{ id: string; actionType: string; status: string }>;
  settings: { massActionThreshold: number; mode: string; llmMode: string };
}

export function snapshot(services: Services): Snapshot {
  const docs: Record<string, DocState> = {};
  const all = services.documents.list({ limit: 50_000 });
  for (const d of all)
    docs[d.id] = {
      archiveRelPath: d.archiveRelPath,
      status: d.status,
      title: d.title,
      topic: d.topicName,
      project: d.projectName,
      docType: d.docType,
      documentDate: d.documentDate,
      tags: [...d.tags].toSorted(),
      persons: [...d.persons].toSorted(),
      llmStatus: d.llmStatus,
    };
  const cases = services.graph.listEntities({ type: 'case', limit: 1000 });
  const relations = new Set<string>();
  for (const id of [...all.map((d) => d.id), ...cases.map((c) => c.id)])
    for (const r of services.graph.relationsOf(id)) relations.add(`${r.id}|${r.sourceEntityId}|${r.targetEntityId}|${r.relationType}|${r.status}`);
  const s = services.settings.get();
  return {
    docs,
    reminders: services.reminders.list().map((r) => ({ id: r.id, title: r.title, remindAt: r.remindAt, targetId: r.targetId, status: r.status })),
    openItems: services.openItems.list().map((o) => ({ id: o.id, title: o.title, dueAt: o.dueAt, status: o.status })),
    decisions: services.decisions.list().map((d) => ({ id: d.id, title: d.title, text: d.decisionText })),
    notes: services.graph.listEntities({ type: 'note', limit: 1000 }).map((n) => ({ id: n.id, name: n.name, description: n.description ?? '' })),
    events: services.eventRecords.list().map((e) => ({ id: e.id, title: e.title })),
    cases: cases.map((c) => ({ id: c.id, name: c.name })),
    memory: services.memory.list().map((m) => ({ id: m.id, kind: m.kind, name: m.name, content: m.content, data: m.data, enabled: m.enabled })),
    relations: [...relations].toSorted(),
    proposals: services.actions.list().map((a) => ({ id: a.id, actionType: a.actionType, status: a.status })),
    settings: { massActionThreshold: s.agent.massActionThreshold, mode: s.agent.mode, llmMode: s.privacy.llmMode },
  };
}

// ---------- check context ----------
export interface CheckContext {
  services: Services;
  /** fixture key → document id */
  ids: Record<string, string>;
  before: Snapshot;
  after: Snapshot;
  replies: Reply[];
  runs: AgentRun[];
  /** All answers of the agent, joined. */
  answer: string;
  /** Files produced by the runs (exports, reports, drafts). */
  files: string[];
}

export type Expectation = [ok: boolean, reason: string];

/** Combines expectations; the reasons of the failed ones explain the verdict. */
export function verdict(...items: Expectation[]): CheckResult {
  const reasons = items.filter(([ok]) => !ok).map(([, r]) => r);
  return { pass: reasons.length === 0, reasons };
}

const DOC_FIELDS: Array<keyof DocState> = ['archiveRelPath', 'status', 'title', 'topic', 'project', 'docType', 'documentDate', 'tags', 'persons', 'llmStatus'];

/** Changed fields per document (by fixture key, or id for documents without a key). */
export function changedDocs(c: CheckContext, fields: Array<keyof DocState> = DOC_FIELDS): Record<string, string[]> {
  const keyOf = new Map(Object.entries(c.ids).map(([k, id]) => [id, k]));
  const out: Record<string, string[]> = {};
  const ids = new Set([...Object.keys(c.before.docs), ...Object.keys(c.after.docs)]);
  for (const id of ids) {
    const a = c.before.docs[id];
    const b = c.after.docs[id];
    const label = keyOf.get(id) ?? id;
    if (!a || !b) {
      out[label] = [a ? 'gelöscht' : 'neu'];
      continue;
    }
    const diff = fields.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
    if (diff.length) out[label] = diff;
  }
  return out;
}

const describeChanges = (changes: Record<string, string[]>) =>
  Object.entries(changes)
    .slice(0, 8)
    .map(([k, f]) => `${k} (${f.join(', ')})`)
    .join('; ');

/** Only these documents changed (and only in these fields, if given). */
export function onlyChanged(c: CheckContext, keys: string[], fields?: Array<keyof DocState>): Expectation {
  const all = changedDocs(c);
  const unexpected = Object.fromEntries(
    Object.entries(all)
      .map(([k, f]) => [k, keys.includes(k) && fields ? f.filter((x) => !(fields as string[]).includes(x)) : keys.includes(k) ? [] : f] as const)
      .filter(([, f]) => f.length),
  );
  return [Object.keys(unexpected).length === 0, `unerwartet geändert: ${describeChanges(unexpected)}`];
}

/** No document changed at all. */
export const archiveUnchanged = (c: CheckContext): Expectation => {
  const all = changedDocs(c);
  return [Object.keys(all).length === 0, `Archiv verändert: ${describeChanges(all)}`];
};

/** No new knowledge entries, reminders, memory or relations. */
export function nothingCreated(c: CheckContext): Expectation {
  const grown = (['reminders', 'openItems', 'decisions', 'notes', 'events', 'cases', 'memory', 'relations'] as const).filter(
    (k) => c.after[k].length > c.before[k].length,
  );
  return [grown.length === 0, `neu angelegt: ${grown.join(', ')}`];
}

/** Read-only task: neither documents nor entries changed. */
export const readOnly = (c: CheckContext): Expectation[] => [archiveUnchanged(c), nothingCreated(c)];

export function folderOf(c: CheckContext, key: string): string {
  const rel = c.after.docs[c.ids[key]!]?.archiveRelPath ?? '';
  return rel.split('/').slice(0, -1).join('/');
}

export const fileNameOf = (c: CheckContext, key: string): string => (c.after.docs[c.ids[key]!]?.archiveRelPath ?? '').split('/').at(-1) ?? '';
export const docAfter = (c: CheckContext, key: string): DocState => c.after.docs[c.ids[key]!]!;

export function inFolder(c: CheckContext, keys: string[], test: (folder: string) => boolean, wanted: string): Expectation {
  const wrong = keys.filter((k) => !test(folderOf(c, k)));
  return [wrong.length === 0, `nicht in ${wanted}: ${wrong.map((k) => `${k} (${folderOf(c, k) || 'Eingang'})`).join(', ')}`];
}

const norm = (s: string) => s.toLowerCase().replace(/\u00a0|\u202f/g, ' ');

/** The answer contains at least one of the alternatives (case-insensitive). */
export function mentions(c: CheckContext, alternatives: string[], what = alternatives[0]!): Expectation {
  const text = norm(c.answer);
  return [alternatives.some((a) => text.includes(norm(a))), `Antwort nennt nicht ${what}`];
}

/** The answer does NOT contain any of these. */
export function avoids(c: CheckContext, forbidden: string[], what: string): Expectation {
  const text = norm(c.answer);
  const hit = forbidden.find((f) => text.includes(norm(f)));
  return [!hit, `Antwort enthält ${what} („${hit}“)`];
}

export function lastStatus(c: CheckContext): AgentRunStatus | null {
  return c.replies.at(-1)?.status ?? null;
}

export const statusIs = (c: CheckContext, ...wanted: AgentRunStatus[]): Expectation => [
  wanted.includes(lastStatus(c) ?? 'error'),
  `Laufstatus ${lastStatus(c) ?? '–'} statt ${wanted.join('/')}`,
];

export const notFailed = (c: CheckContext): Expectation => {
  const bad = c.runs.find((r) => r.status === 'error' || r.status === 'refusal');
  return [!bad, `Lauf endete mit ${bad?.status}: ${bad?.error ?? ''}`];
};

export const askedUser = (c: CheckContext, replyIndex = 0): Expectation => [
  c.replies[replyIndex]?.status === 'ask_user',
  `keine Rückfrage (Status ${c.replies[replyIndex]?.status ?? '–'})`,
];

/** A new proposal card of the agent waits for confirmation. */
export function proposalPending(c: CheckContext): Expectation {
  const known = new Set(c.before.proposals.map((p) => p.id));
  const fresh = c.after.proposals.filter((p) => !known.has(p.id) && p.actionType === 'agent_batch' && p.status === 'proposed');
  return [fresh.length > 0, 'kein Vorschlag (Karte) zur Bestätigung angelegt'];
}

/** Some step of the runs used one of these tools successfully. */
export function usedTool(c: CheckContext, tools: string[], outcome: 'ok' | 'proposed' | 'any' = 'ok'): Expectation {
  const hit = c.runs.some((r) => r.steps.some((s) => tools.includes(s.tool) && (outcome === 'any' || s.outcome === outcome)));
  return [hit, `Werkzeug ${tools.join('/')} nicht ${outcome === 'proposed' ? 'als Vorschlag ' : ''}verwendet`];
}

/** New entries of a kind (compared with the snapshot before). */
export function created<K extends 'reminders' | 'openItems' | 'decisions' | 'notes' | 'events' | 'cases' | 'memory'>(c: CheckContext, kind: K): Snapshot[K] {
  const known = new Set(c.before[kind].map((x) => x.id));
  return c.after[kind].filter((x) => !known.has(x.id)) as Snapshot[K];
}

/** New relations as parsed tuples. */
export function newRelations(c: CheckContext): Array<{ source: string; target: string; type: string; status: string }> {
  const known = new Set(c.before.relations.map((r) => r.split('|')[0]));
  return c.after.relations
    .filter((r) => !known.has(r.split('|')[0]))
    .map((r) => {
      const [, source, target, type, status] = r.split('|');
      return { source: source!, target: target!, type: type!, status: status! };
    });
}

/** Money as German text: 2485.4 → ["2.485,40", "2485,40", "2,485.40", "2485.40"]. */
export function moneyForms(value: number): string[] {
  const [int, frac] = value.toFixed(2).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return [`${grouped},${frac}`, `${int},${frac}`, `${grouped.replaceAll('.', ',')}.${frac}`, `${int}.${frac}`];
}

/** The answer matches a pattern (e.g. a count as a whole word). */
export function matches(c: CheckContext, re: RegExp, what: string): Expectation {
  return [re.test(c.answer.replace(/\u00a0|\u202f/g, ' ')), `Antwort nennt nicht ${what}`];
}
