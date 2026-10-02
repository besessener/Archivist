import { z } from 'zod';
import type { AgentMode, ToolRisk } from '@archivist/shared';
import type { ToolSpec } from './types';

/**
 * Short ids the model sees instead of real ids: D1 … for documents, K1 … for other entries (decisions, open items,
 * notes, events, topics, persons …), S1 … for result sets that stand for ALL hits of a query (#303). They live per
 * conversation, so a follow-up („verschieb die auch“) can still refer to them.
 */
export interface RefState {
  ids: Record<string, string>;
  sets: Record<string, string[]>;
}

/** Agent state of a conversation, stored with the conversation (refs survive follow-ups, the mode override too). */
export interface AgentChatState {
  refs?: RefState;
  /** Mode for this conversation only („frag mich diesmal vorher“); null = setting. */
  mode?: AgentMode | null;
  /** The request the agent asked a question about; it continues with the answer. */
  task?: string | null;
}

export class RefStore {
  private readonly byId = new Map<string, string>();

  constructor(readonly state: RefState = { ids: {}, sets: {} }) {
    for (const [ref, id] of Object.entries(state.ids)) this.byId.set(`${ref[0]}:${id}`, ref);
  }

  private next(prefix: string): string {
    let n = Object.keys(this.state.ids).filter((k) => k.startsWith(prefix)).length + 1;
    while (this.state.ids[`${prefix}${n}`]) n += 1;
    return `${prefix}${n}`;
  }

  /** D-ref of a document. */
  doc(id: string): string {
    return this.ref('D', id);
  }

  /** K-ref of any other entry. */
  entry(id: string): string {
    return this.ref('K', id);
  }

  private ref(prefix: 'D' | 'K', id: string): string {
    const known = this.byId.get(`${prefix}:${id}`);
    if (known) return known;
    const ref = this.next(prefix);
    this.state.ids[ref] = id;
    this.byId.set(`${prefix}:${id}`, ref);
    return ref;
  }

  set(ids: string[]): string {
    let n = Object.keys(this.state.sets).length + 1;
    while (this.state.sets[`S${n}`]) n += 1;
    const ref = `S${n}`;
    this.state.sets[ref] = [...new Set(ids)];
    return ref;
  }

  /** One ref (D1, K2) → real id; real ids pass through unchanged when `allowRaw` (e.g. ids from search results). */
  resolve(ref: string): string | null {
    const key = ref.trim().toUpperCase();
    return this.state.ids[key] ?? null;
  }

  /** D/K/S refs → real ids, in order, without duplicates; unknown refs are collected in `unknown`. */
  resolveMany(refs: readonly string[]): { ids: string[]; unknown: string[] } {
    const out = new Set<string>();
    const unknown: string[] = [];
    for (const r of refs) {
      const key = r.trim().toUpperCase();
      const set = this.state.sets[key];
      if (set) for (const id of set) out.add(id);
      else if (this.state.ids[key]) out.add(this.state.ids[key]);
      else unknown.push(r);
    }
    return { ids: [...out], unknown };
  }
}

/** Collected while a run executes; read by the runner and the run log. */
export interface ToolContext {
  runId: string;
  conversationId: string | null;
  trigger: 'chat' | 'background';
  /** effective mode of this run (conversation override or setting) */
  mode: AgentMode;
  refs: RefStore;
  /** Documents whose metadata or content went to the LLM in this run (transmission log, #301). */
  shared: Set<string>;
  signal: AbortSignal;
  /** The user's message that started (or continued) the run; empty in background runs. */
  userText: string;
  /** Answer to the previous question of the agent (ask_user), if the run continues after one. */
  lastAnswer: string | null;
  /** Files produced by the run (exports, reports). */
  files: string[];
  /** Learned rules, workflows and memory entries applied in this run (#315). */
  applied: Array<{ id: string; kind: string; label: string }>;
  /** Visible notes about changes for the final summary („3 Dateien nach presentations verschoben“). */
  changes: string[];
  /** Proposal cards created by tools along the way (e.g. „ältere Entscheidung als überholt markieren?“). */
  actionIds: string[];
  /** Number of entries changed so far in this run (mass action threshold, #298). */
  changedCount: number;
  /** Set when a tool result contained text that looks like an instruction to the agent (#301). */
  tainted: string | null;
  /** The background job the run is part of: longer steps report their progress to it instead of starting jobs of their own (#304). */
  job?: { report: (progress: number, message: string) => void } | null;
}

export interface ToolOutput {
  /** Text for the model (data, never instructions). */
  content: string;
  /** Short result in plain language for the live view („14 gefunden“). */
  summary?: string;
  isError?: boolean;
  /** Visible change for the final summary. */
  change?: string;
  /** Number of entries changed (mass actions). */
  changed?: number;
}

export interface AgentTool<A = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  /** read: changes nothing; write: changes the archive (logged, undoable); critical: always asks (#298). */
  risk: ToolRisk | ((args: A) => ToolRisk);
  /** Plain-language label of a call („Suche pptx-Dateien“). */
  label: (args: A) => string;
  /** How many entries a call would change (mass action threshold); default 1 for write tools. */
  count?: (args: A, ctx: ToolContext) => number;
  /** Learning tools may only store what the user explicitly asked for (#315). */
  requiresUserInstruction?: boolean;
  run: (args: A, ctx: ToolContext) => Promise<ToolOutput>;
}

export const riskOf = <A>(tool: AgentTool<A>, args: A): ToolRisk => (typeof tool.risk === 'function' ? tool.risk(args) : tool.risk);

/** Typed helper so that `run` sees the parsed argument type. */
export function defineTool<S extends z.ZodType>(tool: Omit<AgentTool<z.output<S>>, 'schema'> & { schema: S }): AgentTool<unknown> {
  return tool as unknown as AgentTool<unknown>;
}

/** Register of all agent tools (#295). Every tool calls the same service function as the user interface. */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool<unknown>>();

  register(...tools: AgentTool<unknown>[]): this {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`Tool registered twice: ${t.name}`);
      this.tools.set(t.name, t);
    }
    return this;
  }

  get(name: string): AgentTool<unknown> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Stable, sorted tool list (prompt caching: the list must not change between requests). */
  specs(filter?: (t: AgentTool<unknown>) => boolean): ToolSpec[] {
    return [...this.tools.values()]
      .filter((t) => !filter || filter(t))
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: jsonSchema(t.schema) }));
  }
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const s = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete s.$schema;
  if (s.type !== 'object') return { type: 'object', properties: {}, additionalProperties: true };
  return s;
}

/** Zod issues as a short text the model can correct itself with. */
export function describeIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 6)
    .map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`)
    .join('; ');
}

// ---------- shared argument helpers ----------
/** A list given as array or as comma/space separated text. */
export const list = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(/[,\s]+/)).map((s) => s.trim()).filter(Boolean));
export const optText = z
  .string()
  .nullish()
  .transform((v) => v?.trim() || null);
