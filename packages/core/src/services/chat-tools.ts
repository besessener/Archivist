import { z } from 'zod';
import type { AgentToolCall, DocumentRecord, DocumentStatus, EntityType, SourceReference } from '@archivist/shared';
import { normalizeName, truncate } from '../util/text';
import { folderLabel, folderOf, groupByFolder } from './archive-structure';
import type { DocumentService } from './documents';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { PrivacyService } from './privacy';
import type { SearchService } from './search';

/** Description of the agent's tools for the prompt. */
export const AGENT_TOOL_HELP = `Werkzeuge (nur lesend; sie ändern nichts):
- find_documents: Dokumente nach Metadaten filtern. args (alle optional, werden kombiniert): ext (Dateiendung oder Liste, z. B. ["pptx","ppt"]), name (Teil von Titel oder Dateiname), folder (Ordner im Archiv bzw. dessen Anfang, z. B. "work/hr"), topic, project, docType (z. B. "Präsentation"), person, tag, from/to (Datum YYYY-MM-DD; Archivierungs- bzw. Importdatum), status ("archived" = Standard, "inbox" = noch nicht archiviert, "all"), limit (Standard 50, höchstens 200). Liefert Dokument-IDs (D1, D2 …) und eine Ergebnismenge (S1, S2 …), die für ALLE Treffer steht – auch die nicht einzeln gezeigten.
- search: Volltext- und Ähnlichkeitssuche über Inhalte. args: query (Pflicht), types (optional, z. B. ["document"], ["decision","note","event"]).
- document_details: Metadaten, Zusammenfassung und Textanfang eines Dokuments. args: id (z. B. "D3").
- list_folders: Ordner des Archivs mit Anzahl und Dateitypen. args: under (optional, Ordneranfang).
- list_subjects: bekannte Themen, Projekte oder Personen. args: type ("topic", "project" oder "person"; ohne = Themen und Projekte), contains (optional).
- archive_overview: Zahlen zum Archiv (Status, Dateitypen, Dokumenttypen, größte Ordner). args: keine.`;

const MAX_RESULT_CHARS = 3500;

const list = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : v.split(/[,\s]+/)).map((s) => s.trim()).filter(Boolean));
const text = z
  .string()
  .nullish()
  .transform((v) => v?.trim() || null);
const FindArgs = z.object({
  ext: list.nullish(),
  name: text,
  folder: text,
  topic: text,
  project: text,
  docType: text,
  person: text,
  tag: text,
  from: text,
  to: text,
  status: z.enum(['archived', 'inbox', 'all']).nullish(),
  limit: z.coerce.number().int().min(1).max(200).nullish(),
});
const SearchArgs = z.object({ query: z.string().min(1), types: list.nullish() });
const DetailArgs = z.object({ id: z.string().min(1) });
const FolderArgs = z.object({ under: text });
const SubjectArgs = z.object({ type: z.enum(['topic', 'project', 'person']).nullish(), contains: text });

const ARCHIVED: DocumentStatus[] = ['archived', 'indexed_only'];
const INBOX: DocumentStatus[] = ['staged', 'analyzing', 'proposed', 'failed'];
const SEARCH_TYPES = new Set<EntityType>(['document', 'decision', 'note', 'event', 'question', 'task', 'topic', 'project', 'person']);

const STATUS_LABEL: Partial<Record<DocumentStatus, string>> = {
  archived: 'archiviert',
  indexed_only: 'nur indexiert',
  staged: 'im Eingang',
  analyzing: 'wird analysiert',
  proposed: 'im Eingang (Vorschlag)',
  failed: 'fehlgeschlagen',
  ignored: 'ignoriert',
  quarantined: 'in Quarantäne',
};

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();
const normExt = (e: string) => e.toLowerCase().replace(/^\*?\./, '');
const day = (d: DocumentRecord) => (d.archivedAt ?? d.createdAt).slice(0, 10);

/**
 * Short ids the agent sees instead of real ids: D1, D2 … for single documents, S1, S2 … for whole result sets.
 * Shares the id map with the other prompt references (P, E, V), so ids returned by the LLM are resolved in one place.
 */
export class AgentRefs {
  private readonly docRefs = new Map<string, string>();
  private readonly sets = new Map<string, string[]>();
  /** Documents whose metadata went to the LLM (for the transmission log). */
  readonly shared = new Set<string>();

  constructor(readonly ids: Map<string, string>) {}

  doc(id: string): string {
    const known = this.docRefs.get(id);
    if (known) return known;
    const ref = `D${this.docRefs.size + 1}`;
    this.docRefs.set(id, ref);
    this.ids.set(ref, id);
    return ref;
  }

  set(ids: string[]): string {
    const ref = `S${this.sets.size + 1}`;
    this.sets.set(ref, ids);
    return ref;
  }

  /** D/S references → real document ids (unknown ones are discarded, order kept, no duplicates). */
  documents(refs: string[] | null | undefined): string[] {
    const out = new Set<string>();
    for (const r of refs ?? []) {
      const key = r.trim().toUpperCase();
      if (key.startsWith('S')) for (const id of this.sets.get(key) ?? []) out.add(id);
      else if (key.startsWith('D')) {
        const id = this.ids.get(key);
        if (id) out.add(id);
      }
    }
    return [...out];
  }
}

/**
 * The read-only tools of the chat agent. Results are plain text for the next agent step. Documents that may not be
 * shared with the LLM appear only with id, file type, folder and status – never with title, file name or contents.
 */
export class ChatTools {
  constructor(
    private readonly docs: DocumentService,
    private readonly search: SearchService,
    private readonly graph: KnowledgeGraphService,
    private readonly privacy: PrivacyService,
  ) {}

  async run(call: AgentToolCall, refs: AgentRefs): Promise<string> {
    try {
      const out = await this.dispatch(call, refs);
      return out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}\n[… gekürzt]` : out;
    } catch (err) {
      if (err instanceof z.ZodError)
        return `Ungültige Argumente: ${err.issues
          .slice(0, 4)
          .map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`)
          .join('; ')}`;
      throw err;
    }
  }

  /** Source references for documents the agent based its own answer on. */
  sources(ids: string[]): SourceReference[] {
    return ids.flatMap((id) => {
      const d = this.docOrNull(id);
      return d
        ? [
            {
              id: d.id,
              type: 'document' as const,
              title: d.title,
              snippet: truncate(d.summary ?? d.textPreview, 200),
              path: d.archivePath ?? d.sourcePath,
              date: d.archivedAt,
              score: 1,
            },
          ]
        : [];
    });
  }

  private async dispatch(call: AgentToolCall, refs: AgentRefs): Promise<string> {
    switch (call.tool) {
      case 'find_documents':
        return this.findDocuments(FindArgs.parse(call.args), refs);
      case 'search':
        return this.searchAll(SearchArgs.parse(call.args), refs);
      case 'document_details':
        return this.details(DetailArgs.parse(call.args).id, refs);
      case 'list_folders':
        return this.folders(FolderArgs.parse(call.args).under);
      case 'list_subjects':
        return this.subjects(SubjectArgs.parse(call.args));
      case 'archive_overview':
        return this.overview();
    }
  }

  private docOrNull(id: string): DocumentRecord | null {
    try {
      return this.docs.get(id);
    } catch {
      return null;
    }
  }

  private all(): DocumentRecord[] {
    return this.docs.list({ limit: 20000 });
  }

  private line(d: DocumentRecord, refs: AgentRefs): string {
    const ref = refs.doc(d.id);
    const folder = d.archiveRelPath ? folderLabel(folderOf(d)) : '–';
    const status = STATUS_LABEL[d.status] ?? d.status;
    if (!this.privacy.mayShareDocument(d)) return `${ref}: [Name und Inhalt nicht freigegeben] | .${d.ext} | Ordner: ${folder} | ${status}`;
    refs.shared.add(d.id);
    return [
      `${ref}: „${truncate(d.title, 80)}“`,
      `Datei: ${truncate(d.originalName, 80)}`,
      `.${d.ext}`,
      `Ordner: ${folder}`,
      d.docType ? `Typ: ${d.docType}` : null,
      d.topicName ? `Thema: ${d.topicName}` : null,
      d.projectName ? `Projekt: ${d.projectName}` : null,
      day(d),
      status,
    ]
      .filter(Boolean)
      .join(' | ');
  }

  private findDocuments(a: z.output<typeof FindArgs>, refs: AgentRefs): string {
    const exts = new Set((a.ext ?? []).map(normExt));
    const statuses = a.status === 'all' ? null : a.status === 'inbox' ? INBOX : ARCHIVED;
    const has = (value: string | null | undefined, wanted: string | null) => !wanted || lower(value).includes(wanted.toLowerCase());
    const folder = a.folder ? a.folder.toLowerCase().replaceAll('\\', '/').split('/').filter(Boolean).join('/') : null;
    const hits = this.all().filter(
      (d) =>
        (!statuses || statuses.includes(d.status)) &&
        (!exts.size || exts.has(normExt(d.ext))) &&
        (!a.name || has(d.title, a.name) || has(d.originalName, a.name)) &&
        (!folder || (d.archiveRelPath !== null && (folderOf(d).toLowerCase() === folder || folderOf(d).toLowerCase().startsWith(`${folder}/`)))) &&
        has(d.topicName, a.topic) &&
        has(d.projectName, a.project) &&
        has(d.docType, a.docType) &&
        (!a.person || d.persons.some((p) => has(p, a.person))) &&
        (!a.tag || d.tags.some((t) => has(t, a.tag))) &&
        (!a.from || day(d) >= a.from) &&
        (!a.to || day(d) <= a.to),
    );
    if (!hits.length) return 'Keine Dokumente gefunden.';
    const limit = a.limit ?? 50;
    const set = refs.set(hits.map((d) => d.id));
    const shown = hits.slice(0, limit);
    return [
      `${hits.length} Dokument(e) gefunden, Ergebnismenge ${set}${hits.length > shown.length ? ` (gezeigt: ${shown.length})` : ''}:`,
      ...shown.map((d) => `- ${this.line(d, refs)}`),
    ].join('\n');
  }

  private async searchAll(a: z.output<typeof SearchArgs>, refs: AgentRefs): Promise<string> {
    const types = (a.types ?? []).filter((t): t is EntityType => SEARCH_TYPES.has(t as EntityType));
    const hits = await this.search.search(a.query, { types: types.length ? types : undefined, limit: 15 });
    if (!hits.length) return 'Keine Treffer.';
    return hits
      .map((h) => {
        if (h.type !== 'document') return `- ${h.type}: ${truncate(h.title, 80)} – ${truncate(h.snippet.replace(/\s+/g, ' '), 160)}`;
        const d = this.docOrNull(h.id);
        if (!d) return null;
        const snippet = this.privacy.mayShareDocument(d) ? ` – ${truncate(h.snippet.replace(/\s+/g, ' '), 160)}` : '';
        return `- ${this.line(d, refs)}${snippet}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  private details(ref: string, refs: AgentRefs): string {
    const [id] = refs.documents([ref]);
    const d = id ? this.docOrNull(id) : null;
    if (!d) return `Unbekannte Dokument-ID „${ref}“. Verwende IDs aus find_documents oder search.`;
    if (!this.privacy.mayShareDocument(d)) return `${this.line(d, refs)}\nWeitere Angaben sind nicht zur Übertragung freigegeben.`;
    return [
      this.line(d, refs),
      d.persons.length ? `Personen: ${d.persons.join(', ')}` : null,
      d.tags.length ? `Tags: ${d.tags.join(', ')}` : null,
      d.dates.length ? `Daten im Dokument: ${d.dates.slice(0, 8).join(', ')}` : null,
      d.summary ? `Zusammenfassung: ${truncate(d.summary, 600)}` : null,
      d.textPreview ? `Textanfang: ${truncate(d.textPreview.replace(/\s+/g, ' '), 600)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private folders(under: string | null): string {
    const prefix = under ? under.toLowerCase().replaceAll('\\', '/').split('/').filter(Boolean).join('/') : null;
    const groups = groupByFolder(this.all().filter((d) => d.status === 'archived' && d.archiveRelPath)).filter(
      (g) => !prefix || g.folder.toLowerCase() === prefix || g.folder.toLowerCase().startsWith(`${prefix}/`),
    );
    if (!groups.length) return prefix ? `Keine archivierten Dokumente unter „${under}“.` : 'Es sind noch keine Dokumente archiviert.';
    return groups
      .toSorted((x, y) => x.folder.localeCompare(y.folder))
      .slice(0, 150)
      .map((g) => {
        const exts = new Map<string, number>();
        for (const d of g.docs) exts.set(d.ext, (exts.get(d.ext) ?? 0) + 1);
        return `- ${folderLabel(g.folder)}: ${g.docs.length} (${[...exts].map(([e, n]) => `${n}× ${e}`).join(', ')})`;
      })
      .join('\n');
  }

  private subjects(a: z.output<typeof SubjectArgs>): string {
    const types: EntityType[] = a.type ? [a.type] : ['topic', 'project'];
    const label: Record<string, string> = { topic: 'Thema', project: 'Projekt', person: 'Person' };
    const rows = types.flatMap((type) => this.graph.listEntities({ type, query: a.contains ?? undefined, limit: 80 }));
    if (!rows.length) return 'Keine gefunden.';
    return rows.map((e) => `- ${label[e.type]}: ${e.name} (${e.relationCount} Verknüpfungen)`).join('\n');
  }

  private overview(): string {
    const all = this.all();
    const count = <T>(items: T[], key: (x: T) => string | null) => {
      const m = new Map<string, number>();
      for (const x of items) {
        const k = key(x);
        if (k) m.set(k, (m.get(k) ?? 0) + 1);
      }
      return [...m].sort((a, b) => b[1] - a[1]);
    };
    const archived = all.filter((d) => ARCHIVED.includes(d.status));
    const fmt = (rows: Array<[string, number]>, n = 15) =>
      rows
        .slice(0, n)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ') || '–';
    return [
      `Dokumente gesamt: ${all.length}`,
      `Nach Status: ${fmt(count(all, (d) => STATUS_LABEL[d.status] ?? d.status))}`,
      `Archiviert nach Dateityp: ${fmt(count(archived, (d) => d.ext))}`,
      `Archiviert nach Dokumenttyp: ${fmt(count(archived, (d) => d.docType))}`,
      `Größte Ordner: ${fmt(
        groupByFolder(archived.filter((d) => d.archiveRelPath)).map((g) => [folderLabel(g.folder), g.docs.length] as [string, number]),
        10,
      )}`,
    ].join('\n');
  }
}

/** Normalized key of a tool call, to spot repeated calls within one message. */
export function toolCallKey(call: AgentToolCall): string {
  return `${call.tool}:${normalizeName(JSON.stringify(call.args))}`;
}
