import { DECISION_FIELD_LABELS, type Decision, type DecisionField, type DecisionInput, type DecisionStatus } from '@archivist/shared';
import { and, desc, eq, inArray, like, or } from 'drizzle-orm';
import type { AppContext } from '../context';
import { decisions, entities } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { normalizeDateInput } from '../util/dates';
import { firstSentence, normalizeName, truncate } from '../util/text';
import type { AuditService } from './audit';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { SearchService } from './search';
import type { UndoService } from './undo';

type Row = typeof decisions.$inferSelect;

export const ACTIVE_DECISION_STATUSES: DecisionStatus[] = ['confirmed', 'active'];

/**
 * Pflichtfelder: Wann, Thema, Beteiligte, Entscheidung.
 * Ein Feld gilt als erfüllt, wenn es vorhanden ist ODER der Benutzer es ausdrücklich als unbekannt bestätigt hat.
 */
export function computeMissingFields(d: { decisionText?: string | null; decidedAt?: string | null; topic?: string | null; participants?: string[]; unknownFields?: DecisionField[] }): DecisionField[] {
  const unknown = new Set(d.unknownFields ?? []);
  const missing: DecisionField[] = [];
  if (!d.decidedAt && !unknown.has('decidedAt')) missing.push('decidedAt');
  if (!d.topic?.trim() && !unknown.has('topic')) missing.push('topic');
  if ((d.participants ?? []).length === 0 && !unknown.has('participants')) missing.push('participants');
  if (!d.decisionText?.trim() && !unknown.has('decisionText')) missing.push('decisionText');
  return missing;
}

/** Gezielte Rückfragen je fehlendem Pflichtfeld. */
export function questionFor(field: DecisionField, ctx: { topic?: string | null } = {}): string {
  switch (field) {
    case 'decidedAt':
      return 'Wann wurde das entschieden?';
    case 'participants':
      return 'Wer war an der Entscheidung beteiligt?';
    case 'topic':
      return 'Zu welchem Thema gehört die Entscheidung?';
    case 'decisionText':
      return ctx.topic ? `Was genau wurde zu „${ctx.topic}“ entschieden?` : 'Was genau wurde entschieden?';
  }
}

export class DecisionService {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
    private readonly search: SearchService,
    private readonly audit: AuditService,
    undo: UndoService,
  ) {
    undo.register('decision_status', {
      check: async (data) => {
        const d = data as { changes: Array<{ id: string; afterUpdatedAt: string }> };
        const conflicts: string[] = [];
        for (const c of d.changes) {
          const row = this.db.select().from(decisions).where(eq(decisions.id, c.id)).get();
          if (!row) conflicts.push(`Entscheidung ${c.id} existiert nicht mehr.`);
          else if (row.updatedAt !== c.afterUpdatedAt) conflicts.push(`Entscheidung „${row.title}“ wurde seit der Aktion verändert.`);
        }
        return conflicts;
      },
      run: async (data) => {
        const d = data as { changes: Array<{ id: string; status: DecisionStatus; supersedesDecisionId: string | null }>; relationIds: string[] };
        for (const c of d.changes) this.db.update(decisions).set({ status: c.status, supersedesDecisionId: c.supersedesDecisionId, updatedAt: nowIso() }).where(eq(decisions.id, c.id)).run();
        for (const rid of d.relationIds) this.graph.deleteRelation(rid);
        for (const c of d.changes) void this.reindex(c.id);
        this.ctx.events.changed('decisions', 'knowledge');
        return 'Status der Entscheidung(en) wiederhergestellt.';
      },
    });
  }

  private get db() {
    return this.ctx.database.db;
  }

  private map(r: Row, names?: Map<string, string>): Decision {
    const nm = (id: string | null) => (id ? (names?.get(id) ?? this.graph.getEntity(id)?.name ?? null) : null);
    return {
      id: r.id,
      title: r.title,
      decisionText: r.decisionText,
      decidedAt: r.decidedAt,
      topicId: r.topicId,
      topicName: nm(r.topicId),
      projectId: r.projectId,
      projectName: nm(r.projectId),
      participants: r.participants,
      rationale: r.rationale,
      consequences: r.consequences,
      alternatives: r.alternatives,
      status: r.status as DecisionStatus,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      supersedesDecisionId: r.supersedesDecisionId,
      sourceIds: r.sourceIds,
      confidence: r.confidence,
      missingFields: r.missingFields as DecisionField[],
      unknownFields: r.unknownFields as DecisionField[],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private mapMany(rows: Row[]): Decision[] {
    const ids = [...new Set(rows.flatMap((r) => [r.topicId, r.projectId]).filter((x): x is string => Boolean(x)))];
    const names = new Map(ids.length ? this.db.select({ id: entities.id, name: entities.name }).from(entities).where(inArray(entities.id, ids)).all().map((e) => [e.id, e.name]) : []);
    return rows.map((r) => this.map(r, names));
  }

  get(id: string): Decision {
    const r = this.db.select().from(decisions).where(eq(decisions.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Entscheidung nicht gefunden.');
    return this.map(r);
  }

  list(opts: { status?: DecisionStatus; topicId?: string; projectId?: string } = {}): Decision[] {
    const conds = [];
    if (opts.status) conds.push(eq(decisions.status, opts.status));
    if (opts.topicId) conds.push(eq(decisions.topicId, opts.topicId));
    if (opts.projectId) conds.push(eq(decisions.projectId, opts.projectId));
    return this.mapMany(this.db.select().from(decisions).where(conds.length ? and(...conds) : undefined).orderBy(desc(decisions.decidedAt), desc(decisions.createdAt)).all());
  }

  /** Aktive Entscheidungen zu Thema oder Projekt (für Widerspruchs-/Überholt-Prüfung). */
  activeFor(topicId: string | null, projectId: string | null, excludeId?: string): Decision[] {
    const all = this.list().filter((d) => ACTIVE_DECISION_STATUSES.includes(d.status) && d.id !== excludeId);
    return all.filter((d) => (topicId && d.topicId === topicId) || (!topicId && projectId && d.projectId === projectId));
  }

  async searchDecisions(query: string, limit = 20): Promise<Decision[]> {
    const hits = await this.search.search(query, { types: ['decision'], limit });
    const ids = hits.map((h) => h.id);
    const found = ids.length ? this.db.select().from(decisions).where(inArray(decisions.id, ids)).all() : [];
    const byId = new Map(found.map((r) => [r.id, r]));
    const ordered = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    if (ordered.length === 0) {
      const q = `%${query.trim()}%`;
      return this.mapMany(this.db.select().from(decisions).where(or(like(decisions.title, q), like(decisions.decisionText, q))).limit(limit).all());
    }
    return this.mapMany(ordered);
  }

  /**
   * Legt eine Entscheidung an. Sind Pflichtfelder offen (und nicht als unbekannt bestätigt), wird sie als Entwurf gespeichert.
   */
  create(input: DecisionInput, opts: { actor?: 'user' | 'agent'; trigger?: string } = {}): Decision {
    const now = nowIso();
    const topic = input.topic?.trim() ? this.graph.ensureEntity('topic', input.topic) : null;
    const project = input.project?.trim() ? this.graph.ensureEntity('project', input.project) : null;
    const decidedAt = normalizeDateInput(input.decidedAt ?? null);
    const missing = computeMissingFields({ decisionText: input.decisionText, decidedAt, topic: topic?.name ?? null, participants: input.participants, unknownFields: input.unknownFields });
    const status: DecisionStatus = input.asDraft || missing.length > 0 ? 'draft' : 'active';
    const row: Row = {
      id: newId(),
      title: input.title?.trim() || firstSentence(input.decisionText, 90),
      decisionText: input.decisionText.trim(),
      decidedAt,
      topicId: topic?.id ?? null,
      projectId: project?.id ?? null,
      participants: input.participants.map((p) => p.trim()).filter(Boolean),
      rationale: input.rationale?.trim() || null,
      consequences: input.consequences?.trim() || null,
      alternatives: input.alternatives,
      status,
      validFrom: normalizeDateInput(input.validFrom ?? null),
      validUntil: normalizeDateInput(input.validUntil ?? null),
      supersedesDecisionId: null,
      sourceIds: input.sourceIds,
      confidence: input.confidence,
      missingFields: missing,
      unknownFields: input.unknownFields,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db.insert(decisions).values(row).run();
      this.syncGraph(row);
    });
    this.audit.log({ action: 'decision.create', actor: opts.actor ?? 'user', trigger: opts.trigger ?? 'manual', confirmed: status !== 'draft', entityIds: [row.id], after: { title: row.title, status, missing } });
    void this.reindex(row.id);
    this.ctx.events.changed('decisions', 'knowledge', 'status');
    return this.get(row.id);
  }

  update(id: string, patch: Partial<DecisionInput> & { status?: DecisionStatus }, opts: { trigger?: string } = {}): Decision {
    const cur = this.db.select().from(decisions).where(eq(decisions.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Entscheidung nicht gefunden.');
    const set: Partial<Row> = { updatedAt: nowIso() };
    if (patch.title !== undefined) set.title = patch.title.trim() || cur.title;
    if (patch.decisionText !== undefined) set.decisionText = patch.decisionText.trim();
    if (patch.decidedAt !== undefined) set.decidedAt = normalizeDateInput(patch.decidedAt ?? null);
    if (patch.topic !== undefined) set.topicId = patch.topic?.trim() ? this.graph.ensureEntity('topic', patch.topic).id : null;
    if (patch.project !== undefined) set.projectId = patch.project?.trim() ? this.graph.ensureEntity('project', patch.project).id : null;
    if (patch.participants !== undefined) set.participants = patch.participants.map((p) => p.trim()).filter(Boolean);
    if (patch.rationale !== undefined) set.rationale = patch.rationale?.trim() || null;
    if (patch.consequences !== undefined) set.consequences = patch.consequences?.trim() || null;
    if (patch.alternatives !== undefined) set.alternatives = patch.alternatives;
    if (patch.validFrom !== undefined) set.validFrom = normalizeDateInput(patch.validFrom ?? null);
    if (patch.validUntil !== undefined) set.validUntil = normalizeDateInput(patch.validUntil ?? null);
    if (patch.sourceIds !== undefined) set.sourceIds = [...new Set([...cur.sourceIds, ...patch.sourceIds])];
    if (patch.unknownFields !== undefined) set.unknownFields = [...new Set([...(cur.unknownFields as string[]), ...patch.unknownFields])];

    const merged = { ...cur, ...set };
    const topicName = merged.topicId ? this.graph.getEntity(merged.topicId)?.name ?? null : null;
    const missing = computeMissingFields({ decisionText: merged.decisionText, decidedAt: merged.decidedAt, topic: topicName, participants: merged.participants, unknownFields: merged.unknownFields as DecisionField[] });
    set.missingFields = missing;
    // Entwurf wird final, sobald alle Pflichtfelder erfüllt sind (oder ausdrücklich als unbekannt bestätigt wurden)
    if (patch.status) set.status = patch.status;
    else if (cur.status === 'draft' && missing.length === 0 && !patch.asDraft) set.status = 'active';

    this.db.transaction(() => {
      this.db.update(decisions).set(set).where(eq(decisions.id, id)).run();
      this.syncGraph({ ...cur, ...set });
    });
    this.audit.log({ action: 'decision.update', actor: 'user', trigger: opts.trigger ?? 'manual', confirmed: true, entityIds: [id], before: { status: cur.status, decidedAt: cur.decidedAt }, after: { status: set.status ?? cur.status, missing } });
    void this.reindex(id);
    this.ctx.events.changed('decisions', 'knowledge', 'status');
    return this.get(id);
  }

  private syncGraph(r: Row): void {
    this.graph.registerNode('decision', r.id, r.title, r.decisionText);
    if (r.topicId) this.graph.link(r.id, r.topicId, 'concerns', { confidence: r.confidence, status: 'confirmed', sourceIds: r.sourceIds });
    if (r.projectId) this.graph.link(r.id, r.projectId, 'affects', { confidence: r.confidence, status: 'confirmed', sourceIds: r.sourceIds });
    for (const name of r.participants) {
      const person = this.graph.ensureEntity('person', name);
      this.graph.link(person.id, r.id, 'participated_in', { confidence: r.confidence, status: 'confirmed', sourceIds: r.sourceIds });
    }
    for (const src of r.sourceIds) {
      if (this.graph.getEntity(src)?.type === 'document') this.graph.link(src, r.id, 'supports', { confidence: Math.min(r.confidence, 0.8), status: 'proposed', sourceIds: [src] });
    }
  }

  /** Menschenlesbare Darstellung (Wann/Thema/Beteiligte/…). */
  format(d: Decision): string {
    const unknown = (f: DecisionField) => d.unknownFields.includes(f);
    return [
      `**Wann:** ${d.decidedAt ? d.decidedAt.slice(0, 10) : unknown('decidedAt') ? 'unbekannt (bestätigt)' : 'offen'}`,
      `**Thema:** ${d.topicName ?? (unknown('topic') ? 'unbekannt (bestätigt)' : 'offen')}${d.projectName && d.projectName !== d.topicName ? ` (Projekt: ${d.projectName})` : ''}`,
      `**Beteiligte:** ${d.participants.length ? d.participants.join(', ') : unknown('participants') ? 'unbekannt (bestätigt)' : 'offen'}`,
      `**Entscheidung:** ${d.decisionText}`,
      `**Begründung:** ${d.rationale ?? '–'}`,
      `**Auswirkungen:** ${d.consequences ?? '–'}`,
      `**Alternativen:** ${d.alternatives.length ? d.alternatives.join('; ') : '–'}`,
      `**Status:** ${d.status}`,
      `**Confidence:** ${Math.round(d.confidence * 100)} %`,
    ].join('\n');
  }

  missingLabels(d: Decision): string[] {
    return d.missingFields.map((f) => DECISION_FIELD_LABELS[f]);
  }

  /**
   * Stufe 2: ältere Entscheidung als überholt markieren (nur nach Bestätigung durch den Benutzer).
   */
  supersede(oldId: string, newId: string, opts: { confirmed: boolean; trigger?: string }): { old: Decision; new: Decision } {
    if (!opts.confirmed) throw new AppError('permission_error', 'Eine Entscheidung darf nur nach ausdrücklicher Bestätigung als überholt markiert werden.');
    if (oldId === newId) throw new AppError('validation_error', 'Eine Entscheidung kann sich nicht selbst ersetzen.');
    const oldRow = this.db.select().from(decisions).where(eq(decisions.id, oldId)).get();
    const newRow = this.db.select().from(decisions).where(eq(decisions.id, newId)).get();
    if (!oldRow || !newRow) throw new AppError('validation_error', 'Entscheidung nicht gefunden.');
    const now = nowIso();
    let relationId = '';
    this.db.transaction(() => {
      this.db.update(decisions).set({ status: 'superseded', updatedAt: now }).where(eq(decisions.id, oldId)).run();
      this.db.update(decisions).set({ supersedesDecisionId: oldId, updatedAt: now }).where(eq(decisions.id, newId)).run();
      relationId = this.graph.link(newId, oldId, 'supersedes', { confidence: 0.95, status: 'confirmed' })?.id ?? '';
    });
    this.audit.log({
      action: 'decision.supersede',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [oldId, newId],
      before: { oldStatus: oldRow.status },
      after: { oldStatus: 'superseded', newSupersedes: oldId },
      undo: {
        type: 'decision_status',
        data: {
          changes: [
            { id: oldId, status: oldRow.status, supersedesDecisionId: oldRow.supersedesDecisionId, afterUpdatedAt: now },
            { id: newId, status: newRow.status, supersedesDecisionId: newRow.supersedesDecisionId, afterUpdatedAt: now },
          ],
          relationIds: relationId ? [relationId] : [],
        },
      },
    });
    void this.reindex(oldId);
    void this.reindex(newId);
    this.ctx.events.changed('decisions', 'knowledge', 'status');
    return { old: this.get(oldId), new: this.get(newId) };
  }

  revoke(id: string, opts: { confirmed: boolean; trigger?: string }): Decision {
    if (!opts.confirmed) throw new AppError('permission_error', 'Eine Entscheidung darf nur nach ausdrücklicher Bestätigung widerrufen werden.');
    const cur = this.db.select().from(decisions).where(eq(decisions.id, id)).get();
    if (!cur) throw new AppError('validation_error', 'Entscheidung nicht gefunden.');
    const now = nowIso();
    this.db.update(decisions).set({ status: 'revoked', updatedAt: now }).where(eq(decisions.id, id)).run();
    this.audit.log({
      action: 'decision.revoke',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: cur.status },
      after: { status: 'revoked' },
      undo: { type: 'decision_status', data: { changes: [{ id, status: cur.status, supersedesDecisionId: cur.supersedesDecisionId, afterUpdatedAt: now }], relationIds: [] } },
    });
    void this.reindex(id);
    this.ctx.events.changed('decisions', 'status');
    return this.get(id);
  }

  private async reindex(id: string): Promise<void> {
    try {
      const d = this.get(id);
      await this.search.index({
        type: 'decision',
        id,
        title: d.title,
        content: [d.decisionText, d.topicName && `Thema: ${d.topicName}`, d.projectName && `Projekt: ${d.projectName}`, d.decidedAt && `Datum: ${d.decidedAt.slice(0, 10)}`, d.participants.length ? `Beteiligte: ${d.participants.join(', ')}` : '', d.rationale && `Begründung: ${d.rationale}`, d.consequences && `Auswirkungen: ${d.consequences}`, `Status: ${d.status}`].filter(Boolean).join('\n'),
      });
    } catch (err) {
      this.ctx.logger.warn('decisions', 'Indexierung fehlgeschlagen', { error: err });
    }
  }

  summary(d: Decision): string {
    return `${d.decidedAt ? d.decidedAt.slice(0, 10) : 'ohne Datum'}: ${truncate(d.title, 80)}${d.topicName ? ` [${d.topicName}]` : ''} (${normalizeName(d.status)})`;
  }
}
