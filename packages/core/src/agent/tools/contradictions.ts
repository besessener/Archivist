import type { Contradiction, Decision } from '@archivist/shared';
import { z } from 'zod';
import { checkSupersede, decisionsOf, RESOLUTION_LABELS, type ContradictionResolution } from '../../services/contradiction-resolution';
import { ACTIVE_DECISION_STATUSES } from '../../services/decisions';
import { truncate } from '../../util/text';
import { defineTool, optText, type AgentTool, type ToolOutput } from '../registry';
import type { ToolDeps, ToolScope } from './common';
import { unknownNote } from './common';
import { quotesHiddenDocument } from './read-entry-rows';

function contradictionEntry({ deps, ctx }: ToolScope, contradiction: Contradiction): string {
  // a contradiction quoting a document that may not be shared is described without its content (#301)
  const hidden = quotesHiddenDocument(deps, contradiction.sourceIds);
  const decisions = decisionsOf(deps.decisions, contradiction).map((d) =>
    hidden ? ctx.refs.entry(d.id) : `${ctx.refs.entry(d.id)} „${truncate(d.title, 80)}“`,
  );
  const head = `- ${contradiction.id} (${contradiction.status}): ${hidden ? '[nicht freigegeben]' : contradiction.title}`;
  return [head, decisions.length ? `  Entscheidungen: ${decisions.join(', ')}` : '', hidden ? '' : `  ${truncate(contradiction.description, 300)}`]
    .filter(Boolean)
    .join('\n');
}

interface ResolveArgs {
  contradiction: string;
  resolution: ContradictionResolution;
  older: string | null | undefined;
  newer: string | null | undefined;
}

/** The supersede that comes with the resolution: none, or both decisions checked against the contradiction; otherwise refused. */
type SupersedeRequest = { supersede: Array<{ older: Decision; newer: Decision }> } | { refused: ToolOutput };

const refused = (content: string): SupersedeRequest => ({ refused: { content, isError: true } });

function supersedeRequest({ deps, ctx }: ToolScope, args: ResolveArgs, contradiction: Contradiction): SupersedeRequest {
  if (!args.older && !args.newer) return { supersede: [] };
  if (!args.older || !args.newer) return refused('older und newer gehören zusammen: gib beide an oder keine.');
  const refs = [args.older, args.newer];
  const [olderId, newerId] = refs.map((ref) => ctx.refs.resolve(ref));
  if (!olderId || !newerId) return refused(`older und newer müssen bekannte K-IDs sein.${unknownNote(refs.filter((ref) => !ctx.refs.resolve(ref)))}`);
  const check = checkSupersede(contradiction, { resolution: args.resolution, olderId, newerId });
  if (!check.fits) return refused(`${check.reason} Die K-IDs nennt list_contradictions.`);
  const [older, newer] = [deps.decisions.get(olderId), deps.decisions.get(newerId)];
  if (![older, newer].every((d) => ACTIVE_DECISION_STATUSES.includes(d.status)))
    return refused('Beide Entscheidungen müssen noch gelten (gültig oder bestätigt).');
  return { supersede: [{ older, newer }] };
}

function proposeResolution({ deps, ctx }: ToolScope, args: ResolveArgs): ToolOutput {
  const contradiction = deps.contradictions.get(args.contradiction);
  if (contradiction.status === 'resolved' || contradiction.status === 'false_positive')
    return { content: 'Der Widerspruch ist bereits aufgelöst.', isError: true };
  const request = supersedeRequest({ deps, ctx }, args, contradiction);
  if ('refused' in request) return request.refused;
  const [pair] = request.supersede;
  const supersedeNote = pair ? ` – „${truncate(pair.newer.title, 50)}“ ersetzt „${truncate(pair.older.title, 50)}“` : '';
  const action = deps.actions.propose({
    actionType: 'resolve_contradiction',
    label: `Widerspruch „${truncate(contradiction.title, 60)}“ ${RESOLUTION_LABELS[args.resolution].card}${supersedeNote}`,
    rationale: 'Du hast darum gebeten, diesen Widerspruch aufzulösen.',
    confidence: 0.7,
    affectedEntities: [
      { type: 'contradiction', id: contradiction.id, label: contradiction.title },
      ...(pair ? [pair.older, pair.newer].map((d) => ({ type: 'decision' as const, id: d.id, label: d.title })) : []),
    ],
    requiredConfirmation: 'confirm',
    proposedParameters: {
      contradictionId: contradiction.id,
      resolution: args.resolution,
      ...(pair ? { supersedeOldDecisionId: pair.older.id, supersedeNewDecisionId: pair.newer.id } : {}),
    },
    conversationId: ctx.conversationId,
  });
  ctx.actionIds.push(action.id);
  // refs instead of the card label: the model learns no title it may not see
  const supersedes = pair ? `, ${ctx.refs.entry(pair.newer.id)} ersetzt ${ctx.refs.entry(pair.older.id)}` : '';
  return {
    content: `Vorschlagskarte angelegt: Widerspruch ${contradiction.id} ${RESOLUTION_LABELS[args.resolution].card}${supersedes}. Der Benutzer bestätigt sie unter deiner Antwort.`,
    summary: 'als Vorschlag vorbereitet',
  };
}

/** Listing and resolving contradictions: resolving is only ever a proposal card the user confirms. */
export function contradictionTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'list_contradictions',
      description:
        'Listet die offenen Widersprüche (noch nicht aufgelöst) mit ID, Titel, Beschreibung und den beiden Entscheidungen (K-IDs). Die IDs brauchst du für resolve_contradiction.',
      schema: z.object({}),
      risk: 'read',
      label: () => 'Liste offene Widersprüche',
      run: async (_, ctx) => {
        const open = deps.contradictions.listOpen();
        if (!open.length) return { content: 'Es gibt keine offenen Widersprüche.', summary: 'keine' };
        return { content: open.map((c) => contradictionEntry({ deps, ctx }, c)).join('\n'), summary: `${open.length} offen` };
      },
    }),
    defineTool({
      name: 'resolve_contradiction',
      description:
        'Schlägt vor, einen Widerspruch (ID aus list_contradictions) aufzulösen: resolved (Widerspruch ist geklärt), false_positive (kein echter Widerspruch) oder acknowledged (zur Kenntnis genommen). Nur mit resolved kann zugleich die neuere Entscheidung (newer: K…) die ältere (older: K…) ersetzen; beide müssen die Entscheidungen dieses Widerspruchs aus list_contradictions sein. Es entsteht eine Vorschlagskarte; aufgelöst wird erst nach Bestätigung durch den Benutzer. Nur auf Wunsch des Benutzers.',
      schema: z.object({
        contradiction: z.string().min(1),
        resolution: z.enum(['resolved', 'false_positive', 'acknowledged']),
        older: optText,
        newer: optText,
      }),
      risk: 'write',
      label: (a) => `Schlage vor, einen Widerspruch ${RESOLUTION_LABELS[a.resolution].sentence}`,
      run: async (a, ctx) => proposeResolution({ deps, ctx }, a),
    }),
  ];
}
