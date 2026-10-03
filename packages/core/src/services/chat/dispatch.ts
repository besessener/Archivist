import { CaptureService } from '../capture';
import type { Reply } from '../chat-state';
import { ArchiveReplies } from './archive-replies';
import type { ConversationStore } from './conversation-store';
import { FilingReplies } from './filing';
import { historyLines } from './intent-prompt';
import { LookupReplies } from './lookup-replies';
import { ChatProposals } from './proposals';
import type { ChatDeps, ChatRequest } from './types';

const HELP_TEXT =
  'Ich bin Archivist, dein persönlicher Archivar. Du kannst mir Entscheidungen und Notizen mitteilen („Wir haben entschieden, dass …“), Fragen zum Archiv stellen („Wann haben wir … entschieden?“), Dokumente suchen, offene Punkte erfassen, Erinnerungen setzen oder Dateien hierher ziehen, damit ich sie archiviere.';

/** Routes one recognized request to the module that handles it. */
export class ChatDispatcher {
  readonly proposals: ChatProposals;
  private readonly lookups: LookupReplies;
  private readonly filing: FilingReplies;
  private readonly archiveReplies: ArchiveReplies;

  constructor(
    private readonly deps: ChatDeps,
    private readonly store: ConversationStore,
  ) {
    this.proposals = new ChatProposals(deps.actions, store);
    this.lookups = new LookupReplies(deps);
    this.filing = new FilingReplies(deps);
    this.archiveReplies = new ArchiveReplies(deps, () => this.filing.scatterHint());
  }

  /** `request.state.pending` is only set if this request answers the open follow-up question. */
  async dispatch(request: ChatRequest, options: { viaLlm: boolean }): Promise<Reply> {
    const { conversationId, text, intent, state } = request;
    // capturing is the capture module's – the agent tools use it too (#307)
    if (CaptureService.handles(intent.intent)) return this.deps.capture.handle({ conv: conversationId, text, intent, state }, { viaLlm: options.viaLlm });
    switch (intent.intent) {
      case 'knowledge_question':
        return this.deps.answers.knowledgeQuestion({ ...request, history: historyLines(this.store.recent(conversationId, 7)) });
      case 'document_search':
        return this.lookups.documentSearch(request);
      case 'timeline_query':
        return this.lookups.timelineQuery(request);
      case 'proposal_confirm':
      case 'proposal_reject':
        return this.proposals.decide(request);
      case 'archive_execute':
        return this.archiveReplies.archiveExecute(request);
      case 'archive_status':
        return this.archiveReplies.archiveStatus(state);
      case 'archive_structure':
        return this.filing.structure(request);
      case 'archive_reorganize':
        return this.filing.reorganize(request);
      case 'scan_start':
        return this.archiveReplies.scanStart(state);
      case 'exclude_path':
        return this.archiveReplies.excludePath(request);
      case 'contradiction_check':
        return this.archiveReplies.contradictionCheck(state);
      case 'relation_decide':
        return this.archiveReplies.relationDecide(request);
      default:
        return { intent: intent.intent, content: HELP_TEXT, confidence: intent.confidence, state };
    }
  }
}
