import fs from 'node:fs';
import path from 'node:path';
import { DECISION_FIELD_LABELS, localDate, localToday, type Decision, type DocumentProposal } from '@archivist/shared';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents, insights as insightsTable, notifications as notificationsTable, relations } from '../db/schema';
import { newId } from '../util/ids';
import { sha256Text } from '../util/hash';
import { truncate } from '../util/text';
import { chooseTargetFolder, folderLabel, splitSubjects } from './archive-structure';
import { checkTopicProjectNames } from './cleanup/topic-project-names';
import type { EntityDuplicateCheck } from './cleanup/entity-duplicates';
import type { ContradictionService } from './contradictions';
import type { DecisionService } from './decisions';
import { ACTIVE_DECISION_STATUSES } from './decisions';
import type { InsightService } from './insights';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { NotificationService } from './notifications';
import type { OpenItemService } from './open-items';
import { IntervalSchedule, type LastRunStore } from './scheduler';
import type { SettingsService } from './settings';

export interface ConsistencyReport {
  insights: number;
  notifications: number;
  contradictions: number;
  byKind: Record<string, number>;
  /** Hints that were not open before this run (new or reopened insights, new notifications). */
  newFindings: number;
  /** Short German summary for the job history. */
  summary: string;
}

const KIND_LABELS: Record<string, string> = {
  orphan_document: 'Dokumente ohne Zuordnung',
  missing_metadata: 'fehlende Metadaten',
  duplicate: 'mögliche Duplikate',
  duplicate_note: 'doppelte Notizen',
  duplicate_event: 'doppelte Ereignisse',
  misplaced_file: 'Ablageort-Auffälligkeiten',
  scattered_documents: 'verstreut abgelegte Dokumente',
  similar_topics: 'ähnliche Themen',
  topic_project_name: 'gleiche Namen bei Thema und Projekt',
  similar_entities: 'mögliche Dubletten',
  incomplete_decision: 'unvollständige Entscheidungen',
  possibly_superseded: 'möglicherweise überholte Entscheidungen',
  contradiction: 'Widersprüche',
  open_item: 'offene Punkte mit Handlungsbedarf',
  outdated_info: 'widersprüchliche Status',
  low_confidence_relation: 'ungeklärte Beziehungen',
  external_file: 'externe Dateien mit Archivbezug',
  duplicate_open_item: 'doppelte offene Punkte',
  persons_merged: 'automatisch zusammengeführte Personen-Einträge',
  unclear_person: 'unklare Personen-Zuordnungen',
};

/** An additional archive check step (cleanup detectors in services/cleanup); `count` adds to the summary per kind. */
/** The document columns the check reads – never extracted_text (#213). */
const CHECKED_COLUMNS = {
  id: documents.id,
  title: documents.title,
  status: documents.status,
  sha256: documents.sha256,
  textHash: documents.textHash,
  archiveRelPath: documents.archiveRelPath,
  categoryPath: documents.categoryPath,
  topicId: documents.topicId,
  projectId: documents.projectId,
};
type CheckedDocument = Pick<typeof documents.$inferSelect, keyof typeof CHECKED_COLUMNS>;

export type ConsistencyCheck = (count: (kind: string, n?: number) => void) => void | Promise<void>;

/** Key prefixes of the hints this check owns; a hint whose cause no longer exists is closed after each run. */
const RECONCILED_INSIGHTS = [
  'missing-topic',
  'missing-category',
  'dup:',
  'missing-file:',
  'misplaced:',
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
 * Active archive maintenance: regularly checks the archive for consistency and only creates hints
 * (insights, notifications, action proposals) – without changing anything itself.
 */
export class ConsistencyService {
  /** Periodic check; every completed run (also manual or on startup) restarts the interval */
  private readonly schedule: IntervalSchedule;
  private enqueueInterval: (() => void) | null = null;
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
    private readonly entityDuplicates: EntityDuplicateCheck,
    lastRun?: LastRunStore,
  ) {
    this.schedule = new IntervalSchedule({ name: 'consistency', run: () => this.enqueueInterval?.(), logger: ctx.logger, lastRun });
  }

  private get db() {
    return this.ctx.database.db;
  }

  /** Registers an additional check step; it runs after the open-item checks of every archive check. */
  addCheck(check: ConsistencyCheck): void {
    this.extraChecks.push(check);
  }

  /** Documents of the same topic or project that lie in different archive directories: hint plus relocation proposal. */
  private checkScatteredDocuments(archived: CheckedDocument[], count: (kind: string) => void): void {
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
      // only dated decisions: the capture date says nothing about which decision is newer (#168)
      const sorted = list.filter((d) => d.decidedAt).sort((a, b) => a.decidedAt!.localeCompare(b.decidedAt!));
      for (let i = 0; i < sorted.length - 1; i += 1) {
        const older = sorted[i]!;
        const newer = sorted[i + 1]!;
        if (older.decidedAt === newer.decidedAt) continue;
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
    const openBefore = this.openFindingIds();
    const count = (k: string, n = 1) => (byKind[k] = (byKind[k] ?? 0) + n);
    // local calendar day, otherwise items are "due today" for two more hours after midnight (#77)
    const today = localToday();
    const staleDays = this.settings.get().consistency.staleOpenItemDays;

    // ---- Documents ----
    step(0.1, 'Prüfe Dokumente');
    // metadata only: SELECT * loaded every extracted text (up to 400k chars each) into the main process (#213)
    const archived = this.db
      .select(CHECKED_COLUMNS)
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

    // ---- Duplicates ----
    const bySha = new Map<string, typeof archived>();
    for (const d of archived) bySha.set(d.sha256, [...(bySha.get(d.sha256) ?? []), d]);
    const bySimilarText = new Map<string, typeof archived>();
    for (const d of archived) if (d.textHash) bySimilarText.set(d.textHash, [...(bySimilarText.get(d.textHash) ?? []), d]);
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

    // ---- Storage location vs. classification (database against file system) ----
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

    // ---- Scattered filing: documents of the same topic/project lie in different directories ----
    step(0.4, 'Prüfe Verzeichnisse');
    this.checkScatteredDocuments(archived, count);

    // ---- Duplicate topics, projects and tags (always asks, never merges on its own) ----
    step(0.45, 'Prüfe Themen, Projekte und Tags');
    await this.entityDuplicates.run(count, signal);

    // ---- Same name as topic and as project ----
    checkTopicProjectNames({ graph: this.graph, insights: this.insights }, count);

    // ---- Decisions ----
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

    // ---- Open items ----
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
      const due = i.dueAt ? localDate(i.dueAt) : null;
      if (due && due < today) {
        currentNotifications.add(`overdue:${i.id}:${due}`);
        this.notifications.create({
          title: `Überfällig: ${i.title}`,
          description: `Fällig war der ${due}.`,
          type: 'open_item_overdue',
          priority: 'high',
          affectedEntityIds: [i.id],
          proposedActions: [
            { label: 'Offene Punkte öffnen', kind: 'navigate', target: '/open-items/' },
            { label: 'Morgen erneut', kind: 'snooze' },
          ],
          dedupeKey: `overdue:${i.id}:${due}`,
        });
        notifs += 1;
        count('open_item');
      } else if (due === today) {
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
    // task documented as open and completed at the same time
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

    // ---- Relations with low confidence ----
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

    // ---- External, already analyzed files related to known topics ----
    const pending = this.db
      .select({
        id: documents.id,
        title: documents.title,
        proposal: documents.proposal,
        sourcePath: documents.sourcePath,
        stagedPath: documents.stagedPath,
        confidence: documents.confidence,
      })
      .from(documents)
      .where(eq(documents.status, 'proposed'))
      .all();
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
    const newFindings = [...this.openFindingIds()].filter((id) => !openBefore.has(id)).length;
    const overview =
      total === 0
        ? 'keine Auffälligkeiten'
        : `${total} Hinweis(e): ${Object.entries(byKind)
            .map(([k, v]) => `${v}× ${KIND_LABELS[k] ?? k}`)
            .join(', ')}`;
    const summary = `${newFindings === 0 ? 'Nichts Neues' : newFindings === 1 ? '1 neuer Hinweis' : `${newFindings} neue Hinweise`} – ${overview}.`;
    // the completion is recorded in the job history; a notification only announces new findings (#80)
    if (newFindings > 0)
      this.notifications.create({
        title: newFindings === 1 ? 'Archivprüfung: 1 neuer Hinweis' : `Archivprüfung: ${newFindings} neue Hinweise`,
        description: `Insgesamt ${overview}.`,
        type: 'consistency_done',
        priority: 'low',
        proposedActions: [{ label: 'Insights öffnen', kind: 'navigate', target: '/insights/' }],
        dedupeKey: `consistency:${newId()}`,
      });
    this.schedule.markRun();
    report?.(1, 'Fertig');
    this.ctx.logger.info('consistency', 'Archive check completed', { trigger, byKind, newFindings });
    this.ctx.events.changed('insights', 'notifications', 'status');
    return { insights: total, notifications: notifs, contradictions: found.length, byKind, newFindings, summary };
  }

  /** Ids of open insights and unresolved notifications (except completion notices); compared before and after a run. */
  private openFindingIds(): Set<string> {
    const open = this.db.select({ id: insightsTable.id }).from(insightsTable).where(eq(insightsTable.status, 'open')).all();
    const unresolved = this.db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(and(isNull(notificationsTable.resolvedAt), ne(notificationsTable.type, 'consistency_done')))
      .all();
    return new Set([...open, ...unresolved].map((r) => r.id));
  }

  /**
   * Periodic check while the application runs; `enqueue` starts one check. The interval continues from the last run
   * (also across restarts); `startupCheckQueued` counts a check queued at startup as that run, so an overdue
   * interval does not start a second one.
   */
  startTimer(enqueue: () => void, opts: { startupCheckQueued?: boolean } = {}): void {
    this.enqueueInterval = enqueue;
    if (opts.startupCheckQueued) this.schedule.markRun();
    this.applySettings();
    this.schedule.start();
  }

  /** Re-plans the periodic check from the settings (an interval of 0 turns it off); call it after every settings change. */
  applySettings(): void {
    const hours = this.settings.get().consistency.intervalHours;
    this.schedule.setInterval(hours > 0 ? hours * 3_600_000 : null);
  }

  /** When the next periodic check is due (epoch ms), or null if none is planned. */
  nextRunAt(): number | null {
    return this.schedule.nextRunAt();
  }

  stopTimer(): void {
    this.schedule.stop();
  }
}
