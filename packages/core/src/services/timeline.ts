import { localDate, type EntityRef, type TimelineEntry } from '@archivist/shared';
import type { AppContext } from '../context';
import { contradictions, decisions, documents, events, openItems } from '../db/schema';
import { truncate } from '../util/text';
import type { KnowledgeGraphService } from './knowledge-graph';

export interface TimelineQuery {
  topicId?: string;
  projectId?: string;
  from?: string;
  to?: string;
  /** Maximum number of entries; the newest ones are kept (default 300). */
  limit?: number;
}

/**
 * Chronological view of documents, decisions, open items and contradictions – every entry links to its objects.
 * Returns the newest `limit` entries matching the filter, sorted oldest first.
 */
export class TimelineService {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
  ) {}

  get(q: TimelineQuery = {}): TimelineEntry[] {
    const db = this.ctx.database.db;
    const out: TimelineEntry[] = [];
    const match = (topicId: string | null, projectId: string | null) => {
      if (q.topicId && topicId !== q.topicId) return false;
      if (q.projectId && projectId !== q.projectId) return false;
      return true;
    };
    const ref = (type: EntityRef['type'], id: string | null, label?: string | null): EntityRef[] =>
      id ? [{ type, id, label: label ?? this.graph.getEntity(id)?.name ?? id }] : [];
    // the contradiction itself comes first (leads to the insights), then the affected decisions
    const contraRefs = (c: { id: string; title: string; affectedEntityIds: string[] }): EntityRef[] => [
      { type: 'contradiction', id: c.id, label: c.title },
      ...c.affectedEntityIds.map((id) => ({ type: 'decision' as const, id, label: this.graph.getEntity(id)?.name ?? id })),
    ];
    // Timestamps (createdAt, …) belong to the local day, not the UTC day (#77).
    const push = (e: Omit<TimelineEntry, 'year'>) => {
      const date = localDate(e.date);
      if (q.from && date < localDate(q.from)) return;
      if (q.to && date > localDate(q.to)) return;
      out.push({ ...e, date, year: Number(date.slice(0, 4)) || 0 });
    };

    for (const d of db.select().from(documents).all()) {
      if (!['archived', 'indexed_only'].includes(d.status) || !match(d.topicId, d.projectId)) continue;
      push({
        id: `doc:${d.id}`,
        date: d.documentDate ?? d.dates[0] ?? d.archivedAt ?? d.createdAt,
        kind: 'document',
        title: `Dokument: ${d.title}`,
        description: d.summary ? truncate(d.summary, 220) : null,
        refs: [{ type: 'document', id: d.id, label: d.title }, ...ref('topic', d.topicId), ...ref('project', d.projectId)],
      });
    }
    for (const d of db.select().from(decisions).all()) {
      if (!match(d.topicId, d.projectId)) continue;
      push({
        id: `dec:${d.id}`,
        date: d.decidedAt ?? d.createdAt,
        kind: 'decision',
        // without a decision date it is placed at the day it was captured – and says so (#168)
        title: `Entscheidung${d.status === 'superseded' ? ' (überholt)' : d.status === 'draft' ? ' (Entwurf)' : ''}${d.decidedAt ? '' : ' (ohne Datum, erfasst an diesem Tag)'}: ${d.title}`,
        description: truncate(d.decisionText, 240),
        refs: [{ type: 'decision', id: d.id, label: d.title }, ...ref('topic', d.topicId), ...ref('project', d.projectId)],
      });
    }
    for (const e of db.select().from(events).all()) {
      // a discarded duplicate is represented by the event it was merged into
      if (e.duplicateOfId || !match(e.topicId, e.projectId)) continue;
      push({
        id: `event:${e.id}`,
        date: e.occurredAt,
        kind: 'event',
        title: `Ereignis: ${e.title}`,
        description: e.description ? truncate(e.description, 240) : null,
        refs: [{ type: 'event', id: e.id, label: e.title }, ...ref('topic', e.topicId), ...ref('project', e.projectId)],
      });
    }
    for (const o of db.select().from(openItems).all()) {
      if (!match(o.topicId, o.projectId)) continue;
      const refs: EntityRef[] = [{ type: 'task', id: o.id, label: o.title }, ...ref('topic', o.topicId), ...ref('project', o.projectId)];
      push({
        id: `task:${o.id}:created`,
        date: o.createdAt,
        kind: 'open_item',
        title: `Offener Punkt angelegt: ${o.title}`,
        description: o.description ? truncate(o.description, 200) : null,
        refs,
      });
      if (o.dueAt) push({ id: `task:${o.id}:due`, date: o.dueAt, kind: 'open_item', title: `Fällig: ${o.title}`, description: `Status: ${o.status}`, refs });
      if (o.status === 'resolved' || o.status === 'dismissed')
        push({
          id: `task:${o.id}:done`,
          date: o.updatedAt,
          kind: 'open_item',
          title: `${o.status === 'resolved' ? 'Erledigt' : 'Verworfen'}: ${o.title}`,
          description: null,
          refs,
        });
    }
    if (!q.topicId && !q.projectId) {
      for (const c of db.select().from(contradictions).all()) {
        push({
          id: `contra:${c.id}`,
          date: c.createdAt,
          kind: 'contradiction',
          title: c.title,
          description: truncate(c.description, 240),
          refs: contraRefs(c),
        });
      }
    } else {
      // contradictions affecting decisions of this topic/project
      const decIds = new Set(
        db
          .select()
          .from(decisions)
          .all()
          .filter((d) => match(d.topicId, d.projectId))
          .map((d) => d.id),
      );
      for (const c of db.select().from(contradictions).all()) {
        if (c.affectedEntityIds.some((id) => decIds.has(id))) {
          push({
            id: `contra:${c.id}`,
            date: c.createdAt,
            kind: 'contradiction',
            title: c.title,
            description: truncate(c.description, 240),
            refs: contraRefs(c),
          });
        }
      }
    }
    // Filter first (above), then keep the NEWEST `limit` entries; the result stays in chronological order.
    const sorted = out.toSorted((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const limit = q.limit ?? 300;
    return sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
  }
}
