import type { AgentLimits, AgentRunStatus, AgentSettings, BackgroundLimitKind, MemoryEntry } from '@archivist/shared';
import type { NotificationInput } from '../services/notifications';
import { truncate } from '../util/text';
import type { RefStore } from './registry';

export type BackgroundKind = 'inbox' | 'archive_check' | 'links' | `workflow:${string}`;

export interface BackgroundTask {
  task: string;
  trigger: `background:${string}`;
}

/** Limits of one background trigger: its own values over the general background limits (#313). */
export function backgroundLimitsFor(agent: AgentSettings, trigger: string): AgentLimits {
  const kind = trigger.replace(/^background:/, '') as BackgroundLimitKind;
  return { ...agent.backgroundLimits, ...agent.backgroundKindLimits[kind] };
}

export interface BackgroundTaskInput {
  refs: RefStore;
  /** Inbox documents still waiting to be sorted. */
  docIds: string[];
  findWorkflow: (id: string) => MemoryEntry | undefined;
  /** Steps an interrupted earlier attempt of this job finished; the resumed run does not repeat them. */
  alreadyDone: string[];
}

const ARCHIVE_CHECK_TASK =
  'Agentische Archivprüfung: Sieh dir die offenen Hinweise der Archivprüfung an (list_entries kind=insight) und das Archiv (archive_overview, problem_files, find_duplicates). Bewerte die Befunde. Räume auf, wo es eindeutig ist (z. B. falsch abgelegte Dateien verschieben, Duplikate als Duplikat markieren – nie löschen); alles andere lässt du als Hinweis stehen. Kurze Zusammenfassung am Ende.';
const LINKS_TASK =
  'Verknüpfungen pflegen mit den festen Verknüpfungsmethoden: 1. backfill_links (rückwirkender Lauf, prüft nur neue oder geänderte Einträge). 2. find_unlinked_entries: Für verwaiste Einträge mit einem eindeutig passenden Ziel link mit onUserRequest=false. 3. find_topic_clusters: Für eine eindeutige Gruppe propose_topic mit einem treffenden Namen. Alles bleibt ein VORSCHLAG – bestätige nichts selbst; vom Benutzer abgelehnte Paare schlägst du nie wieder vor. Kurze Zusammenfassung am Ende.';

/** Task and trigger of a background run (#313); null when there is nothing to do. */
export function backgroundTask(kind: BackgroundKind, input: BackgroundTaskInput): BackgroundTask | null {
  const spec = taskOf(kind, input);
  if (!spec || !input.alreadyDone.length) return spec;
  return {
    ...spec,
    task: `${spec.task}\nEin früherer Versuch wurde unterbrochen und hat schon erledigt (nicht wiederholen):\n${input.alreadyDone.map((step) => `- ${step}`).join('\n')}`,
  };
}

function taskOf(kind: BackgroundKind, input: BackgroundTaskInput): BackgroundTask | null {
  if (kind === 'inbox') return inboxTask(input);
  if (kind === 'archive_check') return { trigger: 'background:archive_check', task: ARCHIVE_CHECK_TASK };
  if (kind === 'links') return { trigger: 'background:links', task: LINKS_TASK };
  const workflow = input.findWorkflow(kind.slice('workflow:'.length));
  if (!workflow) return null;
  const steps = (workflow.data as { steps?: string[] } | null)?.steps ?? [];
  return {
    trigger: `background:workflow`,
    task: `Starte den Ablauf „${workflow.name}“ [${workflow.id}] mit run_workflow und führe seine Schritte aus: ${workflow.content}\nSchritte: ${steps.map((step, i) => `${i + 1}. ${step}`).join(' ')}`,
  };
}

function inboxTask({ refs, docIds }: BackgroundTaskInput): BackgroundTask | null {
  if (!docIds.length) return null;
  const set = refs.set(docIds);
  return {
    trigger: 'background:inbox',
    task: `Neue Dateien im Eingang: ${set} (${docIds.length} Dokument(e)). Sortiere sie ein: Wende zuerst gelernte Regeln an (apply_rules mit preview=false auf diese Dokumente; was eine Ordner-Regel trifft, wird dabei archiviert und ist erledigt), dann prüfe für den Rest den Vorschlag der Analyse (document_details) und ähnliche frühere Ablagen (similar_filings). Archiviere eindeutige Fälle mit archive_inbox (mode copy) in den passenden Ordner und setze Thema/Projekt. Unsichere Fälle lässt du im Eingang (der Vorschlag der Analyse bleibt). Zum Schluss eine kurze Zusammenfassung.`,
  };
}

export interface HandledInbox {
  docIds: string[];
  status: AgentRunStatus;
  stillProposed: (id: string) => boolean;
}

/** Inbox documents a run dealt with: a finished run decided on all of them, an interrupted one only on those it archived. */
export function handledInbox({ docIds, status, stillProposed }: HandledInbox): string[] {
  if (status === 'done' || status === 'ask_user') return docIds;
  return docIds.filter((id) => !stillProposed(id));
}

export interface BackgroundReport {
  runId: string;
  status: AgentRunStatus;
  error: string | null;
  changes: string[];
  /** Proposals waiting for the user's confirmation. */
  waiting: number;
  /** The run's answer with refs turned into names. */
  summary: string;
}

/** ONE bundled notification per background run with summary and a link to the run (#313). */
export function backgroundNotification(report: BackgroundReport): NotificationInput {
  const { changes, waiting } = report;
  const failed = report.status === 'error';
  return {
    title: failed ? 'Hintergrund-Agent: Fehler' : 'Archivist hat im Hintergrund gearbeitet',
    description: [
      changes.length ? `${changes.length} Änderung(en): ${changes.slice(0, 5).join('; ')}${changes.length > 5 ? ' …' : ''}` : null,
      waiting ? `${waiting} Vorschlag/Vorschläge warten auf deine Bestätigung.` : null,
      failed ? report.error : null,
      truncate(report.summary.replace(/\s+/g, ' '), 300),
    ]
      .filter(Boolean)
      .join(' '),
    type: 'agent_run',
    priority: waiting ? 'normal' : 'low',
    proposedActions: [
      { label: 'Lauf ansehen', kind: 'navigate', target: `/settings/?tab=agent&run=${report.runId}` },
      ...(changes.length ? [{ label: 'Rückgängig', kind: 'undo_run' as const, target: report.runId }] : []),
    ],
    dedupeKey: `agent-run:${report.runId}`,
  };
}
