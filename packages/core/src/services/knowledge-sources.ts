import { localDate, OPEN_ITEM_STATUS_LABELS, type Decision, type OpenItemStatus, type SourceReference } from '@archivist/shared';
import { truncate } from '../util/text';
import { decisionSource } from './chat-state';
import type { DecisionService } from './decisions';
import type { DocumentService } from './documents';
import type { EventService } from './events';
import type { OpenItemService } from './open-items';
import type { PrivacyService } from './privacy';
import type { SearchHit, SearchService } from './search';
import type { SettingsService } from './settings';

/** A source for a knowledge answer with fields that stay in the main process (prompt text, filters). */
export type GatheredSource = SourceReference & {
  _text: string;
  /** Not released for external analysis: cited locally only, its content (incl. title) never goes to the LLM. */
  _local?: boolean;
  /** Topic/project ids of the source (for the topic filter). */
  _topics?: string[];
  /** Dates of the source (for the time-range filter). */
  _dates?: string[];
  /** Archive date of a document source (the header names it separately from the document date). */
  _archivedAt?: string | null;
  /** A superseded or revoked decision: listed after the current ones (#170). */
  _outdated?: boolean;
};

/** Characters of the matched passage per source (a whole chunk of the search index). */
export const PASSAGE_CHARS = 1000;

/** The part of a gathered source that is shown and stored. */
export function publicSource({ _text, _local, _topics, _dates, _archivedAt, ...s }: GatheredSource): SourceReference {
  void _text;
  void _local;
  void _topics;
  void _dates;
  void _archivedAt;
  return s;
}

/** Date of a document source: its own date if known, otherwise – labelled as such – the archive date (#168). */
export function documentDateRef(d: { documentDate: string | null; archivedAt: string | null }): Pick<SourceReference, 'date' | 'dateKind'> {
  if (d.documentDate) return { date: d.documentDate, dateKind: 'document' };
  return { date: d.archivedAt, dateKind: d.archivedAt ? 'archived' : null };
}

/** All dates of a document for the time-range filter: its own date, the dates in the text, the archive date. */
function documentDates(d: { documentDate: string | null; dates: string[]; archivedAt: string | null }): string[] {
  return [d.documentDate, ...d.dates, d.archivedAt].filter((x): x is string => Boolean(x));
}

const subjectIds = (...ids: Array<string | null>) => ids.filter((x): x is string => Boolean(x));

/** Labelled date for the source header of the answer prompt – the model must not take an archive date for a document date. */
export function sourceDateLabel(s: Pick<GatheredSource, 'type' | 'date' | 'dateKind' | '_archivedAt'>): string {
  const day = s.date?.slice(0, 10);
  const archived = s._archivedAt ? `archiviert am ${s._archivedAt.slice(0, 10)}` : null;
  switch (s.dateKind) {
    case 'document':
      return [`Dokumentdatum ${day}`, archived].filter(Boolean).join(', ');
    case 'archived':
      return `Dokumentdatum unbekannt, archiviert am ${day}`;
    case 'decided':
      return `entschieden am ${day}`;
    case 'occurred':
      return `am ${day}`;
    case 'created':
      return `erfasst am ${day}`;
    default:
      if (s.type === 'document') return archived ? `Dokumentdatum unbekannt, ${archived}` : 'Dokumentdatum unbekannt';
      if (s.type === 'decision') return 'ohne Entscheidungsdatum';
      return day ? `Datum ${day}` : 'ohne Datum';
  }
}

type ReaderDeps = {
  settings: SettingsService;
  decisions: DecisionService;
  openItems: OpenItemService;
  search: SearchService;
  docs: DocumentService;
  privacy: PrivacyService;
  events: EventService;
};

/** Turns search hits into answer sources: the matched passage, the metadata, and only what the privacy rules allow to send. */
export class SourceReader {
  constructor(private readonly deps: ReaderDeps) {}

  /** One hit as an answer source (null: a document that is not archived); decisions add their backing documents to `supporting`. */
  sourceOf(hit: SearchHit, supporting: GatheredSource[]): GatheredSource | null {
    switch (hit.type) {
      case 'document':
        return this.documentSource(hit);
      case 'decision':
        return this.decisionHitSource(hit, supporting);
      case 'event':
        return this.eventSource(hit);
      case 'task':
        return this.taskSource(hit);
      default:
        return {
          id: hit.id,
          type: hit.type,
          title: hit.title,
          snippet: truncate(hit.snippet, 220),
          path: null,
          date: hit.date,
          score: hit.score,
          _text: truncate(hit.passage, PASSAGE_CHARS),
        };
    }
  }

  private documentSource(hit: SearchHit): GatheredSource | null {
    const d = this.deps.docs.getRow(hit.id);
    if (d.status !== 'archived' && d.status !== 'indexed_only') return null;
    // folder permission, exclusions and – in mode „vorher fragen“ – the user's release for external analysis
    const shareable = this.deps.privacy.mayShareDocument(d);
    // the matched passage itself, not only the summary and a few words around the hit (#157)
    const text = shareable
      ? [
          d.summary && `Zusammenfassung: ${truncate(d.summary, 400)}`,
          `Textstelle: ${truncate(hit.passage, PASSAGE_CHARS)}`,
          d.persons.length && `Personen: ${d.persons.join(', ')}`,
          d.dates.length && `Im Text genannte Daten: ${d.dates.slice(0, 4).join(', ')}`,
        ]
          .filter(Boolean)
          .join('\n')
      : '';
    return {
      ...(shareable ? {} : { _local: true }),
      id: hit.id,
      type: 'document',
      title: d.title,
      snippet: truncate(hit.snippet || d.summary || '', 220),
      path: this.documentPath(d),
      ...documentDateRef(d),
      score: hit.score,
      _archivedAt: d.archivedAt,
      _text: text,
      _topics: subjectIds(d.topicId, d.projectId),
      _dates: documentDates(d),
    };
  }

  private documentPath(d: { archiveRelPath: string | null; sourcePath: string | null }): string | null {
    return d.archiveRelPath ? `${this.deps.settings.get().archiveRoot}/${d.archiveRelPath}` : d.sourcePath;
  }

  private decisionHitSource(hit: SearchHit, supporting: GatheredSource[]): GatheredSource {
    const d = this.deps.decisions.get(hit.id);
    const backing = this.decisionDocuments(d);
    // the documents the decision was taken from become sources of their own (#165)
    supporting.push(...backing);
    return {
      ...decisionSource(d, hit.score),
      _text: this.decisionPromptText(d, backing),
      _topics: subjectIds(d.topicId, d.projectId),
      _dates: d.decidedAt ? [d.decidedAt] : [],
      ...(d.status === 'superseded' || d.status === 'revoked' ? { _outdated: true } : {}),
    };
  }

  /** Events from the timeline: the date (occurredAt) belongs in the source and its text. */
  private eventSource(hit: SearchHit): GatheredSource {
    const e = this.deps.events.get(hit.id);
    const day = localDate(e.occurredAt);
    return {
      id: e.id,
      type: 'event',
      title: e.title,
      snippet: truncate(`Am ${day}${e.description ? `: ${e.description}` : ''}`, 220),
      path: null,
      date: e.occurredAt,
      dateKind: 'occurred',
      score: hit.score,
      _text: `Ereignis am ${day}: ${e.title}.${e.description ? ` ${e.description}` : ''}${e.topicName ? ` Thema: ${e.topicName}.` : ''}${e.projectName ? ` Projekt: ${e.projectName}.` : ''}`,
      _topics: subjectIds(e.topicId, e.projectId),
      _dates: [e.occurredAt],
    };
  }

  private taskSource(hit: SearchHit): GatheredSource {
    const i = this.deps.openItems.get(hit.id);
    return {
      id: i.id,
      type: 'task',
      title: i.title,
      snippet: `Status: ${OPEN_ITEM_STATUS_LABELS[i.status as OpenItemStatus] ?? i.status}${i.dueAt ? `, fällig ${i.dueAt.slice(0, 10)}` : ''}`,
      path: null,
      date: i.createdAt,
      dateKind: 'created',
      score: hit.score,
      _text: `Offener Punkt: ${i.title}. ${i.description ?? ''} Status: ${i.status}. Fällig: ${i.dueAt?.slice(0, 10) ?? 'unbekannt'}. Verantwortlich: ${i.responsibleName ?? 'unbekannt'}.`,
    };
  }

  /** A decision as answer source: its fields, the verbatim evidence of a document decision (#175) and the backing documents. */
  private decisionPromptText(d: Decision, backing: GatheredSource[]): string {
    return [
      this.deps.decisions.format(d).replace(/\*\*/g, ''),
      d.origin === 'document' && 'Herkunft: aus einem Dokument übernommen (vom Benutzer bestätigt)',
      d.evidence && `Wörtlich im Dokument: „${truncate(d.evidence, 400)}“`,
      backing.length && `Belegt durch: ${backing.map((b) => `Dokument „${b.title}“`).join(', ')}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Archived source documents of a decision, with the passage that best matches the decision text. */
  private decisionDocuments(d: Decision): GatheredSource[] {
    const out: GatheredSource[] = [];
    for (const id of d.sourceIds) {
      const doc = this.deps.docs.findRow(id);
      if (!doc || (doc.status !== 'archived' && doc.status !== 'indexed_only')) continue;
      const shareable = this.deps.privacy.mayShareDocument(doc);
      const passage = this.deps.search.bestPassage(id, `${d.title} ${d.decisionText}`) ?? '';
      out.push({
        ...(shareable ? {} : { _local: true }),
        id: doc.id,
        type: 'document',
        title: doc.title,
        snippet: truncate(doc.summary ?? passage, 220),
        path: this.documentPath(doc),
        ...documentDateRef(doc),
        score: 0,
        _archivedAt: doc.archivedAt,
        _text: shareable
          ? [
              `Quelle der Entscheidung „${d.title}“.`,
              doc.summary && `Zusammenfassung: ${truncate(doc.summary, 400)}`,
              passage && `Textstelle: ${truncate(passage, PASSAGE_CHARS)}`,
            ]
              .filter(Boolean)
              .join('\n')
          : '',
        _topics: subjectIds(doc.topicId, doc.projectId),
        _dates: documentDates(doc),
      });
    }
    return out;
  }
}
