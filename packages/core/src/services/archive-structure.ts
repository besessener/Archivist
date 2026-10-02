import path from 'node:path';

/** The minimum the filing analysis needs from a document. */
export interface PlacedDoc {
  id: string;
  title: string;
  archiveRelPath: string | null;
  topicName?: string | null;
  projectName?: string | null;
}

export interface FolderGroup<T extends PlacedDoc = PlacedDoc> {
  /** Folder relative to the archive (POSIX); empty = top level */
  folder: string;
  docs: T[];
}

export interface SplitSubject<T extends PlacedDoc = PlacedDoc> {
  kind: 'Thema' | 'Projekt';
  name: string;
  groups: FolderGroup<T>[];
}

const segments = (folder: string) => (folder === '' ? 0 : folder.split('/').length);

/** Folder the archive file actually lies in. */
export function folderOf(doc: Pick<PlacedDoc, 'archiveRelPath'>): string {
  const dir = path.posix.dirname((doc.archiveRelPath ?? '').replaceAll('\\', '/'));
  return dir === '.' ? '' : dir;
}

export const folderLabel = (folder: string): string => (folder === '' ? '(oberste Ebene des Archivs)' : folder);

/** Grouped by folder; the largest group first, alphabetical on a tie. */
export function groupByFolder<T extends PlacedDoc>(docs: T[]): FolderGroup<T>[] {
  const byFolder = new Map<string, T[]>();
  for (const doc of docs) {
    const folder = folderOf(doc);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), doc]);
  }
  return [...byFolder.entries()]
    .map(([folder, list]) => ({ folder, docs: list }))
    .sort((a, b) => b.docs.length - a.docs.length || a.folder.localeCompare(b.folder));
}

/** Common target folder: where most documents lie, on a tie the deeper, then alphabetical; never the top level (`null`). */
export function chooseTargetFolder(groups: FolderGroup[]): string | null {
  const candidates = groups.filter((g) => g.folder !== '');
  if (candidates.length === 0) return null;
  const best = [...candidates].sort((a, b) => b.docs.length - a.docs.length || segments(b.folder) - segments(a.folder) || a.folder.localeCompare(b.folder))[0]!;
  return best.folder;
}

/** Topics and projects whose documents lie in more than one folder. */
export function splitSubjects<T extends PlacedDoc>(docs: T[]): SplitSubject<T>[] {
  const out: SplitSubject<T>[] = [];
  const collect = (kind: SplitSubject['kind'], pick: (d: T) => string | null | undefined) => {
    const byName = new Map<string, T[]>();
    for (const doc of docs) {
      const name = pick(doc)?.trim();
      if (name) byName.set(name, [...(byName.get(name) ?? []), doc]);
    }
    for (const [name, list] of byName) {
      const groups = groupByFolder(list);
      if (groups.length > 1) out.push({ kind, name, groups });
    }
  };
  collect('Thema', (d) => d.topicName);
  collect('Projekt', (d) => d.projectName);
  return out.sort((a, b) => b.groups.length - a.groups.length || a.name.localeCompare(b.name));
}
