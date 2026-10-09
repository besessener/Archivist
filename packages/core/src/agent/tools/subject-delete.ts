import { z } from 'zod';
import { DeletableSubjectType, isDeletableSubjectType, type GraphEntity, type ToolRisk } from '@archivist/shared';
import { truncate } from '../../util/text';
import { linkCount } from '../../services/graph/subject-delete';
import { defineTool, optText, type AgentTool, type ToolContext } from '../registry';
import { TYPE_LABEL, type ToolDeps } from './common';

const DeleteArgs = z.object({ subject: z.string().min(1), type: DeletableSubjectType.nullish(), reason: optText });
type DeleteArgs = z.output<typeof DeleteArgs>;

type SubjectPick = { kind: 'subject'; subject: GraphEntity } | { kind: 'problem'; problem: string };

/** The subjects a K-ID or a name stands for: a ref names one, a name can match several types or persons. */
function matches(deps: ToolDeps, ctx: ToolContext, args: DeleteArgs): GraphEntity[] {
  const ref = ctx.refs.resolve(args.subject);
  if (ref) return [deps.graph.getEntity(ref)].filter((entity) => entity !== undefined);
  const types = args.type ? [args.type] : DeletableSubjectType.options;
  const found = types.flatMap((type) => {
    if (type !== 'person') return [deps.graph.findByNameOrAlias(type, args.subject)].filter((entity) => entity !== undefined);
    const person = deps.persons.resolve(args.subject, { create: false });
    // names the person parser rejects (an identifier like „K35“) are still found when such a person exists
    const known = person.entity ?? deps.graph.findByNameOrAlias('person', args.subject);
    return known ? [known] : person.ambiguousCandidates.map((candidate) => candidate.entity);
  });
  return [...new Map(found.map((entity) => [entity.id, entity])).values()];
}

/** The one deletable subject the call names, or what the model has to clear up first. */
function pickSubject(deps: ToolDeps, ctx: ToolContext, args: DeleteArgs): SubjectPick {
  const [subject, ...others] = matches(deps, ctx, args);
  const problem = (text: string): SubjectPick => ({ kind: 'problem', problem: text });
  if (!subject) return problem(`Kein Eintrag „${args.subject}“ gefunden. Mit list_subjects nachsehen oder den Benutzer fragen.`);
  if (others.length > 0) {
    const candidates = [subject, ...others]
      .map((entity) => `${ctx.refs.entry(entity.id)} ${TYPE_LABEL[entity.type] ?? entity.type} „${entity.name}“`)
      .join(', ');
    return problem(`„${args.subject}“ ist nicht eindeutig. Kandidaten: ${candidates}. Frag den Benutzer mit ask_user oder gib die K-ID und type an.`);
  }
  if (subject.isSelf) return problem('Der Benutzer selbst wird nicht gelöscht.');
  if (!isDeletableSubjectType(subject.type))
    return problem(
      `„${subject.name}“ ist ${TYPE_LABEL[subject.type] ?? 'ein Eintrag'}: delete_subject löscht nur Personen, Themen, Projekte und Schlagwörter.`,
    );
  return { kind: 'subject', subject };
}

/** Without links the deletion is a plain change; anything that still hangs on the subject asks first. */
function riskOfDeleting(deps: ToolDeps, args: DeleteArgs, ctx: ToolContext): ToolRisk {
  const pick = pickSubject(deps, ctx, args);
  if (pick.kind === 'problem') return 'critical';
  return linkCount(deps.graph.subjectImpact(pick.subject.id)) === 0 ? 'write' : 'critical';
}

export function subjectDeleteTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'delete_subject',
      description:
        'Eine Person, ein Thema, ein Projekt oder ein Schlagwort (K…) löschen, z. B. eine fälschlich angelegte Person. Entfernt alle Verknüpfungen und Aliasse; Dokumente, deren Hauptthema/-projekt es war, verlieren es (Ablage und Dateien bleiben unverändert, sie werden aufgelistet). Der Name wird von der automatischen Erkennung nicht wieder angelegt. subject: K-ID oder eindeutiger Name, type nur zur Eindeutigkeit, reason fürs Protokoll. Nur auf ausdrücklichen Wunsch des Benutzers; ohne Verknüpfungen läuft das Löschen dann direkt, sonst fragt Archivist ihn vorher. Rückgängig möglich. Den Benutzer selbst löschst du nicht. Für Gelerntes forget, für Doppelte merge_subjects.',
      schema: DeleteArgs,
      risk: (args, ctx) => riskOfDeleting(deps, args, ctx),
      requiresUserRequest: true,
      label: (args) => `Lösche „${truncate(args.subject, 40)}“`,
      run: async (args, ctx) => {
        const pick = pickSubject(deps, ctx, args);
        if (pick.kind === 'problem') return { content: pick.problem, isError: true };
        const { subject } = pick;
        const reference = ctx.refs.entry(subject.id);
        const { impact, relationsRemoved } = await deps.graph.deleteSubject(subject.id, {
          actor: 'agent',
          trigger: 'agent',
          confirmed: true,
          reason: args.reason ?? undefined,
        });
        const removed = relationsRemoved + impact.records.length;
        const lost = impact.records
          .filter((record) => record.main)
          .map((record) => `„${truncate(record.title, 60)}“ (${record.table === 'documents' ? ctx.refs.doc(record.id) : ctx.refs.entry(record.id)})`);
        const lostNote = lost.length ? ` Ohne Hauptthema/-projekt (Ablage unverändert, nichts verschoben): ${lost.join(', ')}.` : '';
        const label = TYPE_LABEL[subject.type] ?? 'Eintrag';
        return {
          content: `${label} „${subject.name}“ (${reference}) gelöscht – ${removed} Verknüpfung(en) entfernt. Rückgängig möglich.${lostNote}`,
          summary: 'gelöscht',
          change: `${label} „${subject.name}“ gelöscht (${removed} Verknüpfung(en) entfernt)`,
        };
      },
    }),
  ];
}
