import path from 'node:path';

/** Das Mindeste, was die Ablage-Auswertung von einem Dokument braucht. */
export interface PlacedDoc {
  id: string;
  title: string;
  archiveRelPath: string | null;
  topicName?: string | null;
  projectName?: string | null;
}

export interface FolderGroup<T extends PlacedDoc = PlacedDoc> {
  /** Ordner relativ zum Archiv (POSIX); leer = oberste Ebene */
  folder: string;
  docs: T[];
}

export interface SplitSubject<T extends PlacedDoc = PlacedDoc> {
  kind: 'Thema' | 'Projekt';
  name: string;
  groups: FolderGroup<T>[];
}

const segments = (folder: string) => (folder === '' ? 0 : folder.split('/').length);

/** Ordner, in dem die Archivdatei tatsächlich liegt. */
export function folderOf(doc: Pick<PlacedDoc, 'archiveRelPath'>): string {
  const dir = path.posix.dirname((doc.archiveRelPath ?? '').replaceAll('\\', '/'));
  return dir === '.' ? '' : dir;
}

export const folderLabel = (folder: string): string => (folder === '' ? '(oberste Ebene des Archivs)' : folder);

/** Gruppiert nach Ordner; die größte Gruppe zuerst, bei Gleichstand alphabetisch. */
export function groupByFolder<T extends PlacedDoc>(docs: T[]): FolderGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const doc of docs) {
    const folder = folderOf(doc);
    map.set(folder, [...(map.get(folder) ?? []), doc]);
  }
  return [...map.entries()].map(([folder, list]) => ({ folder, docs: list })).sort((a, b) => b.docs.length - a.docs.length || a.folder.localeCompare(b.folder));
}

/**
 * Schlägt den gemeinsamen Zielordner vor: dort, wo die meisten Dokumente schon liegen. Bei Gleichstand der
 * speziellere (tiefere) Ordner, danach alphabetisch. Die oberste Ebene kommt nie in Frage; `null`, wenn es nur sie gibt.
 */
export function chooseTargetFolder(groups: FolderGroup[]): string | null {
  const candidates = groups.filter((g) => g.folder !== '');
  if (candidates.length === 0) return null;
  const best = [...candidates].sort((a, b) => b.docs.length - a.docs.length || segments(b.folder) - segments(a.folder) || a.folder.localeCompare(b.folder))[0]!;
  return best.folder;
}

/** Themen und Projekte, deren Dokumente in mehr als einem Ordner liegen. */
export function splitSubjects<T extends PlacedDoc>(docs: T[]): SplitSubject<T>[] {
  const out: SplitSubject<T>[] = [];
  const collect = (kind: SplitSubject['kind'], pick: (d: T) => string | null | undefined) => {
    const by = new Map<string, T[]>();
    for (const doc of docs) {
      const name = pick(doc)?.trim();
      if (name) by.set(name, [...(by.get(name) ?? []), doc]);
    }
    for (const [name, list] of by) {
      const groups = groupByFolder(list);
      if (groups.length > 1) out.push({ kind, name, groups });
    }
  };
  collect('Thema', (d) => d.topicName);
  collect('Projekt', (d) => d.projectName);
  return out.sort((a, b) => b.groups.length - a.groups.length || a.name.localeCompare(b.name));
}
