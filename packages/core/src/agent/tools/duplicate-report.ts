import type { DocumentRecord } from '@archivist/shared';
import { normalizeName, truncate } from '../../util/text';
import type { ToolOutput } from '../registry';
import { ARCHIVED, allDocs, docDay, docLine, normalizeExtension, resolveDocs, unknownNote, type ToolDeps, type ToolScope } from './common';
import { looksLikeVersions, versionKey } from './duplicate-versions';

export type DuplicateKind = 'exact' | 'near' | 'versions';

const KIND_LABEL: Record<DuplicateKind, string> = { exact: 'Exaktes Duplikat', near: 'Fast gleich', versions: 'Versionen' };

const newestKey = (d: Pick<DocumentRecord, 'documentDate' | 'archivedAt' | 'createdAt'>) => `${docDay(d)}|${d.archivedAt ?? d.createdAt}`;

/** The user said these two are different (rejected duplicate_of in either direction). */
const markedDifferent = (deps: ToolDeps) => (a: string, b: string) =>
  deps.graph.relationsOf(a, { statuses: ['rejected'], types: ['duplicate_of'] }).some((r) => r.sourceEntityId === b || r.targetEntityId === b) ||
  deps.graph.rejectedBetween({ a, b, includeDuplicateOf: true })?.relationType === 'duplicate_of';

interface Grouping {
  differ: (a: string, b: string) => boolean;
  fits: (a: DocumentRecord, b: DocumentRecord) => boolean;
}

/** Greedy clusters of a bucket that never put two documents together the user marked as different. */
function cluster(bucket: DocumentRecord[], { differ, fits }: Grouping): DocumentRecord[][] {
  const groups: DocumentRecord[][] = [];
  for (const d of bucket) {
    const group = groups.find((xs) => xs.every((x) => !differ(x.id, d.id)) && xs.some((x) => fits(x, d)));
    if (group) group.push(d);
    else groups.push([d]);
  }
  return groups.filter((g) => g.length > 1);
}

/** Documents with the same key, buckets of two or more. */
function bucketBy(docs: DocumentRecord[], key: (d: DocumentRecord) => string | null): DocumentRecord[][] {
  const buckets = new Map<string, DocumentRecord[]>();
  for (const d of docs) {
    const k = key(d);
    if (k) buckets.set(k, [...(buckets.get(k) ?? []), d]);
  }
  return [...buckets.values()].filter((xs) => xs.length > 1);
}

const textStart = (d: DocumentRecord) => {
  const normalized = normalizeName(d.textPreview);
  return normalized.length >= 80 ? normalized.slice(0, 200) : null;
};

const versionBucket = (d: DocumentRecord) => {
  const key = versionKey(d.originalName).key;
  return key ? `${normalizeExtension(d.ext)}|${key}` : null;
};

const sameVersion = (x: DocumentRecord, y: DocumentRecord) =>
  looksLikeVersions({ name: x.originalName, title: x.title }, { name: y.originalName, title: y.title });

interface KindGroups {
  kind: DuplicateKind;
  groups: () => DocumentRecord[][];
  reason: (group: DocumentRecord[]) => string;
}

/** The groupings per kind, strongest first; each groups lazily, so only the requested kinds do the work. */
function kindGroups(scope: ToolScope, found: DocumentRecord[]): KindGroups[] {
  const { deps, ctx } = scope;
  const differ = markedDifferent(deps);
  const any = () => true;
  return [
    {
      kind: 'exact',
      groups: () => bucketBy(found, (d) => d.sha256).flatMap((b) => cluster(b, { differ, fits: any })),
      reason: () => 'gleicher Dateiinhalt (gleiche Prüfsumme)',
    },
    {
      kind: 'near',
      groups: () => bucketBy(found, textStart).flatMap((b) => cluster(b, { differ, fits: any })),
      reason: (group) => {
        const hashes = new Set(group.map((d) => deps.docs.findRow(d.id)?.textHash ?? null));
        return hashes.size === 1 && !hashes.has(null)
          ? 'gleicher Textinhalt (andere Datei, z. B. anderes Format oder neu gespeichert)'
          : 'sehr ähnlicher Textanfang';
      },
    },
    {
      kind: 'versions',
      groups: () => bucketBy(found, versionBucket).flatMap((b) => cluster(b, { differ, fits: sameVersion })),
      reason: (group) => {
        const marked = group.filter((d) => versionKey(d.originalName).marker).map((d) => ctx.refs.doc(d.id));
        return `gleicher Name bis auf Versions- oder Datumsangaben, ähnlicher Titel${marked.length ? ` (Versionsmerkmal bei ${marked.join(', ')})` : ''}`;
      },
    },
  ];
}

function describeGroup(scope: ToolScope, group: { kind: DuplicateKind; docs: DocumentRecord[]; reason: string }): string {
  const { ctx } = scope;
  const newest = group.docs.toSorted((a, b) => newestKey(b).localeCompare(newestKey(a)))[0]!;
  const set = ctx.refs.set(group.docs.map((d) => d.id));
  return [
    `${KIND_LABEL[group.kind]} (${group.docs.length} Dokumente, ${set}) – ${group.reason}. Neueste: ${ctx.refs.doc(newest.id)}`,
    ...group.docs.map((d) => `  - ${docLine(scope, d)}`),
  ].join('\n');
}

/** One block per group; a group already reported under a stronger kind (or fully contained in one) is not repeated. */
function groupBlocks(scope: ToolScope, groupings: KindGroups[]): string[] {
  const grouped = new Set<string>();
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const { kind, groups, reason } of groupings)
    for (const docs of groups()) {
      const key = docs
        .map((d) => d.id)
        .toSorted()
        .join('|');
      if (seen.has(key) || docs.every((d) => grouped.has(d.id))) continue;
      seen.add(key);
      for (const d of docs) grouped.add(d.id);
      blocks.push(describeGroup(scope, { kind, docs, reason: reason(docs) }));
    }
  return blocks;
}

/** Open duplicate hints of the archive check; details only when every affected document may be shared. */
function duplicateHints({ deps, ctx }: ToolScope): string[] {
  return deps.insights
    .list('open')
    .filter((i) => i.kind.includes('duplicate'))
    .slice(0, 20)
    .map((i) => {
      const hidden = i.affected
        .filter((x) => x.type === 'document')
        .some((x) => {
          const row = deps.docs.findRow(x.id);
          return !row || !deps.privacy.mayShareDocument(deps.docs.toRecord(row));
        });
      const refs = i.affected.map((x) => (x.type === 'document' ? ctx.refs.doc(x.id) : ctx.refs.entry(x.id))).join(', ');
      return hidden
        ? `- Hinweis ${ctx.refs.entry(i.id)} (${i.kind}) zu ${refs}`
        : `- Hinweis ${ctx.refs.entry(i.id)} (${i.kind}): ${truncate(i.title, 100)} – ${refs}`;
    });
}

export async function duplicateReport(scope: ToolScope, args: { documents?: string[] | null; kinds?: DuplicateKind[] | null }): Promise<ToolOutput> {
  const { deps } = scope;
  const { docs: found, unknown } = args.documents?.length
    ? resolveDocs(scope, args.documents)
    : { docs: allDocs(deps).filter((d) => ARCHIVED.includes(d.status)), unknown: [] as string[] };
  const kinds = new Set<DuplicateKind>(args.kinds?.length ? args.kinds : ['exact', 'near', 'versions']);
  const blocks = groupBlocks(
    scope,
    kindGroups(scope, found).filter((g) => kinds.has(g.kind)),
  );
  const hints = duplicateHints(scope);
  const content = [
    blocks.length ? `${blocks.length} Gruppe(n) unter ${found.length} Dokumenten:` : `Keine Duplikate unter ${found.length} Dokumenten gefunden.`,
    ...blocks,
    hints.length ? `Offene Duplikat-Hinweise der Archivprüfung:\n${hints.join('\n')}` : null,
    blocks.length ? 'Behalten/markieren mit mark_duplicates, „sind verschieden“ mit mark_different.' : null,
  ]
    .filter(Boolean)
    .join('\n');
  return { content: content + unknownNote(unknown), summary: blocks.length ? `${blocks.length} Gruppe(n)` : 'keine Duplikate' };
}
