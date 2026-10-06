import { z } from 'zod';
import type { GraphEntity, ToolRisk } from '@archivist/shared';
import { truncate } from '../../util/text';
import { DELETABLE_SUBJECT_TYPES, linkCount } from '../../services/graph/subject-delete';
import { defineTool, optText, type AgentTool, type ToolContext } from '../registry';
import { TYPE_LABEL, type ToolDeps } from './common';

const DeleteArgs = z.object({ subject: z.string().min(1), type: z.enum(['person', 'topic', 'project', 'tag']).nullish(), reason: optText });
type DeleteArgs = z.output<typeof DeleteArgs>;

/** The subjects a K-ID or a name stands for: a ref names one, a name can match several types or persons. */
function matches(deps: ToolDeps, ctx: ToolContext, args: DeleteArgs): GraphEntity[] {
  const ref = ctx.refs.resolve(args.subject);
  if (ref) return [deps.graph.getEntity(ref)].filter((entity) => entity !== undefined);
  const types = args.type ? [args.type] : (['person', 'topic', 'project', 'tag'] as const);
  const found = types.flatMap((type) => {
    if (type !== 'person') return [deps.graph.findByNameOrAlias(type, args.subject)].filter((entity) => entity !== undefined);
    const person = deps.persons.resolve(args.subject, { create: false });
    // names the person parser rejects (an identifier like „K35“) are still found when such a person exists
    const known = person.entity ?? deps.graph.findByNameOrAlias('person', args.subject);
    return known ? [known] : person.ambiguousCandidates.map((candidate) => candidate.entity);
  });
  return [...new Map(found.map((entity) => [entity.id, entity])).values()];
}

/** Without links the deletion is a plain change; anything that still hangs on the subject asks first. */
function riskOfDeleting(deps: ToolDeps, args: DeleteArgs, ctx?: ToolContext): ToolRisk {
  const found = ctx ? matches(deps, ctx, args) : [];
  const [subject] = found;
  if (found.length !== 1 || !subject || subject.isSelf || !DELETABLE_SUBJECT_TYPES.has(subject.type)) return 'critical';
  return linkCount(deps.graph.subjectImpact(subject.id)) === 0 ? 'write' : 'critical';
}

function problemWith(found: GraphEntity[], ctx: ToolContext, args: DeleteArgs): string | null {
  if (found.length === 0) return `Kein Eintrag „${args.subject}“ gefunden. Mit list_subjects nachsehen oder den Benutzer fragen.`;
  if (found.length > 1) {
    const candidates = found.map((entity) => `${ctx.refs.entry(entity.id)} ${TYPE_LABEL[entity.type] ?? entity.type} „${entity.name}“`).join(', ');
    return `„${args.subject}“ ist nicht eindeutig. Kandidaten: ${candidates}. Frag den Benutzer mit ask_user oder gib die K-ID und type an.`;
  }
  const [subject] = found;
  if (subject?.isSelf) return 'Der Benutzer selbst wird nicht gelöscht.';
  if (subject && !DELETABLE_SUBJECT_TYPES.has(subject.type))
    return `„${subject.name}“ ist ${TYPE_LABEL[subject.type] ?? 'ein Eintrag'}: delete_subject löscht nur Personen, Themen, Projekte und Schlagwörter.`;
  return null;
}

export function subjectDeleteTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'delete_subject',
      description:
        'Eine Person, ein Thema, ein Projekt oder ein Schlagwort (K…) löschen, z. B. eine fälschlich angelegte Person. Entfernt alle Verknüpfungen und Aliasse; Dokumente, deren Hauptthema/-projekt es war, verlieren es (Ablage und Dateien bleiben unverändert, sie werden aufgelistet). Der Name wird von der automatischen Erkennung nicht wieder angelegt. subject: K-ID oder eindeutiger Name, type nur zur Eindeutigkeit, reason fürs Protokoll. Ohne Verknüpfungen läuft das Löschen direkt, sonst fragt Archivist den Benutzer vorher. Rückgängig möglich. Den Benutzer selbst löschst du nicht. Für Gelerntes forget, für Doppelte merge_subjects.',
      schema: DeleteArgs,
      risk: (args, ctx) => riskOfDeleting(deps, args, ctx),
      label: (args) => `Lösche „${truncate(args.subject, 40)}“`,
      run: async (args, ctx) => {
        const found = matches(deps, ctx, args);
        const problem = problemWith(found, ctx, args);
        if (problem || !found[0]) return { content: problem ?? '', isError: true };
        const subject = found[0];
        const reference = ctx.refs.entry(subject.id);
        const { impact, relationsRemoved } = await deps.graph.deleteSubject(subject.id, { actor: 'agent', trigger: 'agent', reason: args.reason ?? undefined });
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
