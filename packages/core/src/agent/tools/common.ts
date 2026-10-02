import type { DocumentRecord, DocumentStatus, EntityType } from '@archivist/shared';
import type { CaseService } from '../../services/cases';
import type { LinkThresholds } from '../../services/link-thresholds';
import type { SubjectService } from '../../services/subjects';
import type { DataPaths } from '../../context';
import type { ActionService } from '../../services/actions';
import type { ArchiveService } from '../../services/archive';
import type { AuditService } from '../../services/audit';
import type { CategoryService } from '../../services/categories';
import type { NoteEventDuplicateService } from '../../services/cleanup/note-event-duplicates';
import type { OpenItemDuplicateService } from '../../services/cleanup/open-item-duplicates';
import type { DecisionService } from '../../services/decisions';
import type { DocumentService } from '../../services/documents';
import type { EventService } from '../../services/events';
import type { InsightService } from '../../services/insights';
import type { JobQueueService } from '../../services/jobs';
import type { KnowledgeGraphService } from '../../services/knowledge-graph';
import type { LinkMethodsService } from '../../services/link-methods';
import type { NoteService } from '../../services/notes';
import type { NotificationService } from '../../services/notifications';
import type { OpenItemService } from '../../services/open-items';
import type { PersonService } from '../../services/persons';
import type { PrivacyService } from '../../services/privacy';
import type { ReminderService } from '../../services/reminders';
import type { ScannerService } from '../../services/scanner';
import type { SearchService } from '../../services/search';
import type { SettingsService } from '../../services/settings';
import type { TimelineService } from '../../services/timeline';
import type { UndoService } from '../../services/undo';
import { truncate } from '../../util/text';
import { folderLabel, folderOf } from '../../services/archive-structure';
import type { AgentFileJobs } from '../file-jobs';
import type { MemoryService } from '../memory';
import type { ToolContext } from '../registry';
import type { CaptureService } from '../../services/capture';
import type { KnowledgeAnswerService } from '../../services/knowledge-answers';

/** Services the tools use – the same service functions the user interface calls (#294: one function, two callers). */
export interface ToolDeps {
  paths: DataPaths;
  settings: SettingsService;
  docs: DocumentService;
  search: SearchService;
  graph: KnowledgeGraphService;
  privacy: PrivacyService;
  decisions: DecisionService;
  openItems: OpenItemService;
  reminders: ReminderService;
  events: EventService;
  notes: NoteService;
  timeline: TimelineService;
  insights: InsightService;
  actions: ActionService;
  archive: ArchiveService;
  categories: CategoryService;
  scanner: ScannerService;
  jobs: JobQueueService;
  audit: AuditService;
  undo: UndoService;
  persons: PersonService;
  notifications: NotificationService;
  openItemDuplicates: OpenItemDuplicateService;
  noteEventDuplicates: NoteEventDuplicateService;
  memory: MemoryService;
  fileJobs: AgentFileJobs;
  links: LinkMethodsService;
  /** Main and further topics/projects, bulk assignment (#287, #291). */
  subjects: SubjectService;
  /** Cases („Vorgänge“, #286). */
  cases: CaseService;
  /** What the link methods learned from rejections (#275). */
  linkThresholds: LinkThresholds;
  /** Capturing knowledge: the same module as the rule-based chat (#307). */
  capture: CaptureService;
  answers: KnowledgeAnswerService;
  enqueueConsistency: (trigger: string) => void;
}

export const ARCHIVED: DocumentStatus[] = ['archived', 'indexed_only'];
export const INBOX: DocumentStatus[] = ['staged', 'analyzing', 'proposed', 'failed'];

export const STATUS_LABEL: Partial<Record<DocumentStatus, string>> = {
  archived: 'archiviert',
  indexed_only: 'nur indexiert',
  staged: 'im Eingang',
  analyzing: 'wird analysiert',
  proposed: 'im Eingang (Vorschlag)',
  failed: 'fehlgeschlagen',
  ignored: 'ignoriert',
  quarantined: 'in Quarantäne',
};

export const TYPE_LABEL: Partial<Record<EntityType, string>> = {
  document: 'Dokument',
  decision: 'Entscheidung',
  topic: 'Thema',
  project: 'Projekt',
  person: 'Person',
  event: 'Ereignis',
  question: 'offener Punkt',
  task: 'offener Punkt',
  note: 'Notiz',
  category: 'Ordner',
  tag: 'Schlagwort',
  case: 'Vorgang',
};

export const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();
export const normExt = (e: string) => e.toLowerCase().replace(/^\*?\./, '');
/** Business date of a document: its own date, else the archive or import date. */
export const docDay = (d: Pick<DocumentRecord, 'documentDate' | 'archivedAt' | 'createdAt'>) => (d.documentDate ?? d.archivedAt ?? d.createdAt).slice(0, 10);
export const normFolder = (f: string) => f.replaceAll('\\', '/').split('/').filter(Boolean).join('/');

/** Every document line that goes to the model passes the privacy filter (#301). */
export function docLine(d: DocumentRecord, ctx: ToolContext, privacy: PrivacyService): string {
  const ref = ctx.refs.doc(d.id);
  const folder = d.archiveRelPath ? folderLabel(folderOf(d)) : '–';
  const status = STATUS_LABEL[d.status] ?? d.status;
  if (!privacy.mayShareDocument(d)) return `${ref}: [nicht freigegeben] | .${d.ext} | Ordner: ${folder} | ${status}`;
  ctx.shared.add(d.id);
  return [
    `${ref}: „${truncate(d.title, 80)}“`,
    `Datei: ${truncate(d.originalName, 80)}`,
    `.${d.ext}`,
    `Ordner: ${folder}`,
    d.docType ? `Typ: ${d.docType}` : null,
    d.topicName ? `Thema: ${d.topicName}` : null,
    d.projectName ? `Projekt: ${d.projectName}` : null,
    d.persons.length ? `Personen: ${d.persons.slice(0, 4).join(', ')}` : null,
    d.documentDate ? `Datum: ${d.documentDate.slice(0, 10)}` : null,
    d.archivedAt ? `archiviert: ${d.archivedAt.slice(0, 10)}` : null,
    `${Math.max(1, Math.round(d.size / 1024))} KB`,
    status,
  ]
    .filter(Boolean)
    .join(' | ');
}

/** Resolves D/S refs to documents; unknown refs are named in the result instead of being guessed. */
export function resolveDocs(deps: ToolDeps, ctx: ToolContext, refs: readonly string[]): { docs: DocumentRecord[]; unknown: string[] } {
  const { ids, unknown } = ctx.refs.resolveMany(refs);
  const docs = ids.length ? deps.docs.list({ ids: ids.slice(0, 1000), limit: 1000 }) : [];
  const found = new Set(docs.map((d) => d.id));
  const order = new Map(ids.map((id, i) => [id, i]));
  return { docs: docs.toSorted((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)), unknown: [...unknown, ...ids.filter((id) => !found.has(id))] };
}

export const unknownNote = (unknown: string[]) =>
  unknown.length ? `\nUnbekannte IDs: ${unknown.slice(0, 10).join(', ')} – verwende IDs aus find_documents, search oder list_entries.` : '';

/** All documents (metadata only) for filtering. */
export function allDocs(deps: ToolDeps): DocumentRecord[] {
  return deps.docs.list({ limit: 50_000 });
}
