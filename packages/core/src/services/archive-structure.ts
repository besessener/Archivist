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

/** The folder to file into: clear (`chosen`), a tie between several folders (`tied`) or no candidate (`none`). */
export type TargetChoice = { kind: 'chosen'; folder: string } | { kind: 'tied'; folders: string[] } | { kind: 'none' };

/** Where most documents lie, never the top level; a tie is not decided but returned for the user to choose (#200). */
export function chooseTargetFolder(groups: FolderGroup[]): TargetChoice {
  const candidates = groups.filter((g) => g.folder !== '');
  if (candidates.length === 0) return { kind: 'none' };
  const most = Math.max(...candidates.map((g) => g.docs.length));
  const folders = candidates
    .filter((g) => g.docs.length === most)
    .map((g) => g.folder)
    .sort((a, b) => a.localeCompare(b));
  return folders.length === 1 ? { kind: 'chosen', folder: folders[0]! } : { kind: 'tied', folders };
}

/** Folder names quoted and joined with „oder“. */
export const folderChoiceText = (folders: string[]): string => folders.map((f) => `„${f}“`).join(' oder ');

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
