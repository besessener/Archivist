import type { ChatIntent } from '@archivist/shared';
import type { AppContext } from '../../context';
import type { ActionService } from '../actions';
import type { ConvState } from '../chat-state';
import type { ContradictionService } from '../contradictions';
import type { DecisionService } from '../decisions';
import type { EventService } from '../events';
import type { InsightService } from '../insights';
import type { KnowledgeGraphService } from '../knowledge-graph';
import type { NoteService } from '../notes';
import type { OpenItemService } from '../open-items';
import type { PersonService } from '../persons';
import type { ReminderService } from '../reminders';
import type { SettingsService } from '../settings';

/** The services the capture handlers work with. */
export interface CaptureDeps {
  ctx: AppContext;
  settings: SettingsService;
  decisions: DecisionService;
  openItems: OpenItemService;
  reminders: ReminderService;
  graph: KnowledgeGraphService;
  persons: PersonService;
  contradictions: ContradictionService;
  insights: InsightService;
  notes: NoteService;
  events: EventService;
  /** wired after construction: the action service itself depends on the capture service */
  actions: () => ActionService;
}

/** One capture request: conversation id ('' outside a conversation), the user's text, its intent and the conversation state. */
export interface CaptureRequest {
  conv: string;
  text: string;
  intent: ChatIntent;
  state: ConvState;
}
