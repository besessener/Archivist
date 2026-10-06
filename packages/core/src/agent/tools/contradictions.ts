import { z } from 'zod';
import { truncate } from '../../util/text';
import { defineTool, optText, type AgentTool } from '../registry';
import type { ToolDeps } from './common';
import { unknownNote } from './common';

const RESOLUTION_LABELS = {
  resolved: 'als aufgelöst markieren',
  false_positive: 'als Fehlalarm markieren',
  acknowledged: 'zur Kenntnis nehmen',
} as const;

const OPEN_STATUSES = ['detected', 'acknowledged'] as const;

/** Listing and resolving contradictions: resolving is only ever a proposal card the user confirms. */
export function contradictionTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'list_contradictions',
      description: 'Listet die offenen Widersprüche (noch nicht aufgelöst) mit ID, Titel und Beschreibung. Die ID brauchst du für resolve_contradiction.',
      schema: z.object({}),
      risk: 'read',
      label: () => 'Liste offene Widersprüche',
      run: async () => {
        const open = OPEN_STATUSES.flatMap((status) => deps.contradictions.list({ status }));
        if (!open.length) return { content: 'Es gibt keine offenen Widersprüche.', summary: 'keine' };
        return {
          content: open.map((c) => `- ${c.id} (${c.status}): ${c.title}\n  ${truncate(c.description, 300)}`).join('\n'),
          summary: `${open.length} offen`,
        };
      },
    }),
    defineTool({
      name: 'resolve_contradiction',
      description:
        'Schlägt vor, einen Widerspruch (ID aus list_contradictions) aufzulösen: resolved (Widerspruch ist geklärt), false_positive (kein echter Widerspruch) oder acknowledged (zur Kenntnis genommen). Optional ersetzt die neuere Entscheidung (newer: K…) die ältere (older: K…) gleich mit. Es entsteht eine Vorschlagskarte; aufgelöst wird erst nach Bestätigung durch den Benutzer. Nur auf Wunsch des Benutzers.',
      schema: z.object({
        contradiction: z.string().min(1),
        resolution: z.enum(['resolved', 'false_positive', 'acknowledged']),
        older: optText,
        newer: optText,
      }),
      risk: 'write',
      label: (a) => `Schlage vor, einen Widerspruch ${RESOLUTION_LABELS[a.resolution]}`,
      run: async (a, ctx) => {
        const contradiction = deps.contradictions.get(a.contradiction);
        if (contradiction.status === 'resolved' || contradiction.status === 'false_positive')
          return { content: 'Der Widerspruch ist bereits aufgelöst.', isError: true };
        const older = a.older ? ctx.refs.resolve(a.older) : null;
        const newer = a.newer ? ctx.refs.resolve(a.newer) : null;
        if (Boolean(a.older) !== Boolean(a.newer) || (a.older && !older) || (a.newer && !newer))
          return {
            content: `older und newer gehören zusammen und müssen bekannte K-IDs sein.${unknownNote([a.older, a.newer].filter((r): r is string => Boolean(r) && !ctx.refs.resolve(r!)))}`,
            isError: true,
          };
        const action = deps.actions.propose({
          actionType: 'resolve_contradiction',
          label: `Widerspruch „${truncate(contradiction.title, 60)}“ ${RESOLUTION_LABELS[a.resolution]}`,
          rationale: 'Du hast darum gebeten, diesen Widerspruch aufzulösen.',
          confidence: 0.7,
          affectedEntities: [{ type: 'contradiction', id: contradiction.id, label: contradiction.title }],
          requiredConfirmation: 'confirm',
          proposedParameters: {
            contradictionId: contradiction.id,
            resolution: a.resolution,
            supersedeOldDecisionId: older ?? undefined,
            supersedeNewDecisionId: newer ?? undefined,
          },
          conversationId: ctx.conversationId,
        });
        ctx.actionIds.push(action.id);
        return { content: `Vorschlagskarte angelegt: ${action.label}. Der Benutzer bestätigt sie unter deiner Antwort.`, summary: 'als Vorschlag vorbereitet' };
      },
    }),
  ];
}
