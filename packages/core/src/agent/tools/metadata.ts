import { z } from 'zod';
import { normalizeDateInput } from '../../util/dates';
import { truncate } from '../../util/text';
import { defineTool, list, optText, type AgentTool, type ToolContext } from '../registry';
import { TYPE_LABEL, resolveDocs, unknownNote, type ToolDeps } from './common';

/** "" or "-" means: remove the value. */
const removable = z
  .string()
  .nullish()
  .transform((v) => (v === undefined || v === null ? undefined : ['', '-', 'keins', 'keines', 'ohne'].includes(v.trim().toLowerCase()) ? null : v.trim()));

/** The change of a `set_metadata` call in words (for the run log). */
function describeChange(
  a: {
    addTopics?: string[] | null;
    addProjects?: string[] | null;
    removeTopics?: string[] | null;
    removeProjects?: string[] | null;
    case?: string | null;
    topic?: string | null;
    project?: string | null;
    addTags?: string[] | null;
    removeTags?: string[] | null;
    addPersons?: string[] | null;
    docType?: string | null;
    title?: string | null;
  },
  date: string | null | undefined,
): string {
  return [
    a.addTopics?.length && `Themen +${a.addTopics.join(', ')}`,
    a.addProjects?.length && `Projekte +${a.addProjects.join(', ')}`,
    a.removeTopics?.length && `Themen −${a.removeTopics.join(', ')}`,
    a.removeProjects?.length && `Projekte −${a.removeProjects.join(', ')}`,
    a.case && `Vorgang ${a.case}`,
    a.topic !== undefined && `Thema ${a.topic ?? 'entfernt'}`,
    a.project !== undefined && `Projekt ${a.project ?? 'entfernt'}`,
    a.addTags?.length && `Tags +${a.addTags.join(', ')}`,
    a.removeTags?.length && `Tags −${a.removeTags.join(', ')}`,
    a.addPersons?.length && `Personen +${a.addPersons.join(', ')}`,
    a.docType !== undefined && `Typ ${a.docType ?? 'entfernt'}`,
    date !== undefined && `Datum ${date ?? 'entfernt'}`,
    a.title && `Titel „${a.title}“`,
  ]
    .filter(Boolean)
    .join(', ');
}

const samePerson = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Participants after adding and removing names; no key when nothing changes. */
function mergePersons(current: string[], add: string[], remove: string[]): { participants?: string[] } {
  if (!add.length && !remove.length) return {};
  const kept = current.filter((p) => !remove.some((r) => samePerson(r, p)));
  return { participants: [...kept, ...add.filter((p) => !kept.some((k) => samePerson(k, p)))] };
}

/** Title, topic, project, persons and date of decisions, open items and events (#305). */
function updateEntries(
  deps: ToolDeps,
  ids: string[],
  a: {
    title: string | null;
    topic?: string | null;
    project?: string | null;
    addPersons: string[];
    removePersons?: string[] | null;
    date: string | null | undefined;
  },
): { changed: string[] } | { error: string } {
  const changed: string[] = [];
  const { date, addPersons } = a;
  for (const id of ids) {
    const e = deps.graph.getEntity(id);
    if (!e) continue;
    const common = {
      ...(a.title ? { title: a.title } : {}),
      ...(a.topic !== undefined ? { topic: a.topic } : {}),
      ...(a.project !== undefined ? { project: a.project } : {}),
    };
    const persons = (current: string[]) => mergePersons(current, addPersons, a.removePersons ?? []);
    if (e.type === 'decision') {
      const d = deps.decisions.get(id);
      const patch = { ...common, ...(date !== undefined ? { decidedAt: date } : {}), ...persons(d.participants) };
      if (!Object.keys(patch).length) continue;
      deps.decisions.update(id, patch, { trigger: 'agent' });
    } else if (e.type === 'task' || e.type === 'question') {
      const o = deps.openItems.get(id);
      const responsible = addPersons[0] ?? (o.responsibleName && a.removePersons?.some((p) => samePerson(p, o.responsibleName!)) ? null : undefined);
      const patch = { ...common, ...(date !== undefined ? { dueAt: date } : {}), ...(responsible !== undefined ? { responsible } : {}) };
      if (!Object.keys(patch).length) continue;
      deps.openItems.update(id, patch, { trigger: 'agent' });
    } else if (e.type === 'event') {
      if (date === null) return { error: 'Ein Ereignis braucht ein Datum – es kann nicht entfernt werden.' };
      const merged = persons(deps.events.get(id).participants);
      const patch = { ...common, ...(date ? { occurredAt: date } : {}), ...(merged.participants ? { participants: merged.participants } : {}) };
      if (!Object.keys(patch).length) continue;
      deps.events.update(id, patch, { trigger: 'agent' });
    } else continue;
    changed.push(`${TYPE_LABEL[e.type] ?? e.type} „${truncate(e.name, 40)}“`);
  }
  return { changed };
}

export function metadataTools(deps: ToolDeps): AgentTool[] {
  const { graph } = deps;
  const resolveOne = (ctx: ToolContext, ref: string) => ctx.refs.resolve(ref);

  return [
    defineTool({
      name: 'set_metadata',
      description:
        'Thema, Projekt, Personen, Tags, Dokumenttyp, Titel und fachliches Datum setzen oder entfernen – für Dokumente (D…/S…, einzeln und in Serie; eine Sammelaktion ist EIN Rückgängig-Schritt). Für Entscheidungen, offene Punkte und Ereignisse (K…) Titel, Thema, Projekt, Personen (Beteiligte bzw. verantwortlich) und Datum (documentDate = Entscheidungsdatum, Fälligkeit bzw. Ereignisdatum). topic/project ERSETZEN das Hauptthema bzw. -projekt (danach richtet sich die Ablage); leerer Wert ("") entfernt es. Ein Eintrag kann weitere Themen und Projekte haben: addTopics/addProjects ERGÄNZEN (wer noch keins hat, bekommt es als Hauptthema), removeTopics/removeProjects entfernen weitere. „Ordne das auch X zu“ heißt ergänzen, nicht ersetzen. case: Vorgang (ID oder Name eines vorhandenen Vorgangs), dem die Einträge zugeordnet werden. addTags gilt für alle Arten von Einträgen, auch Notizen. Personen werden mit dem Graph abgeglichen (Aliasse, „ich“ = Benutzer).',
      schema: z.object({
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
      }),
      risk: 'write',
      count: (a, ctx) => ctx.refs.resolveMany(a.targets).ids.length || a.targets.length,
      label: (a) =>
        `Ordne ${a.targets.length === 1 && !a.targets[0]!.toUpperCase().startsWith('S') ? 'einen Eintrag' : 'Einträge'} zu${a.topic ? ` (Thema ${a.topic})` : ''}${a.project ? ` (Projekt ${a.project})` : ''}${a.addTopics?.length ? ` (+ Thema ${a.addTopics.join(', ')})` : ''}${a.addProjects?.length ? ` (+ Projekt ${a.addProjects.join(', ')})` : ''}${a.case ? ` (Vorgang ${a.case})` : ''}`,
      run: async (a, ctx) => {
        const { ids, unknown } = ctx.refs.resolveMany(a.targets);
        if (!ids.length) return { content: `Keine Einträge angegeben.${unknownNote(unknown)}`, isError: true };
        const docIds = ids.filter((id) => deps.docs.findRow(id));
        const others = ids.filter((id) => !docIds.includes(id));
        let date: string | null | undefined = a.documentDate;
        if (date) {
          date = normalizeDateInput(date) ?? null;
          if (!date) return { content: `Ungültiges Datum „${a.documentDate}“ – erwartet YYYY-MM-DD.`, isError: true };
        }
        // persons: unclear mentions are asked about instead of guessed
        const unclear = (a.addPersons ?? []).flatMap((p) => {
          const r = deps.persons.resolve(p, { create: false });
          return !r.entity && !r.selfReference && r.ambiguousCandidates.length > 1
            ? [
                `„${p}“ (meinst du ${r.ambiguousCandidates
                  .slice(0, 3)
                  .map((c) => c.entity.name)
                  .join(' oder ')}?)`,
              ]
            : [];
        });
        if (unclear.length) return { content: `Unklare Person(en): ${unclear.join('; ')}. Frag den Benutzer mit ask_user, wer gemeint ist.`, isError: true };
        // „ich/mir/mich“ is the user's own person (#305)
        const addPersons = (a.addPersons ?? []).map((p) => {
          const r = deps.persons.resolve(p, { create: false });
          return r.selfReference || r.matchedBy === 'self' ? (r.entity?.name ?? (deps.settings.get().profile.name || p)) : p;
        });
        // a case by its id or the name of an existing one (#286)
        let caseId: string | undefined;
        if (a.case) {
          const byRef = ctx.refs.resolve(a.case);
          const c = (byRef && graph.getEntity(byRef)?.type === 'case' ? graph.getEntity(byRef) : undefined) ?? graph.findByNameOrAlias('case', a.case);
          if (!c) return { content: `Vorgang „${a.case}“ ist unbekannt – mit create_case anlegen oder list_subjects type=case ansehen.`, isError: true };
          caseId = c.id;
        }
        const changed: string[] = [];
        if (docIds.length) {
          const res = deps.docs.bulkUpdate(
            docIds,
            {
              ...(a.title ? { title: a.title } : {}),
              ...(a.topic !== undefined ? { topic: a.topic } : {}),
              ...(a.project !== undefined ? { project: a.project } : {}),
              ...(a.addTags?.length ? { addTags: a.addTags } : {}),
              ...(a.removeTags?.length ? { removeTags: a.removeTags } : {}),
              ...(addPersons.length ? { addPersons } : {}),
              ...(a.removePersons?.length ? { removePersons: a.removePersons } : {}),
              ...(a.docType !== undefined ? { docType: a.docType } : {}),
              ...(date !== undefined ? { documentDate: date } : {}),
            },
            { trigger: 'agent' },
          );
          changed.push(`${res.updated.length} Dokument(e)`);
        }
        const entriesChanged = updateEntries(deps, others, { ...a, addPersons, date });
        if ('error' in entriesChanged) return { content: entriesChanged.error, isError: true };
        changed.push(...entriesChanged.changed);
        // further topics/projects, a case and tags of entries without a tag column: added, ONE undo step each (#287, #291)
        const noteIds = others.filter((id) => graph.getEntity(id)?.type === 'note');
        const nonDocs = others.filter((id) => !noteIds.includes(id));
        const assign = async (targets: string[], patch: Parameters<typeof deps.subjects.bulkAssign>[1]) => {
          if (!targets.length || (!patch.topics?.length && !patch.projects?.length && !patch.tags?.length && !patch.caseId)) return 0;
          return (await deps.subjects.bulkAssign(targets, patch, { trigger: 'agent' })).updated;
        };
        const added =
          (await assign(ids, { topics: a.addTopics ?? [], projects: a.addProjects ?? [], caseId })) +
          // notes have no main topic: a topic or project for a note is a further one
          (await assign(noteIds, { topics: a.topic ? [a.topic] : [], projects: a.project ? [a.project] : [], tags: a.addTags ?? [] })) +
          (await assign(nonDocs, { tags: a.addTags ?? [] }));
        if (added) changed.push(`${added} Zuordnung(en) ergänzt`);
        const removed =
          a.removeTopics?.length || a.removeProjects?.length
            ? deps.subjects.removeFurther(ids, { topics: a.removeTopics ?? [], projects: a.removeProjects ?? [] }, { trigger: 'agent' })
            : 0;
        if (removed) changed.push(`${removed} weitere(s) Thema/Projekt entfernt`);
        const what = describeChange(a, date);
        if (!changed.length) return { content: `Nichts geändert.${unknownNote(unknown)}`, isError: true };
        return {
          content: `Geändert: ${changed.join(', ')} – ${what}.${unknownNote(unknown)}`,
          summary: changed.join(', '),
          change: `${changed.join(', ')}: ${what}`,
          changed: ids.length,
        };
      },
    }),
    defineTool({
      name: 'create_subject',
      description: 'Ein neues Thema, Projekt, eine Person oder ein Schlagwort anlegen (bestehende werden wiederverwendet).',
      schema: z.object({ type: z.enum(['topic', 'project', 'person', 'tag']), name: z.string().min(1), description: optText }),
      risk: 'write',
      label: (a) => `Lege ${TYPE_LABEL[a.type]} „${truncate(a.name, 40)}“ an`,
      run: async (a, ctx) => {
        const existing = graph.findByNameOrAlias(a.type, a.name);
        if (existing) return { content: `${ctx.refs.entry(existing.id)} ${TYPE_LABEL[a.type]} „${existing.name}“ gibt es schon.`, summary: 'gab es schon' };
        const e = a.type === 'person' ? deps.persons.resolve(a.name, { create: true }).entity : graph.ensureEntity(a.type, a.name, a.description);
        if (!e) return { content: `„${a.name}“ ist kein Personenname.`, isError: true };
        deps.audit.log({
          action: 'entity.create',
          actor: 'agent',
          trigger: 'agent',
          confirmed: true,
          entityIds: [e.id],
          after: { type: a.type, name: e.name },
        });
        return {
          content: `${ctx.refs.entry(e.id)} ${TYPE_LABEL[a.type]} „${e.name}“ angelegt.`,
          summary: 'angelegt',
          change: `${TYPE_LABEL[a.type]} „${e.name}“ angelegt`,
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
        const target = resolveOne(ctx, a.target);
        const { ids, unknown } = ctx.refs.resolveMany(a.sources);
        if (!target || !ids.length) return { content: `Unbekannte IDs.${unknownNote(unknown)}`, isError: true };
        const r = await graph.merge({ sourceIds: ids.filter((i) => i !== target), targetId: target, allowCrossType: a.allowCrossType }, { trigger: 'agent' });
        return {
          content: `${r.mergedNames.map((n) => `„${n}“`).join(', ')} mit „${r.targetName}“ zusammengeführt (${r.relationsMoved} Beziehungen übernommen).`,
          summary: 'zusammengeführt',
          change: `${r.mergedNames.join(', ')} → ${r.targetName} zusammengeführt`,
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
        const r = deps.persons.resolve(a.name, { create: false });
        if (r.selfReference) return { content: 'Gemeint ist der Benutzer selbst.' };
        if (r.entity) return { content: `${ctx.refs.entry(r.entity.id)} ${r.entity.name} (erkannt über ${r.matchedBy}).` };
        if (r.ambiguousCandidates.length)
          return {
            content: `Nicht eindeutig. Kandidaten: ${r.ambiguousCandidates.map((c) => `${ctx.refs.entry(c.entity.id)} ${c.entity.name}`).join(', ')}. Frag den Benutzer.`,
          };
        return { content: r.rejected ? `„${a.name}“ ist kein Personenname.` : `Keine bekannte Person „${a.name}“.` };
      },
    }),
    defineTool({
      name: 'exclude_from_llm',
      description:
        'Dokumente von der Analyse durch das LLM ausschließen (excluded=false hebt das auf). Das ist eine Datenschutz-Einstellung und fragt immer nach. Die Datei selbst wird nicht verändert.',
      schema: z.object({ documents: list, excluded: z.boolean().default(true) }),
      risk: 'critical',
      count: (a, ctx) => ctx.refs.resolveMany(a.documents).ids.length,
      label: (a) => (a.excluded ? 'Schließe Dokumente von der LLM-Analyse aus' : 'Gebe Dokumente für die LLM-Analyse frei'),
      run: async (a, ctx) => {
        const { docs, unknown } = resolveDocs({ deps, ctx }, a.documents);
        for (const d of docs) deps.docs.setLlmExcluded(d.id, a.excluded);
        return {
          content: `${docs.length} Dokument(e) ${a.excluded ? 'von der LLM-Analyse ausgeschlossen' : 'wieder freigegeben'}.${unknownNote(unknown)}`,
          summary: `${docs.length} geändert`,
          change: `${docs.length} Dokument(e) ${a.excluded ? 'von der LLM-Analyse ausgeschlossen' : 'freigegeben'}`,
        };
      },
    }),
  ];
}
