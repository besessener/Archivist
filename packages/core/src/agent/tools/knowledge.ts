import { z } from 'zod';
import type { ChatIntent, DecisionField, OpenItemPatch } from '@archivist/shared';
import { normalizeDateInput, normalizeDecisionDate, normalizeDueDate } from '../../util/dates';
import { truncate } from '../../util/text';
import { defineTool, list, optText, type AgentTool, type ToolContext } from '../registry';
import type { CaptureResult } from '../../services/capture';
import { unknownNote, type ToolDeps } from './common';
import { REMINDER_SNOOZE_UNDO, type ReminderSnoozeUndoData } from './tool-undo';
import { linkHint } from './link-methods';
import { wikiNames } from '../../services/wiki-links';

/** What became of the [[Name]] links of a saved note (#285): linked names, and unknown ones to offer creating. */
function wikiNote(deps: ToolDeps, text: string, noteId: string | undefined): string {
  const names = wikiNames(text);
  if (!names.length || !noteId) return '';
  const resolved = deps.notes.wiki.resolveAll(names, noteId);
  const known = resolved.filter((r) => r.entity).map((r) => `„${r.name}“`);
  const unknown = resolved.filter((r) => !r.entity).map((r) => `„${r.name}“`);
  return [
    known.length ? `\nVerlinkt: ${known.join(', ')}.` : '',
    unknown.length ? `\nNoch ohne Eintrag (anbieten, ihn anzulegen): ${unknown.join(', ')}.` : '',
  ].join('');
}

/**
 * Capturing knowledge as agent tools (#307): the tools call the capture module the rule-based chat uses as well (required
 * fields and follow-up questions, duplicate checks for open items, notes and events, „Entscheidung oder nur Notiz?“, person
 * resolution, superseding and contradiction checks). A follow-up question of a handler comes back as text: the agent asks
 * it through its own question exit (ask_user) and continues with the answer.
 */
const base = (intent: ChatIntent['intent'], segment: string): ChatIntent => ({
  intent,
  confidence: 0.9,
  rationale: 'Agent',
  segment,
  query: null,
  alternativeQueries: null,
  topic: null,
  project: null,
  timeRange: null,
  decision: null,
  openItem: null,
  event: null,
  reminder: null,
  proposalId: null,
  path: null,
  note: null,
  decisionCertainty: null,
});

function asked(r: CaptureResult): string {
  if (!r.question) return '';
  const q = r.question.trim() === r.content.trim() ? '(siehe oben)' : r.question;
  return `\nOFFENE RÜCKFRAGE ${q}\nStelle sie dem Benutzer mit ask_user (falls er es nicht schon gesagt hat) und ergänze danach mit dem passenden Werkzeug.`;
}

/** A date given in words or numbers → YYYY-MM-DD (deterministic, also for „31.10.“). */
const dateArg = optText.transform((v) => (v ? (normalizeDateInput(v) ?? v) : null));
/** A decision lies in the past: „31.10.“ without a year is the last 31 October. A future date stays and is refused by the service. */
const decisionDateArg = optText.transform((v) => (v ? (normalizeDecisionDate(v) ?? normalizeDateInput(v) ?? v) : null));
/** A due date lies ahead: „15.1.“ without a year is the next 15 January. */
const dueDateArg = optText.transform((v) => (v ? (normalizeDueDate(v) ?? v) : null));

/** Candidates of „Welche Entscheidung wird ersetzt?“ with their K-refs, so the agent can pass the user's choice on. */
function candidateNote(ctx: ToolContext, r: CaptureResult): string {
  if (!r.supersedeCandidateIds.length) return '';
  return `\nKandidaten (nach der Antwort des Benutzers supersede_decision aufrufen): ${r.supersedeCandidateIds.map((id) => ctx.refs.entry(id)).join(', ')}`;
}

export function knowledgeTools(deps: ToolDeps): AgentTool[] {
  const { capture } = deps;
  const ref = (ctx: ToolContext, id: string | null) => (id ? ctx.refs.entry(id) : '');

  return [
    defineTool({
      name: 'record_decision',
      description:
        'Eine getroffene Entscheidung erfassen (Pflichtangaben und Rückfragen, Personen-Auflösung, Widerspruchsprüfung wie gewohnt). Bei certainty="unsure" (könnte auch Plan, Ereignis oder Notiz sein) wird nichts gespeichert – dann frag den Benutzer. supersedes: Hinweis oder K-ID der ersetzten Entscheidung.',
      schema: z.object({
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
        unknownFields: z
          .array(z.enum(['decidedAt', 'participants', 'topic', 'rationale']))
          .nullish()
          .describe('Felder, die der Benutzer ausdrücklich nicht weiß'),
        certainty: z.enum(['clear', 'unsure']).default('clear'),
        supersedes: optText,
      }),
      risk: 'write',
      label: (a) => `Erfasse die Entscheidung „${truncate(a.title ?? a.text, 60)}“`,
      run: async (a, ctx) => {
        if (a.certainty === 'unsure')
          return {
            content:
              'NICHT GESPEICHERT. Es ist unklar, ob das eine getroffene Entscheidung ist. Frag den Benutzer mit ask_user: als Entscheidung, als Ereignis, nur als Notiz oder gar nicht speichern? (options: ["Entscheidung","Ereignis","Notiz","nichts speichern"])',
            summary: 'Rückfrage nötig',
          };
        const supersedesId = a.supersedes ? ctx.refs.resolve(a.supersedes) : null;
        const intent: ChatIntent = {
          ...base(a.supersedes ? 'decision_supersede' : 'decision_new', a.text),
          topic: a.topic,
          project: a.project,
          decisionCertainty: 'clear',
          decision: {
            title: a.title,
            decisionText: a.text,
            decidedAt: a.decidedAt,
            topic: a.topic,
            project: a.project,
            participants: a.participants ?? [],
            rationale: a.rationale,
            consequences: a.consequences,
            alternatives: a.alternatives ?? [],
            validFrom: a.validFrom,
            validUntil: a.validUntil,
            topicIsProject: a.topicIsProject ?? null,
            supersedesId,
            unknownFields: (a.unknownFields ?? []) as DecisionField[],
            confidence: 0.85,
          },
        };
        if (a.supersedes && !supersedesId) intent.topic = a.topic ?? a.supersedes;
        const r = await capture.forAgent(ctx.conversationId, ctx.userText || a.text, intent);
        ctx.actionIds.push(...r.actionIds);
        return {
          content: `${ref(ctx, r.decisionId)} ${r.content}${asked(r)}${candidateNote(ctx, r)}${r.actionIds.length ? `\n(${r.actionIds.length} Vorschlagskarte(n) zur Bestätigung angelegt)` : ''}${await linkHint(deps, ctx, r.decisionId)}`,
          summary: r.question ? 'als Entwurf, Angaben fehlen' : 'gespeichert',
          change: `Entscheidung „${truncate(a.title ?? a.text, 60)}“ erfasst`,
        };
      },
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
        const action = capture.proposeSupersedeOf(ctx.conversationId, older, newer);
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
      schema: z.object({
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
        unknownFields: z.array(z.enum(['decidedAt', 'participants', 'topic', 'rationale'])).nullish(),
      }),
      risk: 'write',
      label: () => 'Ergänze eine Entscheidung',
      run: async (a, ctx) => {
        const id = ctx.refs.resolve(a.id);
        if (!id) return { content: `Unbekannte ID „${a.id}“ – list_entries kind=decision zeigt die Entscheidungen.`, isError: true };
        const cur = deps.decisions.get(id);
        const d = deps.decisions.update(
          id,
          {
            ...(a.text ? { decisionText: a.text } : {}),
            ...(a.title ? { title: a.title } : {}),
            ...(a.decidedAt ? { decidedAt: a.decidedAt } : {}),
            ...(a.topic ? { topic: a.topic } : {}),
            ...(a.project ? { project: a.project } : {}),
            ...(a.participants?.length ? { participants: [...new Set([...cur.participants, ...a.participants])] } : {}),
            ...(a.rationale ? { rationale: a.rationale } : {}),
            ...(a.consequences ? { consequences: a.consequences } : {}),
            ...(a.alternatives?.length ? { alternatives: [...new Set([...cur.alternatives, ...a.alternatives])] } : {}),
            ...(a.validFrom ? { validFrom: a.validFrom } : {}),
            ...(a.validUntil ? { validUntil: a.validUntil } : {}),
            ...(a.unknownFields?.length ? { unknownFields: [...new Set([...cur.unknownFields, ...(a.unknownFields as DecisionField[])])] } : {}),
          },
          { trigger: 'agent' },
        );
        const missing = deps.decisions.missingLabels(d);
        return {
          content: `${ctx.refs.entry(d.id)} ergänzt.\n${deps.decisions.format(d)}${missing.length ? `\nEs fehlt noch: ${missing.join(', ')} – frag nach oder speichere „unbekannt“.` : ''}`,
          summary: missing.length ? `ergänzt, fehlt: ${missing.join(', ')}` : 'vollständig',
          change: `Entscheidung „${truncate(d.title, 60)}“ ergänzt`,
        };
      },
    }),
    defineTool({
      name: 'record_note',
      description:
        'Eine Notiz festhalten (identische Notizen werden nicht doppelt angelegt). links: K/D-IDs, mit denen die Notiz verknüpft wird. Im Text verweist [[Name]] auf einen anderen Eintrag (Name oder Alias) und verknüpft ihn beim Speichern.',
      schema: z.object({ content: z.string().min(1), title: optText, topic: optText, links: list.nullish() }),
      risk: 'write',
      label: (a) => `Halte eine Notiz fest: „${truncate(a.title ?? a.content, 50)}“`,
      run: async (a, ctx) => {
        const r = await capture.forAgent(ctx.conversationId, a.content, { ...base('note_capture', a.content), note: a.content, topic: a.topic });
        const created = deps.graph.listEntities({ type: 'note', limit: 2000 }).find((n) => (n.description ?? n.name).trim() === a.content.trim());
        if (created) {
          deps.audit.log({ action: 'note.create', actor: 'agent', trigger: 'agent', confirmed: true, entityIds: [created.id], after: { title: created.name } });
          for (const l of ctx.refs.resolveMany(a.links ?? []).ids) deps.graph.link(created.id, l, 'relates_to', { confidence: 0.9, status: 'confirmed' });
        }
        return {
          content: `${created ? ctx.refs.entry(created.id) : ''} ${r.content}${wikiNote(deps, a.content, created?.id)}${await linkHint(deps, ctx, created?.id ?? null)}`,
          summary: 'gespeichert',
          change: `Notiz „${truncate(a.title ?? a.content, 50)}“ gespeichert`,
        };
      },
    }),
    defineTool({
      name: 'update_note',
      description:
        'Titel und/oder Text einer vorhandenen Notiz (K…) ändern – nur auf Wunsch des Benutzers. Der Text ersetzt den bisherigen; [[Name]] verlinkt andere Einträge, entfernte Links entfernen die Verknüpfung. Danach wird die Notiz neu eingeordnet. Rückgängig im Änderungsprotokoll.',
      schema: z.object({ note: z.string().min(1), title: optText, content: optText }),
      risk: 'write',
      label: () => 'Bearbeite eine Notiz',
      run: async (a, ctx) => {
        const id = ctx.refs.resolve(a.note);
        const note = id ? deps.graph.getEntity(id) : undefined;
        if (!id || note?.type !== 'note') return { content: `„${a.note}“ ist keine Notiz.`, isError: true };
        if (!a.title && !a.content) return { content: 'Gib title oder content an.', isError: true };
        const after = await deps.notes.update(id, { title: a.title ?? null, content: a.content ?? null }, { trigger: 'agent', actor: 'agent' });
        return {
          content: `${ctx.refs.entry(id)} Notiz „${truncate(after.name, 60)}“ gespeichert.${wikiNote(deps, after.description ?? '', id)}`,
          summary: 'gespeichert',
          change: `Notiz „${truncate(after.name, 50)}“ bearbeitet`,
        };
      },
    }),
    defineTool({
      name: 'create_open_item',
      description:
        'Einen offenen Punkt anlegen (Dubletten-Prüfung; „ich/mir“ = Benutzer). Gibt es schon einen ähnlichen, wird nichts angelegt und das gemeldet – nach Rückfrage mit ifDuplicate="create" trotzdem anlegen oder update_open_item verwenden. sources: D-IDs der Dokumente, aus denen der Punkt stammt.',
      schema: z.object({
        title: z.string().min(1).describe('Kurzer Titel aus Subjekt und Tätigkeit'),
        description: optText,
        responsible: optText,
        dueAt: dueDateArg,
        priority: z.enum(['low', 'normal', 'high']).nullish(),
        topic: optText,
        project: optText,
        sources: list.nullish(),
        ifDuplicate: z.enum(['report', 'create']).default('report'),
      }),
      risk: 'write',
      label: (a) => `Lege den offenen Punkt „${truncate(a.title, 60)}“ an`,
      run: async (a, ctx) => {
        const r = await capture.forAgent(
          ctx.conversationId,
          [a.title, a.description].filter(Boolean).join(' – '),
          {
            ...base('open_item_new', a.title),
            topic: a.topic,
            project: a.project,
            openItem: {
              title: a.title,
              description: a.description,
              responsible: a.responsible,
              dueAt: a.dueAt,
              priority: a.priority ?? null,
              targetId: null,
              targetHint: null,
              newStatus: null,
              resolutionNote: null,
            },
          },
          { force: a.ifDuplicate === 'create' },
        );
        if (r.openItemId)
          for (const docId of ctx.refs.resolveMany(a.sources ?? []).ids)
            deps.openItems.addSource(r.openItemId, docId, {}, { actor: 'agent', trigger: 'agent' });
        return {
          content: `${ref(ctx, r.openItemId)} ${r.content}${asked(r)}${await linkHint(deps, ctx, r.openItemId)}`,
          summary: r.openItemId ? 'angelegt' : 'nicht angelegt',
          change: r.openItemId ? `Offener Punkt „${truncate(a.title, 60)}“ angelegt` : undefined,
        };
      },
    }),
    defineTool({
      name: 'update_open_item',
      description: 'Einen offenen Punkt (K…) ändern: Titel, Beschreibung (ergänzen), Verantwortlicher, Fälligkeit, Priorität, Status (open, waiting, blocked).',
      schema: z.object({
        id: z.string().min(1),
        title: optText,
        description: optText,
        appendDescription: z.boolean().default(true),
        responsible: optText,
        dueAt: dueDateArg,
        priority: z.enum(['low', 'normal', 'high']).nullish(),
        status: z.enum(['open', 'waiting', 'blocked']).nullish(),
      }),
      risk: 'write',
      label: () => 'Ändere einen offenen Punkt',
      run: async (a, ctx) => {
        const id = ctx.refs.resolve(a.id);
        if (!id) return { content: `Unbekannte ID „${a.id}“.`, isError: true };
        const cur = deps.openItems.get(id);
        const patch: OpenItemPatch = {};
        if (a.title) patch.title = a.title;
        if (a.description) patch.description = a.appendDescription && cur.description ? `${cur.description}\n${a.description}` : a.description;
        if (a.responsible) patch.responsible = a.responsible;
        if (a.dueAt) patch.dueAt = a.dueAt;
        if (a.priority) patch.priority = a.priority;
        if (a.status) patch.status = a.status;
        if (!Object.keys(patch).length) return { content: 'Nichts zu ändern angegeben.', isError: true };
        const o = deps.openItems.update(id, patch, { trigger: 'agent' });
        return {
          content: `${ctx.refs.entry(o.id)} „${o.title}“ geändert (${Object.keys(patch).join(', ')}).`,
          summary: 'geändert',
          change: `Offener Punkt „${truncate(o.title, 60)}“ geändert`,
        };
      },
    }),
    defineTool({
      name: 'close_open_item',
      description: 'Einen offenen Punkt (K…) schließen: resolved (erledigt) oder dismissed (hat sich erledigt), optional mit Lösungsnotiz.',
      schema: z.object({ id: z.string().min(1), status: z.enum(['resolved', 'dismissed']).default('resolved'), note: optText }),
      risk: 'write',
      label: () => 'Schließe einen offenen Punkt',
      run: async (a, ctx) => {
        const id = ctx.refs.resolve(a.id);
        if (!id) return { content: `Unbekannte ID „${a.id}“.`, isError: true };
        const o = deps.openItems.close(id, a.status, { confirmed: true, trigger: 'agent', resolutionNote: a.note });
        return {
          content: `${ctx.refs.entry(o.id)} „${o.title}“ ist jetzt ${a.status === 'resolved' ? 'erledigt' : 'verworfen'}.`,
          summary: 'geschlossen',
          change: `Offener Punkt „${truncate(o.title, 60)}“ geschlossen`,
        };
      },
    }),
    defineTool({
      name: 'create_reminder',
      description:
        'Eine Erinnerung anlegen. target: K-ID eines offenen Punkts oder D-ID eines Dokuments (optional). remindAt: Datum (YYYY-MM-DD) oder Zeitpunkt. Gibt es für dasselbe Ziel schon eine Erinnerung am selben Tag, wird keine zweite angelegt.',
      schema: z.object({ title: z.string().min(1), remindAt: z.string().min(4), target: optText }),
      risk: 'write',
      label: (a) => `Lege eine Erinnerung an: „${truncate(a.title, 50)}“`,
      run: async (a, ctx) => {
        const when = normalizeDueDate(a.remindAt) ?? a.remindAt;
        if (!/^\d{4}-\d{2}-\d{2}/.test(when)) return { content: `Ungültiges Datum „${a.remindAt}“ – erwartet YYYY-MM-DD.`, isError: true };
        const targetId = a.target ? ctx.refs.resolve(a.target) : null;
        const targetType = !targetId
          ? 'custom'
          : deps.docs.findRow(targetId)
            ? 'document'
            : (() => {
                try {
                  deps.openItems.get(targetId);
                  return 'open_item';
                } catch {
                  return 'custom';
                }
              })();
        const dupe = deps.reminders
          .list('pending')
          .find(
            (r) =>
              r.remindAt.slice(0, 10) === when.slice(0, 10) &&
              ((targetId && r.targetId === targetId) || (!targetId && r.title.toLowerCase() === a.title.toLowerCase())),
          );
        if (dupe)
          return {
            content: `Es gibt schon eine Erinnerung „${dupe.title}“ am ${dupe.remindAt.slice(0, 10)} – keine zweite angelegt.`,
            summary: 'schon vorhanden',
          };
        const r = deps.reminders.create({
          targetType: targetType,
          targetId: targetType === 'custom' ? null : targetId,
          title: a.title,
          remindAt: when,
        });
        deps.audit.log({
          action: 'reminder.create',
          actor: 'agent',
          trigger: 'agent',
          confirmed: true,
          entityIds: [r.id],
          after: { title: r.title, remindAt: r.remindAt },
        });
        return {
          content: `Erinnerung „${r.title}“ am ${r.remindAt.slice(0, 16)} angelegt.`,
          summary: `am ${r.remindAt.slice(0, 10)}`,
          change: `Erinnerung „${truncate(r.title, 50)}“ am ${r.remindAt.slice(0, 10)}`,
        };
      },
    }),
    defineTool({
      name: 'snooze_reminder',
      description: 'Eine bestehende Erinnerung (K…) verschieben.',
      schema: z.object({ id: z.string().min(1), remindAt: z.string().min(4) }),
      risk: 'write',
      label: () => 'Verschiebe eine Erinnerung',
      run: async (a, ctx) => {
        const id = ctx.refs.resolve(a.id);
        const when = normalizeDueDate(a.remindAt) ?? a.remindAt;
        if (!id) return { content: `Unbekannte ID „${a.id}“.`, isError: true };
        const before = deps.reminders.get(id);
        const r = deps.reminders.snooze(id, when);
        deps.audit.log({
          action: 'reminder.snooze',
          actor: 'agent',
          trigger: 'agent',
          confirmed: true,
          entityIds: [id],
          before: { remindAt: before.remindAt },
          after: { remindAt: r.remindAt },
          undo: {
            type: REMINDER_SNOOZE_UNDO,
            data: { id, before: { remindAt: before.remindAt, status: before.status }, after: { remindAt: r.remindAt } } satisfies ReminderSnoozeUndoData,
          },
        });
        return {
          content: `Erinnerung „${r.title}“ auf ${r.remindAt.slice(0, 16)} verschoben.`,
          summary: 'verschoben',
          change: `Erinnerung „${truncate(r.title, 50)}“ verschoben`,
        };
      },
    }),
    defineTool({
      name: 'record_event',
      description: 'Ein Ereignis mit Datum in die Timeline eintragen (identische werden nicht doppelt angelegt; ohne Datum wird nachgefragt).',
      schema: z.object({ title: z.string().min(1), occurredAt: dateArg, description: optText, topic: optText, project: optText }),
      risk: 'write',
      label: (a) => `Trage das Ereignis „${truncate(a.title, 60)}“ ein`,
      run: async (a, ctx) => {
        const r = await capture.forAgent(ctx.conversationId, ctx.userText || a.title, {
          ...base('event_record', a.title),
          topic: a.topic,
          project: a.project,
          event: { title: a.title, description: a.description, occurredAt: a.occurredAt },
        });
        return {
          content: `${r.content}${asked(r)}`,
          summary: r.question ? 'Datum fehlt' : 'eingetragen',
          change: r.question ? undefined : `Ereignis „${truncate(a.title, 60)}“ eingetragen`,
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
        const res = await deps.actions.resolve(id, a.decision === 'confirm' ? 'approve' : 'reject', { confirmed: true });
        return {
          content: `Vorschlag „${res.label}“: ${res.status}${res.result ? ` – ${res.result}` : ''}`,
          summary: res.status,
          isError: res.status === 'failed',
          change: `Vorschlag „${truncate(res.label, 60)}“ ${a.decision === 'confirm' ? 'bestätigt' : 'abgelehnt'}`,
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
