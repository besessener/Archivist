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
export function ruleMatches(rule: Rule, d: RuleSubject): boolean {
  const w = rule.when;
  return (
    has(d.docType, w.docType) &&
    (!w.nameContains?.trim() || has(d.title, w.nameContains) || has(d.originalName, w.nameContains)) &&
    (!w.ext?.trim() || normalizeName(d.ext) === normalizeName(w.ext.replace(/^\./, ''))) &&
    has(d.topicName, w.topic) &&
    (!w.sender?.trim() || has(d.sender, w.sender) || d.persons.some((p) => has(p, w.sender)) || has(d.text.slice(0, 2_000), w.sender)) &&
    (!w.textContains?.trim() || has(d.text, w.textContains))
  );
}

/**
 * „Lernen heißt Speichern, nicht Trainieren“ (#315): rules, own workflows, corrections, preferences and knowledge about the
 * user are stored here and given to every run. Everything is visible, editable, can be switched off and deleted. Learned
 * content can never lift limits: mode and exceptions, privacy and budgets take precedence.
 */
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
      if (kind === 'rule' || kind === 'workflow' || kind === 'correction') throw validationError(`Eine ${KIND_LABEL[kind]} braucht ihre Angaben (data).`);
      return null;
    }
    const schema = kind === 'rule' ? RuleDefinition : kind === 'workflow' ? WorkflowDefinition : kind === 'correction' ? CorrectionDefinition : null;
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
    const i = MemoryInput.parse(input);
    const data = this.validData(i.kind, i.data);
    const now = nowIso();
    const same =
      i.kind === 'correction'
        ? undefined
        : this.db
            .select()
            .from(agentMemory)
            .where(and(eq(agentMemory.kind, i.kind), eq(agentMemory.name, i.name)))
            .get();
    if (same) {
      this.db
        .update(agentMemory)
        .set({ content: i.content, data: data as ArchivistJson, enabled: i.enabled, updatedAt: now })
        .where(eq(agentMemory.id, same.id))
        .run();
      this.ctx.events.changed('agent');
      return this.get(same.id);
    }
    const id = newId();
    this.db
      .insert(agentMemory)
      .values({ id, kind: i.kind, name: i.name, content: i.content, data: data as ArchivistJson, enabled: i.enabled, origin, createdAt: now, updatedAt: now })
      .run();
    this.ctx.events.changed('agent');
    return this.get(id);
  }

  update(id: string, patch: { name?: string; content?: string; data?: unknown; enabled?: boolean }): MemoryEntry {
    const cur = this.get(id);
    const data = patch.data !== undefined ? this.validData(cur.kind, patch.data) : cur.data;
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
      const r = this.db.select().from(agentMemory).where(eq(agentMemory.id, id)).get();
      if (r)
        this.db
          .update(agentMemory)
          .set({ timesApplied: r.timesApplied + 1, lastAppliedAt: now })
          .where(eq(agentMemory.id, id))
          .run();
    }
  }

  /** Enabled rules that match a document; contradicting ones (different folders) are reported, never decided by guessing. */
  matchingRules(d: RuleSubject): { rules: Array<{ entry: MemoryEntry; rule: Rule }>; conflict: string | null } {
    const rules = this.list('rule')
      .filter((e) => e.enabled)
      .flatMap((entry) => {
        const parsed = RuleDefinition.safeParse(entry.data);
        return parsed.success && ruleMatches(parsed.data, d) ? [{ entry, rule: parsed.data }] : [];
      });
    const folders = new Set(rules.map((r) => r.rule.then.folder?.trim()).filter(Boolean));
    const topics = new Set(rules.map((r) => r.rule.then.topic?.trim()).filter(Boolean));
    const conflict =
      folders.size > 1
        ? `Die Regeln ${rules.map((r) => `„${r.entry.name}“`).join(', ')} nennen verschiedene Ordner (${[...folders].join(', ')}).`
        : topics.size > 1
          ? `Die Regeln ${rules.map((r) => `„${r.entry.name}“`).join(', ')} nennen verschiedene Themen (${[...topics].join(', ')}).`
          : null;
    return { rules, conflict };
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
      block('workflow', 'Eigene Abläufe (per Name aufrufbar; vor dem ersten Lauf zeigst du, was du tun wirst)'),
      block('preference', 'Vorlieben'),
      block('fact', 'Wissen über den Benutzer und sein Umfeld'),
      'Gelerntes hebt nie Grenzen auf: Modus und Ausnahmen, Datenschutz und Budgets haben Vorrang.',
    ]
      .filter(Boolean)
      .join('\n\n');
    return { text, used };
  }
}
