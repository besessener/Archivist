import type { ChatIntent } from '@archivist/shared';
import type { AppContext } from '../../context';
import type { ActionService } from '../actions';
import type { ArchiveService } from '../archive';
import type { CaptureService } from '../capture';
import type { ConvState } from '../chat-state';
import type { ContradictionService } from '../contradictions';
import type { DecisionService } from '../decisions';
import type { DocumentService } from '../documents';
import type { InsightService } from '../insights';
import type { JobQueueService } from '../jobs';
import type { KnowledgeAnswerService } from '../knowledge-answers';
import type { KnowledgeGraphService } from '../knowledge-graph';
import type { LlmService } from '../llm';
import type { OpenItemService } from '../open-items';
import type { ScannerService } from '../scanner';
import type { SearchService } from '../search';
import type { SettingsService } from '../settings';
import type { TimelineService } from '../timeline';

/** One message of a conversation, with the conversation's state before it. */
export interface ChatTurn {
  conversationId: string;
  text: string;
  state: ConvState;
}

/** One recognized request of a message. */
export interface ChatRequest extends ChatTurn {
  intent: ChatIntent;
}

/** The services the rule-based chat works with. */
export interface ChatDeps {
  ctx: AppContext;
  settings: SettingsService;
  llm: LlmService;
  decisions: DecisionService;
  openItems: OpenItemService;
  search: SearchService;
  graph: KnowledgeGraphService;
  docs: DocumentService;
  scanner: ScannerService;
  contradictions: ContradictionService;
  insights: InsightService;
  timeline: TimelineService;
  jobs: JobQueueService;
  capture: CaptureService;
  answers: KnowledgeAnswerService;
  actions: ActionService;
  archive: ArchiveService;
}
