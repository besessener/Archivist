import fs from 'node:fs';
import type { DocumentRecord, DocumentStatus, StoredAgentAction } from '@archivist/shared';
import { toErrorInfo } from '../../util/errors';
import type { ConvState, Reply } from '../chat-state';
import { CONTRADICTION_SCAN_JOB } from '../contradictions';
import type { ChatDeps, ChatRequest } from './types';

type ArchiveDeps = Pick<ChatDeps, 'docs' | 'actions' | 'jobs' | 'openItems' | 'decisions' | 'insights' | 'scanner' | 'contradictions' | 'graph'>;
type Relation = ReturnType<ChatDeps['graph']['relationsOf']>[number];

/** How long the chat waits for the scan job before it answers with what is known so far. */
const SCAN_WAIT_MS = 20_000;

const isInInbox = (d: DocumentRecord) => d.status === 'proposed' || d.status === 'staged';

/** Archiving, status, scan, exclusions, contradictions and relations in the rule-based chat; changes only as proposal cards. */
export class ArchiveReplies {
  constructor(
    private readonly deps: ArchiveDeps,
    private readonly scatterHint: () => string,
  ) {}

  archiveExecute({ conversationId, intent, state }: ChatRequest): Reply {
    const candidates = this.inboxCandidates(state);
    if (candidates.length === 0)
      return { intent: 'archive_execute', content: 'Es gibt aktuell keine analysierten Dokumente, die auf Archivierung warten.', confidence: 0.5, state };
    const topic = intent.topic?.trim();
    const project = intent.project?.trim();
    const items = candidates.map((d) => ({
      documentId: d.id,
      mode: 'copy' as const,
      categoryPath: d.proposal?.location.categoryPath ?? d.categoryPath ?? undefined,
      // undefined (not null): without a wish the proposal applies; null would mean "explicitly without"
      topic: topic || undefined,
      project: project || undefined,
    }));
    const action = this.deps.actions.propose({
      actionType: 'archive_documents',
      label: `${items.length} Dokument(e) kopieren und archivieren${project ? ` (Projekt ${project})` : topic ? ` (Thema ${topic})` : ''}`,
      rationale: 'Auf deinen Wunsch vorbereitet. Es wird kopiert; Originale bleiben unverändert.',
      confidence: Math.min(...candidates.map((d) => d.confidence ?? 0.5)),
      affectedEntities: candidates.map((d) => ({ type: 'document' as const, id: d.id, label: d.title })),
      requiredConfirmation: 'confirm',
      proposedParameters: { items, approveNewCategories: [] },
      conversationId,
    });
    return {
      intent: 'archive_execute',
      content: `Ich habe ${items.length} Dokument(e) für die Archivierung vorbereitet (Standard: Kopieren ins Archiv):\n\n${candidates.map((d) => `• ${d.title} → ${d.proposal?.location.categoryPath ?? d.categoryPath ?? '?'}`).join('\n')}\n\nBitte bestätige – vorher kannst du in der Inbox alle Quell- und Zielpfade prüfen.`,
      actions: [action],
      context: { documents: candidates.map((d) => ({ type: 'document' as const, id: d.id, label: d.title })) },
      confidence: action.confidence,
      state,
    };
  }

  /** Documents shown last only count if they are still in the inbox; otherwise all waiting ones in the inbox. */
  private inboxCandidates(state: ConvState): DocumentRecord[] {
    const shown = (state.last?.documentIds ?? []).flatMap((id) => {
      try {
        return [this.deps.docs.get(id)];
      } catch {
        return [];
      }
    });
    const fromShown = shown.filter(isInInbox);
    if (fromShown.length) return fromShown;
    return [...this.deps.docs.list({ status: 'proposed', limit: 50 }), ...this.deps.docs.list({ status: 'staged', limit: 50 })].filter(isInInbox);
  }

  archiveStatus(state: ConvState): Reply {
    // COUNT per status instead of counting a list capped at 1000 (#222)
    const counts = this.deps.docs.counts();
    const by = (status: DocumentStatus) => counts[status] ?? 0;
    const jobs = this.deps.jobs.counts();
    const open = this.deps.openItems.list({ onlyActive: true });
    const { decisions, openItems, insights } = this.deps;
    const content = `**Archivstatus**\n• Archiviert: ${by('archived')} · nur indexiert: ${by('indexed_only')}\n• Wartet auf Zuordnung (Inbox): ${by('proposed') + by('staged')} · in Analyse: ${by('analyzing')}\n• Fehlgeschlagen: ${by('failed')}\n• Entscheidungen: ${decisions.list().length} (davon Entwürfe: ${decisions.list({ status: 'draft' }).length})\n• Offene Punkte: ${open.length}, überfällig: ${openItems.overdue().length}\n• Offene Hinweise (Insights): ${insights.openCount()}\n• Jobs: ${jobs.pending} wartend, ${jobs.running} laufend, ${jobs.failed} fehlgeschlagen`;
    return { intent: 'archive_status', content, confidence: 1, state };
  }

  scanStart(state: ConvState): Reply {
    try {
      const job = this.deps.scanner.startScan(undefined, 'chat');
      return {
        intent: 'scan_start',
        content: `Der Scan läuft (Job „${job.label}“). Ich melde mich über die Notification Bell, sobald er fertig ist. Es werden nur Dateien aufgelistet – es gehen keine Inhalte an das LLM, bevor du Dateien zur Analyse auswählst.`,
        confidence: 0.9,
        state,
      };
    } catch (err) {
      const info = toErrorInfo(err);
      return { intent: 'scan_start', content: info.message, errorMessage: info.message, confidence: 0.5, state };
    }
  }

  excludePath({ conversationId, intent, state }: ChatRequest): Reply {
    const target = intent.path?.trim();
    if (!target || (!target.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(target)))
      return {
        intent: 'exclude_path',
        content: 'Bitte nenne den vollständigen Pfad der Datei oder des Ordners, den ich künftig ignorieren soll.',
        confidence: 0.4,
        state,
      };
    const kind = pathKind(target);
    const action = this.deps.actions.propose({
      actionType: 'exclude_path',
      label: `${kind === 'dir' ? 'Ordner' : 'Datei'} dauerhaft vom Scan ausschließen: ${target}`,
      rationale: 'Ausschlüsse gelten für alle künftigen Scans.',
      confidence: 0.9,
      affectedEntities: [],
      requiredConfirmation: 'confirm',
      proposedParameters: { kind, path: target },
      conversationId,
    });
    return {
      intent: 'exclude_path',
      content: `Soll ich ${kind === 'dir' ? 'den Ordner' : 'die Datei'} **${target}** dauerhaft von Scans ausschließen?`,
      actions: [action],
      confidence: 0.9,
      state,
    };
  }

  async contradictionCheck(state: ConvState): Promise<Reply> {
    // a job of its own (visible and cancellable under Jobs); short scans still answer right away (#254)
    const queued = this.deps.jobs.enqueue(CONTRADICTION_SCAN_JOB, { label: 'Widersprüche prüfen', sameAs: () => true });
    const scan = await this.deps.jobs.waitFor(queued.id, SCAN_WAIT_MS);
    const stillRunning = scan.status === 'pending' || scan.status === 'running';
    const scanNote = stillRunning
      ? '\n\n_Die Prüfung läuft noch im Hintergrund (siehe Jobs). Neue Funde melde ich als Hinweis; frag später noch einmal nach._'
      : scan.status === 'failed'
        ? `\n\n_Die Prüfung ist fehlgeschlagen: ${scan.error ?? 'unbekannter Fehler'}_`
        : '';
    const list = this.deps.contradictions.list('detected');
    const outdated = this.deps.insights.list('open').filter((insight) => insight.kind === 'possibly_superseded');
    if (list.length === 0 && outdated.length === 0)
      return {
        intent: 'contradiction_check',
        content: `Ich habe keine widersprüchlichen Aussagen gefunden.${this.scatterHint()}${scanNote}`,
        confidence: 0.6,
        uncertainties: ['Die Prüfung erkennt nur eindeutige Gegensätze bei aktiven Entscheidungen zum gleichen Thema.'],
        state,
      };
    const insights = [...list.map((c) => this.deps.insights.byDedupeKey(`contradiction:${c.id}`)), ...outdated];
    const actions = insights.flatMap((insight) => (insight?.recommendedActionId ? [this.deps.actions.get(insight.recommendedActionId)] : []));
    const sections = [
      list.length
        ? `Ich habe ${list.length} mögliche(n) Widerspruch/Widersprüche gefunden:\n\n${list.map((c) => `**${c.title}**\n${c.description}`).join('\n\n')}`
        : '',
      outdated.length
        ? `Möglicherweise überholte Entscheidungen (${outdated.length}):\n\n${outdated.map((i) => `**${i.title}**\n${i.explanation}`).join('\n\n')}`
        : '',
    ].filter(Boolean);
    return {
      intent: 'contradiction_check',
      content: `${sections.join('\n\n')}\n\nDas sind Hinweise, keine festgestellte Wahrheit.${scanNote}`,
      actions: actions.filter((a) => a.status === 'proposed'),
      context: { contradictions: list.map((c) => ({ type: 'contradiction' as const, id: c.id, label: c.title })) },
      confidence: list.length ? Math.max(...list.map((c) => c.confidence)) : 0.5,
      state,
    };
  }

  relationDecide({ conversationId, intent, state }: ChatRequest): Reply {
    const relations = this.proposedRelations(intent.topic ?? intent.project);
    if (relations.length === 0)
      return { intent: 'relation_decide', content: 'Es gibt keine vorgeschlagenen Beziehungen, die auf deine Entscheidung warten.', confidence: 0.5, state };
    const actions: StoredAgentAction[] = [];
    const lines = relations.slice(0, 3).map((r) => {
      const source = this.deps.graph.getEntity(r.sourceEntityId)?.name ?? r.sourceEntityId;
      const target = this.deps.graph.getEntity(r.targetEntityId)?.name ?? r.targetEntityId;
      // one card per relation: confirming adopts it, rejecting discards it
      actions.push(
        this.deps.actions.propose({
          actionType: 'confirm_relation',
          label: `Beziehung: ${source} → ${r.relationType} → ${target}`,
          rationale: `Vorgeschlagene Beziehung (Confidence ${Math.round(r.confidence * 100)} %). Bestätigen übernimmt sie, Ablehnen verwirft sie.`,
          confidence: r.confidence,
          affectedEntities: [],
          requiredConfirmation: 'confirm',
          proposedParameters: { relationId: r.id },
          conversationId,
        }),
      );
      return `• ${source} → ${r.relationType} → ${target} (${Math.round(r.confidence * 100)} %)`;
    });
    return { intent: 'relation_decide', content: `Diese Beziehungen sind noch ungeklärt:\n\n${lines.join('\n')}`, actions, confidence: 0.7, state };
  }

  /** Proposed relations of the named topic/project, otherwise of all entries (each relation once). */
  private proposedRelations(name: string | null | undefined): Relation[] {
    const { graph } = this.deps;
    const subject = name ? (graph.findByName('topic', name) ?? graph.findByName('project', name)) : undefined;
    if (subject) return graph.relationsOf(subject.id, { statuses: ['proposed'] });
    const seen = new Set<string>();
    return graph
      .listEntities({ limit: 200 })
      .flatMap((e) => graph.relationsOf(e.id, { statuses: ['proposed'] }))
      .filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
  }
}

/** A path that cannot be read counts as a directory if it ends in a separator or has no file extension. */
function pathKind(target: string): 'file' | 'dir' {
  try {
    return fs.statSync(target).isDirectory() ? 'dir' : 'file';
  } catch {
    return /[\\/]$/.test(target) || !/\.[a-z0-9]{2,5}$/i.test(target) ? 'dir' : 'file';
  }
}
