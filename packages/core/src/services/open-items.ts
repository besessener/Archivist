import {
  isEditableOpenItemStatus,
  localDate,
  localToday,
  OpenItemSolution,
  type OpenItem,
  type OpenItemInput,
  type OpenItemPatch,
  type OpenItemStatus,
} from '@archivist/shared';
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
import { mentionContext, type PersonService } from './persons';
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

/** Detects typical "open item" phrasings locally (without LLM). */
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

/** Filler words in hints at open items („erledigt“, „schließ den Punkt“) that say nothing about the item. */
const HINT_FILLERS = new Set(
  'erledigt erledige erledigen erledigung schliess schliesse schliessen geschlossen punkt punkte offen offene offenen offener aufgabe aufgaben todo todos bitte mach mache machen kann koennen konnen soll sollte done fertig abgeschlossen abhaken hak hake erinnere erinner erinnern erinnerung mich mir daran dran verschieb verschiebe verschieben aendern andern andere setze setz wieder nochmal mal ok okay ja jetzt heute morgen gerade schon endlich raus damit thema zum zur'.split(
    ' ',
  ),
);

/** Time expressions say nothing about which item is meant („erinnere mich in sieben Tagen daran“). */
const TIME_WORDS = new Set(
  'tag tage tagen woche wochen monat monaten monate jahr jahren stunde stunden minute minuten montag dienstag mittwoch donnerstag freitag samstag sonntag januar februar marz april mai juni juli august september oktober november dezember naechsten nachsten nachste nachster kommenden kommende uebermorgen ubermorgen am um vom abend abends frueh fruh mittag vormittag nachmittag eins zwei drei vier fuenf funf sechs sieben acht neun zehn elf zwoelf zwolf einer einem einen ein eine bis ab'.split(
    ' ',
  ),
);

/** Words of a hint that actually say something about the item meant (without filler, stop and time words). */
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
    // abbreviations and word beginnings: „Präsi“ → „Präsentation“, „Steuer“ in „Steuererklärung“
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
 * Ranks open items against a hint: word by word over title and description (filler and stop words do not
 * count, short abbreviations like „TÜV“ only as a whole word), fuzzy only as the last stage. If the best
 * hits are close together, the result is ambiguous; below the threshold there is no hit.
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

/** Open items (tasks/questions) including responsible person, due date and status. */
export class OpenItemService {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
    private readonly persons: PersonService,
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
        const d = data as { id: string; previousStatus: OpenItemStatus; previousNote?: string | null; reminders?: Array<{ id: string; status: string }> };
        this.db.transaction(() => {
          this.db
            .update(openItems)
            .set({ status: d.previousStatus, resolutionNote: d.previousNote ?? null, updatedAt: nowIso() })
            .where(eq(openItems.id, d.id))
            .run();
          // reminders ended on closing come back
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

  /** Chat messages among the sources → conversation (to jump back from the open item into the chat). */
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
      resolutionNote: r.resolutionNote,
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

  /** Finds an active open item by a hint – only on an unambiguous hit. */
  findByHint(hint: string): OpenItem | null {
    const m = this.matchByHint(hint);
    return m.status === 'match' ? m.item : null;
  }

  /** Hit, ambiguous (several close together) or none – see rankOpenItems. */
  matchByHint(hint: string): HintMatch {
    return matchOpenItems(hint, this.list({ onlyActive: true }));
  }

  /** The responsible person as a `responsible_for` relation; a relation to a former responsible person becomes outdated (#274). */
  private syncResponsible(id: string, personId: string | null, sourceIds: string[]): void {
    if (personId) this.graph.link(personId, id, 'responsible_for', { confidence: 0.9, status: 'confirmed', sourceIds });
    this.graph.unlinkSystemRelations(id, 'responsible_for', personId ? [personId] : [], { direction: 'in', otherType: 'person' });
  }

  create(input: OpenItemInput, ctxInfo: { actor?: 'user' | 'agent'; trigger?: string } = {}): OpenItem {
    const now = nowIso();
    const topic = input.topic?.trim() ? this.graph.ensureEntity('topic', input.topic) : null;
    const project = input.project?.trim() ? this.graph.ensureEntity('project', input.project) : null;
    const person = input.responsible?.trim() ? this.persons.resolve(input.responsible, { context: mentionContext(ctxInfo.trigger, 'open_item') }).entity : null;
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
      resolutionNote: null,
    };
    this.db.transaction(() => {
      this.db.insert(openItems).values(row).run();
      this.graph.registerNode('task', row.id, row.title, row.description);
      if (topic) this.graph.link(row.id, topic.id, 'relates_to', { confidence: row.confidence, status: 'confirmed', sourceIds: row.sourceIds });
      if (project) this.graph.link(row.id, project.id, 'belongs_to', { confidence: row.confidence, status: 'confirmed', sourceIds: row.sourceIds });
      this.syncResponsible(row.id, row.responsiblePersonId, row.sourceIds);
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
  update(id: string, patch: OpenItemPatch, opts: { trigger?: string } = {}): OpenItem {
    const cur = this.db.select().from(openItems).where(eq(openItems.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
    if (patch.status !== undefined && patch.status !== cur.status) {
      // runtime guard for internal callers as well (the IPC schema already rejects these statuses)
      if (!isEditableOpenItemStatus(patch.status))
        throw new AppError('permission_error', 'Einen offenen Punkt als erledigt oder verworfen zu schließen, erfordert eine ausdrückliche Bestätigung.');
      if (!isEditableOpenItemStatus(cur.status as OpenItemStatus))
        throw new AppError(
          'permission_error',
          'Ein abgeschlossener Punkt lässt sich nicht durch Bearbeiten wieder öffnen. Mache das Schließen im Änderungsprotokoll rückgängig.',
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
      // a pronoun or answer word ("ja", "unbekannt") is not a person and leaves the responsible person unchanged
      const resolved = patch.responsible?.trim() ? this.persons.resolve(patch.responsible, { context: mentionContext(opts.trigger, 'open_item') }) : null;
      if (!resolved?.rejected) set.responsiblePersonId = resolved?.entity?.id ?? null;
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
        if (set.responsiblePersonId !== undefined) this.syncResponsible(id, set.responsiblePersonId, cur.sourceIds);
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

  /** Links a source (decision or document) with the item in the graph: item → results_from → source. */
  private linkSource(id: string, src: string, confidence: number): void {
    const type = this.graph.getEntity(src)?.type;
    if (type === 'decision' || type === 'document') this.graph.link(id, src, 'results_from', { confidence, status: 'confirmed', sourceIds: [src] });
  }

  /**
   * Adds another source to an existing item (the same item was detected in another document).
   * Missing details (description, due date, responsible person) are filled in from the new source; existing ones stay.
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
    const responsible = !cur.responsiblePersonId && extra.responsible?.trim() ? this.persons.resolve(extra.responsible, { context: 'open_item' }).entity : null;
    if (responsible) {
      set.responsiblePersonId = responsible.id;
      set.responsibleUnknown = false;
    }
    this.db.transaction(() => {
      this.db.update(openItems).set(set).where(eq(openItems.id, id)).run();
      if (set.description) this.graph.registerNode('task', id, cur.title, set.description);
      if (set.responsiblePersonId) this.syncResponsible(id, set.responsiblePersonId, set.sourceIds ?? cur.sourceIds);
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

  /** Stores the (latest) solution proposal on the item; an existing one is replaced. */
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

  /** Stage 2: closing only with explicit confirmation; with an undo entry. */
  /** `resolutionNote`: optional comment on how it was solved (or why it was dropped); shown with the item and searchable. */
  close(id: string, status: 'resolved' | 'dismissed', opts: { confirmed: boolean; trigger?: string; resolutionNote?: string | null }): OpenItem {
    if (!opts.confirmed) throw new AppError('permission_error', 'Das Schließen eines offenen Punkts erfordert eine ausdrückliche Bestätigung.');
    const cur = this.db.select().from(openItems).where(eq(openItems.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
    const updatedAt = nowIso();
    // open reminders of the item end with it (undo restores them)
    const ended = this.db
      .select({ id: reminders.id, status: reminders.status })
      .from(reminders)
      .where(and(eq(reminders.targetType, 'open_item'), eq(reminders.targetId, id), inArray(reminders.status, ['pending', 'fired'])))
      .all();
    this.db.transaction(() => {
      this.db
        .update(openItems)
        .set({ status, updatedAt, resolutionNote: opts.resolutionNote?.trim() || null })
        .where(eq(openItems.id, id))
        .run();
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
      after: { status, resolutionNote: opts.resolutionNote?.trim() || null },
      undo: {
        type: 'open_item_status',
        data: { id, previousStatus: cur.status, previousNote: cur.resolutionNote, afterUpdatedAt: updatedAt, reminders: ended },
      },
    });
    void this.reindex(id);
    this.ctx.events.changed('openItems', 'status', 'reminders');
    return this.get(id);
  }

  /** Active items due before `today` (local calendar day, #77). */
  overdue(today = localToday()): OpenItem[] {
    return this.list({ onlyActive: true }).filter((i) => i.dueAt && localDate(i.dueAt) < today);
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
          i.resolutionNote && `${i.status === 'dismissed' ? 'Verworfen' : 'Erledigt'}: ${i.resolutionNote}`,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    } catch (err) {
      this.ctx.logger.warn('open-items', 'Indexing failed', { error: err });
    }
  }
}
