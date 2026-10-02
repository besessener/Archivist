import type { DocumentStatus, SourceReference } from '@archivist/shared';
import { normalizeDateInput } from '../../util/dates';
import { truncate } from '../../util/text';
import type { ConvState, Reply } from '../chat-state';
import { documentDateRef } from '../knowledge-sources';
import type { ChatDeps, ChatRequest } from './types';

/** Timeline queries in chat show at most this many (newest) entries. */
const CHAT_TIMELINE_LIMIT = 300;
/** Documents a chat reply lists for a topic or project (the newest). */
const TOPIC_DOCUMENT_LIMIT = 50;
const SEARCH_DOCUMENT_LIMIT = 15;
const ARCHIVED_STATUSES: DocumentStatus[] = ['archived', 'indexed_only'];

/** A search returns the best hits, not every document that mentions the words: say so instead of „N gefunden“. */
const searchHeading = (count: number, capped: boolean) =>
  capped ? `Hier sind die ${count} besten Treffer (es kann weitere passende Dokumente geben):` : `Ich habe ${count} passende(s) Dokument(e) gefunden:`;

type TimelineEntries = ReturnType<ChatDeps['timeline']['get']>;
type TimelineSubject = { topicId?: string; projectId?: string; label: string };
type LookupDeps = Pick<ChatDeps, 'graph' | 'docs' | 'search' | 'timeline' | 'answers'>;

/** Document search and timeline in the rule-based chat. */
export class LookupReplies {
  constructor(private readonly deps: LookupDeps) {}

  async documentSearch({ text, intent, state }: ChatRequest): Promise<Reply> {
    const topicName = intent.topic?.trim();
    // how the list came about, so the reply never passes a capped list off as everything there is (#222)
    const listed = topicName ? this.subjectDocuments(topicName) : { docs: [], heading: null };
    const searched = listed.docs.length ? { docs: [], capped: false } : await this.searchedDocuments(intent.query?.trim() || text);
    const docs = listed.docs.length ? listed.docs : searched.docs;
    if (docs.length === 0)
      return {
        intent: 'document_search',
        content: 'Ich habe dazu keine archivierten Dokumente gefunden.',
        confidence: 0.3,
        uncertainties: ['Nicht archivierte Dateien werden nicht durchsucht.'],
        state,
      };
    const numbered = docs.map((d, i) => ({ ...d, title: `${i + 1}. ${d.title}` }));
    return {
      intent: 'document_search',
      content: `${listed.heading ?? searchHeading(docs.length, searched.capped)}\n\n${docs.map((d, i) => `${i + 1}. **${d.title}** – ${d.snippet}`).join('\n')}`,
      sources: numbered,
      context: { documents: docs.map((d) => ({ type: 'document' as const, id: d.id, label: d.title })), ...this.deps.answers.contextFromSources(docs) },
      confidence: 0.7,
      state: { ...state, last: { ...(state.last ?? {}), documentIds: docs.map((d) => d.id), topic: topicName ?? null } },
    };
  }

  /** The newest archived documents of a known topic or project; filtered in the database so inbox documents cannot hide them. */
  private subjectDocuments(name: string): { docs: SourceReference[]; heading: string | null } {
    const subject = this.deps.graph.findByName('topic', name) ?? this.deps.graph.findByName('project', name);
    if (!subject) return { docs: [], heading: null };
    const filter = { [subject.type === 'topic' ? 'topicId' : 'projectId']: subject.id, statuses: ARCHIVED_STATUSES };
    const rows = this.deps.docs.list({ ...filter, limit: TOPIC_DOCUMENT_LIMIT });
    const total = rows.length < TOPIC_DOCUMENT_LIMIT ? rows.length : this.deps.docs.count(filter);
    const heading =
      total > rows.length
        ? `Zu „${subject.name}“ gibt es ${total} archivierte Dokumente; hier die ${rows.length} neuesten:`
        : `Zu „${subject.name}“ gibt es ${total} archivierte(s) Dokument(e):`;
    const docs = rows.map((d) => ({
      id: d.id,
      type: 'document' as const,
      title: d.title,
      snippet: truncate(d.summary ?? d.textPreview, 200),
      path: d.archivePath ?? d.sourcePath,
      ...documentDateRef(d),
      score: 1,
    }));
    return { docs, heading };
  }

  private async searchedDocuments(query: string): Promise<{ docs: SourceReference[]; capped: boolean }> {
    const hits = await this.deps.search.search(query, { types: ['document'], limit: SEARCH_DOCUMENT_LIMIT });
    const docs = hits.flatMap((hit) => {
      const d = this.deps.docs.get(hit.id);
      if (!ARCHIVED_STATUSES.includes(d.status)) return [];
      return [
        {
          id: d.id,
          type: 'document' as const,
          title: d.title,
          snippet: truncate(d.summary ?? hit.snippet, 200),
          path: d.archivePath ?? d.sourcePath,
          ...documentDateRef(d),
          score: hit.score,
        },
      ];
    });
    return { docs, capped: hits.length >= SEARCH_DOCUMENT_LIMIT };
  }

  timelineQuery({ intent, state }: ChatRequest): Reply {
    const name = intent.topic?.trim() || intent.project?.trim() || null;
    const subject = name ? this.timelineSubject(name) : { label: 'dem Archiv' };
    if (!subject) return { intent: 'timeline_query', content: `Zu „${name}“ kenne ich kein Thema oder Projekt.`, confidence: 0.3, state };
    const entries = this.deps.timeline.get({
      topicId: subject.topicId,
      projectId: subject.projectId,
      from: normalizeDateInput(intent.timeRange?.from ?? null) ?? undefined,
      to: normalizeDateInput(intent.timeRange?.to ?? null) ?? undefined,
      limit: CHAT_TIMELINE_LIMIT,
    });
    if (entries.length === 0)
      return { intent: 'timeline_query', content: `Für ${subject.label} gibt es im gewählten Zeitraum keine Einträge.`, confidence: 0.4, state };
    return this.timelineReply(entries, { label: subject.label, state });
  }

  /** The topic or project of a timeline query: exact name first, otherwise the most similar one; null when none fits. */
  private timelineSubject(name: string): TimelineSubject | null {
    const topic = this.deps.graph.findByName('topic', name);
    if (topic) return { topicId: topic.id, label: `Thema „${topic.name}“` };
    const project = this.deps.graph.findByName('project', name);
    if (project) return { projectId: project.id, label: `Projekt „${project.name}“` };
    const similar = this.deps.graph.listEntities({ query: name, limit: 5 }).find((e) => e.type === 'topic' || e.type === 'project');
    if (!similar) return null;
    const label = `${similar.type === 'topic' ? 'Thema' : 'Projekt'} „${similar.name}“`;
    return similar.type === 'topic' ? { topicId: similar.id, label } : { projectId: similar.id, label };
  }

  private timelineReply(entries: TimelineEntries, view: { label: string; state: ConvState }): Reply {
    const byYear = new Map<number, TimelineEntries>();
    for (const e of entries) byYear.set(e.year, [...(byYear.get(e.year) ?? []), e]);
    const body = [...byYear.entries()].map(([year, list]) => `**${year}**\n${list.map((e) => `• ${e.date}: ${e.title}`).join('\n')}`).join('\n\n');
    // the newest entries are the most relevant context for follow-up questions
    const sources: SourceReference[] = entries.slice(-25).map((e, i) => ({
      id: e.refs[0]?.id ?? e.id,
      type: e.refs[0]?.type ?? 'note',
      title: `${i + 1}. ${e.title}`,
      snippet: truncate(e.description ?? '', 160),
      path: null,
      date: e.date,
      score: 1,
    }));
    return {
      intent: 'timeline_query',
      content: `Zeitverlauf für ${view.label}${entries.length >= CHAT_TIMELINE_LIMIT ? ` (die neuesten ${CHAT_TIMELINE_LIMIT} Einträge)` : ''}:\n\n${body}`,
      sources,
      context: this.deps.answers.contextFromSources(sources),
      confidence: 0.8,
      state: view.state,
    };
  }
}
