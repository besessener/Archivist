import {
  localToday,
  SolutionProposal,
  type EntityType,
  type ErrorCategory,
  type OpenItem,
  type OpenItemSolution,
  type SolutionPreview,
} from '@archivist/shared';
import type { AppContext } from '../context';
import { AppError } from '../util/errors';
import { nowIso } from '../util/ids';
import { truncate } from '../util/text';
import { ACTIVE_STATUSES, type OpenItemService } from './open-items';
import type { AuditService } from './audit';
import type { DecisionService } from './decisions';
import type { DocumentService } from './documents';
import type { EventService } from './events';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { LlmService } from './llm';
import type { NoteService } from './notes';
import type { PrivacyService } from './privacy';
import type { SearchService } from './search';
import type { SettingsService } from './settings';
import { composeSolution, formatSolution, itemFields, SOLUTION_INSTRUCTIONS, solutionPrompt, STATUS_LABELS, type GatheredSource } from './solution-content';

/** Linked entries that qualify as a source (graph relations and sourceIds). */
const LINKED_TYPES: EntityType[] = ['document', 'decision', 'event', 'note', 'task'];
/** Hybrid search hits that qualify as a source. */
const SEARCH_TYPES: EntityType[] = ['document', 'decision', 'event', 'note', 'task'];
/** Documents in these states are not a source. */
const SKIPPED_DOC_STATUSES = new Set(['ignored', 'failed', 'quarantined']);
const MAX_SOURCES = 10;
const MAX_LINKED = 6;
const EXCLUDED_TEXT = '(Inhalt ist von der externen Analyse ausgeschlossen; nur der Titel ist bekannt.)';

type SourceDescription = Omit<GatheredSource, 'ref'>;
type ApplyInput =
  { target: 'description'; id: string } | { target: 'items'; id: string; stepIndexes: number[]; confirmed: boolean } | { target: 'note'; id: string };
type ApplyResult = { item: OpenItem; created: OpenItem[]; noteId: string | null };

const abortedError = () => new AppError('llm_error', 'Die Erzeugung des Lösungsvorschlags wurde abgebrochen. Es wurde nichts geändert.');

/** Solution proposals: gathers sources from the archive, sends them – respecting privacy – to the LLM and stores the result. */
export class SolutionService {
  /** running generations per item (for cancellation) */
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly llm: LlmService,
    private readonly privacy: PrivacyService,
    private readonly openItems: OpenItemService,
    private readonly decisions: DecisionService,
    private readonly documents: DocumentService,
    private readonly eventRecords: EventService,
    private readonly graph: KnowledgeGraphService,
    private readonly search: SearchService,
    private readonly audit: AuditService,
    private readonly notes: NoteService,
  ) {}

  /** Reason why no proposal can (currently) be generated for this item – or null. */
  private blocked(item: OpenItem): { category: ErrorCategory; message: string } | null {
    if (!ACTIVE_STATUSES.includes(item.status)) return { category: 'validation_error', message: 'Lösungsvorschläge gibt es nur für aktive offene Punkte.' };
    if (this.privacy.mode() === 'local_only')
      return {
        category: 'permission_error',
        message:
          'Im Datenschutzmodus „nur lokal“ werden keine Inhalte an das LLM gesendet. Ändere den Modus in den Einstellungen, um Lösungsvorschläge zu erzeugen.',
      };
    if (!this.llm.isConfigured())
      return { category: 'llm_error', message: 'Das LLM ist nicht konfiguriert. Bitte Base URL, Modell und API-Key in den Einstellungen hinterlegen.' };
    return null;
  }

  /** Describes an entry as a source; excluded documents only provide their title. */
  private describe(id: string, snippet?: string): SourceDescription | null {
    const entity = this.graph.getEntity(id);
    if (!entity) return null;
    try {
      switch (entity.type) {
        case 'document':
          return this.describeDocument(id, snippet);
        case 'decision':
          return this.describeDecision(id);
        case 'event':
          return this.describeEvent(id);
        case 'note':
          return { id, type: 'note', title: entity.name, date: entity.updatedAt, contentIncluded: true, text: entity.description ?? entity.name };
        case 'task':
          return this.describeOpenItem(id);
        default:
          return null;
      }
    } catch {
      return null; // source not readable (any more) → leave it out
    }
  }

  private describeDocument(id: string, snippet: string | undefined): SourceDescription | null {
    const doc = this.documents.getRow(id);
    if (SKIPPED_DOC_STATUSES.has(doc.status)) return null;
    const allowed = this.privacy.evaluateDocument(doc).allowed;
    const text = allowed
      ? [
          doc.docType && `Typ: ${doc.docType}`,
          doc.summary,
          `Auszug: ${snippet ?? truncate(doc.extractedText.replace(/\s+/g, ' '), 800)}`,
          doc.persons.length ? `Personen: ${doc.persons.join(', ')}` : '',
          doc.dates.length ? `Daten: ${doc.dates.slice(0, 4).join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : EXCLUDED_TEXT;
    return { id, type: 'document', title: doc.title, date: doc.archivedAt ?? doc.createdAt, contentIncluded: allowed, text };
  }

  private describeDecision(id: string): SourceDescription {
    const decision = this.decisions.get(id);
    const text = this.decisions.format(decision).replace(/\*\*/g, '');
    return { id, type: 'decision', title: decision.title, date: decision.decidedAt, contentIncluded: true, text };
  }

  private describeEvent(id: string): SourceDescription {
    const event = this.eventRecords.get(id);
    const text = `Ereignis am ${event.occurredAt.slice(0, 10)}: ${event.title}. ${event.description ?? ''}`.trim();
    return { id, type: 'event', title: event.title, date: event.occurredAt, contentIncluded: true, text };
  }

  private describeOpenItem(id: string): SourceDescription {
    const item = this.openItems.get(id);
    return {
      id,
      type: 'task',
      title: item.title,
      date: item.createdAt,
      contentIncluded: true,
      text: `Offener Punkt: ${item.title}. ${item.description ?? ''} Status: ${STATUS_LABELS[item.status]}. Fällig: ${item.dueAt?.slice(0, 10) ?? 'unbekannt'}. Verantwortlich: ${item.responsibleName ?? 'unbekannt'}.`,
    };
  }

  /** Linked entries (sourceIds, graph) first, then hybrid search hits (without external embeddings). */
  private async gather(item: OpenItem): Promise<GatheredSource[]> {
    const out: SourceDescription[] = [];
    const seen = new Set<string>([item.id]);
    const add = (id: string, { max, snippet }: { max: number; snippet?: string }) => {
      if (seen.has(id) || out.length >= max) return;
      seen.add(id);
      const source = this.describe(id, snippet);
      if (source) out.push(source);
    };
    for (const id of item.sourceIds) add(id, { max: MAX_LINKED });
    for (const neighbor of this.graph.neighbors(item.id, { types: LINKED_TYPES })) add(neighbor.id, { max: MAX_LINKED });
    const query = [item.title, item.description, item.topicName, item.projectName].filter(Boolean).join(' ');
    // no external embeddings: nothing may leave the device before the confirmation
    const hits = await this.search.search(query, { types: SEARCH_TYPES, limit: MAX_SOURCES * 2, allowRemoteEmbedding: false });
    for (const hit of hits) add(hit.id, { max: MAX_SOURCES, snippet: hit.snippet });
    return out.map((source, i) => ({ ...source, ref: `S${i + 1}` }));
  }

  /** What would be sent – without an LLM call (for the confirmation dialog in mode „vorher fragen“). */
  async preview(id: string): Promise<SolutionPreview> {
    const item = this.openItems.get(id);
    const blocked = this.blocked(item);
    const sources = await this.gather(item);
    return {
      mode: this.privacy.mode(),
      available: blocked === null,
      blockedReason: blocked?.message ?? null,
      itemFields: itemFields(item),
      sources: sources.map(({ ref, id: sourceId, type, title, contentIncluded }) => ({ ref, id: sourceId, type, title, contentIncluded, used: false })),
    };
  }

  /** Generates a solution proposal and stores it on the item (replaces an existing one). */
  async generate(id: string, opts: { confirmed: boolean }): Promise<OpenItem> {
    const item = this.openItems.get(id);
    const blocked = this.blocked(item);
    if (blocked) throw new AppError(blocked.category, blocked.message);
    if (this.privacy.mode() === 'confirm' && !opts.confirmed)
      throw new AppError('permission_error', 'Im Datenschutzmodus „vorher fragen“ muss die Übertragung an das LLM zuerst bestätigt werden.');
    this.running.get(id)?.abort();
    const controller = new AbortController();
    this.running.set(id, controller);
    try {
      const sources = await this.gather(item);
      if (controller.signal.aborted) throw abortedError();
      const model = this.settings.get().llm.model;
      const answer = await this.requestProposal(item, { sources, signal: controller.signal });
      if (controller.signal.aborted) throw abortedError();
      const solution = composeSolution({ answer, sources, model, generatedAt: nowIso() });
      const saved = this.openItems.setSolution(id, solution);
      this.audit.log({
        action: 'open_item.solution',
        actor: 'agent',
        trigger: 'ui',
        confirmed: true,
        entityIds: [id],
        after: { model, steps: solution.nextSteps.length, sources: solution.sources.length },
      });
      return saved;
    } finally {
      if (this.running.get(id) === controller) this.running.delete(id);
    }
  }

  private async requestProposal(item: OpenItem, { sources, signal }: { sources: GatheredSource[]; signal: AbortSignal }): Promise<SolutionProposal> {
    try {
      return await this.llm.completeJson(SolutionProposal, {
        schemaName: 'SolutionProposal',
        purpose: 'Lösungsvorschlag',
        documentIds: sources.filter((s) => s.type === 'document').map((s) => s.id),
        instructions: SOLUTION_INSTRUCTIONS,
        input: solutionPrompt(item, { sources, today: localToday() }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw abortedError();
      throw err;
    }
  }

  /** Cancels a running generation; the result is discarded. */
  cancel(id: string): boolean {
    const controller = this.running.get(id);
    if (!controller) return false;
    controller.abort();
    this.running.delete(id);
    return true;
  }

  /** Applies the stored proposal: extend the description, steps as separate items or as a note. */
  async apply(input: ApplyInput): Promise<ApplyResult> {
    const item = this.openItems.get(input.id);
    const solution = item.solution;
    if (!solution) throw new AppError('validation_error', 'Zu diesem Punkt gibt es noch keinen Lösungsvorschlag.');
    if (input.target === 'description') {
      const description = [item.description?.trim(), formatSolution(solution)].filter(Boolean).join('\n\n');
      return { item: this.openItems.update(item.id, { description }), created: [], noteId: null };
    }
    if (input.target === 'items') return this.createSteps(item, { ...input, solution });
    return this.createNote(item, solution);
  }

  private createSteps(item: OpenItem, input: { solution: OpenItemSolution; stepIndexes: number[]; confirmed: boolean }): ApplyResult {
    const { solution } = input;
    if (!input.confirmed) throw new AppError('permission_error', 'Neue offene Punkte aus dem Vorschlag erfordern eine ausdrückliche Bestätigung.');
    const steps = [...new Set(input.stepIndexes)].flatMap((i) => (solution.nextSteps[i] ? [solution.nextSteps[i]] : []));
    if (!steps.length) throw new AppError('validation_error', 'Keine gültigen Schritte ausgewählt.');
    const created = steps.map((step) => {
      const child = this.openItems.create(
        {
          title: truncate(step.text, 200),
          description: [step.detail, `Schritt aus dem Lösungsvorschlag zu „${item.title}“.`].filter(Boolean).join('\n'),
          topic: item.topicName,
          project: item.projectName,
          priority: item.priority,
          sourceIds: [item.id],
          confidence: 0.8,
        },
        { actor: 'user', trigger: 'ui' },
      );
      this.graph.link(child.id, item.id, 'results_from', { confidence: 0.9, status: 'confirmed', sourceIds: [item.id] });
      return child;
    });
    return { item: this.openItems.get(item.id), created, noteId: null };
  }

  private async createNote(item: OpenItem, solution: OpenItemSolution): Promise<ApplyResult> {
    const note = await this.notes.create({
      title: truncate(`Lösungsvorschlag: ${item.title}`, 70),
      content: `Lösungsvorschlag zum offenen Punkt „${item.title}“\n\n${formatSolution(solution)}`,
      links: [
        { targetId: item.id, relationType: 'relates_to', confidence: 1 },
        ...(item.topicId ? [{ targetId: item.topicId, relationType: 'relates_to' as const }] : []),
        ...(item.projectId ? [{ targetId: item.projectId, relationType: 'belongs_to' as const }] : []),
      ],
    });
    this.audit.log({ action: 'open_item.solution_note', actor: 'user', trigger: 'ui', confirmed: true, entityIds: [note.id, item.id] });
    return { item, created: [], noteId: note.id };
  }
}
