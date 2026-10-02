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

export function metadataTools(deps: ToolDeps): AgentTool[] {
  const { graph } = deps;
  const resolveOne = (ctx: ToolContext, ref: string) => ctx.refs.resolve(ref);

  return [
    defineTool({
      name: 'set_metadata',
      description:
        'Thema, Projekt, Personen, Tags, Dokumenttyp, Titel und fachliches Datum setzen oder entfernen – für Dokumente (D…/S…, einzeln und in Serie; eine Sammelaktion ist EIN Rückgängig-Schritt). Für Entscheidungen, offene Punkte und Ereignisse (K…) Thema und Projekt. Leerer Wert ("") entfernt. Personen werden mit dem Graph abgeglichen (Aliasse, „ich“ = Benutzer). Bis mehrere Themen je Eintrag möglich sind, ersetzt eine Zuordnung den bisherigen Wert.',
      schema: z.object({
        targets: list,
        topic: removable,
        project: removable,
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
        `Ordne ${a.targets.length === 1 && !a.targets[0]!.toUpperCase().startsWith('S') ? 'einen Eintrag' : 'Einträge'} zu${a.topic ? ` (Thema ${a.topic})` : ''}${a.project ? ` (Projekt ${a.project})` : ''}`,
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
        for (const id of others) {
          const e = graph.getEntity(id);
          const patch = { ...(a.topic !== undefined ? { topic: a.topic } : {}), ...(a.project !== undefined ? { project: a.project } : {}) };
          if (!e || !Object.keys(patch).length) continue;
          if (e.type === 'decision') deps.decisions.update(id, patch, { trigger: 'agent' });
          else if (e.type === 'task' || e.type === 'question') deps.openItems.update(id, patch, { trigger: 'agent' });
          else if (e.type === 'event') deps.events.update(id, patch);
          else continue;
          changed.push(`${TYPE_LABEL[e.type] ?? e.type} „${truncate(e.name, 40)}“`);
        }
        const what = [
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
        const { docs, unknown } = resolveDocs(deps, ctx, a.documents);
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
