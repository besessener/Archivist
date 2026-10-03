import { ActionService } from '../services/actions';
import { AppStateService } from '../services/app-state';
import { ArchiveService } from '../services/archive';
import { ArchiveRootService } from '../services/archive-root';
import { BackupService } from '../services/backup';
import { CaptureService } from '../services/capture';
import { CaseService } from '../services/cases';
import { ChatService } from '../services/chat';
import { EntityDuplicateCheck } from '../services/cleanup/entity-duplicates';
import { NoteEventDuplicateService } from '../services/cleanup/note-event-duplicates';
import { OpenItemDuplicateService } from '../services/cleanup/open-item-duplicates';
import { PersonDuplicateService } from '../services/cleanup/person-duplicates';
import { PersonQuestionService } from '../services/cleanup/person-questions';
import { ConsistencyService } from '../services/consistency';
import { ContradictionService } from '../services/contradictions';
import { DecisionService } from '../services/decisions';
import { DocumentService } from '../services/documents';
import { EventService } from '../services/events';
import { InsightService } from '../services/insights';
import { KnowledgeAnswerService } from '../services/knowledge-answers';
import { LinkMethodsService } from '../services/link-methods';
import { LinkThresholds } from '../services/link-thresholds';
import { NoteAnalysisService } from '../services/note-analysis';
import { NoteService } from '../services/notes';
import { OpenItemService } from '../services/open-items';
import { RelationRefiner } from '../services/relation-refiner';
import { ScannerService } from '../services/scanner';
import { SolutionService } from '../services/solutions';
import { SubjectService } from '../services/subjects';
import { TimelineService } from '../services/timeline';
import { TopicNamer } from '../services/topic-namer';
import { AgentRunService } from '../agent/runs';
import { MemoryService } from '../agent/memory';
import { registerCreatedUndo } from '../agent/created-undo';
import type { BaseServices } from './base-services';

export type DomainServices = ReturnType<typeof createDomainServices>;
export type LinkingServices = ReturnType<typeof createLinkingServices>;
export type WiredServices = BaseServices & DomainServices & LinkingServices;

/** Records, archive, consistency checks and chat, in dependency order. */
export function createDomainServices(base: BaseServices) {
  const { ctx, settings, graph, persons, search, llm, privacy, pool, audit, notifications, categories, jobs, undo, reminders, self } = base;
  const documents = new DocumentService({ ctx, settings, graph, persons, search, llm, privacy, pool, audit, notifications, categories, jobs, undo });
  const decisions = new DecisionService({ ctx, graph, persons, search, audit, undo });
  const openItems = new OpenItemService({ ctx, graph, persons, search, audit, undo });
  const eventRecords = new EventService({ ctx, graph, search, audit, persons, undo });
  const notes = new NoteService({ ctx, graph, search, audit, undo });
  const noteAnalysis = new NoteAnalysisService({ ctx, graph, persons, llm, privacy });
  const memory = new MemoryService(ctx);
  const agentRuns = new AgentRunService({ ctx, audit, undo });
  registerCreatedUndo(ctx, undo, graph, search);
  const insights = new InsightService(ctx);
  const actions = new ActionService(ctx);
  const contradictions = new ContradictionService({ ctx, decisions, graph, insights, notifications, llm });
  const archive = new ArchiveService({ ctx, settings, docs: documents, categories, graph, persons, audit, notifications, pool, undo });
  const archiveRoot = new ArchiveRootService({ ctx, settings, archive, audit, notifications, jobs, undo });
  const scanner = new ScannerService({ ctx, settings, pool, docs: documents, graph, privacy, notifications, insights, audit, jobs });
  const timeline = new TimelineService(ctx);
  const entityDuplicates = new EntityDuplicateCheck({ ctx, insights, actions, llm, privacy });
  const appState = new AppStateService(ctx);
  const consistency = new ConsistencyService({
    ctx,
    settings,
    decisions,
    openItems,
    graph,
    contradictions,
    insights,
    notifications,
    entityDuplicates,
    lastRun: appState.lastRunStore('consistency.lastRunAt'),
  });
  const backup = new BackupService({ ctx, settings, audit, archive });
  const openItemDuplicates = new OpenItemDuplicateService({ ctx, openItems, graph, audit, undo, insights });
  consistency.addCheck((count) => {
    openItemDuplicates.check(count);
  });
  const personDuplicates = new PersonDuplicateService({ ctx, settings, graph, insights, ownNameKeys: () => self.ownNameKeys() });
  consistency.setIndexRefresher((id, signal) => documents.refreshIndexedOnly(id, { signal }));
  consistency.addCheck((count) => personDuplicates.check(count));
  const personQuestions = new PersonQuestionService({ ctx, graph, insights, llm, privacy });
  consistency.addCheck((count) => personQuestions.check(count));
  const noteEventDuplicates = new NoteEventDuplicateService({ ctx, graph, notes, eventRecords, audit, undo, insights });
  consistency.addCheck((count) => {
    noteEventDuplicates.check(count);
  });
  const solutions = new SolutionService({ ctx, settings, llm, privacy, openItems, decisions, documents, eventRecords, graph, search, audit, notes });
  // one module each for capturing knowledge and verified answers, shared by the agent tools and the rule-based chat (#307)
  const capture = new CaptureService({ ctx, settings, decisions, openItems, reminders, graph, persons, contradictions, insights, notes, events: eventRecords });
  const answers = new KnowledgeAnswerService({ settings, llm, decisions, openItems, search, graph, docs: documents, privacy, events: eventRecords });
  const chat = new ChatService({
    ctx,
    settings,
    llm,
    decisions,
    openItems,
    search,
    graph,
    docs: documents,
    scanner,
    contradictions,
    insights,
    timeline,
    jobs,
    capture,
    answers,
  });
  return {
    documents,
    decisions,
    openItems,
    openItemDuplicates,
    solutions,
    eventRecords,
    notes,
    noteAnalysis,
    noteEventDuplicates,
    personDuplicates,
    personQuestions,
    insights,
    actions,
    contradictions,
    archive,
    archiveRoot,
    scanner,
    timeline,
    consistency,
    appState,
    backup,
    chat,
    capture,
    answers,
    agentRuns,
    memory,
  };
}

/** The fixed link methods (Epic #269): the same functions for the UI and the agent tools (#313). */
export function createLinkingServices(services: BaseServices & DomainServices) {
  const { ctx, graph, audit, undo, search, insights, appState, llm, privacy, documents, contradictions, noteAnalysis } = services;
  const cases = new CaseService({ ctx, graph, audit });
  const subjects = new SubjectService({ ctx, graph, audit, undo });
  const linkThresholds = new LinkThresholds(ctx, appState);
  const links = new LinkMethodsService({ ctx, graph, search, insights, appState, thresholds: linkThresholds });
  const topicNamer = new TopicNamer({ ctx, llm, privacy, docs: documents });
  const refiner = new RelationRefiner({ ctx, graph, llm, privacy, docs: documents, insights, contradictions, appState });
  links.setTopicNamer((cluster, signal) =>
    topicNamer.name(cluster, { known: graph.listEntities({ type: 'topic', limit: 200, confirmedOnly: true }).map((topic) => topic.name), signal }),
  );
  links.setNoteAnalyzer(async (id, signal) => (await noteAnalysis.analyze(id, { signal }))?.proposed ?? 0);
  return { cases, subjects, linkThresholds, links, refiner };
}
