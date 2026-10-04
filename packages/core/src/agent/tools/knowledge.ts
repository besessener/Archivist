import { z } from 'zod';
import { truncate } from '../../util/text';
import { defineTool, list, optText, type AgentTool, type ToolOutput } from '../registry';
import type { ToolDeps, ToolScope } from './common';
import { agentIntent, dateArg, followUpQuestion, wikiNote } from './knowledge-capture';
import { decisionTools } from './knowledge-decisions';
import { taskTools } from './knowledge-tasks';
import { linkHint } from './link-methods';

async function recordNote(
  scope: ToolScope,
  args: { content: string; title: string | null; topic: string | null; links?: string[] | null },
): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const topic = args.topic ? deps.graph.ensureEntity({ type: 'topic', name: args.topic }) : null;
  const links = [
    ...(topic ? [{ targetId: topic.id, relationType: 'relates_to' as const, confidence: 0.8 }] : []),
    ...ctx.refs.resolveMany(args.links ?? []).ids.map((targetId) => ({ targetId, relationType: 'relates_to' as const })),
  ];
  const { note, created } = await deps.notes.createUnlessExists({ content: args.content, title: args.title, links });
  if (created) deps.audit.log({ action: 'note.create', actor: 'agent', trigger: 'agent', confirmed: true, entityIds: [note.id], after: { title: note.name } });
  return {
    content: `${ctx.refs.entry(note.id)} Notiz gespeichert${args.topic ? ` (Thema: ${args.topic})` : ''}.${wikiNote(deps, { text: args.content, id: note.id })}${await linkHint(scope, note.id)}`,
    summary: 'gespeichert',
    change: `Notiz „${truncate(args.title ?? args.content, 50)}“ gespeichert`,
  };
}

async function updateNote({ deps, ctx }: ToolScope, args: { note: string; title: string | null; content: string | null }): Promise<ToolOutput> {
  const id = ctx.refs.resolve(args.note);
  const note = id ? deps.graph.getEntity(id) : undefined;
  if (!id || note?.type !== 'note') return { content: `„${args.note}“ ist keine Notiz.`, isError: true };
  if (!args.title && !args.content) return { content: 'Gib title oder content an.', isError: true };
  const after = await deps.notes.update(id, { patch: { title: args.title ?? note.name, content: args.content ?? null }, trigger: 'agent', actor: 'agent' });
  return {
    content: `${ctx.refs.entry(id)} Notiz „${truncate(after.name, 60)}“ gespeichert.${wikiNote(deps, { text: after.description ?? '', id })}`,
    summary: 'gespeichert',
    change: `Notiz „${truncate(after.name, 50)}“ bearbeitet`,
  };
}

/** Capturing knowledge as agent tools (#307): the same capture module as the rule-based chat. */
export function knowledgeTools(deps: ToolDeps): AgentTool[] {
  return [
    ...decisionTools(deps),
    defineTool({
      name: 'record_note',
      description:
        'Eine Notiz festhalten (identische Notizen werden nicht doppelt angelegt). links: K/D-IDs, mit denen die Notiz verknüpft wird. Im Text verweist [[Name]] auf einen anderen Eintrag (Name oder Alias) und verknüpft ihn beim Speichern.',
      schema: z.object({ content: z.string().min(1), title: optText, topic: optText, links: list.nullish() }),
      risk: 'write',
      label: (a) => `Halte eine Notiz fest: „${truncate(a.title ?? a.content, 50)}“`,
      run: (a, ctx) => recordNote({ deps, ctx }, a),
    }),
    defineTool({
      name: 'update_note',
      description:
        'Titel und/oder Text einer vorhandenen Notiz (K…) ändern – nur auf Wunsch des Benutzers. Der Text ersetzt den bisherigen; [[Name]] verlinkt andere Einträge, entfernte Links entfernen die Verknüpfung. Danach wird die Notiz neu eingeordnet. Rückgängig im Änderungsprotokoll.',
      schema: z.object({ note: z.string().min(1), title: optText, content: optText }),
      risk: 'write',
      label: () => 'Bearbeite eine Notiz',
      run: (a, ctx) => updateNote({ deps, ctx }, a),
    }),
    ...taskTools(deps),
    defineTool({
      name: 'record_event',
      description: 'Ein Ereignis mit Datum in die Timeline eintragen (identische werden nicht doppelt angelegt; ohne Datum wird nachgefragt).',
      schema: z.object({ title: z.string().min(1), occurredAt: dateArg, description: optText, topic: optText, project: optText }),
      risk: 'write',
      label: (a) => `Trage das Ereignis „${truncate(a.title, 60)}“ ein`,
      run: async (a, ctx) => {
        const result = await deps.capture.forAgent({
          conversationId: ctx.conversationId,
          text: ctx.userText || a.title,
          intent: {
            ...agentIntent('event_record', a.title),
            topic: a.topic,
            project: a.project,
            event: { title: a.title, description: a.description, occurredAt: a.occurredAt },
          },
        });
        return {
          content: `${result.content}${followUpQuestion(result)}`,
          summary: result.question ? 'Datum fehlt' : 'eingetragen',
          change: result.question ? undefined : `Ereignis „${truncate(a.title, 60)}“ eingetragen`,
        };
      },
    }),
    defineTool({
      name: 'decide_proposal',
      description: 'Eine offene Vorschlagskarte (K-ID aus list_entries kind=proposal) bestätigen oder ablehnen – nur, wenn der Benutzer das verlangt.',
      schema: z.object({ id: z.string().min(1), decision: z.enum(['confirm', 'reject']) }),
      risk: 'write',
      label: (a) => (a.decision === 'confirm' ? 'Bestätige einen Vorschlag' : 'Lehne einen Vorschlag ab'),
      run: async (a, ctx) => {
        const id = ctx.refs.resolve(a.id);
        if (!id) return { content: `Unbekannte ID „${a.id}“.`, isError: true };
        const resolved = await deps.actions.resolve(id, { decision: a.decision === 'confirm' ? 'approve' : 'reject', confirmed: true });
        return {
          content: `Vorschlag „${resolved.label}“: ${resolved.status}${resolved.result ? ` – ${resolved.result}` : ''}`,
          summary: resolved.status,
          isError: resolved.status === 'failed',
          change: `Vorschlag „${truncate(resolved.label, 60)}“ ${a.decision === 'confirm' ? 'bestätigt' : 'abgelehnt'}`,
        };
      },
    }),
    defineTool({
      name: 'verified_answer',
      description:
        'Beantwortet eine Wissensfrage mit der geprüften Antwortlogik von Archivist (Quellen werden gesucht, jede Aussage wird gegen die Belege geprüft, Unsicheres gekennzeichnet). Gut als Abschluss einer Recherche.',
      schema: z.object({ question: z.string().min(3), alternativeQueries: list.nullish() }),
      risk: 'read',
      label: (a) => `Prüfe die Antwort auf „${truncate(a.question, 60)}“`,
      run: async (a) => ({ content: await deps.answers.verifiedAnswer(a.question, a.alternativeQueries ?? null), summary: 'geprüft' }),
    }),
  ];
}
