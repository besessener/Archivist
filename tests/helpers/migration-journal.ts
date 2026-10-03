export interface MigrationSnapshot {
  id: string;
  prevId: string;
}

export interface MigrationFiles {
  /** Names of all files directly in the migrations folder. */
  fileNames: string[];
  /** Parsed `meta/NNNN_snapshot.json` files by file name. */
  snapshots: Record<string, MigrationSnapshot>;
}

const FIRST_PREV_ID = '00000000-0000-0000-0000-000000000000';
const TAG_PATTERN = /^(\d{4})_[a-z0-9_]+$/;

interface Entry {
  idx: number;
  when: number;
  tag: string;
}

const isEntry = (value: unknown): value is Entry => {
  const entry = value as Partial<Entry> | null;
  return typeof entry === 'object' && entry !== null && Number.isInteger(entry.idx) && Number.isFinite(entry.when) && typeof entry.tag === 'string';
};

const snapshotName = (entry: Entry) => `${entry.tag.slice(0, 4)}_snapshot.json`;

function entryViolations(entries: Entry[]): string[] {
  const violations: string[] = [];
  const seenTags = new Set<string>();
  entries.forEach((entry, position) => {
    if (entry.idx !== position) violations.push(`${entry.tag}: idx is ${entry.idx}, expected ${position} (idx must run 0..n-1 in order)`);
    const number = TAG_PATTERN.exec(entry.tag)?.[1];
    if (number === undefined) violations.push(`${entry.tag}: tag must look like NNNN_name`);
    else if (Number(number) !== entry.idx) violations.push(`${entry.tag}: tag number ${number} does not match idx ${entry.idx}`);
    if (seenTags.has(entry.tag)) violations.push(`${entry.tag}: tag occurs more than once`);
    seenTags.add(entry.tag);
    const previous = entries[position - 1];
    if (previous && entry.when <= previous.when) {
      violations.push(
        `${entry.tag}: when ${entry.when} is not greater than when ${previous.when} of ${previous.tag}; the migrator would silently skip it on upgrade`,
      );
    }
  });
  return violations;
}

function fileViolations(entries: Entry[], fileNames: string[]): string[] {
  const violations: string[] = [];
  const tags = new Set(entries.map((entry) => entry.tag));
  const sqlTags = new Set(fileNames.filter((name) => name.endsWith('.sql')).map((name) => name.slice(0, -'.sql'.length)));
  for (const tag of tags) if (!sqlTags.has(tag)) violations.push(`${tag}: ${tag}.sql is in the journal but missing on disk`);
  for (const tag of sqlTags) if (!tags.has(tag)) violations.push(`${tag}: ${tag}.sql is on disk but not in the journal (the migrator would never apply it)`);
  return violations;
}

function snapshotViolations(entries: Entry[], snapshots: Record<string, MigrationSnapshot>): string[] {
  const violations: string[] = [];
  const expectedNames = new Set(entries.map(snapshotName));
  for (const name of Object.keys(snapshots)) if (!expectedNames.has(name)) violations.push(`${name}: snapshot belongs to no journal entry`);
  let previousId = FIRST_PREV_ID;
  for (const entry of entries) {
    const name = snapshotName(entry);
    const snapshot = snapshots[name];
    if (!snapshot) {
      violations.push(`${entry.tag}: meta/${name} is missing (drizzle-kit generate would diff against a stale schema)`);
      continue;
    }
    if (snapshot.prevId !== previousId) violations.push(`${entry.tag}: ${name} has prevId ${snapshot.prevId}, expected ${previousId} (broken snapshot chain)`);
    previousId = snapshot.id;
  }
  return violations;
}

/** Returns every way the migrations folder would trip the migrator or drizzle-kit; empty when consistent. */
export function validateMigrations(journal: unknown, files: MigrationFiles): string[] {
  const entries = (journal as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return ['_journal.json: "entries" is not an array'];
  const malformed = entries.findIndex((entry) => !isEntry(entry));
  if (malformed !== -1) return [`_journal.json: entry at position ${malformed} is malformed (needs numeric idx and when, string tag)`];
  const valid = entries as Entry[];
  return [...entryViolations(valid), ...fileViolations(valid, files.fileNames), ...snapshotViolations(valid, files.snapshots)];
}
