import type { OpenItem, OpenItemInput, OpenItemStatus } from '@archivist/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { entities, openItems } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { normalizeDateInput } from '../util/dates';
import { levenshtein, tokenize } from '../util/text';
import type { AuditService } from './audit';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { SearchService } from './search';
import type { UndoService } from './undo';

type Row = typeof openItems.$inferSelect;
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
 * Bewertet offene Punkte gegen einen Hinweis: Wort für Wort über Titel und Beschreibung (Füll- und Stoppwörter
 * zählen nicht, kurze Kürzel wie „TÜV“ nur als ganzes Wort), unscharf nur als letzte Stufe. Liegen die besten
 * Treffer nah beieinander, ist das Ergebnis mehrdeutig; unter der Schwelle gibt es keinen Treffer.
 */
export function matchOpenItems<T extends { title: string; description?: string | null }>(
  hint: string,
  items: T[],
): { status: 'match'; item: T } | { status: 'ambiguous'; items: T[] } | { status: 'none' } {
  const wanted = hintTokens(hint);
  if (!wanted.length) return { status: 'none' };
  const scored = items
    .map((item) => {
      const title = tokenize(item.title, { keepStopwords: true });
      const desc = tokenize(item.description ?? '', { keepStopwords: true });
      const sum = wanted.reduce((acc, h) => acc + Math.max(tokenScore(h, title), 0.7 * tokenScore(h, desc)), 0);
      return { item, score: sum / wanted.length };
    })
    .filter((x) => x.score >= MATCH_THRESHOLD)
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
        const d = data as { id: string; previousStatus: OpenItemStatus };
        this.db.update(openItems).set({ status: d.previousStatus, updatedAt: nowIso() }).where(eq(openItems.id, d.id)).run();
        this.ctx.events.changed('openItems');
        return 'Status des offenen Punkts wiederhergestellt.';
      },
    });
  }

  private get db() {
    return this.ctx.database.db;
  }

  private map(r: Row, names?: Map<string, string>): OpenItem {
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
      reminderAt: r.reminderAt,
      confidence: r.confidence,
      updatedAt: r.updatedAt,
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
    return rows.map((r) => this.map(r, names));
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
    };
    this.db.transaction(() => {
      this.db.insert(openItems).values(row).run();
      this.graph.registerNode('task', row.id, row.title, row.description);
      if (topic) this.graph.link(row.id, topic.id, 'relates_to', { confidence: row.confidence, status: 'confirmed', sourceIds: row.sourceIds });
      if (project) this.graph.link(row.id, project.id, 'belongs_to', { confidence: row.confidence, status: 'confirmed', sourceIds: row.sourceIds });
      for (const src of row.sourceIds)
        if (this.graph.getEntity(src)?.type === 'decision')
          this.graph.link(row.id, src, 'results_from', { confidence: row.confidence, status: 'confirmed', sourceIds: [src] });
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

  update(id: string, patch: Partial<OpenItemInput> & { status?: OpenItemStatus; responsibleUnknown?: boolean; dueUnknown?: boolean }): OpenItem {
    const cur = this.db.select().from(openItems).where(eq(openItems.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
    const set: Partial<Row> = { updatedAt: nowIso() };
    if (patch.title !== undefined) set.title = patch.title.trim();
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.priority) set.priority = patch.priority;
    if (patch.status) set.status = patch.status;
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
    this.db.transaction(() => {
      this.db.update(openItems).set(set).where(eq(openItems.id, id)).run();
      if (set.title) this.graph.registerNode('task', id, set.title, set.description ?? cur.description);
      if (set.topicId) this.graph.link(id, set.topicId, 'relates_to', { confidence: 0.9, status: 'confirmed' });
      if (set.projectId) this.graph.link(id, set.projectId, 'belongs_to', { confidence: 0.9, status: 'confirmed' });
    });
    this.audit.log({
      action: 'open_item.update',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: cur.status, dueAt: cur.dueAt },
      after: patch,
    });
    void this.reindex(id);
    this.ctx.events.changed('openItems', 'knowledge', 'status');
    return this.get(id);
  }

  /** Stufe 2: Schließen nur mit ausdrücklicher Bestätigung; mit Undo-Eintrag. */
  close(id: string, status: 'resolved' | 'dismissed', opts: { confirmed: boolean; trigger?: string }): OpenItem {
    if (!opts.confirmed) throw new AppError('permission_error', 'Das Schließen eines offenen Punkts erfordert eine ausdrückliche Bestätigung.');
    const cur = this.db.select().from(openItems).where(eq(openItems.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Offener Punkt nicht gefunden.');
    const updatedAt = nowIso();
    this.db.update(openItems).set({ status, updatedAt }).where(eq(openItems.id, id)).run();
    this.audit.log({
      action: 'open_item.close',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: cur.status },
      after: { status },
      undo: { type: 'open_item_status', data: { id, previousStatus: cur.status, afterUpdatedAt: updatedAt } },
    });
    void this.reindex(id);
    this.ctx.events.changed('openItems', 'status');
    return this.get(id);
  }

  overdue(today = nowIso().slice(0, 10)): OpenItem[] {
    return this.list({ onlyActive: true }).filter((i) => i.dueAt && i.dueAt.slice(0, 10) < today);
  }

  private async reindex(id: string): Promise<void> {
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
