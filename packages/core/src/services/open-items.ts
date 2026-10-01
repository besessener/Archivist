import { isEditableOpenItemStatus, OpenItemSolution, type OpenItem, type OpenItemInput, type OpenItemPatch, type OpenItemStatus } from '@archivist/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { entities, messages, openItems, reminders } from '../db/schema';
import { syncReminderAt } from './reminders';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { normalizeDateInput } from '../util/dates';
import { levenshtein, tokenize } from '../util/text';
import type { AuditService } from './audit';
import type { KnowledgeGraphService, RelationChangeSet } from './knowledge-graph';
import type { SearchService } from './search';
import type { UndoService } from './undo';

type Row = typeof openItems.$inferSelect;

interface OpenItemUpdateUndo {
  id: string;
  /** Previous values of the edited columns. */
  before: Partial<Row>;
  afterUpdatedAt: string;
  relations: RelationChangeSet;
}
export const ACTIVE_STATUSES: OpenItemStatus[] = ['open', 'waiting', 'blocked'];

/** Erkennt typische „offener Punkt“-Formulierungen lokal (ohne LLM). */
const OPEN_PATTERNS = [
  /muss\s+noch\s+(?:geklärt|geprüft|entschieden|abgestimmt)\s+werden/i,
  /noch\s+(?:zu\s+)?(?:klären|prüfen|entscheiden|abstimmen)/i,
  /offen\s+ist\b|ist\s+(?:noch\s+)?offen\b|offener?\s+punkt/i,
  /später\s+entscheiden/i,
  /\bTBD\b|\bTBC\b|\bpending\b/i,
  /ungeklärt|ungeklaert/i,
  /rückmeldung\s+(?:steht\s+)?(?:noch\s+)?aus(?:stehend)?|ausstehende\s+rückmeldung/i,
  /entscheidung\s+(?:steht\s+)?(?:noch\s+)?aus(?:stehend)?|ausstehende\s+entscheidung/i,
  /follow[- ]?up\s+(?:ist\s+)?erforderlich/i,
];

export function detectOpenItemSentences(text: string, max = 8): string[] {
  const sentences = text
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && s.length < 400);
  return sentences.filter((s) => OPEN_PATTERNS.some((p) => p.test(s))).slice(0, max);
}

/** Füllwörter in Hinweisen auf offene Punkte („erledigt“, „schließ den Punkt“), die nichts über den Punkt sagen. */
const HINT_FILLERS = new Set(
  'erledigt erledige erledigen erledigung schliess schliesse schliessen geschlossen punkt punkte offen offene offenen offener aufgabe aufgaben todo todos bitte mach mache machen kann koennen konnen soll sollte done fertig abgeschlossen abhaken hak hake erinnere erinner erinnern erinnerung mich mir daran dran verschieb verschiebe verschieben aendern andern andere setze setz wieder nochmal mal ok okay ja jetzt heute morgen gerade schon endlich raus damit thema zum zur'.split(
    ' ',
  ),
);

/** Zeitangaben sagen nichts darüber, welcher Punkt gemeint ist („erinnere mich in sieben Tagen daran“). */
const TIME_WORDS = new Set(
  'tag tage tagen woche wochen monat monaten monate jahr jahren stunde stunden minute minuten montag dienstag mittwoch donnerstag freitag samstag sonntag januar februar marz april mai juni juli august september oktober november dezember naechsten nachsten nachste nachster kommenden kommende uebermorgen ubermorgen am um vom abend abends frueh fruh mittag vormittag nachmittag eins zwei drei vier fuenf funf sechs sieben acht neun zehn elf zwoelf zwolf einer einem einen ein eine bis ab'.split(
    ' ',
  ),
);

/** Wörter eines Hinweises, die tatsächlich etwas über den gemeinten Punkt sagen (ohne Füll-, Stopp- und Zeitwörter). */
export function hintTokens(hint: string): string[] {
  return [...new Set(tokenize(hint).filter((t) => !HINT_FILLERS.has(t) && !TIME_WORDS.has(t) && !/^\d+$/.test(t)))];
}

export type HintMatch = { status: 'match'; item: OpenItem } | { status: 'ambiguous'; items: OpenItem[] } | { status: 'none' };

const MATCH_THRESHOLD = 0.5;
const AMBIGUITY_MARGIN = 0.15;

function tokenScore(h: string, tokens: string[]): number {
  let best = 0;
  for (const t of tokens) {
    if (t === h) return 1;
    // Abkürzungen und Wortanfänge: „Präsi“ → „Präsentation“, „Steuer“ in „Steuererklärung“
    if ((h.length >= 3 && t.startsWith(h)) || (t.length >= 4 && h.startsWith(t))) best = Math.max(best, 0.8);
    else if (h.length >= 5 && t.length >= 5) {
      const sim = 1 - levenshtein(h, t) / Math.max(h.length, t.length);
      if (sim >= 0.8) best = Math.max(best, 0.6);
    }
  }
  return best;
}

/**
 * Share (0..1) of the hint tokens found in an open item: a title word counts fully, a description word 0.7,
 * abbreviations and near misses less (see tokenScore). `wanted` are {@link hintTokens}.
 */
export function scoreHintTokens(wanted: string[], item: { title: string; description?: string | null }): number {
  if (!wanted.length) return 0;
  const title = tokenize(item.title, { keepStopwords: true });
  const desc = tokenize(item.description ?? '', { keepStopwords: true });
  return wanted.reduce((acc, h) => acc + Math.max(tokenScore(h, title), 0.7 * tokenScore(h, desc)), 0) / wanted.length;
}

/**
 * Bewertet offene Punkte gegen einen Hinweis: Wort für Wort über Titel und Beschreibung (Füll- und Stoppwörter
 * zählen nicht, kurze Kürzel wie „TÜV“ nur als ganzes Wort), unscharf nur als letzte Stufe. Liegen die besten
 * Treffer nah beieinander, ist das Ergebnis mehrdeutig; unter der Schwelle gibt es keinen Treffer.
 */
export function matchOpenItems<T extends { title: string; description?: string | null }>(
  hint: string,
  items: T[],
  opts: { threshold?: number } = {},
): { status: 'match'; item: T } | { status: 'ambiguous'; items: T[] } | { status: 'none' } {
  const wanted = hintTokens(hint);
  if (!wanted.length) return { status: 'none' };
  const scored = items
    .map((item) => ({ item, score: scoreHintTokens(wanted, item) }))
    .filter((x) => x.score >= (opts.threshold ?? MATCH_THRESHOLD))
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { status: 'none' };
  const close = scored.filter((x) => x.score >= scored[0]!.score - AMBIGUITY_MARGIN);
  return close.length === 1 ? { status: 'match', item: close[0]!.item } : { status: 'ambiguous', items: close.slice(0, 4).map((x) => x.item) };
}

/** Offene Punkte (Aufgaben/Fragen) inkl. Verantwortlichen, Fälligkeit und Status. */
export class OpenItemService {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
    private readonly search: SearchService,
    private readonly audit: AuditService,
    undo: UndoService,
  ) {
    undo.register('open_item_status', {
      check: async (data) => {
        const d = data as { id: string; afterUpdatedAt: string };
        const row = this.db.select().from(openItems).where(eq(openItems.id, d.id)).get();
        if (!row) return ['Der offene Punkt existiert nicht mehr.'];
        return row.updatedAt === d.afterUpdatedAt ? [] : ['Der offene Punkt wurde seit der Aktion verändert.'];
      },
      run: async (data) => {
        const d = data as { id: string; previousStatus: OpenItemStatus; reminders?: Array<{ id: string; status: string }> };
        this.db.transaction(() => {
          this.db.update(openItems).set({ status: d.previousStatus, updatedAt: nowIso() }).where(eq(openItems.id, d.id)).run();
          // beim Schließen beendete Erinnerungen kommen wieder
          for (const r of d.reminders ?? []) this.db.update(reminders).set({ status: r.status }).where(eq(reminders.id, r.id)).run();
          syncReminderAt(this.db, d.id);
        });
        this.ctx.events.changed('openItems', 'reminders');
        return 'Status des offenen Punkts wiederhergestellt.';
      },
    });
    undo.register('open_item_update', {
      check: async (data) => {
        const d = data as OpenItemUpdateUndo;
        const row = this.db.select().from(openItems).where(eq(openItems.id, d.id)).get();
        if (!row) return ['Der offene Punkt existiert nicht mehr.'];
        const conflicts = row.updatedAt === d.afterUpdatedAt ? [] : ['Der offene Punkt wurde seit der Bearbeitung verändert.'];
        return [...conflicts, ...this.graph.relationChangeConflicts(d.relations)];
      },
      run: async (data) => {
        const d = data as OpenItemUpdateUndo;
        this.db.transaction(() => {
          this.db
            .update(openItems)
            .set({ ...d.before, updatedAt: nowIso() })
            .where(eq(openItems.id, d.id))
            .run();
          const row = this.db.select().from(openItems).where(eq(openItems.id, d.id)).get();
          if (row) this.graph.registerNode('task', row.id, row.title, row.description);
          this.graph.revertRelationChanges(d.relations);
        });
        void this.reindex(d.id);
        this.ctx.events.changed('openItems', 'knowledge', 'status');
        return 'Bearbeitung des offenen Punkts rückgängig gemacht.';
      },
    });
  }

  private get db() {
    return this.ctx.database.db;
  }

  /** Chat-Nachrichten unter den Quellen → Unterhaltung (für den Rücksprung aus dem offenen Punkt in den Chat). */
  private conversationsOf(rows: Row[]): Map<string, string> {
    const ids = [...new Set(rows.flatMap((r) => r.sourceIds))];
    if (!ids.length) return new Map();
    return new Map(
      this.db
        .select({ id: messages.id, conversationId: messages.conversationId })
        .from(messages)
        .where(inArray(messages.id, ids))
        .all()
        .map((m) => [m.id, m.conversationId]),
    );
  }

  private map(r: Row, names?: Map<string, string>, convs = this.conversationsOf([r])): OpenItem {
    const nm = (id: string | null) => (id ? (names?.get(id) ?? this.graph.getEntity(id)?.name ?? null) : null);
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      topicId: r.topicId,
      topicName: nm(r.topicId),
      projectId: r.projectId,
      projectName: nm(r.projectId),
      responsiblePersonId: r.responsiblePersonId,
      responsibleName: nm(r.responsiblePersonId),
      responsibleUnknown: r.responsibleUnknown,
      createdAt: r.createdAt,
      dueAt: r.dueAt,
      dueUnknown: r.dueUnknown,
      status: r.status as OpenItemStatus,
      priority: r.priority as OpenItem['priority'],
      sourceIds: r.sourceIds,
      sourceConversationId: r.sourceIds.map((id) => convs.get(id)).find(Boolean) ?? null,
      reminderAt: r.reminderAt,
      confidence: r.confidence,
      updatedAt: r.updatedAt,
      solution: r.solution ? (OpenItemSolution.safeParse(r.solution).data ?? null) : null,
      duplicateOfId: r.duplicateOfId,
    };
  }

  private mapMany(rows: Row[]): OpenItem[] {
    const ids = [...new Set(rows.flatMap((r) => [r.topicId, r.projectId, r.responsiblePersonId]).filter((x): x is string => Boolean(x)))];
    const names = new Map(
      ids.length
        ? this.db
            .select({ id: entities.id, name: entities.name })
            .from(entities)
            .where(inArray(entities.id, ids))
            .all()
            .map((e) => [e.id, e.name])
        : [],
    );
    const convs = this.conversationsOf(rows);
    return rows.map((r) => this.map(r, names, convs));
  }

  get(id: string): OpenItem {
    const r = this.db.select().from(openItems).where(eq(openItems.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
    return this.map(r);
  }

  list(opts: { status?: OpenItemStatus; topicId?: string; projectId?: string; onlyActive?: boolean } = {}): OpenItem[] {
    const conds = [];
    if (opts.status) conds.push(eq(openItems.status, opts.status));
    if (opts.onlyActive) conds.push(inArray(openItems.status, ACTIVE_STATUSES));
    if (opts.topicId) conds.push(eq(openItems.topicId, opts.topicId));
    if (opts.projectId) conds.push(eq(openItems.projectId, opts.projectId));
    const rows = this.db
      .select()
      .from(openItems)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(openItems.createdAt))
      .all();
    return this.mapMany(rows);
  }

  /** Findet einen aktiven offenen Punkt anhand eines Hinweises – nur bei eindeutigem Treffer. */
  findByHint(hint: string): OpenItem | null {
    const m = this.matchByHint(hint);
    return m.status === 'match' ? m.item : null;
  }

  /** Treffer, mehrdeutig (mehrere nah beieinander) oder keiner – siehe rankOpenItems. */
  matchByHint(hint: string): HintMatch {
    return matchOpenItems(hint, this.list({ onlyActive: true }));
  }

  create(input: OpenItemInput, ctxInfo: { actor?: 'user' | 'agent'; trigger?: string } = {}): OpenItem {
    const now = nowIso();
    const topic = input.topic?.trim() ? this.graph.ensureEntity('topic', input.topic) : null;
    const project = input.project?.trim() ? this.graph.ensureEntity('project', input.project) : null;
    const person = input.responsible?.trim() ? this.graph.ensureEntity('person', input.responsible) : null;
    const dueAt = normalizeDateInput(input.dueAt ?? null);
    const row: Row = {
      id: newId(),
      title: input.title.trim(),
      description: input.description?.trim() || null,
      topicId: topic?.id ?? null,
      projectId: project?.id ?? null,
      responsiblePersonId: person?.id ?? null,
      responsibleUnknown: false,
      dueAt,
      dueUnknown: false,
      status: 'open',
      priority: input.priority ?? 'normal',
      sourceIds: input.sourceIds ?? [],
      reminderAt: null,
      confidence: input.confidence ?? 0.9,
      createdAt: now,
      updatedAt: now,
      solution: null,
      duplicateOfId: null,
    };
    this.db.transaction(() => {
      this.db.insert(openItems).values(row).run();
      this.graph.registerNode('task', row.id, row.title, row.description);
      if (topic) this.graph.link(row.id, topic.id, 'relates_to', { confidence: row.confidence, status: 'confirmed', sourceIds: row.sourceIds });
      if (project) this.graph.link(row.id, project.id, 'belongs_to', { confidence: row.confidence, status: 'confirmed', sourceIds: row.sourceIds });
      for (const src of row.sourceIds) this.linkSource(row.id, src, row.confidence);
    });
    this.audit.log({
      action: 'open_item.create',
      actor: ctxInfo.actor ?? 'user',
      trigger: ctxInfo.trigger ?? 'manual',
      confirmed: true,
      entityIds: [row.id],
      after: { title: row.title, dueAt },
    });
    void this.reindex(row.id);
    this.ctx.events.changed('openItems', 'knowledge', 'status');
    return this.get(row.id);
  }

  /**
   * Partial update: only fields present in `patch` change. `status` may only move between open, waiting and
   * blocked – closing needs `close()` with confirmation, reopening goes through undo.
   */
  update(id: string, patch: OpenItemPatch): OpenItem {
    const cur = this.db.select().from(openItems).where(eq(openItems.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
    if (patch.status !== undefined && patch.status !== cur.status) {
      // runtime guard for internal callers as well (the IPC schema already rejects these statuses)
      if (!isEditableOpenItemStatus(patch.status))
        throw new AppError('permission_error', 'Einen offenen Punkt als erledigt oder verworfen zu schließen, erfordert eine ausdrückliche Bestätigung.');
      if (!isEditableOpenItemStatus(cur.status as OpenItemStatus))
        throw new AppError(
          'permission_error',
          'Ein abgeschlossener Punkt lässt sich nicht durch Bearbeiten wieder öffnen. Machen Sie das Schließen im Änderungsprotokoll rückgängig.',
        );
    }
    const set: Partial<Row> = { updatedAt: nowIso() };
    if (patch.title !== undefined) set.title = patch.title.trim();
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.priority) set.priority = patch.priority;
    if (patch.status && patch.status !== cur.status) set.status = patch.status;
    if (patch.topic !== undefined) set.topicId = patch.topic?.trim() ? this.graph.ensureEntity('topic', patch.topic).id : null;
    if (patch.project !== undefined) set.projectId = patch.project?.trim() ? this.graph.ensureEntity('project', patch.project).id : null;
    if (patch.responsible !== undefined) {
      set.responsiblePersonId = patch.responsible?.trim() ? this.graph.ensureEntity('person', patch.responsible).id : null;
      if (set.responsiblePersonId) set.responsibleUnknown = false;
    }
    if (patch.dueAt !== undefined) {
      set.dueAt = normalizeDateInput(patch.dueAt ?? null);
      if (set.dueAt) set.dueUnknown = false;
    }
    if (patch.responsibleUnknown !== undefined) set.responsibleUnknown = patch.responsibleUnknown;
    if (patch.dueUnknown !== undefined) set.dueUnknown = patch.dueUnknown;
    const { changes } = this.graph.trackRelationChanges(id, () =>
      this.db.transaction(() => {
        this.db.update(openItems).set(set).where(eq(openItems.id, id)).run();
        if (set.title) this.graph.registerNode('task', id, set.title, set.description ?? cur.description);
        if (set.topicId) this.graph.link(id, set.topicId, 'relates_to', { confidence: 0.9, status: 'confirmed' });
        if (set.projectId) this.graph.link(id, set.projectId, 'belongs_to', { confidence: 0.9, status: 'confirmed' });
        // the previous topic/project no longer applies
        if (set.topicId !== undefined) this.graph.unlinkSystemRelations(id, 'relates_to', set.topicId ? [set.topicId] : [], { otherType: 'topic' });
        if (set.projectId !== undefined) this.graph.unlinkSystemRelations(id, 'belongs_to', set.projectId ? [set.projectId] : [], { otherType: 'project' });
      }),
    );
    const before = Object.fromEntries(Object.keys(set).flatMap((k) => (k === 'updatedAt' ? [] : [[k, cur[k as keyof Row]]]))) as Partial<Row>;
    const undoData: OpenItemUpdateUndo = { id, before, afterUpdatedAt: set.updatedAt!, relations: changes };
    this.audit.log({
      action: 'open_item.update',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: cur.status, dueAt: cur.dueAt },
      after: patch,
      undo: { type: 'open_item_update', data: undoData },
    });
    void this.reindex(id);
    this.ctx.events.changed('openItems', 'knowledge', 'status');
    return this.get(id);
  }

  /** Quelle (Entscheidung oder Dokument) im Graph mit dem Punkt verknüpfen: Punkt → results_from → Quelle. */
  private linkSource(id: string, src: string, confidence: number): void {
    const type = this.graph.getEntity(src)?.type;
    if (type === 'decision' || type === 'document') this.graph.link(id, src, 'results_from', { confidence, status: 'confirmed', sourceIds: [src] });
  }

  /**
   * Weitere Quelle zu einem bestehenden Punkt hinzufügen (derselbe Punkt in einem weiteren Dokument erkannt).
   * Fehlende Angaben (Beschreibung, Fälligkeit, Verantwortlicher) werden aus der neuen Quelle ergänzt, vorhandene bleiben.
   */
  addSource(
    id: string,
    sourceId: string,
    extra: { description?: string | null; dueAt?: string | null; responsible?: string | null } = {},
    ctxInfo: { actor?: 'user' | 'agent'; trigger?: string } = {},
  ): OpenItem {
    const cur = this.db.select().from(openItems).where(eq(openItems.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
    const set: Partial<Row> = { updatedAt: nowIso() };
    if (!cur.sourceIds.includes(sourceId)) set.sourceIds = [...cur.sourceIds, sourceId];
    if (!cur.description && extra.description?.trim()) set.description = extra.description.trim();
    if (!cur.dueAt && extra.dueAt) {
      set.dueAt = normalizeDateInput(extra.dueAt);
      if (set.dueAt) set.dueUnknown = false;
    }
    if (!cur.responsiblePersonId && extra.responsible?.trim()) {
      set.responsiblePersonId = this.graph.ensureEntity('person', extra.responsible).id;
      set.responsibleUnknown = false;
    }
    this.db.transaction(() => {
      this.db.update(openItems).set(set).where(eq(openItems.id, id)).run();
      if (set.description) this.graph.registerNode('task', id, cur.title, set.description);
      this.linkSource(id, sourceId, cur.confidence);
    });
    this.audit.log({
      action: 'open_item.add_source',
      actor: ctxInfo.actor ?? 'user',
      trigger: ctxInfo.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id, sourceId],
      before: { sourceIds: cur.sourceIds },
      after: { sourceIds: set.sourceIds ?? cur.sourceIds },
    });
    void this.reindex(id);
    this.ctx.events.changed('openItems', 'knowledge', 'status');
    return this.get(id);
  }

  /** Speichert den (neuesten) Lösungsvorschlag am Punkt; ein vorhandener wird ersetzt. */
  setSolution(id: string, solution: OpenItemSolution): OpenItem {
    const cur = this.db.select({ id: openItems.id }).from(openItems).where(eq(openItems.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
    this.db
      .update(openItems)
      .set({ solution: OpenItemSolution.parse(solution), updatedAt: nowIso() })
      .where(eq(openItems.id, id))
      .run();
    this.ctx.events.changed('openItems');
    return this.get(id);
  }

  /** Stufe 2: Schließen nur mit ausdrücklicher Bestätigung; mit Undo-Eintrag. */
  close(id: string, status: 'resolved' | 'dismissed', opts: { confirmed: boolean; trigger?: string }): OpenItem {
    if (!opts.confirmed) throw new AppError('permission_error', 'Das Schließen eines offenen Punkts erfordert eine ausdrückliche Bestätigung.');
    const cur = this.db.select().from(openItems).where(eq(openItems.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
    const updatedAt = nowIso();
    // offene Erinnerungen des Punkts enden mit ihm (Undo stellt sie wieder her)
    const ended = this.db
      .select({ id: reminders.id, status: reminders.status })
      .from(reminders)
      .where(and(eq(reminders.targetType, 'open_item'), eq(reminders.targetId, id), inArray(reminders.status, ['pending', 'fired'])))
      .all();
    this.db.transaction(() => {
      this.db.update(openItems).set({ status, updatedAt }).where(eq(openItems.id, id)).run();
      for (const r of ended) this.db.update(reminders).set({ status: 'dismissed' }).where(eq(reminders.id, r.id)).run();
      syncReminderAt(this.db, id);
    });
    this.audit.log({
      action: 'open_item.close',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: cur.status },
      after: { status },
      undo: { type: 'open_item_status', data: { id, previousStatus: cur.status, afterUpdatedAt: updatedAt, reminders: ended } },
    });
    void this.reindex(id);
    this.ctx.events.changed('openItems', 'status', 'reminders');
    return this.get(id);
  }

  overdue(today = nowIso().slice(0, 10)): OpenItem[] {
    return this.list({ onlyActive: true }).filter((i) => i.dueAt && i.dueAt.slice(0, 10) < today);
  }

  /** Rebuilds the search index entry (e.g. after a merge changed names or references). */
  async reindex(id: string): Promise<void> {
    try {
      const i = this.get(id);
      await this.search.index({
        type: 'task',
        id,
        title: i.title,
        content: [
          i.title,
          i.description,
          i.topicName && `Thema: ${i.topicName}`,
          i.projectName && `Projekt: ${i.projectName}`,
          i.responsibleName && `Verantwortlich: ${i.responsibleName}`,
          i.dueAt && `Fällig: ${i.dueAt.slice(0, 10)}`,
          `Status: ${i.status}`,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    } catch (err) {
      this.ctx.logger.warn('open-items', 'Indexierung fehlgeschlagen', { error: err });
    }
  }
}
