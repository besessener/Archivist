import { z } from 'zod';
import type { ChatIntent, Decision, DecisionField } from '@archivist/shared';
import { truncate } from '../../util/text';
import { defineTool, list, optText, type AgentTool, type ToolOutput } from '../registry';
import { unknownNote, type ToolDeps, type ToolScope } from './common';
import { agentIntent, candidateNote, dateArg, decisionDateArg, entryRef, followUpQuestion } from './knowledge-capture';
import { linkHint } from './link-methods';

const DECISION_FIELDS = z.array(z.enum(['decidedAt', 'participants', 'topic', 'rationale']));

const RecordArgs = z.object({
  text: z.string().min(1).describe('Die Entscheidung in einem Satz'),
  title: optText,
  decidedAt: decisionDateArg.describe('YYYY-MM-DD, nur wenn genannt oder eindeutig ableitbar'),
  topic: optText,
  project: optText,
  topicIsProject: z.boolean().nullish(),
  participants: list.nullish(),
  rationale: optText,
  consequences: optText,
  alternatives: list.nullish(),
  validFrom: dateArg,
  validUntil: dateArg,
  unknownFields: DECISION_FIELDS.nullish().describe('Felder, die der Benutzer ausdrücklich nicht weiß'),
  certainty: z.enum(['clear', 'unsure']).default('clear'),
  supersedes: optText,
});

const AmendArgs = z.object({
  id: z.string().min(1),
  text: optText,
  title: optText,
  decidedAt: decisionDateArg,
  topic: optText,
  project: optText,
  participants: list.nullish(),
  rationale: optText,
  consequences: optText,
  alternatives: list.nullish(),
  validFrom: dateArg,
  validUntil: dateArg,
  unknownFields: DECISION_FIELDS.nullish(),
});

function decisionIntent(args: z.output<typeof RecordArgs>, supersedesId: string | null): ChatIntent {
  const intent: ChatIntent = {
    ...agentIntent(args.supersedes ? 'decision_supersede' : 'decision_new', args.text),
    topic: args.topic,
    project: args.project,
    decisionCertainty: 'clear',
    decision: {
      title: args.title,
      decisionText: args.text,
      decidedAt: args.decidedAt,
      topic: args.topic,
      project: args.project,
      participants: args.participants ?? [],
      rationale: args.rationale,
      consequences: args.consequences,
      alternatives: args.alternatives ?? [],
      validFrom: args.validFrom,
      validUntil: args.validUntil,
      topicIsProject: args.topicIsProject ?? null,
      supersedesId,
      unknownFields: (args.unknownFields ?? []) as DecisionField[],
      confidence: 0.85,
    },
  };
  if (args.supersedes && !supersedesId) intent.topic = args.topic ?? args.supersedes;
  return intent;
}

async function recordDecision(scope: ToolScope, args: z.output<typeof RecordArgs>): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  if (args.certainty === 'unsure')
    return {
      content:
        'NICHT GESPEICHERT. Es ist unklar, ob das eine getroffene Entscheidung ist. Frag den Benutzer mit ask_user: als Entscheidung, als Ereignis, nur als Notiz oder gar nicht speichern? (options: ["Entscheidung","Ereignis","Notiz","nichts speichern"])',
      summary: 'Rückfrage nötig',
    };
  const supersedesId = args.supersedes ? ctx.refs.resolve(args.supersedes) : null;
  const result = await deps.capture.forAgent({
    conversationId: ctx.conversationId,
    text: ctx.userText || args.text,
    intent: decisionIntent(args, supersedesId),
    // nobody has looked at what a background run records
    status: ctx.trigger === 'background' ? 'unclear' : undefined,
  });
  ctx.actionIds.push(...result.actionIds);
  const cards = result.actionIds.length ? `\n(${result.actionIds.length} Vorschlagskarte(n) zur Bestätigung angelegt)` : '';
  return {
    content: `${entryRef(ctx, result.decisionId)} ${result.content}${followUpQuestion(result)}${candidateNote(ctx, result)}${cards}${await linkHint(scope, result.decisionId)}`,
    summary: result.question ? 'als Entwurf, Angaben fehlen' : 'gespeichert',
    change: `Entscheidung „${truncate(args.title ?? args.text, 60)}“ erfasst`,
  };
}

const merged = <T>(current: T[], added: T[]) => [...new Set([...current, ...added])];

/** Only the given fields; lists are added to the current ones. */
function decisionPatch(args: z.output<typeof AmendArgs>, current: Decision) {
  return {
    ...(args.text ? { decisionText: args.text } : {}),
    ...(args.title ? { title: args.title } : {}),
    ...(args.decidedAt ? { decidedAt: args.decidedAt } : {}),
    ...(args.topic ? { topic: args.topic } : {}),
    ...(args.project ? { project: args.project } : {}),
    ...(args.participants?.length ? { participants: merged(current.participants, args.participants) } : {}),
    ...(args.rationale ? { rationale: args.rationale } : {}),
    ...(args.consequences ? { consequences: args.consequences } : {}),
    ...(args.alternatives?.length ? { alternatives: merged(current.alternatives, args.alternatives) } : {}),
    ...(args.validFrom ? { validFrom: args.validFrom } : {}),
    ...(args.validUntil ? { validUntil: args.validUntil } : {}),
    ...(args.unknownFields?.length ? { unknownFields: merged(current.unknownFields, args.unknownFields as DecisionField[]) } : {}),
  };
}

async function amendDecision({ deps, ctx }: ToolScope, args: z.output<typeof AmendArgs>): Promise<ToolOutput> {
  const id = ctx.refs.resolve(args.id);
  if (!id) return { content: `Unbekannte ID „${args.id}“ – list_entries kind=decision zeigt die Entscheidungen.`, isError: true };
  const d = deps.decisions.update(id, { patch: decisionPatch(args, deps.decisions.get(id)), trigger: 'agent' });
  const missing = deps.decisions.missingLabels(d);
  return {
    content: `${ctx.refs.entry(d.id)} ergänzt.\n${deps.decisions.format(d)}${missing.length ? `\nEs fehlt noch: ${missing.join(', ')} – frag nach oder speichere „unbekannt“.` : ''}`,
    summary: missing.length ? `ergänzt, fehlt: ${missing.join(', ')}` : 'vollständig',
    change: `Entscheidung „${truncate(d.title, 60)}“ ergänzt`,
  };
}

/** Recording, superseding and amending decisions. */
export function decisionTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'record_decision',
      description:
        'Eine getroffene Entscheidung erfassen (Pflichtangaben und Rückfragen, Personen-Auflösung, Widerspruchsprüfung wie gewohnt). Bei certainty="unsure" (könnte auch Plan, Ereignis oder Notiz sein) wird nichts gespeichert – dann frag den Benutzer. supersedes: Hinweis oder K-ID der ersetzten Entscheidung.',
      schema: RecordArgs,
      risk: 'write',
      label: (a) => `Erfasse die Entscheidung „${truncate(a.title ?? a.text, 60)}“`,
      run: (a, ctx) => recordDecision({ deps, ctx }, a),
    }),
    defineTool({
      name: 'supersede_decision',
      description:
        'Vorschlagen, dass eine neue Entscheidung (newer: K…) eine ältere aktive (older: K…) ersetzt – z. B. nach der Rückfrage „Welche Entscheidung wird ersetzt?“. Es entsteht eine Vorschlagskarte; als überholt markiert wird erst nach Bestätigung durch den Benutzer.',
      schema: z.object({ older: z.string().min(1), newer: z.string().min(1) }),
      risk: 'write',
      label: () => 'Schlage vor, eine ältere Entscheidung als überholt zu markieren',
      run: async (a, ctx) => {
        const older = ctx.refs.resolve(a.older);
        const newer = ctx.refs.resolve(a.newer);
        if (!older || !newer) return { content: `Unbekannte ID(s).${unknownNote([a.older, a.newer].filter((r) => !ctx.refs.resolve(r)))}`, isError: true };
        const action = deps.capture.proposeSupersedeOf(ctx.conversationId, { olderId: older, newerId: newer });
        ctx.actionIds.push(action.id);
        return {
          content: `Vorschlagskarte angelegt: ${action.label}. Der Benutzer bestätigt sie unter deiner Antwort.`,
          summary: 'als Vorschlag vorbereitet',
        };
      },
    }),
    defineTool({
      name: 'amend_decision',
      description:
        'Eine bestehende Entscheidung (K…) ergänzen oder korrigieren: Datum, Beteiligte, Thema, Projekt, Begründung, Folgen, Alternativen, Gültigkeit.',
      schema: AmendArgs,
      risk: 'write',
      label: () => 'Ergänze eine Entscheidung',
      run: (a, ctx) => amendDecision({ deps, ctx }, a),
    }),
  ];
}
