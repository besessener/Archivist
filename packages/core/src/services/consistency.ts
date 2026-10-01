import fs from 'node:fs';
import path from 'node:path';
import { DECISION_FIELD_LABELS, type Decision, type DocumentProposal } from '@archivist/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents, relations } from '../db/schema';
import { newId } from '../util/ids';
import { sha256Text } from '../util/hash';
import { truncate } from '../util/text';
import { chooseTargetFolder, folderLabel, splitSubjects } from './archive-structure';
import { checkTopicProjectNames } from './cleanup/topic-project-names';
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
  topic_project_name: 'gleiche Namen bei Thema und Projekt',
  incomplete_decision: 'unvollständige Entscheidungen',
  possibly_superseded: 'möglicherweise überholte Entscheidungen',
  contradiction: 'Widersprüche',
  open_item: 'offene Punkte mit Handlungsbedarf',
  outdated_info: 'widersprüchliche Status',
  low_confidence_relation: 'ungeklärte Beziehungen',
  external_file: 'externe Dateien mit Archivbezug',
  duplicate_open_item: 'doppelte offene Punkte',
};

/** An additional archive check step (cleanup detectors in services/cleanup); `count` adds to the summary per kind. */
export type ConsistencyCheck = (count: (kind: string) => void) => void | Promise<void>;

/** Key prefixes of the hints this check owns; a hint whose cause no longer exists is closed after each run. */
const RECONCILED_INSIGHTS = [
  'missing-topic',
  'missing-category',
  'dup:',
  'missing-file:',
  'misplaced:',
  'similar-topics:',
  'incomplete-decision:',
  'superseded:',
  'stale:',
  'open-closed:',
  'low-rel',
  'external:',
];
const RECONCILED_NOTIFICATIONS = ['dup:', 'incomplete-decision:', 'no-owner:', 'no-due:', 'overdue:', 'due:'];

const h = (ids: string[]) => sha256Text([...ids].sort().join('|')).slice(0, 12);

/**
 * Aktive Archivpflege: prüft das Archiv regelmäßig auf Konsistenz und erzeugt ausschließlich Hinweise
 * (Insights, Benachrichtigungen, Aktionsvorschläge) – ohne selbst etwas zu ändern.
 */
export class ConsistencyService {
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt = 0;
  private readonly extraChecks: ConsistencyCheck[] = [];

  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly decisions: DecisionService,
    private readonly openItems: OpenItemService,
    private readonly graph: KnowledgeGraphService,
    private readonly contradictions: ContradictionService,
    private readonly insights: InsightService,
    private readonly notifications: NotificationService,
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  /** Registers an additional check step; it runs after the open-item checks of every archive check. */
  addCheck(check: ConsistencyCheck): void {
    this.extraChecks.push(check);
  }

  /** Dokumente zum selben Thema oder Projekt, die in verschiedenen Archivverzeichnissen liegen: Hinweis plus Umlager-Vorschlag. */
  private checkScatteredDocuments(archived: Array<typeof documents.$inferSelect>, count: (kind: string) => void): void {
    const entityIds = new Map<string, string>();
    const entityName = (kind: 'topic' | 'project', id: string | null) => {
      const name = id ? (this.graph.getEntity(id)?.name ?? null) : null;
      if (id && name) entityIds.set(`${kind}:${name.trim()}`, id);
      return name;
    };
    const placed = archived
      .filter((d) => d.status === 'archived' && d.archiveRelPath)
      .map((d) => ({
        id: d.id,
        title: d.title,
        archiveRelPath: d.archiveRelPath,
        topicName: entityName('topic', d.topicId),
        projectName: entityName('project', d.projectId),
      }));
    const keepScattered = new Set<string>();
    for (const s of splitSubjects(placed)) {
      const all = s.groups.flatMap((g) => g.docs);
      // stable per topic/project; the proposal inside is replaced when the distribution changes
      const kind = s.kind === 'Thema' ? 'topic' : 'project';
      const key = `scattered:${kind}:${entityIds.get(`${kind}:${s.name}`) ?? s.name}`;
      keepScattered.add(key);
      const target = chooseTargetFolder(s.groups);
      const movable = target ? s.groups.filter((g) => g.folder !== target).flatMap((g) => g.docs) : [];
      const shown = this.insights.upsert({
        kind: 'scattered_documents',
        title: `${s.kind} „${s.name}“: Dokumente liegen in ${s.groups.length} Verzeichnissen`,
        explanation: `${s.groups.map((g) => `• ${folderLabel(g.folder)} (${g.docs.length}): ${g.docs.map((d) => truncate(d.title, 50)).join('; ')}`).join('\n')}\n\nDas Verschieben erfordert deine Bestätigung; nichts wird überschrieben, und es lässt sich rückgängig machen.`,
        confidence: 0.8,
        affected: all.slice(0, 15).map((d) => ({ type: 'document' as const, id: d.id, label: d.title })),
        sourceIds: all.map((d) => d.id),
        action:
          target && movable.length
            ? {
                label: 'In einen Ordner verschieben',
                proposal: {
                  actionType: 'relocate_documents',
                  label: `${movable.length} Dokument(e) zu „${s.name}“ nach „${target}“ verschieben`,
                  rationale: `Die Dokumente zu ${s.kind} „${s.name}“ liegen in ${s.groups.length} Verzeichnissen; in „${target}“ liegen schon die meisten.`,
                  confidence: 0.7,
                  affectedEntities: movable.map((d) => ({ type: 'document' as const, id: d.id, label: d.title })),
                  requiredConfirmation: 'confirm',
                  proposedParameters: {
                    items: movable.map((d) => ({ documentId: d.id, categoryPath: target, fromRelPath: d.archiveRelPath ?? undefined })),
                  },
                },
              }
            : undefined,
        dedupeKey: key,
      });
      if (shown.status === 'open') count('scattered_documents');
    }
    this.insights.reconcile('scattered:', keepScattered);
  }

  /** Two active decisions on the same topic: the older one may be superseded (unless a contradiction covers the pair). */
  private checkSuperseded(allDecisions: Decision[], current: Set<string>, count: (kind: string) => void): void {
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
        if (this.contradictions.forPair(older.id, newer.id)) continue;
        const key = `superseded:${older.id}:${newer.id}`;
        current.add(key);
        const shown = this.insights.upsert({
          kind: 'possibly_superseded',
          title: `Möglicherweise überholt: ${older.title}`,
          explanation: `Zum Thema „${older.topicName}“ existiert eine neuere aktive Entscheidung vom ${newer.decidedAt?.slice(0, 10) ?? 'unbekanntem Datum'}: ${truncate(newer.decisionText, 160)}`,
          confidence: 0.5,
          affected: [
            { type: 'decision', id: older.id, label: older.title },
            { type: 'decision', id: newer.id, label: newer.title },
          ],
          action: {
            label: 'Als überholt markieren',
            proposal: {
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
            },
          },
          dedupeKey: key,
        });
        if (shown.status === 'open') count('possibly_superseded');
      }
    }
  }

  /** `signal`: cancels the check between its sections (insights found so far are kept). */
  async run(trigger = 'manual', report?: (p: number, m: string) => void, signal?: AbortSignal): Promise<ConsistencyReport> {
    const step = (p: number, m: string) => {
      signal?.throwIfAborted();
      report?.(p, m);
    };
    const byKind: Record<string, number> = {};
    let notifs = 0;
    const count = (k: string, n = 1) => (byKind[k] = (byKind[k] ?? 0) + n);
    const today = new Date().toISOString().slice(0, 10);
    const staleDays = this.settings.get().consistency.staleOpenItemDays;

    // ---- Dokumente ----
    step(0.1, 'Prüfe Dokumente');
    const archived = this.db
      .select()
      .from(documents)
      .where(inArray(documents.status, ['archived', 'indexed_only']))
      .all();
    const noTopic = archived.filter((d) => !d.topicId && !d.projectId);
    // keys are stable (kind plus object id, or just the kind for aggregated hints); after the run, every hint whose
    // cause is gone is removed together with its open proposal
    const current = new Set<string>();
    const currentNotifications = new Set<string>();
    if (noTopic.length > 0) {
      const key = 'missing-topic';
      current.add(key);
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
    const noCategory = archived.filter((d) => !d.categoryPath);
    if (noCategory.length > 0) {
      current.add('missing-category');
      this.insights.upsert({
        kind: 'missing_metadata',
        title: `${noCategory.length} Dokument(e) ohne Kategorie`,
        explanation: noCategory
          .slice(0, 15)
          .map((d) => `• ${d.title}`)
          .join('\n'),
        confidence: 0.9,
        affected: noCategory.slice(0, 15).map((d) => ({ type: 'document' as const, id: d.id, label: d.title })),
        sourceIds: noCategory.map((d) => d.id),
        dedupeKey: 'missing-category',
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
      if (current.has(key)) continue;
      current.add(key);
      currentNotifications.add(key);
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
    step(0.3, 'Prüfe Ablageorte');
    const root = this.settings.get().archiveRoot;
    for (const d of archived.filter((x) => x.archiveRelPath)) {
      const abs = path.join(root, ...d.archiveRelPath!.split('/'));
      if (!fs.existsSync(abs)) {
        current.add(`missing-file:${d.id}`);
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
        current.add(`misplaced:${d.id}`);
        this.insights.upsert({
          kind: 'misplaced_file',
          title: `Ablageort passt nicht zur Klassifikation: ${d.title}`,
          explanation: `Die Datei liegt in „${path.dirname(d.archiveRelPath!)}“, die Kategorie lautet „${d.categoryPath}“.`,
          confidence: 0.7,
          affected: [{ type: 'document', id: d.id, label: d.title }],
          dedupeKey: `misplaced:${d.id}`,
        });
        count('misplaced_file');
      }
    }

    // ---- Verstreute Ablage: Dokumente zum selben Thema/Projekt liegen in verschiedenen Verzeichnissen ----
    step(0.4, 'Prüfe Verzeichnisse');
    this.checkScatteredDocuments(archived, count);

    // ---- Themen ----
    step(0.45, 'Prüfe Themen');
    for (const { a, b, score } of this.graph.findSimilarTopics()) {
      const key = `similar-topics:${[a.id, b.id].sort().join('|')}`;
      current.add(key);
      const shown = this.insights.upsert({
        kind: 'similar_topics',
        title: `Ähnliche Themen: „${a.name}“ und „${b.name}“`,
        explanation:
          'Beide Themen sind sehr ähnlich benannt. Zusammenführen würde alle Dokumente, Entscheidungen und Beziehungen bündeln (erfordert Bestätigung).',
        confidence: score,
        affected: [
          { type: 'topic', id: a.id, label: a.name },
          { type: 'topic', id: b.id, label: b.name },
        ],
        action: {
          label: 'Themen zusammenführen',
          proposal: {
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
          },
        },
        dedupeKey: key,
      });
      if (shown.status === 'open') count('similar_topics');
    }

    // ---- Gleicher Name als Thema und als Projekt ----
    checkTopicProjectNames({ graph: this.graph, insights: this.insights }, count);

    // ---- Entscheidungen ----
    step(0.6, 'Prüfe Entscheidungen');
    const allDecisions = this.decisions.list();
    for (const d of allDecisions) {
      if (d.status === 'draft' || (d.missingFields.length > 0 && d.status !== 'revoked' && d.status !== 'superseded')) {
        const key = `incomplete-decision:${d.id}`;
        current.add(key);
        currentNotifications.add(key);
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
    // contradictions first: a pair with a contradiction gets no additional "possibly superseded" hint
    step(0.7, 'Prüfe Widersprüche');
    const found = await this.contradictions.scanAll();
    signal?.throwIfAborted();
    count('contradiction', found.length);
    this.checkSuperseded(allDecisions, current, count);

    // ---- Offene Punkte ----
    step(0.85, 'Prüfe offene Punkte');
    const active = this.openItems.list({ onlyActive: true });
    // notifications that were dismissed are never revived, so aggregated ones keep their member hash; outdated ones are closed
    const noOwner = active.filter((i) => !i.responsiblePersonId && !i.responsibleUnknown);
    if (noOwner.length) {
      const key = `no-owner:${h(noOwner.map((i) => i.id))}`;
      currentNotifications.add(key);
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
      currentNotifications.add(`no-due:${h(noDue.map((i) => i.id))}`);
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
        currentNotifications.add(`overdue:${i.id}:${i.dueAt.slice(0, 10)}`);
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
        currentNotifications.add(`due:${i.id}:${today}`);
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
        current.add(`stale:${i.id}`);
        this.insights.upsert({
          kind: 'open_item',
          title: `Lange unverändert: ${i.title}`,
          explanation: `Dieser offene Punkt wurde seit ${Math.floor(ageDays)} Tagen nicht aktualisiert.`,
          confidence: 0.7,
          affected: [{ type: 'task', id: i.id, label: i.title }],
          dedupeKey: `stale:${i.id}`,
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
        current.add(`open-closed:${o.id}:${twin.id}`);
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

    for (const check of this.extraChecks) await check(count);

    // ---- Beziehungen mit niedriger Confidence ----
    const lowRelIds = this.db
      .select({ id: relations.id })
      .from(relations)
      .where(and(eq(relations.status, 'proposed'), sql`${relations.confidence} < 0.5`))
      .all()
      .map((r) => r.id);
    const lowRel = lowRelIds.length;
    if (lowRel > 0) {
      current.add('low-rel');
      this.insights.upsert({
        kind: 'low_confidence_relation',
        title: `${lowRel} ungeklärte Beziehung(en) mit niedriger Confidence`,
        explanation: 'Diese vorgeschlagenen Beziehungen wurden noch nicht bestätigt oder abgelehnt. Prüfe sie im Bereich „Wissen“.',
        confidence: 0.5,
        sourceIds: lowRelIds,
        dedupeKey: 'low-rel',
      });
      count('low_confidence_relation');
    }

    // ---- Externe, bereits analysierte Dateien mit Bezug zu bekannten Themen ----
    const pending = this.db.select().from(documents).where(eq(documents.status, 'proposed')).all();
    for (const p of pending) {
      const prop = p.proposal as DocumentProposal | null;
      const topic = prop?.topic ?? prop?.project;
      if (topic && p.sourcePath && !p.stagedPath && (this.graph.findByName('topic', topic) || this.graph.findByName('project', topic))) {
        current.add(`external:${p.id}`);
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

    // a cancelled check neither retires insights of sections it did not reach nor announces itself as completed
    signal?.throwIfAborted();
    for (const prefix of RECONCILED_INSIGHTS) this.insights.reconcile(prefix, current);
    for (const prefix of RECONCILED_NOTIFICATIONS) this.notifications.resolveStale(prefix, currentNotifications);

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
