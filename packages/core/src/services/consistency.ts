import { localToday } from '@archivist/shared';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { AppContext } from '../context';
import { insights as insightsTable, notifications as notificationsTable } from '../db/schema';
import { newId } from '../util/ids';
import { checkExpiredDecisions, checkIncompleteDecisions, checkSuperseded } from './archive-check/decisions';
import { checkAssignments, checkDuplicates, checkSimilarDocuments, checkedDocuments } from './archive-check/documents';
import { Findings, yieldToEventLoop, type CheckDeps, type CheckRun } from './archive-check/findings';
import { checkExternalFiles, checkLowConfidenceRelations } from './archive-check/knowledge';
import { checkOpenItems } from './archive-check/open-items';
import { checkScatteredDocuments } from './archive-check/scattered';
import { checkArchiveHashes } from './archive-check/hashes';
import { checkIndexedOriginals, checkStorage, type IndexRefresher } from './archive-check/storage';
import { RECONCILED_INSIGHTS, RECONCILED_NOTIFICATIONS, summarize } from './archive-check/summary';
import { checkTopicProjectNames } from './cleanup/topic-project-names';
import type { EntityDuplicateCheck } from './cleanup/entity-duplicates';
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

/** An additional archive check step (cleanup detectors in services/cleanup); `count` adds to the summary per kind. */
export type ConsistencyCheck = (count: (kind: string, n?: number) => void) => void | Promise<void>;

type ProgressReport = (progress: number, message: string) => void;

export type ConsistencyServiceDeps = CheckDeps & { entityDuplicates: EntityDuplicateCheck; lastRun?: LastRunStore };

/** Active archive maintenance: only creates hints, never changes anything – except re-reading a changed index-only original. */
export class ConsistencyService {
  /** Periodic check; every completed run (also manual or on startup) restarts the interval. */
  private readonly schedule: IntervalSchedule;
  private enqueueInterval: () => void = () => {};
  private readonly extraChecks: ConsistencyCheck[] = [];
  private refreshIndexedOnly: IndexRefresher = async () => false;
  private readonly deps: CheckDeps;

  private readonly ctx: AppContext;
  private readonly settings: SettingsService;
  private readonly entityDuplicates: EntityDuplicateCheck;

  constructor({ entityDuplicates, lastRun, ...checks }: ConsistencyServiceDeps) {
    ({ ctx: this.ctx, settings: this.settings } = checks);
    this.entityDuplicates = entityDuplicates;
    this.deps = checks;
    this.schedule = new IntervalSchedule({ name: 'consistency', run: () => this.enqueueInterval(), logger: checks.ctx.logger, lastRun });
  }

  /** Re-reads an index-only document whose original changed (DocumentService.refreshIndexedOnly). */
  setIndexRefresher(refresh: IndexRefresher): void {
    this.refreshIndexedOnly = refresh;
  }

  /** Registers an additional check step; it runs after the open-item checks of every archive check. */
  addCheck(check: ConsistencyCheck): void {
    this.extraChecks.push(check);
  }

  /** `signal`: cancels the check between its sections (insights found so far are kept). */
  async run({ trigger = 'manual', report, signal }: { trigger?: string; report?: ProgressReport; signal?: AbortSignal } = {}): Promise<ConsistencyReport> {
    // every section first yields to the event loop: IPC calls (chat, navigation) are answered in between (#215)
    const step = async (progress: number, message: string) => {
      await yieldToEventLoop();
      signal?.throwIfAborted();
      report?.(progress, message);
    };
    const check: CheckRun = { deps: this.deps, findings: new Findings(), signal };
    const openBefore = this.openFindingIds();
    const time = { today: localToday(), staleDays: this.settings.get().consistency.staleOpenItemDays };
    await this.checkArchive(check, step);
    await step(0.6, 'Prüfe Entscheidungen');
    const contradictions = await this.checkDecisions(check, step);
    await step(0.85, 'Prüfe offene Punkte');
    checkOpenItems(check, time);
    for (const extra of this.extraChecks) await extra(check.findings.count);
    checkLowConfidenceRelations(check);
    checkExternalFiles(check);
    // a cancelled check neither retires insights of sections it did not reach nor announces itself as completed
    signal?.throwIfAborted();
    return this.finish({ trigger, findings: check.findings, openBefore, contradictions, report });
  }

  /** Documents, storage locations, directories and duplicate named entries. */
  private async checkArchive(check: CheckRun, step: (progress: number, message: string) => Promise<void>): Promise<void> {
    await step(0.1, 'Prüfe Dokumente');
    const archived = checkedDocuments(check);
    checkAssignments(check, archived);
    checkDuplicates(check, archived);
    checkSimilarDocuments(check);
    await step(0.3, 'Prüfe Ablageorte');
    await checkStorage(check, archived);
    await checkArchiveHashes(check, archived);
    await checkIndexedOriginals(check, { archived, refresh: this.refreshIndexedOnly });
    await step(0.4, 'Prüfe Verzeichnisse');
    checkScatteredDocuments(check, archived);
    // duplicate topics, projects and tags: always asks, never merges on its own
    await step(0.45, 'Prüfe Themen, Projekte und Tags');
    await this.entityDuplicates.run(check.findings.count, check.signal);
    checkTopicProjectNames({ graph: this.deps.graph, insights: this.deps.insights }, check.findings.count);
  }

  /** Incomplete decisions, contradictions, then superseded ones; returns the number of contradictions found. */
  private async checkDecisions(check: CheckRun, step: (progress: number, message: string) => Promise<void>): Promise<number> {
    const allDecisions = this.deps.decisions.list();
    await checkIncompleteDecisions(check, allDecisions);
    // contradictions first: a pair with a contradiction gets no additional "possibly superseded" hint
    await step(0.7, 'Prüfe Widersprüche');
    const found = await this.deps.contradictions.scanAll(check.signal);
    check.findings.count('contradiction', found.length);
    checkSuperseded(check, allDecisions);
    checkExpiredDecisions(check, { decisions: allDecisions, today: localToday() });
    return found.length;
  }

  /** Closes hints whose cause is gone, announces new findings and records the run. */
  private finish(run: { trigger: string; findings: Findings; openBefore: Set<string>; contradictions: number; report?: ProgressReport }): ConsistencyReport {
    const { findings } = run;
    const { insights, notifications } = this.deps;
    for (const prefix of RECONCILED_INSIGHTS) insights.reconcile(prefix, findings.insightKeys);
    for (const prefix of RECONCILED_NOTIFICATIONS) notifications.resolveStale(prefix, findings.notificationKeys);
    const newFindings = [...this.openFindingIds()].filter((id) => !run.openBefore.has(id)).length;
    const { total, overview, summary } = summarize({ byKind: findings.byKind, newFindings });
    // the completion is recorded in the job history; a notification only announces new findings (#80)
    if (newFindings > 0)
      notifications.create({
        title: newFindings === 1 ? 'Archivprüfung: 1 neuer Hinweis' : `Archivprüfung: ${newFindings} neue Hinweise`,
        description: `Insgesamt ${overview}.`,
        type: 'consistency_done',
        priority: 'low',
        proposedActions: [{ label: 'Insights öffnen', kind: 'navigate', target: '/insights/' }],
        dedupeKey: `consistency:${newId()}`,
      });
    this.schedule.markRun();
    run.report?.(1, 'Fertig');
    this.ctx.logger.info('consistency', 'Archive check completed', { trigger: run.trigger, byKind: findings.byKind, newFindings });
    this.ctx.events.changed('insights', 'notifications', 'status');
    return { insights: total, notifications: findings.notifications, contradictions: run.contradictions, byKind: findings.byKind, newFindings, summary };
  }

  /** Ids of open insights and unresolved notifications (except completion notices); compared before and after a run. */
  private openFindingIds(): Set<string> {
    const db = this.ctx.database.db;
    const open = db.select({ id: insightsTable.id }).from(insightsTable).where(eq(insightsTable.status, 'open')).all();
    const unresolved = db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(and(isNull(notificationsTable.resolvedAt), ne(notificationsTable.type, 'consistency_done')))
      .all();
    return new Set([...open, ...unresolved].map((row) => row.id));
  }

  /** Periodic check from the last run on (also across restarts); `startupCheckQueued` counts a check queued at startup as that run. */
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
