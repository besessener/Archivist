import { z } from 'zod';
import type { EntityType } from '@archivist/shared';
import { truncate } from '../../util/text';
import { folderLabel, groupByFolder } from '../../services/archive-structure';
import { defineTool, optText, type AgentTool, type ToolOutput } from '../registry';
import { ARCHIVED, STATUS_LABEL, TYPE_LABEL, allDocs, docLine, type ToolDeps, type ToolScope } from './common';
import { PAGE_SIZE, findDocument } from './read-documents';
import { ENTRY_KINDS, entryRows, type EntryKind } from './read-entry-rows';

const RELATED_PAGE = 40;

const ENTRY_LABEL: Record<EntryKind, string> = {
  decision: 'die Entscheidungen',
  open_item: 'die offenen Punkte',
  reminder: 'die Erinnerungen',
  event: 'die Ereignisse',
  note: 'die Notizen',
  proposal: 'die offenen Vorschläge',
  insight: 'die Hinweise',
  case: 'die Vorgänge',
};

function describeEntity(scope: ToolScope, entity: { id: string; type: EntityType; name: string }): string {
  const { deps, ctx } = scope;
  if (entity.type !== 'document') return `${ctx.refs.entry(entity.id)} ${TYPE_LABEL[entity.type] ?? entity.type}: ${truncate(entity.name, 90)}`;
  if (!deps.docs.findRow(entity.id)) return `${ctx.refs.doc(entity.id)} Dokument`;
  return docLine(scope, deps.docs.get(entity.id));
}

/** Counts per key, the most frequent first; entries without a key are left out. */
function countBy<T>(items: T[], key: (item: T) => string | null): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].toSorted((a, b) => b[1] - a[1]);
}

const topCounts = (rows: Array<[string, number]>, limit = 15) =>
  rows
    .slice(0, limit)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || '–';

function archiveOverview(deps: ToolDeps): ToolOutput {
  const all = allDocs(deps);
  const archived = all.filter((d) => ARCHIVED.includes(d.status));
  const largestFolders = groupByFolder(archived.filter((d) => d.archiveRelPath)).map((g) => [folderLabel(g.folder), g.docs.length] as [string, number]);
  return {
    content: [
      `Dokumente gesamt: ${all.length}`,
      `Nach Status: ${topCounts(countBy(all, (d) => STATUS_LABEL[d.status] ?? d.status))}`,
      `Archiviert nach Dateityp: ${topCounts(countBy(archived, (d) => d.ext))}`,
      `Archiviert nach Dokumenttyp: ${topCounts(countBy(archived, (d) => d.docType))}`,
      `Größte Ordner: ${topCounts(largestFolders, 10)}`,
      `Aktive offene Punkte: ${deps.openItems.list({ onlyActive: true }).length}`,
      `Entscheidungen: ${deps.decisions.list().length}`,
      `Offene Vorschläge: ${deps.actions.list('proposed').length}, offene Hinweise: ${deps.insights.list('open').length}`,
    ].join('\n'),
  };
}

function subjectList(scope: ToolScope, args: { type?: 'topic' | 'project' | 'person' | 'tag' | 'case' | null; contains: string | null }): ToolOutput {
  const { deps, ctx } = scope;
  const { graph } = deps;
  const types: EntityType[] = args.type ? [args.type] : ['topic', 'project'];
  // names taken from documents and not confirmed yet are never given to the LLM as known subjects (#199)
  const rows = types.flatMap((type) => graph.listEntities({ type, query: args.contains ?? undefined, limit: 150 })).filter((e) => !e.unconfirmed);
  if (!rows.length) return { content: 'Keine gefunden.' };
  const parentOf = new Map(graph.hierarchy().map((h) => [h.childId, h.parentId]));
  const under = (id: string) => {
    const parentId = parentOf.get(id);
    const parent = parentId ? graph.getEntity(parentId) : undefined;
    return parent ? ` (Unterthema von „${parent.name}“)` : '';
  };
  return {
    content: rows
      .map(
        (e) =>
          `- ${ctx.refs.entry(e.id)} ${TYPE_LABEL[e.type] ?? e.type}: ${e.name}${under(e.id)}${e.isSelf ? ' (der Benutzer selbst)' : ''}${e.aliases.length ? ` (auch: ${e.aliases.slice(0, 3).join(', ')})` : ''}${e.type === 'case' ? ` [${e.status ?? 'open'}]` : ''} – ${e.relationCount} Verknüpfungen`,
      )
      .join('\n'),
    summary: `${rows.length} gefunden`,
  };
}

function rejectedPairs(scope: ToolScope, id: string): ToolOutput {
  const pairs = scope.deps.graph.rejectedPairsOf(id);
  return { content: pairs.length ? pairs.map((p) => `- abgelehnt: ${describeEntity(scope, p.other)}`).join('\n') : 'Keine abgelehnten Paare.' };
}

function neighborsOfNeighbors(scope: ToolScope, id: string): ToolOutput {
  const related = scope.deps.graph.related(id, { depth: 2, limit: 80 });
  if (!related.length) return { content: 'Keine verknüpften Einträge.', summary: 'nichts verknüpft' };
  return {
    content: related.map((r) => `- ${describeEntity(scope, r.entity)} – ${r.reason}${r.via ? ` (über ${truncate(r.via.name, 40)})` : ''}`).join('\n'),
    summary: `${related.length} verknüpft`,
  };
}

function relatedPage(scope: ToolScope, query: { id: string; page: number }): ToolOutput {
  const { page } = query;
  const { total, items } = scope.deps.links.related(query.id, { limit: RELATED_PAGE, offset: (page - 1) * RELATED_PAGE });
  if (!total) return { content: 'Keine verwandten Einträge.', summary: 'nichts verknüpft' };
  const pages = Math.ceil(total / RELATED_PAGE);
  const status = (r: (typeof items)[number]) => (r.relation ? ` [${r.relation.status === 'confirmed' ? 'bestätigt' : 'Vorschlag'}]` : '');
  return {
    content: `${total} verwandte Einträge, Seite ${page}/${pages}:\n${items
      .map((r) => `- ${describeEntity(scope, r.entity)} – ${r.reason}${status(r)}`)
      .join('\n')}${page < pages ? `\n(weiter mit page=${page + 1})` : ''}`,
    summary: `${total} verwandt`,
  };
}

const CASE_KIND_LABEL: Partial<Record<EntityType, string>> = { document: 'document', decision: 'decision', task: 'open_item', event: 'event', note: 'note' };

/** The entries of a case (Vorgang) – documents, decisions, open items, events, notes – interleaved chronologically. */
function caseTimeline(scope: ToolScope, args: { name: string; from: string | null; to: string | null; limit?: number | null }): ToolOutput {
  const { deps, ctx } = scope;
  const found = deps.graph.findByNameOrAlias('case', args.name);
  if (!found) return { content: `Vorgang „${args.name}“ ist unbekannt – list_subjects mit type=case zeigt die bekannten.`, isError: true };
  const entries = deps.cases
    .entries(found.id)
    .filter((e) => !e.proposed && e.date && (!args.from || e.date.slice(0, 10) >= args.from) && (!args.to || e.date.slice(0, 10) <= args.to))
    .toSorted((a, b) => a.date!.localeCompare(b.date!))
    .slice(0, args.limit ?? 200);
  if (!entries.length) return { content: `Keine Einträge im Vorgang „${found.name}“ in diesem Zeitraum.` };
  const lines = entries.map((e) => {
    const day = e.date!.slice(0, 10);
    const document = e.type === 'document' ? findDocument(deps, e.id) : undefined;
    if (document && !deps.privacy.mayShareDocument(document)) return `- ${day}: Dokument ${ctx.refs.doc(e.id)} [nicht freigegeben]`;
    const ref = e.type === 'document' ? ctx.refs.doc(e.id) : ctx.refs.entry(e.id);
    return `- ${day} ${CASE_KIND_LABEL[e.type] ?? e.type}: ${ref} ${truncate(e.name, 90)}${e.status ? ` [${e.status}]` : ''}`;
  });
  return { content: `Vorgang „${found.name}“:\n${lines.join('\n')}`, summary: `${entries.length} Einträge` };
}

function timelineOf(
  scope: ToolScope,
  args: { topic: string | null; project: string | null; case?: string | null; from: string | null; to: string | null; limit?: number | null },
): ToolOutput {
  const { deps, ctx } = scope;
  if (args.case) return caseTimeline(scope, { name: args.case, from: args.from, to: args.to, limit: args.limit });
  const topicId = args.topic ? deps.graph.findByNameOrAlias('topic', args.topic)?.id : undefined;
  const projectId = args.project ? deps.graph.findByNameOrAlias('project', args.project)?.id : undefined;
  if ((args.topic && !topicId) || (args.project && !projectId))
    return { content: `Thema bzw. Projekt „${args.topic ?? args.project}“ ist unbekannt – list_subjects zeigt die bekannten.`, isError: true };
  const entries = deps.timeline.get({ topicId, projectId, from: args.from ?? undefined, to: args.to ?? undefined, limit: args.limit ?? 200 });
  if (!entries.length) return { content: 'Keine Einträge in diesem Zeitraum.' };
  const lines = entries.map((e) => {
    const document = e.kind === 'document' ? findDocument(deps, e.id) : undefined;
    if (document && !deps.privacy.mayShareDocument(document)) return `- ${e.date}: Dokument ${ctx.refs.doc(e.id)} [nicht freigegeben]`;
    const ref = e.kind === 'document' ? ctx.refs.doc(e.id) : ctx.refs.entry(e.id);
    return `- ${e.date} ${e.kind}: ${ref} ${truncate(e.title, 90)}${e.description ? ` – ${truncate(e.description.replace(/\s+/g, ' '), 140)}` : ''}`;
  });
  return { content: lines.join('\n'), summary: `${entries.length} Einträge` };
}

/** Read tools for subjects, entries, relations and the timeline. */
export function entryReadTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'list_subjects',
      description: 'Bekannte Themen, Projekte, Personen, Schlagwörter oder Vorgänge.',
      schema: z.object({ type: z.enum(['topic', 'project', 'person', 'tag', 'case']).nullish(), contains: optText }),
      risk: 'read',
      label: (a) => `Sehe mir die ${a.type ? (TYPE_LABEL[a.type] ?? a.type) : 'Themen und Projekte'} an`,
      run: async (a, ctx) => subjectList({ deps, ctx }, a),
    }),
    defineTool({
      name: 'archive_overview',
      description: 'Zahlen zum Archiv: Status, Dateitypen, Dokumenttypen, größte Ordner, offene Punkte, Vorschläge.',
      schema: z.object({}),
      risk: 'read',
      label: () => 'Verschaffe mir einen Überblick über das Archiv',
      run: async () => archiveOverview(deps),
    }),
    defineTool({
      name: 'list_entries',
      description:
        'Weitere Einträge abfragen: decision, open_item, reminder, event, note, proposal (offene Vorschlagskarten), insight (Hinweise der Archivprüfung, auch Widersprüche), case (Vorgänge). Filter: status, topic, project, query, from/to; seitenweise.',
      schema: z.object({
        kind: z.enum(ENTRY_KINDS),
        status: optText,
        topic: optText,
        project: optText,
        query: optText,
        from: optText,
        to: optText,
        page: z.coerce.number().int().min(1).nullish(),
      }),
      risk: 'read',
      label: (a) => `Sehe mir ${ENTRY_LABEL[a.kind]} an`,
      run: async (a, ctx) => {
        const rows = entryRows(deps, a);
        if (!rows.length) return { content: 'Keine Einträge gefunden.', summary: 'keine' };
        const page = a.page ?? 1;
        const pages = Math.ceil(rows.length / PAGE_SIZE);
        const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        return {
          content: [`${rows.length} Einträge${pages > 1 ? `, Seite ${page}/${pages}` : ''}:`, ...shown.map((r) => `- ${ctx.refs.entry(r.id)}: ${r.text}`)].join(
            '\n',
          ),
          summary: `${rows.length} gefunden`,
        };
      },
    }),
    defineTool({
      name: 'related',
      description:
        'Verwandte Einträge eines Eintrags (D… oder K…) im Wissensgraphen, mit Begründung – dieselbe Liste wie „Verwandte Einträge“ in der Oberfläche: direkte Beziehungen (bestätigt oder vorgeschlagen) und gemeinsame Projekte, Vorgänge, Themen, Personen und Tags, nach Stärke sortiert, seitenweise (page). depth 2 nennt stattdessen auch die Nachbarn der Nachbarn. Abgelehnte Paare werden auf Wunsch mit rejected=true genannt.',
      schema: z.object({
        id: z.string().min(1),
        depth: z.coerce.number().int().min(1).max(2).nullish(),
        rejected: z.boolean().nullish(),
        page: z.coerce.number().int().min(1).nullish(),
      }),
      risk: 'read',
      label: () => 'Sehe nach, was damit zusammenhängt',
      run: async (a, ctx) => {
        const id = ctx.refs.resolve(a.id);
        if (!id) return { content: `Unbekannte ID „${a.id}“.`, isError: true };
        if (a.rejected) return rejectedPairs({ deps, ctx }, id);
        if ((a.depth ?? 1) === 2) return neighborsOfNeighbors({ deps, ctx }, id);
        return relatedPage({ deps, ctx }, { id, page: a.page ?? 1 });
      },
    }),
    defineTool({
      name: 'timeline',
      description:
        'Zeitlinie zu Thema, Projekt, Vorgang (case) oder Zeitraum: Dokumente, Entscheidungen, offene Punkte, Ereignisse, Notizen – chronologisch. Mit case werden die Einträge des Vorgangs zeitlich verschränkt.',
      schema: z.object({
        topic: optText,
        project: optText,
        case: optText,
        from: optText,
        to: optText,
        limit: z.coerce.number().int().min(1).max(500).nullish(),
      }),
      risk: 'read',
      label: (a) => `Erstelle eine Zeitlinie${a.topic || a.project || a.case ? ` zu ${a.topic ?? a.project ?? a.case}` : ''}`,
      run: async (a, ctx) => timelineOf({ deps, ctx }, a),
    }),
  ];
}
