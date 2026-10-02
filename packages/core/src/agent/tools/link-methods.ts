import { z } from 'zod';
import { truncate } from '../../util/text';
import type { LinkCandidate } from '../../services/link-methods';
import { defineTool, list, type AgentTool, type ToolContext } from '../registry';
import { TYPE_LABEL, unknownNote, type ToolDeps } from './common';

/**
 * The fixed link methods of Epic #269 as tools of their own (#313): candidates for an entry (#271, #283), entries without
 * any link (#290), groups of similar entries without a topic (#281) and the retroactive run (#279). They call the same
 * service functions as the user interface and only ever propose – confirming stays with the user; rejected pairs are never
 * proposed again. Names and passages of documents pass the privacy filter (#301); the runner masks secrets in every result.
 */
export function linkMethodTools(deps: ToolDeps): AgentTool[] {
  const { graph, links } = deps;

  /** An entry as the model sees it: ref, kind and name – documents only with permission. */
  const entryLine = (ctx: ToolContext, id: string, name: string, type: string): string => {
    if (type === 'document') {
      const row = deps.docs.findRow(id);
      if (!row || !deps.privacy.mayShareDocument(row)) return `${ctx.refs.doc(id)} Dokument [nicht freigegeben]`;
      ctx.shared.add(id);
      return `${ctx.refs.doc(id)} Dokument „${truncate(name, 70)}“`;
    }
    return `${ctx.refs.entry(id)} ${TYPE_LABEL[type as keyof typeof TYPE_LABEL] ?? type} „${truncate(name, 70)}“`;
  };
  /** The reason of a similarity candidate is text of the entry – of a document only with permission. */
  const reasonOf = (c: LinkCandidate): string => {
    if (c.method === 'mention') return c.reason;
    const row = c.type === 'document' ? deps.docs.findRow(c.id) : null;
    if (row && !deps.privacy.mayShareDocument(row)) return 'ähnlicher Inhalt';
    return `ähnlich: „${c.reason}“`;
  };
  const candidateLine = (ctx: ToolContext, c: LinkCandidate) => `  → ${entryLine(ctx, c.id, c.name, c.type)} (${Math.round(c.score * 100)} %, ${reasonOf(c)})`;

  return [
    defineTool({
      name: 'suggest_links',
      description:
        'Verknüpfungsvorschläge für Einträge (D…/K…/S…): ähnliche Einträge aus dem Suchindex und genannte Themen/Projekte, bis zu 3 je Eintrag, mit Begründung. Schon verknüpfte und vom Benutzer abgelehnte Paare sind ausgeschlossen. Ändert nichts – zum Verknüpfen link verwenden (aus eigenem Antrieb nur als Vorschlag).',
      schema: z.object({ entries: list, limit: z.number().int().min(1).max(5).default(3) }),
      risk: 'read',
      label: () => 'Suche passende Verknüpfungen',
      run: async (a, ctx) => {
        const { ids, unknown } = ctx.refs.resolveMany(a.entries);
        if (!ids.length) return { content: `Keine Einträge angegeben.${unknownNote(unknown)}`, isError: true };
        const lines: string[] = [];
        let n = 0;
        for (const id of ids.slice(0, 25)) {
          const e = graph.getEntity(id);
          if (!e) continue;
          const found = await links.candidates(id, { limit: a.limit });
          n += found.length;
          lines.push(
            `${entryLine(ctx, id, e.name, e.type)}:`,
            ...(found.length ? found.map((c) => candidateLine(ctx, c)) : ['  (keine passenden Vorschläge)']),
          );
        }
        return { content: `${lines.join('\n')}${unknownNote(unknown)}`, summary: `${n} Vorschläge` };
      },
    }),
    defineTool({
      name: 'find_unlinked_entries',
      description:
        'Verwaiste Einträge finden: Dokumente, Notizen, Entscheidungen, offene Punkte und Ereignisse ohne bestätigte oder vorgeschlagene Beziehung (ein Ordner allein zählt nicht), seitenweise mit Gesamtzahl. withSuggestions=true nennt zu jedem bis zu 2 passende Ziele.',
      schema: z.object({
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
        withSuggestions: z.boolean().default(true),
      }),
      risk: 'read',
      label: () => 'Suche Einträge ohne Verknüpfung',
      run: async (a, ctx) => {
        const page = links.orphans({ limit: a.limit, offset: a.offset });
        if (!page.total) return { content: 'Es gibt keine verwaisten Einträge.', summary: 'keine' };
        const lines: string[] = [];
        for (const o of page.items) {
          lines.push(entryLine(ctx, o.id, o.name, o.type));
          if (a.withSuggestions) for (const c of await links.candidates(o.id, { limit: 2 })) lines.push(candidateLine(ctx, c));
        }
        const set = ctx.refs.set(page.items.map((o) => o.id));
        const more = page.total > a.offset + page.items.length ? `\nWeitere mit offset=${a.offset + page.items.length}.` : '';
        return {
          content: `${page.total} verwaiste Einträge, hier ${a.offset + 1}–${a.offset + page.items.length} (${set}):\n${lines.join('\n')}${more}`,
          summary: `${page.total} ohne Verknüpfung`,
        };
      },
    }),
    defineTool({
      name: 'find_topic_clusters',
      description:
        'Gruppen ähnlicher Einträge ohne Thema finden (ab minSize Einträgen), je Gruppe ein lokaler Namensvorschlag. Bereits beantwortete Vorschläge kommen nicht wieder. Für eine passende Gruppe propose_topic aufrufen (du darfst einen besseren Namen wählen).',
      schema: z.object({ minSize: z.number().int().min(2).max(20).default(3) }),
      risk: 'read',
      label: () => 'Suche Gruppen ähnlicher Einträge ohne Thema',
      run: async (a, ctx) => {
        const clusters = await links.clusters({ minSize: a.minSize, signal: ctx.signal });
        if (!clusters.length) return { content: 'Keine Gruppen ähnlicher Einträge ohne Thema gefunden.', summary: 'keine' };
        const blocks = clusters.slice(0, 10).map((c, i) => {
          const set = ctx.refs.set(c.members.map((m) => m.id));
          return `Gruppe ${i + 1} (${set}, ${c.members.length} Einträge), Namensvorschlag „${c.name}“:\n${c.members
            .slice(0, 12)
            .map((m) => `  ${entryLine(ctx, m.id, m.name, m.type)}`)
            .join('\n')}`;
        });
        return { content: blocks.join('\n\n'), summary: `${clusters.length} Gruppe(n)` };
      },
    }),
    defineTool({
      name: 'propose_topic',
      description:
        'Schlägt ein neues Thema für Einträge (S…/D…/K…) vor: „Neues Thema ‚…‘ anlegen?“ als Hinweis mit den Einträgen als Beleg. Ändert selbst nichts – erst mit „Ja“ des Benutzers wird das Thema angelegt und zugeordnet (rückgängig machbar); ein „Nein“ wird gemerkt.',
      schema: z.object({ name: z.string().min(2).max(80), entries: list }),
      // only a proposal for the user – nothing in the archive changes
      risk: 'read',
      label: (a) => `Schlage das Thema „${truncate(a.name, 40)}“ vor`,
      run: async (a, ctx) => {
        const { ids, unknown } = ctx.refs.resolveMany(a.entries);
        if (ids.length < 2) return { content: `Ein Thema braucht mindestens zwei Einträge.${unknownNote(unknown)}`, isError: true };
        const res = links.proposeTopic(a.name.trim(), ids, { conversationId: ctx.conversationId });
        if (res.actionId) ctx.actionIds.push(res.actionId);
        return {
          content: res.actionId
            ? `Vorschlag „Neues Thema ‚${a.name}‘ anlegen?“ für ${ids.length} Einträge angelegt; der Benutzer entscheidet.${unknownNote(unknown)}`
            : `Zu dieser Gruppe hat der Benutzer schon entschieden – kein neuer Vorschlag.`,
          summary: res.actionId ? 'vorgeschlagen' : 'schon beantwortet',
        };
      },
    }),
    defineTool({
      name: 'backfill_links',
      description:
        'Rückwirkender Verknüpfungslauf über das bestehende Archiv: schlägt für jeden Eintrag ähnliche Einträge als Verknüpfung VOR (nie bestätigt; abgelehnte Paare nie wieder). Arbeitet bis zu maxEntries Einträge ab und merkt sich die Stelle – ein weiterer Aufruf oder ein Neustart macht dort weiter.',
      schema: z.object({ maxEntries: z.number().int().min(1).max(2000).default(200) }),
      risk: 'write',
      // proposals change no entry: they do not count towards the mass-action threshold
      count: () => 1,
      label: () => 'Schlage Verknüpfungen für das bestehende Archiv vor',
      run: async (a, ctx) => {
        const r = await links.backfill({
          maxEntries: a.maxEntries,
          signal: ctx.signal,
          onProgress: (done, total) => ctx.job?.report(done / total, `${done} von ${total} Einträgen geprüft`),
        });
        return {
          content: `${r.processed} Einträge geprüft, ${r.proposed} Verknüpfungen vorgeschlagen. ${r.done ? 'Das Archiv ist vollständig durchlaufen.' : `Noch ${r.remaining} Einträge – ein weiterer Aufruf macht weiter.`}`,
          summary: `${r.proposed} vorgeschlagen`,
          change: r.proposed ? `${r.proposed} Verknüpfungen vorgeschlagen` : undefined,
          changed: 0,
        };
      },
    }),
  ];
}
