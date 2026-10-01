import { describe, expect, it } from 'vitest';
import { chooseTargetFolder, folderLabel, folderOf, groupByFolder, splitSubjects, type PlacedDoc } from '../../packages/core/src/services/archive-structure';

const doc = (id: string, rel: string | null, topic: string | null = null, project: string | null = null): PlacedDoc => ({
  id,
  title: `Dokument ${id}`,
  archiveRelPath: rel,
  topicName: topic,
  projectName: project,
});

describe('Ablage im Archiv auswerten', () => {
  describe('folderOf', () => {
    it('liefert den Ordner der Archivdatei, auch bei Windows-Trennzeichen', () => {
      expect(folderOf({ archiveRelPath: 'private/bildungsurlaub/2026/antrag.pdf' })).toBe('private/bildungsurlaub/2026');
      expect(folderOf({ archiveRelPath: 'work\\hr\\antrag.pdf' })).toBe('work/hr');
    });

    it('meldet für Dateien auf der obersten Ebene und ohne Pfad einen leeren Ordner', () => {
      expect(folderOf({ archiveRelPath: 'antrag.pdf' })).toBe('');
      expect(folderOf({ archiveRelPath: null })).toBe('');
      expect(folderLabel('')).toBe('(oberste Ebene des Archivs)');
      expect(folderLabel('work/hr')).toBe('work/hr');
    });
  });

  describe('groupByFolder', () => {
    it('fasst Dokumente je Ordner zusammen, die größte Gruppe zuerst, bei Gleichstand alphabetisch', () => {
      const groups = groupByFolder([doc('1', 'b/x.pdf'), doc('2', 'a/y.pdf'), doc('3', 'c/z.pdf'), doc('4', 'c/w.pdf')]);

      expect(groups.map((g) => [g.folder, g.docs.map((d) => d.id)])).toEqual([
        ['c', ['3', '4']],
        ['a', ['2']],
        ['b', ['1']],
      ]);
    });

    it('liefert für keine Dokumente keine Gruppen', () => {
      expect(groupByFolder([])).toEqual([]);
    });
  });

  describe('chooseTargetFolder', () => {
    const pick = (...rels: string[]) => chooseTargetFolder(groupByFolder(rels.map((rel, i) => doc(String(i), rel))));

    it('nimmt den Ordner, in dem die meisten Dokumente schon liegen', () => {
      expect(pick('a/1.pdf', 'b/2.pdf', 'b/3.pdf', 'c/4.pdf')).toBe('b');
    });

    it('nimmt bei Gleichstand den spezielleren (tieferen) Ordner, dann den alphabetisch ersten', () => {
      expect(pick('a/1.pdf', 'b/c/2.pdf')).toBe('b/c');
      expect(pick('z/1.pdf', 'a/2.pdf')).toBe('a');
    });

    it('wählt nie die oberste Ebene, auch wenn dort die meisten liegen', () => {
      expect(pick('1.pdf', '2.pdf', '3.pdf', 'a/4.pdf')).toBe('a');
    });

    it('liefert null, wenn es nur die oberste Ebene gibt oder gar nichts', () => {
      expect(pick('1.pdf', '2.pdf')).toBeNull();
      expect(chooseTargetFolder([])).toBeNull();
    });
  });

  describe('splitSubjects', () => {
    it('findet Themen und Projekte, deren Dokumente in mehreren Ordnern liegen', () => {
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

    it('ignoriert leere Namen, trimmt Namen und meldet nichts, wenn alles beisammen liegt', () => {
      expect(splitSubjects([doc('1', 'a/x.pdf', '  '), doc('2', 'b/y.pdf', ''), doc('3', 'c/z.pdf', null)])).toEqual([]);
      expect(splitSubjects([doc('1', 'a/x.pdf', ' Steuer '), doc('2', 'b/y.pdf', 'Steuer')])).toHaveLength(1);
      expect(splitSubjects([])).toEqual([]);
    });

    it('sortiert nach der Zahl der Ordner, bei Gleichstand nach Name', () => {
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
