import type { EntityType } from '@archivist/shared';
import { relationReason } from '../services/knowledge-graph';
import type { JobContext, JobQueueService } from '../services/jobs';
import type { LinkMethodsService } from '../services/link-methods';
import type { AppStateService } from '../services/app-state';
import type { NotificationService } from '../services/notifications';
import type { WiredServices } from './domain-services';

/** Retroactive link run (#279). */
const LINK_RUN_JOB = 'links.run';
/** Analyses a new or edited note (#273). */
const NOTE_ANALYZE_JOB = 'notes.analyze';
/** Proposes similar entries for newly indexed ones (#271). */
const LINK_SIMILAR_JOB = 'links.similar';
/** Offers links for what a chat message captured (#283). */
const CHAT_LINKS_JOB = 'links.chatSuggest';

const KIND_LABEL: Partial<Record<string, string>> = {
  project: 'Projekt',
  topic: 'Thema',
  person: 'Person',
  tag: 'Tag',
  case: 'Vorgang',
  document: 'Dokument',
  note: 'Notiz',
  decision: 'Entscheidung',
  task: 'offener Punkt',
  question: 'offene Frage',
  event: 'Ereignis',
};

type ChatLinksPayload = { entries: Array<{ id: string; type: EntityType }>; messageId: string; conversationId: string };
export type LinkProposalNotifier = (created: number) => void;

/** ONE notification for open link proposals (#280): updated in place while unread, a new one once it was read or dismissed. */
export function createLinkProposalNotifier(services: {
  links: LinkMethodsService;
  appState: AppStateService;
  notifications: NotificationService;
}): LinkProposalNotifier {
  const { links, appState, notifications } = services;
  return (created) => {
    if (created <= 0) return;
    const open = links.proposals({ limit: 1 }).total;
    if (!open) return;
    let key = appState.get('links.notification.key');
    const current = key ? notifications.byDedupeKey(key) : null;
    if (!key || current?.readAt || current?.resolvedAt) {
      key = `link-proposals:${Date.now()}`;
      appState.set('links.notification.key', key);
    }
    notifications.create({
      title: 'Verknüpfungsvorschläge',
      description: `${open === 1 ? 'Ein Vorschlag wartet' : `${open} Vorschläge warten`} auf deine Prüfung. Du entscheidest, was übernommen wird.`,
      type: 'assignment_proposal',
      priority: 'low',
      proposedActions: [{ label: 'Vorschläge prüfen', kind: 'navigate', target: '/insights/' }],
      dedupeKey: key,
    });
  };
}

/** A check that is still queued or running covers a new request (startup, interval and manual triggers can meet). */
export function linkRunEnqueuer(jobs: JobQueueService) {
  return (trigger: string) => jobs.enqueue(LINK_RUN_JOB, { label: 'Verknüpfungslauf (rückwirkend)', payload: { trigger }, maxAttempts: 2, sameAs: () => true });
}

/** What the chat reports after capturing entries: links between them, and link suggestions in a job (#283). */
export function chatLinkCallbacks(services: WiredServices, notifyLinkProposals: LinkProposalNotifier) {
  const { settings, links, jobs } = services;
  return {
    createdTogether: (entries: Array<{ id: string; type: EntityType }>, message: { id: string; text: string }) => {
      if (settings.get().links.autoPropose)
        notifyLinkProposals(links.linkCreatedTogether(entries, { evidence: `Aus derselben Nachricht: „${message.text}“`, sourceIds: [message.id] }));
    },
    suggestLinks: (entries: Array<{ id: string; type: EntityType }>, reply: { messageId: string; conversationId: string }) => {
      if (settings.get().links.autoPropose) jobs.enqueue(CHAT_LINKS_JOB, { label: 'Verknüpfungen anbieten', payload: { entries, ...reply }, maxAttempts: 1 });
    },
  };
}

/** Archive check step for links: orphans (#290), topic clusters (#281), refined kinds (#284) and the linkage history (#292). */
function addLinkConsistencyCheck(services: WiredServices, notifyLinkProposals: LinkProposalNotifier): void {
  const { consistency, links, settings, refiner } = services;
  consistency.addCheck(async (count) => {
    const orphans = await links.checkOrphans({ propose: settings.get().links.autoPropose });
    if (orphans.pending) count('orphan_entries');
    notifyLinkProposals(orphans.proposed);
    const topics = settings.get().links.autoPropose ? await links.proposeClusterTopics() : 0;
    if (topics) count('topic_cluster', topics);
    // the LLM refines confirmed „verwandt“ links only in privacy mode „automatisch“
    if (settings.get().links.autoPropose) {
      const refined = await refiner.run({ max: 10 });
      if (refined) count('relation_refinement', refined);
      notifyLinkProposals(refined);
    }
    links.recordMetrics();
  });
}

/** New, edited and indexed entries trigger link proposals, always in jobs of their own, never on the caller's path. */
function addEntryTriggers(services: WiredServices, notifyLinkProposals: LinkProposalNotifier): void {
  const { search, settings, links, jobs, events, logger } = services;
  search.onIndexed(({ id }) => {
    if (!settings.get().links.autoPropose || !links.queueSimilar([id])) return;
    // a job that has not started yet takes the entry along; a running one picks it up before it ends
    jobs.enqueue(LINK_SIMILAR_JOB, {
      label: 'Verknüpfungen für neue Einträge suchen',
      payload: {},
      maxAttempts: 2,
      sameAs: (_p, status) => status === 'pending',
    });
  });
  const enqueueNoteAnalysis = (entry: { id: string; type: string }) => {
    if (entry.type !== 'note' || !settings.get().links.autoPropose) return;
    jobs.enqueue(NOTE_ANALYZE_JOB, {
      label: 'Notiz analysieren',
      payload: { noteId: entry.id },
      maxAttempts: 2,
      sameAs: (p, status) => status === 'pending' && p.noteId === entry.id,
    });
  };
  events.on('entry:created', enqueueNoteAnalysis);
  events.on('entry:updated', enqueueNoteAnalysis);
  // entries extracted from the same document belong together (#272)
  events.on('entry:created', (entry: { id: string }) => {
    if (!settings.get().links.autoPropose) return;
    try {
      notifyLinkProposals(links.linkSameDocument(entry.id));
    } catch (err) {
      logger.warn('links', 'Linking entries of one document failed', { error: err, id: entry.id });
    }
  });
}

/** Up to 3 clickable link suggestions under the answer that captured something (#283). */
async function suggestChatLinks(services: WiredServices, job: JobContext<ChatLinksPayload>) {
  const { links, actions, chat } = services;
  const found = await links.suggestForCaptured(job.payload.entries, { limit: 3 });
  const ids = found.map((suggestion) => {
    const what = KIND_LABEL[suggestion.target.type] ?? suggestion.target.type;
    const label = ['project', 'topic', 'case'].includes(suggestion.target.type)
      ? `Das klingt nach ${what} „${suggestion.target.name}“ – verknüpfen?`
      : `Mit ${what} „${suggestion.target.name}“ verknüpfen?`;
    return actions.propose({
      actionType: 'confirm_relation',
      label,
      rationale: `Für „${suggestion.entry.name}“: ${relationReason(suggestion.relation)}`,
      confidence: Math.min(1, Math.max(0, suggestion.score)),
      affectedEntities: [
        { type: suggestion.entry.type, id: suggestion.entry.id, label: suggestion.entry.name },
        { type: suggestion.target.type, id: suggestion.target.id, label: suggestion.target.name },
      ],
      requiredConfirmation: 'confirm',
      proposedParameters: { relationId: suggestion.relation.id, offered: true },
      conversationId: job.payload.conversationId,
    }).id;
  });
  chat.attachActions(job.payload.messageId, ids);
  return { summary: `${ids.length} Verknüpfung(en) angeboten` };
}

function linkRunDescription(proposed: number, topics: number): string {
  return [
    proposed ? `${proposed} Verknüpfung${proposed === 1 ? '' : 'en'} vorgeschlagen.` : null,
    topics ? `${topics} neue${topics === 1 ? 's Thema' : ' Themen'} vorgeschlagen.` : null,
    'Du entscheidest, was übernommen wird.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** The retroactive link run (#279) and topic proposals from groups (#281): local, resumable, ONE notification at the end. */
async function runLinkBackfill(services: WiredServices, job: JobContext<{ trigger?: string }>) {
  const { links, notifications, settings } = services;
  let processed = 0;
  let proposed = 0;
  for (;;) {
    job.throwIfCancelled();
    const step = await links.backfill({
      maxEntries: 100,
      max: settings.get().links.maxProposalsPerEntry,
      signal: job.signal,
      onProgress: (done, total) => job.report(null, `${processed + done} Einträge geprüft (dieser Abschnitt: ${done} von ${total})`),
    });
    processed += step.processed;
    proposed += step.proposed;
    if (step.done || !step.processed) break;
  }
  job.throwIfCancelled();
  job.report(null, 'Suche Gruppen ähnlicher Einträge ohne Thema');
  const topics = await links.proposeClusterTopics({ signal: job.signal });
  if (proposed || topics)
    notifications.create({
      title: 'Verknüpfungsvorschläge',
      description: linkRunDescription(proposed, topics),
      type: 'assignment_proposal',
      priority: 'low',
      proposedActions: [{ label: 'Hinweise ansehen', kind: 'navigate', target: '/insights/' }],
      dedupeKey: `link-run:${job.id}`,
    });
  return { summary: `${processed} Einträge geprüft, ${proposed} Verknüpfungen und ${topics} Themen vorgeschlagen` };
}

function registerLinkJobs(services: WiredServices, notifyLinkProposals: LinkProposalNotifier): void {
  const { jobs, links, noteAnalysis, settings } = services;
  jobs.register<ChatLinksPayload>(CHAT_LINKS_JOB, { handler: (job) => suggestChatLinks(services, job) });
  jobs.register<{ trigger?: string }>(LINK_RUN_JOB, { handler: (job) => runLinkBackfill(services, job) });
  jobs.register<{ noteId: string }>(NOTE_ANALYZE_JOB, {
    handler: async (job) => {
      const analysis = await noteAnalysis.analyze(job.payload.noteId, { signal: job.signal });
      notifyLinkProposals(analysis?.proposed ?? 0);
      return { summary: analysis ? `${analysis.proposed} Verknüpfungen vorgeschlagen, ${analysis.outdated} veraltet` : 'Notiz nicht (mehr) vorhanden' };
    },
  });
  jobs.register(LINK_SIMILAR_JOB, {
    handler: async (job) => {
      const similar = await links.runPendingSimilar({ max: settings.get().links.maxProposalsPerEntry, signal: job.signal });
      notifyLinkProposals(similar.proposed);
      job.throwIfCancelled();
      return { summary: `${similar.processed} Einträge geprüft, ${similar.proposed} Verknüpfungen vorgeschlagen` };
    },
  });
}

/** Every automatic trigger of the link methods: archive check step, entry listeners and link jobs. */
export function registerLinkAutomation(services: WiredServices, notifyLinkProposals: LinkProposalNotifier): void {
  addLinkConsistencyCheck(services, notifyLinkProposals);
  addEntryTriggers(services, notifyLinkProposals);
  registerLinkJobs(services, notifyLinkProposals);
}
