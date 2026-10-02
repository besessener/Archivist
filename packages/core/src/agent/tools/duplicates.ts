import { z } from 'zod';
import type { DocumentRecord, EntityType } from '@archivist/shared';
import { nameSimilarity, normalizeName, truncate } from '../../util/text';
import { folderOf } from '../../services/archive-structure';
import { defineTool, list, type AgentTool, type ToolContext } from '../registry';
import { ARCHIVED, allDocs, docDay, docLine, normalizeExtension, resolveDocs, unknownNote, type ToolDeps } from './common';

/**
 * Duplicates and versions (#308, #230): find exact duplicates, near duplicates and older versions of documents, mark
 * them (relation + tag, optionally a subfolder), delete them for good (critical), remember pairs that are different,
 * and merge duplicate entries of the knowledge base through the existing merge flows.
 */

export type DuplicateKind = 'exact' | 'near' | 'versions';

const VERSION_TOKEN_RE =
  /^(?:final|finale|endfassung|kopie|copy|neu|alt|entwurf|draft|v\d{1,3}|version|rev\d{0,3}|korr|korrigiert|aktuell|überarbeitet|ueberarbeitet)$/;
const DATE_IN_NAME_RE = /\b(?:\d{4}[-_.]\d{2}[-_.]\d{2}|\d{2}[-_.]\d{2}[-_.]\d{4}|\d{8})\b/g;

/**
 * Name without version markers (final, v2, Kopie, copy, (1), _neu, _alt, Entwurf, draft) and full dates, normalized;
 * `marker`: a non-date marker was present, `dates`: the dates that were stripped.
 */
export function versionKey(name: string): { key: string; marker: boolean; dates: string[] } {
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, '');
  const dates = [...base.matchAll(DATE_IN_NAME_RE)].map((m) => m[0].replace(/\D/g, ''));
  let marker = /\(\d{1,3}\)|\bversion\s?\d/i.test(base);
  const tokens = normalizeName(
    base
      .replace(DATE_IN_NAME_RE, ' ')
      .replace(/\(\d{1,3}\)/g, ' ')
      .replace(/\bversion\s?\d{1,3}\b/gi, ' '),
  )
    .split(' ')
    .filter((t) => {
      if (!VERSION_TOKEN_RE.test(t)) return true;
      marker = true;
      return false;
    });
  return { key: tokens.join(' '), marker, dates };
}

/** Two names are versions of each other: same key, similar titles, and not just two dated issues of a series. */
export function looksLikeVersions(a: { name: string; title: string }, b: { name: string; title: string }): boolean {
  const ka = versionKey(a.name);
  const kb = versionKey(b.name);
  if (!ka.key || ka.key !== kb.key) return false;
  // titles are compared without their version markers as well („Plan Entwurf“ ~ „Plan final“)
  const ta = versionKey(a.title).key || a.title;
  const tb = versionKey(b.title).key || b.title;
  if (Math.max(nameSimilarity(a.title, b.title), nameSimilarity(ta, tb)) < 0.75) return false;
  const differentDates = ka.dates.length > 0 && kb.dates.length > 0 && ka.dates.join() !== kb.dates.join();
  return !(differentDates && !ka.marker && !kb.marker);
}

const newestKey = (d: Pick<DocumentRecord, 'documentDate' | 'archivedAt' | 'createdAt'>) => `${docDay(d)}|${d.archivedAt ?? d.createdAt}`;

export function duplicateTools(deps: ToolDeps): AgentTool[] {
  const { docs, graph, privacy } = deps;

  /** The user said these two are different (rejected duplicate_of in either direction). */
  const markedDifferent = (a: string, b: string) =>
    graph.relationsOf(a, { statuses: ['rejected'], types: ['duplicate_of'] }).some((r) => r.sourceEntityId === b || r.targetEntityId === b) ||
    graph.rejectedBetween(a, b, { includeDuplicateOf: true })?.relationType === 'duplicate_of';

  /** Greedy clusters of a bucket that never put two documents together the user marked as different. */
  const cluster = (bucket: DocumentRecord[], fits: (a: DocumentRecord, b: DocumentRecord) => boolean = () => true): DocumentRecord[][] => {
    const groups: DocumentRecord[][] = [];
    for (const d of bucket) {
      const g = groups.find((xs) => xs.every((x) => !markedDifferent(x.id, d.id)) && xs.some((x) => fits(x, d)));
      if (g) g.push(d);
      else groups.push([d]);
    }
    return groups.filter((g) => g.length > 1);
  };

  const describeGroup = (ctx: ToolContext, kind: DuplicateKind, g: DocumentRecord[], reason: string) => {
    const newest = g.toSorted((a, b) => newestKey(b).localeCompare(newestKey(a)))[0]!;
    const set = ctx.refs.set(g.map((d) => d.id));
    return [
      `${kind === 'exact' ? 'Exaktes Duplikat' : kind === 'near' ? 'Fast gleich' : 'Versionen'} (${g.length} Dokumente, ${set}) – ${reason}. Neueste: ${ctx.refs.doc(newest.id)}`,
      ...g.map((d) => `  - ${docLine({ deps, ctx }, d)}`),
    ].join('\n');
  };

  const resolveOne = (ctx: ToolContext, ref: string) => ctx.refs.resolve(ref);

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
      run: async (a, ctx) => {
        const { docs: found, unknown } = a.documents?.length
          ? resolveDocs({ deps, ctx }, a.documents)
          : { docs: allDocs(deps).filter((d) => ARCHIVED.includes(d.status)), unknown: [] as string[] };
        const kinds = new Set<DuplicateKind>(a.kinds?.length ? a.kinds : ['exact', 'near', 'versions']);
        const grouped = new Set<string>();
        const pairKey = (g: DocumentRecord[]) =>
          g
            .map((d) => d.id)
            .toSorted()
            .join('|');
        const seen = new Set<string>();
        const out: string[] = [];
        const push = (kind: DuplicateKind, groups: DocumentRecord[][], reason: (g: DocumentRecord[]) => string) => {
          for (const g of groups) {
            const key = pairKey(g);
            // a group already reported under a stronger kind (or fully contained in one) is not repeated
            if (seen.has(key) || g.every((d) => grouped.has(d.id))) continue;
            seen.add(key);
            for (const d of g) grouped.add(d.id);
            out.push(describeGroup(ctx, kind, g, reason(g)));
          }
        };
        const bucketBy = (key: (d: DocumentRecord) => string | null) => {
          const m = new Map<string, DocumentRecord[]>();
          for (const d of found) {
            const k = key(d);
            if (k) m.set(k, [...(m.get(k) ?? []), d]);
          }
          return [...m.values()].filter((xs) => xs.length > 1);
        };
        if (kinds.has('exact'))
          push(
            'exact',
            bucketBy((d) => d.sha256).flatMap((b) => cluster(b)),
            () => 'gleicher Dateiinhalt (gleiche Prüfsumme)',
          );
        if (kinds.has('near')) {
          const startOf = (d: DocumentRecord) => {
            const n = normalizeName(d.textPreview);
            return n.length >= 80 ? n.slice(0, 200) : null;
          };
          push(
            'near',
            bucketBy(startOf).flatMap((b) => cluster(b)),
            (g) => {
              const hashes = new Set(g.map((d) => docs.findRow(d.id)?.textHash ?? null));
              return hashes.size === 1 && !hashes.has(null)
                ? 'gleicher Textinhalt (andere Datei, z. B. anderes Format oder neu gespeichert)'
                : 'sehr ähnlicher Textanfang';
            },
          );
        }
        if (kinds.has('versions'))
          push(
            'versions',
            bucketBy((d) => {
              const k = versionKey(d.originalName).key;
              return k ? `${normalizeExtension(d.ext)}|${k}` : null;
            }).flatMap((b) => cluster(b, (x, y) => looksLikeVersions({ name: x.originalName, title: x.title }, { name: y.originalName, title: y.title }))),
            (g) => {
              const marked = g.filter((d) => versionKey(d.originalName).marker).map((d) => ctx.refs.doc(d.id));
              return `gleicher Name bis auf Versions- oder Datumsangaben, ähnlicher Titel${marked.length ? ` (Versionsmerkmal bei ${marked.join(', ')})` : ''}`;
            },
          );
        const hints = deps.insights
          .list('open')
          .filter((i) => i.kind.includes('duplicate'))
          .slice(0, 20)
          .map((i) => {
            const affectedDocs = i.affected.filter((x) => x.type === 'document');
            const hidden = affectedDocs.some((x) => {
              const row = docs.findRow(x.id);
              return !row || !privacy.mayShareDocument(docs.toRecord(row));
            });
            const refs = i.affected.map((x) => (x.type === 'document' ? ctx.refs.doc(x.id) : ctx.refs.entry(x.id))).join(', ');
            return hidden
              ? `- Hinweis ${ctx.refs.entry(i.id)} (${i.kind}) zu ${refs}`
              : `- Hinweis ${ctx.refs.entry(i.id)} (${i.kind}): ${truncate(i.title, 100)} – ${refs}`;
          });
        const content = [
          out.length ? `${out.length} Gruppe(n) unter ${found.length} Dokumenten:` : `Keine Duplikate unter ${found.length} Dokumenten gefunden.`,
          ...out,
          hints.length ? `Offene Duplikat-Hinweise der Archivprüfung:\n${hints.join('\n')}` : null,
          out.length ? 'Behalten/markieren mit mark_duplicates, „sind verschieden“ mit mark_different.' : null,
        ]
          .filter(Boolean)
          .join('\n');
        return { content: content + unknownNote(unknown), summary: out.length ? `${out.length} Gruppe(n)` : 'keine Duplikate' };
      },
    }),
    defineTool({
      name: 'mark_duplicates',
      description:
        'Behandelt Duplikate bzw. ältere Versionen eines Dokuments (keep bleibt unverändert): action "mark" verknüpft und setzt das Schlagwort „Duplikat“ bzw. „ältere Version“; "subfolder" verschiebt sie zusätzlich in den Unterordner Duplikate bzw. Ältere Versionen neben keep; "delete" löscht sie endgültig (nicht rückgängig zu machen, immer mit Rückfrage).',
      schema: z.object({
        keep: z.string().min(1),
        duplicates: list,
        as: z.enum(['duplicate', 'older_version']).default('duplicate'),
        action: z.enum(['mark', 'subfolder', 'delete']).default('mark'),
      }),
      risk: (a) => (a.action === 'delete' ? 'critical' : 'write'),
      count: (a, ctx) => ctx.refs.resolveMany(a.duplicates).ids.length || a.duplicates.length,
      label: (a) =>
        a.action === 'delete'
          ? `Lösche ${a.duplicates.length} Duplikat(e) endgültig`
          : `Markiere ${a.duplicates.length} Dokument(e) als ${a.as === 'duplicate' ? 'Duplikat' : 'ältere Version'}${a.action === 'subfolder' ? ' und verschiebe sie' : ''}`,
      run: async (a, ctx) => {
        const keepId = resolveOne(ctx, a.keep);
        const keep = keepId ? docs.findRow(keepId) : undefined;
        if (!keepId || !keep) return { content: `Unbekannte Dokument-ID „${a.keep}“ für keep.`, isError: true };
        const { docs: dups, unknown } = resolveDocs({ deps, ctx }, a.duplicates);
        const targets = dups.filter((d) => d.id !== keepId);
        if (!targets.length) return { content: `Keine Duplikate angegeben (keep wird nie verändert).${unknownNote(unknown)}`, isError: true };
        const keepRef = ctx.refs.doc(keepId);
        const refs = targets.map((d) => ctx.refs.doc(d.id)).join(', ');

        if (a.action === 'delete') {
          const failed: string[] = [];
          let deleted = 0;
          for (const d of targets) {
            try {
              docs.deletePermanently(d.id, { trigger: 'agent' });
              deleted += 1;
            } catch (err) {
              failed.push(`${ctx.refs.doc(d.id)}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return {
            content: `${deleted} Duplikat(e) von ${keepRef} endgültig gelöscht (${refs}); ${keepRef} bleibt.${failed.length ? `\nFehlgeschlagen: ${failed.join('; ')}` : ''}${unknownNote(unknown)}`,
            summary: `${deleted} gelöscht`,
            change: `${deleted} Duplikat(e) endgültig gelöscht`,
            changed: deleted,
            isError: deleted === 0,
          };
        }

        const tag = a.as === 'duplicate' ? 'Duplikat' : 'ältere Version';
        for (const d of targets) {
          if (a.as === 'duplicate') graph.linkEntries(d.id, keepId, 'duplicate_of', { status: 'confirmed', trigger: 'agent' });
          else graph.linkEntries(keepId, d.id, 'supersedes', { status: 'confirmed', trigger: 'agent' });
        }
        const { auditId } = docs.bulkUpdate(
          targets.map((d) => d.id),
          { addTags: [tag] },
          { trigger: 'agent' },
        );
        const lines = [`${targets.length} Dokument(e) als ${tag} von ${keepRef} markiert (${refs}), Schlagwort „${tag}“ gesetzt.`];
        let change = `${targets.length} Dokument(e) als ${tag} markiert`;
        if (a.action === 'subfolder') {
          if (!keep.archiveRelPath) lines.push(`${keepRef} liegt nicht im Archiv – kein Unterordner möglich.`);
          else {
            const folder = folderOf(keep);
            const sub = `${folder ? `${folder}/` : ''}${a.as === 'duplicate' ? 'Duplikate' : 'Ältere Versionen'}`;
            const target = deps.categories.canonical(sub);
            const main = deps.categories.needsApproval(target);
            if (main) lines.push(`Der Hauptordner „${main}“ existiert nicht – nicht verschoben. Neue Hauptordner legt nur der Benutzer an.`);
            else {
              deps.categories.create(target, true);
              const res = await deps.archive.relocate(
                targets.map((d) => ({ documentId: d.id, categoryPath: target })),
                { confirmed: true, trigger: 'agent' },
              );
              lines.push(
                `Nach „${target}“ verschoben: ${res.success} erfolgreich${res.skipped ? `, ${res.skipped} übersprungen` : ''}${res.failed ? `, ${res.failed} fehlgeschlagen` : ''}.`,
              );
              for (const i of res.items.filter((x) => x.outcome !== 'success').slice(0, 20)) lines.push(`- ${ctx.refs.doc(i.documentId)}: ${i.message}`);
              change += ` und ${res.success} nach ${target} verschoben`;
            }
          }
        }
        return {
          content: lines.join('\n') + (auditId ? `\n(Schlagwort rückgängig machbar, Protokoll ${auditId})` : '') + unknownNote(unknown),
          summary: `${targets.length} markiert`,
          change,
          changed: targets.length,
        };
      },
    }),
    defineTool({
      name: 'mark_different',
      description: 'Merkt sich, dass zwei Dokumente (oder Einträge) KEINE Duplikate sind – sie werden danach nicht mehr als Duplikat vorgeschlagen.',
      schema: z.object({ a: z.string().min(1), b: z.string().min(1) }),
      risk: 'write',
      label: () => 'Merke: die beiden sind verschieden',
      run: async (args, ctx) => {
        const a = resolveOne(ctx, args.a);
        const b = resolveOne(ctx, args.b);
        if (!a || !b || a === b || !graph.getEntity(a) || !graph.getEntity(b))
          return { content: 'Zwei verschiedene, bekannte IDs (D… oder K…) nötig.', isError: true };
        const existing = graph.relationsOf(a, { types: ['duplicate_of'] }).filter((r) => r.sourceEntityId === b || r.targetEntityId === b);
        let relationId: string | null = null;
        for (const r of existing) {
          if (r.status !== 'rejected') graph.setRelationStatus(r.id, 'rejected', 'user');
          relationId = r.id;
        }
        if (!relationId) relationId = graph.link(a, b, 'duplicate_of', { status: 'rejected', resolvedByUser: true, origin: 'user' })?.id ?? null;
        deps.audit.log({
          action: 'relation.markDifferent',
          actor: 'user',
          trigger: 'agent',
          confirmed: true,
          entityIds: [relationId, a, b].filter((x): x is string => Boolean(x)),
          before: existing.length ? { status: existing.map((r) => r.status) } : null,
          after: { status: 'rejected', relationType: 'duplicate_of' },
        });
        const ra = args.a.trim().toUpperCase();
        const rb = args.b.trim().toUpperCase();
        return {
          content: `Gemerkt: ${ra} und ${rb} sind verschieden und werden nicht mehr als Duplikat genannt.`,
          summary: 'gemerkt',
          change: `${ra} und ${rb} als verschieden markiert`,
        };
      },
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
      run: async (a, ctx) => {
        const keepId = resolveOne(ctx, a.keep);
        const dupId = resolveOne(ctx, a.duplicate);
        if (!keepId || !dupId || keepId === dupId) return { content: 'Zwei verschiedene, bekannte K-IDs nötig.', isError: true };
        const opts = { actor: 'agent' as const, trigger: 'agent' };
        let takenOver: string[];
        switch (a.kind) {
          case 'open_item':
            takenOver = deps.openItemDuplicates.merge(keepId, dupId, opts).takenOver;
            break;
          case 'note':
            takenOver = deps.noteEventDuplicates.mergeNotes(keepId, dupId, opts).takenOver;
            break;
          case 'event':
            takenOver = deps.noteEventDuplicates.mergeEvents(keepId, dupId, opts).takenOver;
            break;
          default: {
            const types: Record<string, EntityType> = { topic: 'topic', project: 'project', person: 'person' };
            const keep = graph.getEntity(keepId);
            const dup = graph.getEntity(dupId);
            if (keep?.type !== types[a.kind] || dup?.type !== types[a.kind])
              return { content: `Beide Einträge müssen vom Typ ${MERGE_LABEL[a.kind]} sein.`, isError: true };
            await graph.merge({ sourceIds: [dupId], targetId: keepId }, opts);
            takenOver = ['Verknüpfungen', 'Name als Alias'];
          }
        }
        const kr = ctx.refs.entry(keepId);
        const dr = ctx.refs.entry(dupId);
        return {
          content: `${dr} in ${kr} zusammengeführt${takenOver.length ? `; übernommen: ${takenOver.join(', ')}` : ''}. Rückgängig machbar.`,
          summary: 'zusammengeführt',
          change: `Doppelte ${MERGE_LABEL[a.kind]} zusammengeführt`,
          changed: 1,
        };
      },
    }),
  ];
}

const MERGE_LABEL: Record<'open_item' | 'note' | 'event' | 'topic' | 'project' | 'person', string> = {
  open_item: 'offene Punkte',
  note: 'Notizen',
  event: 'Ereignisse',
  topic: 'Themen',
  project: 'Projekte',
  person: 'Personen',
};
