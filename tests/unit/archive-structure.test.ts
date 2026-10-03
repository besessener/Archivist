import { describe, expect, it } from 'vitest';
import { chooseTargetFolder, folderLabel, folderOf, groupByFolder, splitSubjects, type PlacedDoc } from '../../packages/core/src/services/archive-structure';

const doc = (id: string, rel: string | null, topic: string | null = null, project: string | null = null): PlacedDoc => ({
  id,
  title: `Dokument ${id}`,
  archiveRelPath: rel,
  topicName: topic,
  projectName: project,
});

describe('evaluating where documents are filed in the archive', () => {
  describe('folderOf', () => {
    it('returns the folder of the archive file, also with Windows separators', () => {
      expect(folderOf({ archiveRelPath: 'Privat/bildungsurlaub/2026/antrag.pdf' })).toBe('Privat/bildungsurlaub/2026');
      expect(folderOf({ archiveRelPath: 'Arbeit\\hr\\antrag.pdf' })).toBe('Arbeit/hr');
    });

    it('reports an empty folder for files at the top level and without a path', () => {
      expect(folderOf({ archiveRelPath: 'antrag.pdf' })).toBe('');
      expect(folderOf({ archiveRelPath: null })).toBe('');
      expect(folderLabel('')).toBe('(oberste Ebene des Archivs)');
      expect(folderLabel('Arbeit/hr')).toBe('Arbeit/hr');
    });
  });

  describe('groupByFolder', () => {
    it('groups documents per folder, largest group first, alphabetically on a tie', () => {
      const groups = groupByFolder([doc('1', 'b/x.pdf'), doc('2', 'a/y.pdf'), doc('3', 'c/z.pdf'), doc('4', 'c/w.pdf')]);

      expect(groups.map((g) => [g.folder, g.docs.map((d) => d.id)])).toEqual([
        ['c', ['3', '4']],
        ['a', ['2']],
        ['b', ['1']],
      ]);
    });

    it('returns no groups for no documents', () => {
      expect(groupByFolder([])).toEqual([]);
    });
  });

  describe('chooseTargetFolder', () => {
    const pick = (...rels: string[]) => chooseTargetFolder(groupByFolder(rels.map((rel, i) => doc(String(i), rel))));

    it('picks the folder that already holds the most documents', () => {
      expect(pick('a/1.pdf', 'b/2.pdf', 'b/3.pdf', 'c/4.pdf')).toEqual({ kind: 'chosen', folder: 'b' });
    });

    it('decides nothing on a tie and returns the tied folders alphabetically, deeper or not', () => {
      expect(pick('a/1.pdf', 'b/c/2.pdf')).toEqual({ kind: 'tied', folders: ['a', 'b/c'] });
      expect(pick('z/1.pdf', 'a/2.pdf', 'm/3.pdf', 'm/4.pdf', 'a/5.pdf', 'z/6.pdf')).toEqual({ kind: 'tied', folders: ['a', 'm', 'z'] });
    });

    it('never picks the top level, even if most documents are there', () => {
      expect(pick('1.pdf', '2.pdf', '3.pdf', 'a/4.pdf')).toEqual({ kind: 'chosen', folder: 'a' });
    });

    it('returns none if there is only the top level or nothing at all', () => {
      expect(pick('1.pdf', '2.pdf')).toEqual({ kind: 'none' });
      expect(chooseTargetFolder([])).toEqual({ kind: 'none' });
    });
  });

  describe('splitSubjects', () => {
    it('finds topics and projects whose documents are spread across several folders', () => {
      const split = splitSubjects([
        doc('1', 'a/x.pdf', 'Bildungsurlaub 2026'),
        doc('2', 'b/y.pdf', 'Bildungsurlaub 2026'),
        doc('3', 'c/z.pdf', 'Bildungsurlaub 2026'),
        doc('4', 'a/v.pdf', 'Steuer'),
        doc('5', 'a/w.pdf', 'Steuer'),
        doc('6', 'a/u.pdf', null, 'Hausbau'),
        doc('7', 'b/t.pdf', null, 'Hausbau'),
      ]);

      expect(split.map((s) => [s.kind, s.name, s.groups.length])).toEqual([
        ['Thema', 'Bildungsurlaub 2026', 3],
        ['Projekt', 'Hausbau', 2],
      ]);
    });

    it('ignores empty names, trims names and reports nothing when everything is in one place', () => {
      expect(splitSubjects([doc('1', 'a/x.pdf', '  '), doc('2', 'b/y.pdf', ''), doc('3', 'c/z.pdf', null)])).toEqual([]);
      expect(splitSubjects([doc('1', 'a/x.pdf', ' Steuer '), doc('2', 'b/y.pdf', 'Steuer')])).toHaveLength(1);
      expect(splitSubjects([])).toEqual([]);
    });

    it('sorts by number of folders, by name on a tie', () => {
      const split = splitSubjects([
        doc('1', 'a/1.pdf', 'Zeta'),
        doc('2', 'b/2.pdf', 'Zeta'),
        doc('3', 'a/3.pdf', 'Alpha'),
        doc('4', 'b/4.pdf', 'Alpha'),
        doc('5', 'a/5.pdf', 'Mitte'),
        doc('6', 'b/6.pdf', 'Mitte'),
        doc('7', 'c/7.pdf', 'Mitte'),
      ]);

      expect(split.map((s) => s.name)).toEqual(['Mitte', 'Alpha', 'Zeta']);
    });
  });
});
