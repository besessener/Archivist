import {
  CorrectionDefinition,
  MemoryInput,
  RuleDefinition,
  WorkflowDefinition,
  type MemoryEntry,
  type MemoryKind,
  type RuleDefinition as Rule,
} from '@archivist/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { agentMemory } from '../db/schema';
import { AppError, validationError } from '../util/errors';
import type { ArchivistJson } from '../util/json';
import { newId, nowIso } from '../util/ids';
import { normalizeName, truncate } from '../util/text';

type Row = typeof agentMemory.$inferSelect;

/** After this many similar corrections the agent proposes a rule (#315). */
export const CORRECTIONS_FOR_RULE = 3;

const KIND_LABEL: Record<MemoryKind, string> = {
  rule: 'Regel',
  workflow: 'Ablauf',
  correction: 'Korrektur',
  preference: 'Vorliebe',
  fact: 'Wissen',
};

/** Kinds whose structured part is validated (and required). */
const DATA_SCHEMA: Partial<Record<MemoryKind, typeof RuleDefinition | typeof WorkflowDefinition | typeof CorrectionDefinition>> = {
  rule: RuleDefinition,
  workflow: WorkflowDefinition,
  correction: CorrectionDefinition,
};

/** Document fields a rule condition is matched against. */
export interface RuleSubject {
  title: string;
  originalName: string;
  ext: string;
  docType: string | null;
  topicName: string | null;
  persons: string[];
  /** Sender as far as known (first person or organisation of the document). */
  sender: string | null;
  text: string;
}

const has = (value: string | null | undefined, wanted: string | null | undefined) =>
  !wanted?.trim() || normalizeName(value ?? '').includes(normalizeName(wanted));

/** Does the rule's condition match the document? Every given condition must hold. */
export function ruleMatches(rule: Rule, subject: RuleSubject): boolean {
  const when = rule.when;
  return (
    has(subject.docType, when.docType) &&
    (!when.nameContains?.trim() || has(subject.title, when.nameContains) || has(subject.originalName, when.nameContains)) &&
    (!when.ext?.trim() || normalizeName(subject.ext) === normalizeName(when.ext.replace(/^\./, ''))) &&
    has(subject.topicName, when.topic) &&
    (!when.sender?.trim() ||
      has(subject.sender, when.sender) ||
      subject.persons.some((person) => has(person, when.sender)) ||
      has(subject.text.slice(0, 2_000), when.sender)) &&
    (!when.textContains?.trim() || has(subject.text, when.textContains))
  );
}

/** Learned rules, workflows, corrections, preferences and facts (#315): visible, switchable, deletable, never above limits. */
export class MemoryService {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.database.db;
  }

  private map(r: Row): MemoryEntry {
    return {
      id: r.id,
      kind: r.kind as MemoryKind,
      name: r.name,
      content: r.content,
      data: r.data,
      enabled: r.enabled,
      origin: r.origin as MemoryEntry['origin'],
      timesApplied: r.timesApplied,
      lastAppliedAt: r.lastAppliedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  /** Validates the structured part of an entry per kind. */
  private validData(kind: MemoryKind, data: unknown): unknown {
    if (data === undefined || data === null) {
      if (DATA_SCHEMA[kind]) throw validationError(`Eine ${KIND_LABEL[kind]} braucht ihre Angaben (data).`);
      return null;
    }
    const schema = DATA_SCHEMA[kind];
    if (!schema) return data;
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw validationError('Ungültige Angaben.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return parsed.data;
  }

  list(kind?: MemoryKind): MemoryEntry[] {
    return this.db
      .select()
      .from(agentMemory)
      .where(kind ? eq(agentMemory.kind, kind) : undefined)
      .orderBy(desc(agentMemory.updatedAt))
      .all()
      .map((r) => this.map(r));
  }

  get(id: string): MemoryEntry {
    const r = this.db.select().from(agentMemory).where(eq(agentMemory.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    return this.map(r);
  }

  /** A rule or workflow with the same name is updated instead of stored twice. */
  save(input: unknown, origin: MemoryEntry['origin'] = 'user'): MemoryEntry {
    const parsed = MemoryInput.parse(input);
    const data = this.validData(parsed.kind, parsed.data);
    const now = nowIso();
    const same =
      parsed.kind === 'correction'
        ? undefined
        : this.db
            .select()
            .from(agentMemory)
            .where(and(eq(agentMemory.kind, parsed.kind), eq(agentMemory.name, parsed.name)))
            .get();
    if (same) {
      this.db
        .update(agentMemory)
        .set({ content: parsed.content, data: data as ArchivistJson, enabled: parsed.enabled, updatedAt: now })
        .where(eq(agentMemory.id, same.id))
        .run();
      this.ctx.events.changed('agent');
      return this.get(same.id);
    }
    const id = newId();
    this.db
      .insert(agentMemory)
      .values({
        id,
        kind: parsed.kind,
        name: parsed.name,
        content: parsed.content,
        data: data as ArchivistJson,
        enabled: parsed.enabled,
        origin,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.ctx.events.changed('agent');
    return this.get(id);
  }

  update(id: string, patch: { name?: string; content?: string; data?: unknown; enabled?: boolean }): MemoryEntry {
    const current = this.get(id);
    const data = patch.data !== undefined ? this.validData(current.kind, patch.data) : current.data;
    this.db
      .update(agentMemory)
      .set({
        ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 200) } : {}),
        ...(patch.content?.trim() ? { content: patch.content.trim().slice(0, 4000) } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        data: data as ArchivistJson,
        updatedAt: nowIso(),
      })
      .where(eq(agentMemory.id, id))
      .run();
    this.ctx.events.changed('agent');
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    this.db.delete(agentMemory).where(eq(agentMemory.id, id)).run();
    this.ctx.events.changed('agent');
  }

  markApplied(ids: string[]): void {
    const now = nowIso();
    for (const id of new Set(ids)) {
      const row = this.db.select().from(agentMemory).where(eq(agentMemory.id, id)).get();
      if (row)
        this.db
          .update(agentMemory)
          .set({ timesApplied: row.timesApplied + 1, lastAppliedAt: now })
          .where(eq(agentMemory.id, id))
          .run();
    }
  }

  /** Enabled rules that match a document; contradicting ones (different folders) are reported, never decided by guessing. */
  matchingRules(subject: RuleSubject): { rules: Array<{ entry: MemoryEntry; rule: Rule }>; conflict: string | null } {
    const rules = this.list('rule')
      .filter((e) => e.enabled)
      .flatMap((entry) => {
        const parsed = RuleDefinition.safeParse(entry.data);
        return parsed.success && ruleMatches(parsed.data, subject) ? [{ entry, rule: parsed.data }] : [];
      });
    const folders = new Set(rules.map((r) => r.rule.then.folder?.trim()).filter(Boolean));
    const topics = new Set(rules.map((r) => r.rule.then.topic?.trim()).filter(Boolean));
    const names = () => rules.map((r) => `„${r.entry.name}“`).join(', ');
    if (folders.size > 1) return { rules, conflict: `Die Regeln ${names()} nennen verschiedene Ordner (${[...folders].join(', ')}).` };
    if (topics.size > 1) return { rules, conflict: `Die Regeln ${names()} nennen verschiedene Themen (${[...topics].join(', ')}).` };
    return { rules, conflict: null };
  }

  /** Stores a correction; returns how many corrections with the same key exist (rule proposal from CORRECTIONS_FOR_RULE). */
  recordCorrection(c: CorrectionDefinition): number {
    this.save(
      { kind: 'correction', name: truncate(`${c.did} → ${c.instead}`, 190), content: `Ich habe ${c.did}; richtig war: ${c.instead}.`, data: c },
      'correction',
    );
    return this.list('correction').filter((e) => (e.data as CorrectionDefinition | null)?.key === c.key).length;
  }

  /** Text for the system instructions: what Archivist has learned, by kind. Disabled entries are left out. */
  promptSection(): { text: string; used: MemoryEntry[] } {
    const used = this.list().filter((e) => e.enabled && e.kind !== 'correction');
    if (!used.length) return { text: '', used };
    const block = (kind: MemoryKind, title: string) => {
      const items = used.filter((e) => e.kind === kind);
      if (!items.length) return null;
      return `${title}:\n${items
        .slice(0, 60)
        .map(
          (e) =>
            `- [${e.id}] ${e.name}: ${truncate(e.content.replace(/\s+/g, ' '), 400)}${kind === 'workflow' ? ` Schritte: ${((e.data as { steps?: string[] } | null)?.steps ?? []).join(' → ')}` : ''}`,
        )
        .join('\n')}`;
    };
    const text = [
      'Was du gelernt hast (vom Benutzer bestätigt; nenne in der Antwort, was du davon angewendet hast, mit der ID in eckigen Klammern):',
      block('rule', 'Regeln'),
      block('workflow', 'Eigene Abläufe (starte sie mit run_workflow; vor dem ersten Lauf zeigst du den Plan)'),
      block('preference', 'Vorlieben'),
      block('fact', 'Wissen über den Benutzer und sein Umfeld'),
      'Gelerntes hebt nie Grenzen auf: Modus und Ausnahmen, Datenschutz und Budgets haben Vorrang.',
    ]
      .filter(Boolean)
      .join('\n\n');
    return { text, used };
  }
}
