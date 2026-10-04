import { z } from 'zod';
import type { GraphEntity } from '@archivist/shared';
import { normalizeDateInput } from '../../util/dates';
import { truncate } from '../../util/text';
import { defineTool, list, optText, type AgentTool, type ToolOutput } from '../registry';
import { TYPE_LABEL, affectedCount, resolveDocs, unknownNote, type ToolDeps, type ToolScope } from './common';
import { updateEntries } from './metadata-entries';

/** "" or "-" means: remove the value. */
const removable = z
  .string()
  .nullish()
  .transform((v) => (v === undefined || v === null ? undefined : ['', '-', 'keins', 'keines', 'ohne'].includes(v.trim().toLowerCase()) ? null : v.trim()));

const SetArgs = z.object({
  targets: list,
  topic: removable,
  project: removable,
  addTopics: list.nullish(),
  addProjects: list.nullish(),
  removeTopics: list.nullish(),
  removeProjects: list.nullish(),
  case: optText,
  addPersons: list.nullish(),
  removePersons: list.nullish(),
  addTags: list.nullish(),
  removeTags: list.nullish(),
  docType: removable,
  title: optText,
  documentDate: removable,
});
type SetMetadata = z.output<typeof SetArgs>;

/** The change of a `set_metadata` call in words (for the run log). */
function describeChange(args: SetMetadata, date: string | null | undefined): string {
  return [
    args.addTopics?.length && `Themen +${args.addTopics.join(', ')}`,
    args.addProjects?.length && `Projekte +${args.addProjects.join(', ')}`,
    args.removeTopics?.length && `Themen −${args.removeTopics.join(', ')}`,
    args.removeProjects?.length && `Projekte −${args.removeProjects.join(', ')}`,
    args.case && `Vorgang ${args.case}`,
    args.topic !== undefined && `Thema ${args.topic ?? 'entfernt'}`,
    args.project !== undefined && `Projekt ${args.project ?? 'entfernt'}`,
    args.addTags?.length && `Tags +${args.addTags.join(', ')}`,
    args.removeTags?.length && `Tags −${args.removeTags.join(', ')}`,
    args.addPersons?.length && `Personen +${args.addPersons.join(', ')}`,
    args.docType !== undefined && `Typ ${args.docType ?? 'entfernt'}`,
    date !== undefined && `Datum ${date ?? 'entfernt'}`,
    args.title && `Titel „${args.title}“`,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The business date of the call: undefined leaves it, null removes it. */
function parseDocumentDate(raw: string | null | undefined): { date: string | null | undefined } | { error: string } {
  if (!raw) return { date: raw };
  const date = normalizeDateInput(raw);
  return date ? { date } : { error: `Ungültiges Datum „${raw}“ – erwartet YYYY-MM-DD.` };
}

/** Persons that match several known ones: asked about instead of guessed. */
function unclearPersons(deps: ToolDeps, names: string[]): string[] {
  return names.flatMap((name) => {
    const resolved = deps.persons.resolve(name, { create: false });
    if (resolved.entity || resolved.selfReference || resolved.ambiguousCandidates.length <= 1) return [];
    const candidates = resolved.ambiguousCandidates
      .slice(0, 3)
      .map((c) => c.entity.name)
      .join(' oder ');
    return [`„${name}“ (meinst du ${candidates}?)`];
  });
}

/** „ich/mir/mich“ is the user's own person (#305). */
const ownName = (deps: ToolDeps, name: string) => {
  const resolved = deps.persons.resolve(name, { create: false });
  return resolved.selfReference || resolved.matchedBy === 'self' ? (resolved.entity?.name ?? (deps.settings.get().profile.name || name)) : name;
};

/** A case by its ref or the name of an existing one (#286). */
function findCase({ deps, ctx }: ToolScope, ref: string): GraphEntity | undefined {
  const byRef = ctx.refs.resolve(ref);
  const entity = byRef ? deps.graph.getEntity(byRef) : undefined;
  return (entity?.type === 'case' ? entity : undefined) ?? deps.graph.findByNameOrAlias('case', ref);
}

function updateDocuments(deps: ToolDeps, update: { ids: string[]; args: SetMetadata; addPersons: string[]; date: string | null | undefined }): number {
  const { args, addPersons, date } = update;
  const result = deps.docs.bulkUpdate(update.ids, {
    patch: {
      ...(args.title ? { title: args.title } : {}),
      ...(args.topic !== undefined ? { topic: args.topic } : {}),
      ...(args.project !== undefined ? { project: args.project } : {}),
      ...(args.addTags?.length ? { addTags: args.addTags } : {}),
      ...(args.removeTags?.length ? { removeTags: args.removeTags } : {}),
      ...(addPersons.length ? { addPersons } : {}),
      ...(args.removePersons?.length ? { removePersons: args.removePersons } : {}),
      ...(args.docType !== undefined ? { docType: args.docType } : {}),
      ...(date !== undefined ? { documentDate: date } : {}),
    },
    trigger: 'agent',
  });
  return result.updated.length;
}

type FurtherPatch = Parameters<ToolDeps['subjects']['bulkAssign']>[1]['patch'];

/** Further topics/projects, a case and tags of entries without a tag column: added, ONE undo step each (#287, #291). */
async function assignFurther(deps: ToolDeps, assignment: { ids: string[]; others: string[]; args: SetMetadata; caseId?: string }): Promise<number> {
  const { ids, others, args, caseId } = assignment;
  const noteIds = others.filter((id) => deps.graph.getEntity(id)?.type === 'note');
  const otherEntries = others.filter((id) => !noteIds.includes(id));
  const assign = async (targets: string[], patch: FurtherPatch) => {
    if (!targets.length || (!patch.topics?.length && !patch.projects?.length && !patch.tags?.length && !patch.caseId)) return 0;
    return (await deps.subjects.bulkAssign(targets, { patch, trigger: 'agent' })).updated;
  };
  return (
    (await assign(ids, { topics: args.addTopics ?? [], projects: args.addProjects ?? [], caseId })) +
    // notes have no main topic: a topic or project for a note is a further one
    (await assign(noteIds, { topics: args.topic ? [args.topic] : [], projects: args.project ? [args.project] : [], tags: args.addTags ?? [] })) +
    (await assign(otherEntries, { tags: args.addTags ?? [] }))
  );
}

async function setMetadata(scope: ToolScope, args: SetMetadata): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const { ids, unknown } = ctx.refs.resolveMany(args.targets);
  if (!ids.length) return { content: `Keine Einträge angegeben.${unknownNote(unknown)}`, isError: true };
  const docIds = ids.filter((id) => deps.docs.findRow(id));
  const others = ids.filter((id) => !docIds.includes(id));
  const parsed = parseDocumentDate(args.documentDate);
  if ('error' in parsed) return { content: parsed.error, isError: true };
  const { date } = parsed;
  const unclear = unclearPersons(deps, args.addPersons ?? []);
  if (unclear.length) return { content: `Unklare Person(en): ${unclear.join('; ')}. Frag den Benutzer mit ask_user, wer gemeint ist.`, isError: true };
  const addPersons = (args.addPersons ?? []).map((name) => ownName(deps, name));
  const caseEntity = args.case ? findCase(scope, args.case) : undefined;
  if (args.case && !caseEntity)
    return { content: `Vorgang „${args.case}“ ist unbekannt – mit create_case anlegen oder list_subjects type=case ansehen.`, isError: true };
  const changed: string[] = [];
  if (docIds.length) changed.push(`${updateDocuments(deps, { ids: docIds, args, addPersons, date })} Dokument(e)`);
  const entries = updateEntries(deps, { ids: others, change: { ...args, addPersons, date } });
  if ('error' in entries) return { content: entries.error, isError: true };
  changed.push(...entries.changed);
  const added = await assignFurther(deps, { ids, others, args, caseId: caseEntity?.id });
  if (added) changed.push(`${added} Zuordnung(en) ergänzt`);
  const removed =
    args.removeTopics?.length || args.removeProjects?.length
      ? deps.subjects.removeFurther(ids, { patch: { topics: args.removeTopics ?? [], projects: args.removeProjects ?? [] }, trigger: 'agent' })
      : 0;
  if (removed) changed.push(`${removed} weitere(s) Thema/Projekt entfernt`);
  const what = describeChange(args, date);
  if (!changed.length) return { content: `Nichts geändert.${unknownNote(unknown)}`, isError: true };
  return {
    content: `Geändert: ${changed.join(', ')} – ${what}.${unknownNote(unknown)}`,
    summary: changed.join(', '),
    change: `${changed.join(', ')}: ${what}`,
    changed: ids.length,
  };
}

export function metadataTools(deps: ToolDeps): AgentTool[] {
  const { graph } = deps;

  return [
    defineTool({
      name: 'set_metadata',
      description:
        'Thema, Projekt, Personen, Tags, Dokumenttyp, Titel und fachliches Datum setzen oder entfernen – für Dokumente (D…/S…, einzeln und in Serie; eine Sammelaktion ist EIN Rückgängig-Schritt). Für Entscheidungen, offene Punkte und Ereignisse (K…) Titel, Thema, Projekt, Personen (Beteiligte bzw. verantwortlich) und Datum (documentDate = Entscheidungsdatum, Fälligkeit bzw. Ereignisdatum). topic/project ERSETZEN das Hauptthema bzw. -projekt (danach richtet sich die Ablage); leerer Wert ("") entfernt es. Ein Eintrag kann weitere Themen und Projekte haben: addTopics/addProjects ERGÄNZEN (wer noch keins hat, bekommt es als Hauptthema), removeTopics/removeProjects entfernen weitere. „Ordne das auch X zu“ heißt ergänzen, nicht ersetzen. case: Vorgang (ID oder Name eines vorhandenen Vorgangs), dem die Einträge zugeordnet werden. addTags gilt für alle Arten von Einträgen, auch Notizen. Personen werden mit dem Graph abgeglichen (Aliasse, „ich“ = Benutzer).',
      schema: SetArgs,
      risk: 'write',
      count: (a, ctx) => affectedCount(ctx, a.targets),
      label: (a) =>
        `Ordne ${a.targets.length === 1 && !a.targets[0]!.toUpperCase().startsWith('S') ? 'einen Eintrag' : 'Einträge'} zu${a.topic ? ` (Thema ${a.topic})` : ''}${a.project ? ` (Projekt ${a.project})` : ''}${a.addTopics?.length ? ` (+ Thema ${a.addTopics.join(', ')})` : ''}${a.addProjects?.length ? ` (+ Projekt ${a.addProjects.join(', ')})` : ''}${a.case ? ` (Vorgang ${a.case})` : ''}`,
      run: (a, ctx) => setMetadata({ deps, ctx }, a),
    }),
    defineTool({
      name: 'create_subject',
      description: 'Ein neues Thema, Projekt, eine Person oder ein Schlagwort anlegen (bestehende werden wiederverwendet).',
      schema: z.object({ type: z.enum(['topic', 'project', 'person', 'tag']), name: z.string().min(1), description: optText }),
      risk: 'write',
      label: (a) => `Lege ${TYPE_LABEL[a.type]} „${truncate(a.name, 40)}“ an`,
      run: async (a, ctx) => {
        // a person also matches without titles or roles and as the user's own person
        const existing = a.type === 'person' ? deps.persons.resolve(a.name, { create: false }).entity : graph.findByNameOrAlias(a.type, a.name);
        if (existing) return { content: `${ctx.refs.entry(existing.id)} ${TYPE_LABEL[a.type]} „${existing.name}“ gibt es schon.`, summary: 'gab es schon' };
        const entity =
          a.type === 'person'
            ? deps.persons.resolve(a.name, { create: true }).entity
            : graph.ensureEntity({ type: a.type, name: a.name, description: a.description });
        if (!entity) return { content: `„${a.name}“ ist kein Personenname.`, isError: true };
        deps.audit.log({
          action: 'entity.create',
          actor: 'agent',
          trigger: 'agent',
          confirmed: true,
          entityIds: [entity.id],
          after: { type: a.type, name: entity.name },
        });
        return {
          content: `${ctx.refs.entry(entity.id)} ${TYPE_LABEL[a.type]} „${entity.name}“ angelegt.`,
          summary: 'angelegt',
          change: `${TYPE_LABEL[a.type]} „${entity.name}“ angelegt`,
        };
      },
    }),
    defineTool({
      name: 'merge_subjects',
      description:
        'Themen, Projekte, Personen oder Schlagwörter (K…) zusammenführen – über den bestehenden Ablauf mit Rückgängig. sources werden in target übernommen.',
      schema: z.object({ sources: list, target: z.string().min(1), allowCrossType: z.boolean().default(false) }),
      risk: 'write',
      count: (a, ctx) => Math.max(1, ctx.refs.resolveMany(a.sources).ids.length),
      label: () => 'Führe Einträge zusammen',
      run: async (a, ctx) => {
        const target = ctx.refs.resolve(a.target);
        const { ids, unknown } = ctx.refs.resolveMany(a.sources);
        if (!target || !ids.length) return { content: `Unbekannte IDs.${unknownNote(unknown)}`, isError: true };
        const merged = await graph.merge(
          { sourceIds: ids.filter((i) => i !== target), targetId: target, allowCrossType: a.allowCrossType },
          { trigger: 'agent' },
        );
        return {
          content: `${merged.mergedNames.map((n) => `„${n}“`).join(', ')} mit „${merged.targetName}“ zusammengeführt (${merged.relationsMoved} Beziehungen übernommen).`,
          summary: 'zusammengeführt',
          change: `${merged.mergedNames.join(', ')} → ${merged.targetName} zusammengeführt`,
        };
      },
    }),
    defineTool({
      name: 'resolve_person',
      description:
        'Prüft, welche bekannte Person mit einem Namen gemeint ist (Aliasse, Spitznamen, „ich“ = Benutzer). Bei mehreren Kandidaten frag den Benutzer.',
      schema: z.object({ name: z.string().min(1) }),
      risk: 'read',
      label: (a) => `Prüfe, wer mit „${truncate(a.name, 30)}“ gemeint ist`,
      run: async (a, ctx) => {
        const person = deps.persons.resolve(a.name, { create: false });
        if (person.selfReference) return { content: 'Gemeint ist der Benutzer selbst.' };
        if (person.entity) return { content: `${ctx.refs.entry(person.entity.id)} ${person.entity.name} (erkannt über ${person.matchedBy}).` };
        if (person.ambiguousCandidates.length)
          return {
            content: `Nicht eindeutig. Kandidaten: ${person.ambiguousCandidates.map((c) => `${ctx.refs.entry(c.entity.id)} ${c.entity.name}`).join(', ')}. Frag den Benutzer.`,
          };
        return { content: person.rejected ? `„${a.name}“ ist kein Personenname.` : `Keine bekannte Person „${a.name}“.` };
      },
    }),
    defineTool({
      name: 'exclude_from_llm',
      description:
        'Dokumente von der Analyse durch das LLM ausschließen (excluded=false hebt das auf). Das ist eine Datenschutz-Einstellung und fragt immer nach. Die Datei selbst wird nicht verändert.',
      schema: z.object({ documents: list, excluded: z.boolean().default(true) }),
      risk: 'critical',
      count: (a, ctx) => ctx.refs.resolveMany(a.documents).ids.length,
      label: (a) => (a.excluded ? 'Schließe Dokumente von der KI-Analyse aus' : 'Gebe Dokumente für die KI-Analyse frei'),
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs({ deps, ctx }, a.documents);
        for (const d of docs) deps.docs.setLlmExcluded(d.id, { excluded: a.excluded });
        return {
          content: `${docs.length} Dokument(e) ${a.excluded ? 'von der LLM-Analyse ausgeschlossen' : 'wieder freigegeben'}.${unknownNote(unknown)}`,
          summary: `${docs.length} geändert`,
          change: `${docs.length} Dokument(e) ${a.excluded ? 'von der LLM-Analyse ausgeschlossen' : 'freigegeben'}`,
        };
      },
    }),
  ];
}
