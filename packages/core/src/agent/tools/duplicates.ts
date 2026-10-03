import { z } from 'zod';
import type { DocumentRecord, EntityType } from '@archivist/shared';
import { folderOf } from '../../services/archive-structure';
import type { DocRow } from '../../services/documents';
import { defineTool, list, type AgentTool, type ToolOutput } from '../registry';
import { affectedCount, resolveDocs, unknownNote, type ToolDeps, type ToolScope } from './common';
import { duplicateReport } from './duplicate-report';

type MergeKind = 'open_item' | 'note' | 'event' | 'topic' | 'project' | 'person';

const MERGE_LABEL: Record<MergeKind, string> = {
  open_item: 'offene Punkte',
  note: 'Notizen',
  event: 'Ereignisse',
  topic: 'Themen',
  project: 'Projekte',
  person: 'Personen',
};

interface MarkArgs {
  keep: string;
  duplicates: string[];
  as: 'duplicate' | 'older_version';
  action: 'mark' | 'subfolder' | 'delete';
}

/** The duplicates to treat: never the document to keep. */
interface Treatment {
  keep: DocRow;
  targets: DocumentRecord[];
  keepRef: string;
  refs: string;
  unknown: string[];
}

/** Moves the duplicates into the trash: restorable via undo until the user empties the trash. */
async function trashDuplicates({ deps, ctx }: ToolScope, treatment: Treatment): Promise<ToolOutput> {
  const { keepRef, refs, targets, unknown } = treatment;
  const failed: string[] = [];
  let trashed = 0;
  for (const d of targets) {
    try {
      await deps.docs.moveToTrash(d.id, { confirmed: true, trigger: 'agent' });
      trashed += 1;
    } catch (error) {
      failed.push(`${ctx.refs.doc(d.id)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    content: `${trashed} Duplikat(e) von ${keepRef} in den Papierkorb gelegt (${refs}); ${keepRef} bleibt. Wiederherstellen über das Änderungsprotokoll oder Einstellungen → Archiv → Papierkorb.${failed.length ? `\nFehlgeschlagen: ${failed.join('; ')}` : ''}${unknownNote(unknown)}`,
    summary: `${trashed} im Papierkorb`,
    change: `${trashed} Duplikat(e) in den Papierkorb gelegt`,
    changed: trashed,
    isError: trashed === 0,
  };
}

/** Moves the duplicates into the subfolder „Duplikate“ / „Ältere Versionen“ next to the kept document; returns the report lines and the change. */
async function moveToSubfolder(scope: ToolScope, move: { treatment: Treatment; as: MarkArgs['as'] }): Promise<{ lines: string[]; change: string }> {
  const { deps, ctx } = scope;
  const { keep, keepRef, targets } = move.treatment;
  if (!keep.archiveRelPath) return { lines: [`${keepRef} liegt nicht im Archiv – kein Unterordner möglich.`], change: '' };
  const folder = folderOf(keep);
  const target = deps.categories.canonical(`${folder ? `${folder}/` : ''}${move.as === 'duplicate' ? 'Duplikate' : 'Ältere Versionen'}`);
  const main = deps.categories.needsApproval(target);
  if (main) return { lines: [`Der Hauptordner „${main}“ existiert nicht – nicht verschoben. Neue Hauptordner legt nur der Benutzer an.`], change: '' };
  deps.categories.create(target, { confirmed: true });
  const result = await deps.archive.relocate(
    targets.map((d) => ({ documentId: d.id, categoryPath: target })),
    { confirmed: true, trigger: 'agent' },
  );
  const lines = [
    `Nach „${target}“ verschoben: ${result.success} erfolgreich${result.skipped ? `, ${result.skipped} übersprungen` : ''}${result.failed ? `, ${result.failed} fehlgeschlagen` : ''}.`,
    ...result.items
      .filter((x) => x.outcome !== 'success')
      .slice(0, 20)
      .map((i) => `- ${ctx.refs.doc(i.documentId)}: ${i.message}`),
  ];
  return { lines, change: ` und ${result.success} nach ${target} verschoben` };
}

async function markDuplicates(scope: ToolScope, mark: { treatment: Treatment; args: MarkArgs }): Promise<ToolOutput> {
  const { deps } = scope;
  const { treatment, args } = mark;
  const { keep, keepRef, refs, targets, unknown } = treatment;
  const tag = args.as === 'duplicate' ? 'Duplikat' : 'ältere Version';
  for (const d of targets) {
    if (args.as === 'duplicate')
      deps.graph.linkEntries({ sourceId: d.id, targetId: keep.id, relationType: 'duplicate_of' }, { status: 'confirmed', trigger: 'agent' });
    else deps.graph.linkEntries({ sourceId: keep.id, targetId: d.id, relationType: 'supersedes' }, { status: 'confirmed', trigger: 'agent' });
  }
  const { auditId } = deps.docs.bulkUpdate(
    targets.map((d) => d.id),
    { patch: { addTags: [tag] }, trigger: 'agent' },
  );
  const lines = [`${targets.length} Dokument(e) als ${tag} von ${keepRef} markiert (${refs}), Schlagwort „${tag}“ gesetzt.`];
  let change = `${targets.length} Dokument(e) als ${tag} markiert`;
  if (args.action === 'subfolder') {
    const moved = await moveToSubfolder(scope, { treatment, as: args.as });
    lines.push(...moved.lines);
    change += moved.change;
  }
  return {
    content: lines.join('\n') + (auditId ? `\n(Schlagwort rückgängig machbar, Protokoll ${auditId})` : '') + unknownNote(unknown),
    summary: `${targets.length} markiert`,
    change,
    changed: targets.length,
  };
}

async function treatDuplicates(scope: ToolScope, args: MarkArgs): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const keepId = ctx.refs.resolve(args.keep);
  const keep = keepId ? deps.docs.findRow(keepId) : undefined;
  if (!keepId || !keep) return { content: `Unbekannte Dokument-ID „${args.keep}“ für keep.`, isError: true };
  const { docs: duplicates, unknown } = resolveDocs(scope, args.duplicates);
  const targets = duplicates.filter((d) => d.id !== keepId);
  if (!targets.length) return { content: `Keine Duplikate angegeben (keep wird nie verändert).${unknownNote(unknown)}`, isError: true };
  const treatment = { keep, targets, keepRef: ctx.refs.doc(keepId), refs: targets.map((d) => ctx.refs.doc(d.id)).join(', '), unknown };
  if (args.action === 'delete') return trashDuplicates(scope, treatment);
  return markDuplicates(scope, { treatment, args });
}

async function markDifferent({ deps, ctx }: ToolScope, args: { a: string; b: string }): Promise<ToolOutput> {
  const { graph } = deps;
  const a = ctx.refs.resolve(args.a);
  const b = ctx.refs.resolve(args.b);
  if (!a || !b || a === b || !graph.getEntity(a) || !graph.getEntity(b))
    return { content: 'Zwei verschiedene, bekannte IDs (D… oder K…) nötig.', isError: true };
  const existing = graph.relationsOf(a, { types: ['duplicate_of'] }).filter((r) => r.sourceEntityId === b || r.targetEntityId === b);
  let relationId: string | null = null;
  for (const r of existing) {
    if (r.status !== 'rejected') graph.setRelationStatus(r.id, { status: 'rejected', by: 'user' });
    relationId = r.id;
  }
  relationId ??=
    graph.link({ sourceId: a, targetId: b, relationType: 'duplicate_of' }, { status: 'rejected', resolvedByUser: true, origin: 'user' })?.id ?? null;
  deps.audit.log({
    action: 'relation.markDifferent',
    actor: 'user',
    trigger: 'agent',
    confirmed: true,
    entityIds: [relationId, a, b].filter((x): x is string => Boolean(x)),
    before: existing.length ? { status: existing.map((r) => r.status) } : null,
    after: { status: 'rejected', relationType: 'duplicate_of' },
  });
  const refA = args.a.trim().toUpperCase();
  const refB = args.b.trim().toUpperCase();
  return {
    content: `Gemerkt: ${refA} und ${refB} sind verschieden und werden nicht mehr als Duplikat genannt.`,
    summary: 'gemerkt',
    change: `${refA} und ${refB} als verschieden markiert`,
  };
}

const SUBJECT_TYPE: Partial<Record<MergeKind, EntityType>> = { topic: 'topic', project: 'project', person: 'person' };

/** What the kept entry took over, or why the entries do not fit the kind. */
async function mergeInto(
  deps: ToolDeps,
  merge: { kind: MergeKind; keepId: string; duplicateId: string },
): Promise<{ takenOver: string[] } | { error: string }> {
  const { kind, keepId, duplicateId } = merge;
  const options = { actor: 'agent' as const, trigger: 'agent' };
  if (kind === 'open_item') return deps.openItemDuplicates.merge({ keepId, duplicateId }, options);
  if (kind === 'note') return deps.noteEventDuplicates.mergeNotes({ keepId, duplicateId }, options);
  if (kind === 'event') return deps.noteEventDuplicates.mergeEvents({ keepId, duplicateId }, options);
  const type = SUBJECT_TYPE[kind];
  if (deps.graph.getEntity(keepId)?.type !== type || deps.graph.getEntity(duplicateId)?.type !== type)
    return { error: `Beide Einträge müssen vom Typ ${MERGE_LABEL[kind]} sein.` };
  await deps.graph.merge({ sourceIds: [duplicateId], targetId: keepId }, options);
  return { takenOver: ['Verknüpfungen', 'Name als Alias'] };
}

async function mergeEntries({ deps, ctx }: ToolScope, args: { kind: MergeKind; keep: string; duplicate: string }): Promise<ToolOutput> {
  const keepId = ctx.refs.resolve(args.keep);
  const duplicateId = ctx.refs.resolve(args.duplicate);
  if (!keepId || !duplicateId || keepId === duplicateId) return { content: 'Zwei verschiedene, bekannte K-IDs nötig.', isError: true };
  const merged = await mergeInto(deps, { kind: args.kind, keepId, duplicateId });
  if ('error' in merged) return { content: merged.error, isError: true };
  const { takenOver } = merged;
  const keepRef = ctx.refs.entry(keepId);
  const duplicateRef = ctx.refs.entry(duplicateId);
  return {
    content: `${duplicateRef} in ${keepRef} zusammengeführt${takenOver.length ? `; übernommen: ${takenOver.join(', ')}` : ''}. Rückgängig machbar.`,
    summary: 'zusammengeführt',
    change: `Doppelte ${MERGE_LABEL[args.kind]} zusammengeführt`,
    changed: 1,
  };
}

/** Duplicates and versions (#308, #230): find, mark or delete them, remember different pairs, merge duplicate entries. */
export function duplicateTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'find_duplicates',
      description:
        'Sucht Duplikate unter Dokumenten: exact (gleicher Dateiinhalt), near (gleicher oder fast gleicher Text), versions (gleicher Name bis auf final/v2/Kopie/(1)/Entwurf/Datum, ähnlicher Titel). Nennt je Gruppe den Grund und das neueste Dokument. Paare, die der Benutzer als verschieden markiert hat, fehlen. Ohne Angabe: alle archivierten Dokumente. Zeigt auch offene Duplikat-Hinweise zu anderen Einträgen.',
      schema: z.object({
        documents: list.nullish().describe('D…/S…; leer = alle archivierten'),
        kinds: z.array(z.enum(['exact', 'near', 'versions'])).nullish(),
      }),
      risk: 'read',
      label: () => 'Suche Duplikate und Versionen',
      run: (a, ctx) => duplicateReport({ deps, ctx }, a),
    }),
    defineTool({
      name: 'mark_duplicates',
      description:
        'Behandelt Duplikate bzw. ältere Versionen eines Dokuments (keep bleibt unverändert): action "mark" verknüpft und setzt das Schlagwort „Duplikat“ bzw. „ältere Version“; "subfolder" verschiebt sie zusätzlich in den Unterordner Duplikate bzw. Ältere Versionen neben keep; "delete" legt sie in den Papierkorb (wiederherstellbar, bis der Benutzer den Papierkorb leert; immer mit Rückfrage).',
      schema: z.object({
        keep: z.string().min(1),
        duplicates: list,
        as: z.enum(['duplicate', 'older_version']).default('duplicate'),
        action: z.enum(['mark', 'subfolder', 'delete']).default('mark'),
      }),
      risk: (a) => (a.action === 'delete' ? 'critical' : 'write'),
      count: (a, ctx) => affectedCount(ctx, a.duplicates),
      label: (a) =>
        a.action === 'delete'
          ? `Lege ${a.duplicates.length} Duplikat(e) in den Papierkorb`
          : `Markiere ${a.duplicates.length} Dokument(e) als ${a.as === 'duplicate' ? 'Duplikat' : 'ältere Version'}${a.action === 'subfolder' ? ' und verschiebe sie' : ''}`,
      run: (a, ctx) => treatDuplicates({ deps, ctx }, a),
    }),
    defineTool({
      name: 'mark_different',
      description: 'Merkt sich, dass zwei Dokumente (oder Einträge) KEINE Duplikate sind – sie werden danach nicht mehr als Duplikat vorgeschlagen.',
      schema: z.object({ a: z.string().min(1), b: z.string().min(1) }),
      risk: 'write',
      label: () => 'Merke: die beiden sind verschieden',
      run: (args, ctx) => markDifferent({ deps, ctx }, args),
    }),
    defineTool({
      name: 'merge_entries',
      description:
        'Führt zwei doppelte Einträge zusammen (offener Punkt, Notiz, Ereignis, Thema, Projekt, Person): keep bleibt und übernimmt fehlende Angaben und Verknüpfungen von duplicate. Rückgängig machbar.',
      schema: z.object({
        kind: z.enum(['open_item', 'note', 'event', 'topic', 'project', 'person']),
        keep: z.string().min(1),
        duplicate: z.string().min(1),
      }),
      risk: 'write',
      label: (a) => `Führe zwei ${MERGE_LABEL[a.kind]} zusammen`,
      run: (a, ctx) => mergeEntries({ deps, ctx }, a),
    }),
  ];
}
