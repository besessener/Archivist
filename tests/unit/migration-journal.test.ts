import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../helpers/harness';
import { validateMigrations, type MigrationFiles, type MigrationSnapshot } from '../helpers/migration-journal';

// The migrator applies an entry only if its `when` is newer than the last applied one: a stale value would skip it on upgrade (#246).

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const ENTRIES: JournalEntry[] = [
  { idx: 0, when: 100, tag: '0000_init' },
  { idx: 1, when: 200, tag: '0001_second' },
  { idx: 2, when: 300, tag: '0002_third' },
];

const SNAPSHOTS: Record<string, MigrationSnapshot> = {
  '0000_snapshot.json': { id: 'id-0', prevId: '00000000-0000-0000-0000-000000000000' },
  '0001_snapshot.json': { id: 'id-1', prevId: 'id-0' },
  '0002_snapshot.json': { id: 'id-2', prevId: 'id-1' },
};

const SQL_FILES = ['0000_init.sql', '0001_second.sql', '0002_third.sql'];

const files = (overrides: Partial<MigrationFiles> = {}): MigrationFiles => ({ fileNames: SQL_FILES, snapshots: SNAPSHOTS, ...overrides });
const journal = (entries: JournalEntry[] = ENTRIES) => ({ entries });
const withEntry = (position: number, patch: Partial<JournalEntry>) =>
  journal(ENTRIES.map((entry, index) => (index === position ? { ...entry, ...patch } : entry)));

describe('validateMigrations', () => {
  it('accepts a consistent migrations folder', () => {
    expect(validateMigrations(journal(), files())).toEqual([]);
  });

  it('flags a when that is lower than its predecessor and names the migration', () => {
    expect(validateMigrations(withEntry(2, { when: 150 }), files())).toEqual([
      '0002_third: when 150 is not greater than when 200 of 0001_second; the migrator would silently skip it on upgrade',
    ]);
  });

  it('flags a when that equals its predecessor', () => {
    expect(validateMigrations(withEntry(1, { when: 100 }), files())).toEqual([
      '0001_second: when 100 is not greater than when 100 of 0000_init; the migrator would silently skip it on upgrade',
    ]);
  });

  it('flags a duplicated idx', () => {
    expect(validateMigrations(withEntry(2, { idx: 1 }), files())).toEqual(
      expect.arrayContaining(['0002_third: idx is 1, expected 2 (idx must run 0..n-1 in order)', '0002_third: tag number 0002 does not match idx 1']),
    );
  });

  it('flags a tag number that differs from idx', () => {
    const renamed = {
      '0005_snapshot.json': SNAPSHOTS['0001_snapshot.json'] as MigrationSnapshot,
      '0000_snapshot.json': SNAPSHOTS['0000_snapshot.json'] as MigrationSnapshot,
    };
    const result = validateMigrations(
      withEntry(1, { tag: '0005_second' }),
      files({ fileNames: ['0000_init.sql', '0005_second.sql', '0002_third.sql'], snapshots: renamed }),
    );
    expect(result).toContain('0005_second: tag number 0005 does not match idx 1');
  });

  it('flags a tag without the NNNN_name shape and a repeated tag', () => {
    const entries = ENTRIES.map((entry) => ({ ...entry, tag: entry.idx === 0 ? entry.tag : 'second' }));
    expect(validateMigrations(journal(entries), files())).toEqual(
      expect.arrayContaining(['second: tag must look like NNNN_name', 'second: tag occurs more than once']),
    );
  });

  it('flags a SQL file that is not in the journal', () => {
    expect(validateMigrations(journal(), files({ fileNames: [...SQL_FILES, '0003_orphan.sql'] }))).toEqual([
      '0003_orphan: 0003_orphan.sql is on disk but not in the journal (the migrator would never apply it)',
    ]);
  });

  it('flags a journal entry whose SQL file is missing', () => {
    expect(validateMigrations(journal(), files({ fileNames: ['0000_init.sql', '0002_third.sql'] }))).toEqual([
      '0001_second: 0001_second.sql is in the journal but missing on disk',
    ]);
  });

  it('ignores files that are not SQL', () => {
    expect(validateMigrations(journal(), files({ fileNames: [...SQL_FILES, 'meta', 'notes.txt'] }))).toEqual([]);
  });

  it('flags a missing snapshot, an orphan snapshot and a broken snapshot chain', () => {
    const snapshots = {
      '0000_snapshot.json': SNAPSHOTS['0000_snapshot.json'] as MigrationSnapshot,
      '0002_snapshot.json': { id: 'id-2', prevId: 'someone-else' },
      '0009_snapshot.json': { id: 'x', prevId: 'y' },
    };
    expect(validateMigrations(journal(), files({ snapshots }))).toEqual(
      expect.arrayContaining([
        '0009_snapshot.json: snapshot belongs to no journal entry',
        '0001_second: meta/0001_snapshot.json is missing (drizzle-kit generate would diff against a stale schema)',
        '0002_third: 0002_snapshot.json has prevId someone-else, expected id-0 (broken snapshot chain)',
      ]),
    );
  });

  it('flags a first snapshot that does not start the chain', () => {
    const snapshots = { ...SNAPSHOTS, '0000_snapshot.json': { id: 'id-0', prevId: 'id-2' } };
    expect(validateMigrations(journal(), files({ snapshots }))).toEqual([
      '0000_init: 0000_snapshot.json has prevId id-2, expected 00000000-0000-0000-0000-000000000000 (broken snapshot chain)',
    ]);
  });

  it('reports a malformed journal instead of throwing', () => {
    expect(validateMigrations(null, files())).toEqual(['_journal.json: "entries" is not an array']);
    expect(validateMigrations({ entries: {} }, files())).toEqual(['_journal.json: "entries" is not an array']);
    expect(
      validateMigrations(
        {
          entries: [
            { idx: 0, when: 1, tag: '0000_a' },
            { idx: 1, tag: '0001_b' },
          ],
        },
        files(),
      ),
    ).toEqual(['_journal.json: entry at position 1 is malformed (needs numeric idx and when, string tag)']);
    expect(validateMigrations({ entries: [null] }, files())).toEqual([
      '_journal.json: entry at position 0 is malformed (needs numeric idx and when, string tag)',
    ]);
  });
});

describe('the real migrations folder', () => {
  it('has a strictly increasing journal with matching SQL files and an intact snapshot chain', () => {
    const journal: unknown = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'));
    const snapshots: Record<string, MigrationSnapshot> = {};
    for (const name of fs.readdirSync(path.join(MIGRATIONS, 'meta')).filter((file) => file.endsWith('_snapshot.json'))) {
      snapshots[name] = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta', name), 'utf8')) as MigrationSnapshot;
    }
    const violations = validateMigrations(journal, { fileNames: fs.readdirSync(MIGRATIONS), snapshots });
    expect(violations, `Fix packages/core/migrations (strictly increasing "when", one NNNN per migration):\n${violations.join('\n')}`).toEqual([]);
  });
});
