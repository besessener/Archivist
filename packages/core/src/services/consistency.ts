import fs from 'node:fs';
import path from 'node:path';
import { DECISION_FIELD_LABELS, type DocumentProposal } from '@archivist/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents, relations } from '../db/schema';
import { newId } from '../util/ids';
import { sha256Text } from '../util/hash';
import { truncate } from '../util/text';
import { chooseTargetFolder, folderLabel, splitSubjects } from './archive-structure';
import type { ActionService } from './actions';
import type { ContradictionService } from './contradictions';
import type { DecisionService } from './decisions';
import { ACTIVE_DECISION_STATUSES } from './decisions';
import type { InsightService } from './insights';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { NotificationService } from './notifications';
import type { OpenItemService } from './open-items';
import type { SettingsService } from './settings';

export interface ConsistencyReport {
  insights: number;
  notifications: number;
  contradictions: number;
  byKind: Record<string, number>;
}

const KIND_LABELS: Record<string, string> = {
  orphan_document: 'Dokumente ohne Zuordnung',
  missing_metadata: 'fehlende Metadaten',
  duplicate: 'mögliche Duplikate',
  misplaced_file: 'Ablageort-Auffälligkeiten',
  scattered_documents: 'verstreut abgelegte Dokumente',
  similar_topics: 'ähnliche Themen',
  incomplete_decision: 'unvollständige Entscheidungen',
  possibly_superseded: 'möglicherweise überholte Entscheidungen',
  contradiction: 'Widersprüche',
  open_item: 'offene Punkte mit Handlungsbedarf',
  outdated_info: 'widersprüchliche Status',
  low_confidence_relation: 'ungeklärte Beziehungen',
  external_file: 'externe Dateien mit Archivbezug',
};

const h = (ids: string[]) => sha256Text([...ids].sort().join('|')).slice(0, 12);

/**
 * Aktive Archivpflege: prüft das Archiv regelmäßig auf Konsistenz und erzeugt ausschließlich Hinweise
 * (Insights, Benachrichtigungen, Aktionsvorschläge) – ohne selbst etwas zu ändern.
 */
export class ConsistencyService {
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly decisions: DecisionService,
    private readonly openItems: OpenItemService,
    private readonly graph: KnowledgeGraphService,
    private readonly contradictions: ContradictionService,
    private readonly insights: InsightService,
    private readonly notifications: NotificationService,
    private readonly actions: ActionService,
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  /** Dokumente zum selben Thema oder Projekt, die in verschiedenen Archivverzeichnissen liegen: Hinweis plus Umlager-Vorschlag. */
  private checkScatteredDocuments(archived: Array<typeof documents.$inferSelect>, count: (kind: string) => void): void {
    const entityName = (id: string | null) => (id ? (this.graph.getEntity(id)?.name ?? null) : null);
    const placed = archived
      .filter((d) => d.status === 'archived' && d.archiveRelPath)
      .map((d) => ({ id: d.id, title: d.title, archiveRelPath: d.archiveRelPath, topicName: entityName(d.topicId), projectName: entityName(d.projectId) }));
    const keepScattered = new Set<string>();
    for (const s of splitSubjects(placed)) {
      const all = s.groups.flatMap((g) => g.docs);
      // der Schlüssel enthält die Verteilung: ändert sie sich (z. B. nach dem Umlagern), erledigt sich der Hinweis von selbst
      const key = `scattered:${s.kind}:${s.name}:${h(s.groups.flatMap((g) => g.docs.map((d) => `${d.id}@${g.folder}`)))}`;
      keepScattered.add(key);
      if (this.insights.has(key)) continue;
      const target = chooseTargetFolder(s.groups);
      const movable = target ? s.groups.filter((g) => g.folder !== target).flatMap((g) => g.docs) : [];
      const action =
        target && movable.length
          ? this.actions.propose({
              actionType: 'relocate_documents',
              label: `${movable.length} Dokument(e) zu „${s.name}“ nach „${target}“ verschieben`,
              rationale: `Die Dokumente zu ${s.kind} „${s.name}“ liegen in ${s.groups.length} Verzeichnissen; in „${target}“ liegen schon die meisten.`,
              confidence: 0.7,
              affectedEntities: movable.map((d) => ({ type: 'document' as const, id: d.id, label: d.title })),
              requiredConfirmation: 'confirm',
              proposedParameters: { items: movable.map((d) => ({ documentId: d.id, categoryPath: target })) },
            })
          : null;
      this.insights.upsert({
        kind: 'scattered_documents',
        title: `${s.kind} „${s.name}“: Dokumente liegen in ${s.groups.length} Verzeichnissen`,
        explanation: `${s.groups.map((g) => `• ${folderLabel(g.folder)} (${g.docs.length}): ${g.docs.map((d) => truncate(d.title, 50)).join('; ')}`).join('\n')}\n\nDas Verschieben erfordert deine Bestätigung; nichts wird überschrieben, und es lässt sich rückgängig machen.`,
        confidence: 0.8,
        affected: all.slice(0, 15).map((d) => ({ type: 'document' as const, id: d.id, label: d.title })),
        sourceIds: all.map((d) => d.id),
        recommendedActionId: action?.id,
        recommendedActionLabel: action ? 'In einen Ordner verschieben' : undefined,
        dedupeKey: key,
      });
      count('scattered_documents');
    }
    this.insights.retireOpen('scattered:', keepScattered);
  }

  async run(trigger = 'manual', report?: (p: number, m: string) => void): Promise<ConsistencyReport> {
    const byKind: Record<string, number> = {};
    let notifs = 0;
    const count = (k: string, n = 1) => (byKind[k] = (byKind[k] ?? 0) + n);
    const today = new Date().toISOString().slice(0, 10);
    const staleDays = this.settings.get().consistency.staleOpenItemDays;

    // ---- Dokumente ----
    report?.(0.1, 'Prüfe Dokumente');
    const archived = this.db
      .select()
      .from(documents)
      .where(inArray(documents.status, ['archived', 'indexed_only']))
      .all();
    const noTopic = archived.filter((d) => !d.topicId && !d.projectId);
    const keepMissing = new Set<string>();
    if (noTopic.length > 0) {
      const key = `missing-topic:${h(noTopic.map((d) => d.id))}`;
      keepMissing.add(key);
      this.insights.upsert({
        kind: 'orphan_document',
        title: `${noTopic.length} Dokument${noTopic.length === 1 ? '' : 'e'} ohne Thema- oder Projektzuordnung`,
        explanation: noTopic
          .slice(0, 15)
          .map((d) => `• ${d.title}`)
          .join('\n'),
        confidence: 0.9,
        affected: noTopic.slice(0, 15).map((d) => ({ type: 'document' as const, id: d.id, label: d.title })),
        sourceIds: noTopic.map((d) => d.id),
        dedupeKey: key,
      });
      count('orphan_document');
    }
    this.insights.retireOpen('missing-topic:', keepMissing);
    const noCategory = archived.filter((d) => !d.categoryPath);
    if (noCategory.length > 0) {
      this.insights.upsert({
        kind: 'missing_metadata',
        title: `${noCategory.length} Dokument(e) ohne Kategorie`,
        explanation: noCategory
          .slice(0, 15)
          .map((d) => `• ${d.title}`)
          .join('\n'),
        confidence: 0.9,
        affected: noCategory.slice(0, 15).map((d) => ({ type: 'document' as const, id: d.id, label: d.title })),
        dedupeKey: `missing-category:${h(noCategory.map((d) => d.id))}`,
      });
      count('missing_metadata');
    }

    // ---- Duplikate ----
    const bySha = new Map<string, typeof archived>();
    for (const d of archived) bySha.set(d.sha256, [...(bySha.get(d.sha256) ?? []), d]);
    const bySimilarText = new Map<string, typeof archived>();
    for (const d of archived) {
      const th = (d.technicalMeta as { textHash?: string } | null)?.textHash;
      if (th) bySimilarText.set(th, [...(bySimilarText.get(th) ?? []), d]);
    }
    for (const group of [...bySha.values(), ...bySimilarText.values()]) {
      if (group.length < 2) continue;
      const ids = group.map((d) => d.id);
      const key = `dup:${h(ids)}`;
      this.insights.upsert({
        kind: 'duplicate',
        title: `Mögliche Duplikate: ${group.map((d) => d.title).join(' / ')}`,
        explanation: `${group.length} Dokumente haben identischen Inhalt. Es wird nichts gelöscht – bitte prüfe, ob eines davon entfallen kann.`,
        confidence: 0.95,
        affected: group.map((d) => ({ type: 'document' as const, id: d.id, label: d.title })),
        sourceIds: ids,
        dedupeKey: key,
      });
      this.notifications.create({
        title: 'Mögliche Duplikate erkannt',
        description: group.map((d) => d.title).join(', '),
        type: 'duplicate',
        priority: 'low',
        affectedEntityIds: ids,
        proposedActions: [{ label: 'Insights öffnen', kind: 'navigate', target: '/insights/' }],
        dedupeKey: key,
      });
      notifs += 1;
      count('duplicate');
    }

    // ---- Ablageort vs. Klassifikation (Datenbank gegen Dateisystem) ----
    report?.(0.3, 'Prüfe Ablageorte');
    const root = this.settings.get().archiveRoot;
    for (const d of archived.filter((x) => x.archiveRelPath)) {
      const abs = path.join(root, ...d.archiveRelPath!.split('/'));
      if (!fs.existsSync(abs)) {
        this.insights.upsert({
          kind: 'misplaced_file',
          title: `Archivdatei fehlt: ${d.title}`,
          explanation: `Die Datei wurde am erwarteten Ort nicht gefunden: ${abs}. Sie wurde möglicherweise verschoben oder gelöscht.`,
          confidence: 0.95,
          affected: [{ type: 'document', id: d.id, label: d.title }],
          dedupeKey: `missing-file:${d.id}`,
        });
        count('misplaced_file');
      } else if (d.categoryPath && !path.dirname(d.archiveRelPath!).replace(/\\/g, '/').startsWith(d.categoryPath)) {
        this.insights.upsert({
          kind: 'misplaced_file',
          title: `Ablageort passt nicht zur Klassifikation: ${d.title}`,
          explanation: `Die Datei liegt in „${path.dirname(d.archiveRelPath!)}“, die Kategorie lautet „${d.categoryPath}“.`,
          confidence: 0.7,
          affected: [{ type: 'document', id: d.id, label: d.title }],
          dedupeKey: `misplaced:${d.id}:${d.categoryPath}`,
        });
        count('misplaced_file');
      }
    }

    // ---- Verstreute Ablage: Dokumente zum selben Thema/Projekt liegen in verschiedenen Verzeichnissen ----
    report?.(0.4, 'Prüfe Verzeichnisse');
    this.checkScatteredDocuments(archived, count);

    // ---- Themen ----
    report?.(0.45, 'Prüfe Themen');
    for (const { a, b, score } of this.graph.findSimilarTopics()) {
      if (this.insights.has(`similar-topics:${[a.id, b.id].sort().join('|')}`)) continue;
      const action = this.actions.propose({
        actionType: 'merge_topics',
        label: `Themen „${a.name}“ und „${b.name}“ zusammenführen`,
        rationale: `Die Namen sind sehr ähnlich (${Math.round(score * 100)} %).`,
        confidence: score,
        affectedEntities: [
          { type: 'topic', id: a.id, label: a.name },
          { type: 'topic', id: b.id, label: b.name },
        ],
        requiredConfirmation: 'confirm',
        proposedParameters: { sourceTopicId: b.id, targetTopicId: a.id },
      });
      this.insights.upsert({
        kind: 'similar_topics',
        title: `Ähnliche Themen: „${a.name}“ und „${b.name}“`,
        explanation:
          'Beide Themen sind sehr ähnlich benannt. Zusammenführen würde alle Dokumente, Entscheidungen und Beziehungen bündeln (erfordert Bestätigung).',
        confidence: score,
        affected: [
          { type: 'topic', id: a.id, label: a.name },
          { type: 'topic', id: b.id, label: b.name },
        ],
        recommendedActionId: action.id,
        recommendedActionLabel: 'Themen zusammenführen',
        dedupeKey: `similar-topics:${[a.id, b.id].sort().join('|')}`,
      });
      count('similar_topics');
    }

    // ---- Entscheidungen ----
    report?.(0.6, 'Prüfe Entscheidungen');
    const allDecisions = this.decisions.list();
    for (const d of allDecisions) {
      if (d.status === 'draft' || (d.missingFields.length > 0 && d.status !== 'revoked' && d.status !== 'superseded')) {
        const key = `incomplete-decision:${d.id}:${d.missingFields.join(',')}`;
        this.insights.upsert({
          kind: 'incomplete_decision',
          title: `Unvollständige Entscheidung: ${d.title}`,
          explanation: `Es fehlen Angaben: ${d.missingFields.map((f) => DECISION_FIELD_LABELS[f]).join(', ') || '–'}. Ergänze sie im Chat oder unter „Entscheidungen“.`,
          confidence: 1,
          affected: [{ type: 'decision', id: d.id, label: d.title }],
          dedupeKey: key,
        });
        this.notifications.create({
          title: 'Unvollständige Entscheidung',
          description: d.title,
          type: 'incomplete_decision',
          priority: 'normal',
          affectedEntityIds: [d.id],
          proposedActions: [{ label: 'Entscheidungen öffnen', kind: 'navigate', target: '/decisions/' }],
          dedupeKey: key,
        });
        notifs += 1;
        count('incomplete_decision');
      }
    }
    const byTopic = new Map<string, typeof allDecisions>();
    for (const d of allDecisions.filter((x) => ACTIVE_DECISION_STATUSES.includes(x.status) && x.topicId))
      byTopic.set(d.topicId!, [...(byTopic.get(d.topicId!) ?? []), d]);
    for (const list of byTopic.values()) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => (a.decidedAt ?? a.createdAt).localeCompare(b.decidedAt ?? b.createdAt));
      for (let i = 0; i < sorted.length - 1; i += 1) {
        const older = sorted[i]!;
        const newer = sorted[i + 1]!;
        if ((older.decidedAt ?? '') === (newer.decidedAt ?? '')) continue;
        if (this.insights.has(`superseded:${older.id}:${newer.id}`)) continue;
        const action = this.actions.propose({
          actionType: 'supersede_decision',
          label: 'Ältere Entscheidung als überholt markieren',
          rationale: `Zum Thema „${older.topicName}“ gibt es eine neuere Entscheidung.`,
          confidence: 0.5,
          affectedEntities: [
            { type: 'decision', id: older.id, label: older.title },
            { type: 'decision', id: newer.id, label: newer.title },
          ],
          requiredConfirmation: 'confirm',
          proposedParameters: { oldDecisionId: older.id, newDecisionId: newer.id },
        });
        this.insights.upsert({
          kind: 'possibly_superseded',
          title: `Möglicherweise überholt: ${older.title}`,
          explanation: `Zum Thema „${older.topicName}“ existiert eine neuere aktive Entscheidung vom ${newer.decidedAt?.slice(0, 10) ?? 'unbekanntem Datum'}: ${truncate(newer.decisionText, 160)}`,
          confidence: 0.5,
          affected: [
            { type: 'decision', id: older.id, label: older.title },
            { type: 'decision', id: newer.id, label: newer.title },
          ],
          recommendedActionId: action.id,
          recommendedActionLabel: 'Als überholt markieren',
          dedupeKey: `superseded:${older.id}:${newer.id}`,
        });
        count('possibly_superseded');
      }
    }
    report?.(0.75, 'Prüfe Widersprüche');
    const found = await this.contradictions.scanAll();
    count('contradiction', found.length);

    // ---- Offene Punkte ----
    report?.(0.85, 'Prüfe offene Punkte');
    const active = this.openItems.list({ onlyActive: true });
    const noOwner = active.filter((i) => !i.responsiblePersonId && !i.responsibleUnknown);
    if (noOwner.length) {
      const key = `no-owner:${h(noOwner.map((i) => i.id))}`;
      this.notifications.create({
        title: `${noOwner.length} offene Punkte ohne Verantwortlichen`,
        description: noOwner
          .slice(0, 5)
          .map((i) => i.title)
          .join(', '),
        type: 'open_item_no_owner',
        priority: 'low',
        affectedEntityIds: noOwner.map((i) => i.id),
        proposedActions: [{ label: 'Offene Punkte öffnen', kind: 'navigate', target: '/open-items/' }],
        dedupeKey: key,
      });
      notifs += 1;
      count('open_item');
    }
    const noDue = active.filter((i) => !i.dueAt && !i.dueUnknown);
    if (noDue.length) {
      this.notifications.create({
        title: `${noDue.length} offene Punkte ohne Fälligkeitsdatum`,
        description: noDue
          .slice(0, 5)
          .map((i) => i.title)
          .join(', '),
        type: 'open_item_no_due',
        priority: 'low',
        affectedEntityIds: noDue.map((i) => i.id),
        proposedActions: [{ label: 'Offene Punkte öffnen', kind: 'navigate', target: '/open-items/' }],
        dedupeKey: `no-due:${h(noDue.map((i) => i.id))}`,
      });
      notifs += 1;
    }
    for (const i of active) {
      if (i.dueAt && i.dueAt.slice(0, 10) < today) {
        this.notifications.create({
          title: `Überfällig: ${i.title}`,
          description: `Fällig war der ${i.dueAt.slice(0, 10)}.`,
          type: 'open_item_overdue',
          priority: 'high',
          affectedEntityIds: [i.id],
          proposedActions: [
            { label: 'Offene Punkte öffnen', kind: 'navigate', target: '/open-items/' },
            { label: 'Morgen erneut', kind: 'snooze' },
          ],
          dedupeKey: `overdue:${i.id}:${i.dueAt.slice(0, 10)}`,
        });
        notifs += 1;
        count('open_item');
      } else if (i.dueAt && i.dueAt.slice(0, 10) === today) {
        this.notifications.create({
          title: `Heute fällig: ${i.title}`,
          description: 'Dieser offene Punkt ist heute fällig.',
          type: 'open_item_due',
          priority: 'high',
          affectedEntityIds: [i.id],
          proposedActions: [{ label: 'Offene Punkte öffnen', kind: 'navigate', target: '/open-items/' }],
          dedupeKey: `due:${i.id}:${today}`,
        });
        notifs += 1;
      }
      const ageDays = (Date.now() - new Date(i.updatedAt).getTime()) / 86_400_000;
      if (ageDays > staleDays) {
        this.insights.upsert({
          kind: 'open_item',
          title: `Lange unverändert: ${i.title}`,
          explanation: `Dieser offene Punkt wurde seit ${Math.floor(ageDays)} Tagen nicht aktualisiert.`,
          confidence: 0.7,
          affected: [{ type: 'task', id: i.id, label: i.title }],
          dedupeKey: `stale:${i.id}:${Math.floor(ageDays / staleDays)}`,
        });
        count('open_item');
      }
    }
    // Aufgabe gleichzeitig offen und abgeschlossen dokumentiert
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const all = this.openItems.list();
    for (const o of all.filter((x) => ['open', 'waiting', 'blocked'].includes(x.status))) {
      const twin = all.find((x) => x.id !== o.id && x.status === 'resolved' && norm(x.title) === norm(o.title));
      if (twin) {
        this.insights.upsert({
          kind: 'outdated_info',
          title: `Widersprüchlicher Status: ${o.title}`,
          explanation: 'Ein gleichnamiger offener Punkt ist bereits als erledigt dokumentiert, ein weiterer ist noch offen.',
          confidence: 0.6,
          affected: [
            { type: 'task', id: o.id, label: o.title },
            { type: 'task', id: twin.id, label: twin.title },
          ],
          dedupeKey: `open-closed:${o.id}:${twin.id}`,
        });
        count('outdated_info');
      }
    }

    // ---- Beziehungen mit niedriger Confidence ----
    const lowRel =
      this.db
        .select({ c: sql<number>`count(*)` })
        .from(relations)
        .where(and(eq(relations.status, 'proposed'), sql`${relations.confidence} < 0.5`))
        .get()?.c ?? 0;
    if (lowRel > 0) {
      this.insights.upsert({
        kind: 'low_confidence_relation',
        title: `${lowRel} ungeklärte Beziehung(en) mit niedriger Confidence`,
        explanation: 'Diese vorgeschlagenen Beziehungen wurden noch nicht bestätigt oder abgelehnt. Prüfe sie im Bereich „Wissen“.',
        confidence: 0.5,
        dedupeKey: `low-rel:${lowRel}`,
      });
      count('low_confidence_relation');
    }

    // ---- Externe, bereits analysierte Dateien mit Bezug zu bekannten Themen ----
    const pending = this.db.select().from(documents).where(eq(documents.status, 'proposed')).all();
    for (const p of pending) {
      const prop = p.proposal as DocumentProposal | null;
      const topic = prop?.topic ?? prop?.project;
      if (topic && p.sourcePath && !p.stagedPath && (this.graph.findByName('topic', topic) || this.graph.findByName('project', topic))) {
        this.insights.upsert({
          kind: 'external_file',
          title: `Datei außerhalb des Archivs passt zu „${topic}“`,
          explanation: `${p.title} (${p.sourcePath}) ist noch nicht archiviert.`,
          confidence: p.confidence ?? 0.5,
          affected: [{ type: 'document', id: p.id, label: p.title }],
          dedupeKey: `external:${p.id}`,
        });
        count('external_file');
      }
    }

    const total = Object.values(byKind).reduce((a, b) => a + b, 0);
    if (trigger !== 'startup' || total > 0)
      this.notifications.create({
        title: 'Archivprüfung abgeschlossen',
        description:
          total === 0
            ? 'Keine Auffälligkeiten gefunden.'
            : `${total} Hinweis(e): ${Object.entries(byKind)
                .map(([k, v]) => `${v}× ${KIND_LABELS[k] ?? k}`)
                .join(', ')}.`,
        type: 'consistency_done',
        priority: 'low',
        proposedActions: [{ label: 'Insights öffnen', kind: 'navigate', target: '/insights/' }],
        dedupeKey: `consistency:${newId()}`,
      });
    this.lastRunAt = Date.now();
    report?.(1, 'Fertig');
    this.ctx.logger.info('consistency', 'Archivprüfung abgeschlossen', { trigger, byKind });
    this.ctx.events.changed('insights', 'notifications', 'status');
    return { insights: total, notifications: notifs, contradictions: found.length, byKind };
  }

  /** Periodische Prüfung, solange die Anwendung läuft. */
  startTimer(enqueue: () => void): void {
    this.stopTimer();
    const hours = this.settings.get().consistency.intervalHours;
    if (hours > 0) {
      this.timer = setInterval(() => {
        if (Date.now() - this.lastRunAt > hours * 3_600_000 * 0.9) enqueue();
      }, 10 * 60_000);
      this.timer.unref?.();
    }
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
