import { z } from 'zod';
import { truncate } from '../../util/text';
import type { LinkCandidate } from '../../services/link-methods';
import { defineTool, list, type AgentTool } from '../registry';
import { TYPE_LABEL, unknownNote, type ToolDeps, type ToolScope } from './common';

/** An entry as the model sees it: ref, kind and name – documents only with permission (#301). */
function entryLine({ deps, ctx }: ToolScope, entry: { id: string; name: string; type: string }): string {
  const { id, name, type } = entry;
  if (type === 'document') {
    const row = deps.docs.findRow(id);
    if (!row || !deps.privacy.mayShareDocument(row)) return `${ctx.refs.doc(id)} Dokument [nicht freigegeben]`;
    ctx.shared.add(id);
    return `${ctx.refs.doc(id)} Dokument „${truncate(name, 70)}“`;
  }
  return `${ctx.refs.entry(id)} ${TYPE_LABEL[type as keyof typeof TYPE_LABEL] ?? type} „${truncate(name, 70)}“`;
}

/** A candidate with its reason; the reason of a similarity is text of the entry – of a document only with permission. */
function candidateLine(scope: ToolScope, candidate: LinkCandidate): string {
  const { deps } = scope;
  const row = candidate.method === 'similarity' && candidate.type === 'document' ? deps.docs.findRow(candidate.id) : null;
  const hidden = row && !deps.privacy.mayShareDocument(row);
  const reason = candidate.method === 'mention' ? candidate.reason : hidden ? 'ähnlicher Inhalt' : `ähnlich: „${candidate.reason}“`;
  return `  → ${entryLine(scope, candidate)} (${Math.round(candidate.score * 100)} %, ${reason})`;
}

/** How a backfill call ended, for the model: at the cap another call does nothing until the user has decided. */
function backfillOutcome(result: { done: boolean; remaining: number; waiting: number }): string {
  if (result.done) return 'Das Archiv ist vollständig durchlaufen.';
  if (result.waiting)
    return `Angehalten: ${result.waiting} Vorschläge warten auf die Prüfung durch den Benutzer. Erst danach schlägt der Lauf weitere vor; bis dahin bringt ein erneuter Aufruf nichts.`;
  return `Noch ${result.remaining} Einträge – ein weiterer Aufruf macht weiter.`;
}

/** Up to 3 link proposals right after capturing an entry, for the agent to offer (#283); a failing search never fails the capture. */
export async function linkHint(scope: ToolScope, id: string | null): Promise<string> {
  if (!id) return '';
  try {
    const found = await scope.deps.links.candidates(id, { limit: 3 });
    if (!found.length) return '';
    return `\nMögliche Verknüpfungen (anbieten; verknüpfen nur auf Wunsch des Benutzers, sonst bleibt es ein Vorschlag):\n${found.map((c) => candidateLine(scope, c)).join('\n')}`;
  } catch (error) {
    scope.deps.logger.warn('agent', 'Link proposals for a captured entry failed', { error });
    return '';
  }
}

/** The fixed link methods of Epic #269 as tools (#313): they only ever propose – confirming stays with the user. */
export function linkMethodTools(deps: ToolDeps): AgentTool[] {
  const { graph, links, settings } = deps;

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
        let proposals = 0;
        for (const id of ids.slice(0, 25)) {
          const e = graph.getEntity(id);
          if (!e) continue;
          const found = await links.candidates(id, { limit: a.limit });
          proposals += found.length;
          lines.push(
            `${entryLine({ deps, ctx }, { id, name: e.name, type: e.type })}:`,
            ...(found.length ? found.map((c) => candidateLine({ deps, ctx }, c)) : ['  (keine passenden Vorschläge)']),
          );
        }
        return { content: `${lines.join('\n')}${unknownNote(unknown)}`, summary: `${proposals} Vorschläge` };
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
          lines.push(entryLine({ deps, ctx }, o));
          if (a.withSuggestions) for (const c of await links.candidates(o.id, { limit: 2 })) lines.push(candidateLine({ deps, ctx }, c));
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
            .map((m) => `  ${entryLine({ deps, ctx }, m)}`)
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
        const proposal = links.proposeTopic({ name: a.name.trim(), memberIds: ids }, { conversationId: ctx.conversationId });
        if (proposal.actionId) ctx.actionIds.push(proposal.actionId);
        return {
          content: proposal.actionId
            ? `Vorschlag „Neues Thema ‚${a.name}‘ anlegen?“ für ${ids.length} Einträge angelegt; der Benutzer entscheidet.${unknownNote(unknown)}`
            : `Zu dieser Gruppe hat der Benutzer schon entschieden – kein neuer Vorschlag.`,
          summary: proposal.actionId ? 'vorgeschlagen' : 'schon beantwortet',
        };
      },
    }),
    defineTool({
      name: 'linkage_report',
      description:
        'Wie gut das Archiv verknüpft ist (#292): Anteil verwaister Einträge, offene Verknüpfungsvorschläge, Bestätigungsquote je Methode und der Verlauf der Archivprüfungen – dazu, was die Methoden aus Ablehnungen gelernt haben (#275, angehobene Schwellen mit Deckel). Ändert nichts.',
      schema: z.object({}),
      risk: 'read',
      label: () => 'Sehe nach, wie gut das Archiv verknüpft ist',
      run: async () => {
        const metrics = links.metrics();
        const percent = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)} %`);
        const share = (s: { orphans: number; entries: number }) => (s.entries ? s.orphans / s.entries : 0);
        const history = metrics.history.slice(-8);
        const lines = [
          `Einträge: ${metrics.current.entries}, davon ohne Verknüpfung: ${metrics.current.orphans} (${percent(share(metrics.current))}).`,
          `Offene Verknüpfungsvorschläge: ${metrics.current.openProposals}. Bestätigungsquote gesamt: ${percent(metrics.current.confirmationRate)}.`,
          'Je Methode (bestätigt / abgelehnt / offen, Quote):',
          ...metrics.methods.map((x) => `- ${x.label}: ${x.confirmed} / ${x.rejected} / ${x.open}, ${percent(x.rate)}`),
          history.length
            ? `Verlauf (Anteil verwaist je Archivprüfung, älteste zuerst): ${history.map((h) => `${h.at.slice(0, 10)} ${percent(share(h))}`).join(', ')}.`
            : 'Noch kein Verlauf – er entsteht mit jeder Archivprüfung.',
          'Aus Ablehnungen gelernt:',
          ...deps.linkThresholds
            .list()
            .map(
              (t) =>
                `- ${t.label} (${t.measure}): ${t.offset > 0 ? `+${Math.round(t.offset * 100)} Punkte` : 'unverändert'} (Deckel +${Math.round(t.cap * 100)}; zuletzt ${t.confirmed} bestätigt, ${t.rejected} abgelehnt)`,
            ),
        ];
        return { content: lines.join('\n'), summary: `${percent(share(metrics.current))} verwaist` };
      },
    }),
    defineTool({
      name: 'reset_learned_thresholds',
      description:
        'Setzt zurück, was die Verknüpfungsmethoden aus Ablehnungen gelernt haben (#275): alle schlagen wieder mit ihrer ursprünglichen Schwelle vor, nur künftige Entscheidungen zählen. Abgelehnte Paare bleiben abgelehnt. Nur auf ausdrücklichen Wunsch des Benutzers; nicht rückgängig machbar.',
      schema: z.object({}),
      // cannot be undone: always asks
      risk: 'critical',
      label: () => 'Setze die gelernten Schwellen zurück',
      run: async () => {
        deps.linkThresholds.reset();
        deps.audit.log({ action: 'links.thresholds.reset', actor: 'agent', trigger: 'agent', confirmed: true, entityIds: [] });
        return { content: 'Die gelernten Schwellen sind zurückgesetzt.', summary: 'zurückgesetzt', change: 'Gelernte Schwellen zurückgesetzt' };
      },
    }),
    defineTool({
      name: 'backfill_links',
      description:
        'Rückwirkender Verknüpfungslauf über das bestehende Archiv: schlägt für jeden Eintrag ähnliche Einträge als Verknüpfung VOR (nie bestätigt; abgelehnte Paare nie wieder). Prüft nur Einträge, die neu oder seit der letzten Prüfung geändert sind, bis zu maxEntries je Aufruf – ein weiterer Aufruf macht mit den übrigen weiter. Warten zu viele Vorschläge auf die Prüfung durch den Benutzer, hält der Lauf an, bis er entschieden hat.',
      schema: z.object({ maxEntries: z.number().int().min(1).max(2000).default(200) }),
      risk: 'write',
      // proposals change no entry: they do not count towards the mass-action threshold
      count: () => 1,
      label: () => 'Schlage Verknüpfungen für das bestehende Archiv vor',
      run: async (a, ctx) => {
        const result = await links.backfill({
          maxEntries: a.maxEntries,
          max: settings.get().links.maxProposalsPerEntry,
          signal: ctx.signal,
          onProgress: (done, total) => ctx.job?.report(done / total, `${done} von ${total} Einträgen geprüft`),
        });
        return {
          content: `${result.processed} Einträge geprüft, ${result.proposed} Verknüpfungen vorgeschlagen. ${backfillOutcome({ ...result, waiting: result.stoppedAtLimit ? links.proposals({ limit: 1 }).total : 0 })}`,
          summary: `${result.proposed} vorgeschlagen`,
          change: result.proposed ? `${result.proposed} Verknüpfungen vorgeschlagen` : undefined,
          changed: 0,
        };
      },
    }),
  ];
}
