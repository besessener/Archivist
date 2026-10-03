import {
  archiveUnchanged,
  created,
  docAfter,
  fileNameOf,
  inFolder,
  mentions,
  newRelations,
  notFailed,
  onlyChanged,
  readOnly,
  verdict,
  type EvalTask,
} from './checks';
import { DATES, dateForms } from './fixture';
import { BATH, CRAFTSMEN, CRAFTSMEN_2025, SLIDES, tilerInbox } from './task-documents';

export const ARCHIVE_TASKS: EvalTask[] = [
  // #303 read tools
  {
    id: 'read-emails',
    story: '#303',
    title: 'Nach Endung suchen: E-Mails',
    messages: ['Welche E-Mails habe ich archiviert?'],
    check: (c) => verdict(...readOnly(c), mentions(c, ['Badsanierung'], 'die Badsanierungs-Mails'), mentions(c, ['Sommerfest'], 'die Sommerfest-Mail')),
  },
  {
    id: 'read-fulltext',
    story: '#303',
    title: 'Inhaltssuche findet die Fundstelle',
    messages: ['In welchem Dokument steht etwas über PostgreSQL?'],
    check: (c) => verdict(...readOnly(c), mentions(c, ['Protokoll'], 'das Protokoll des Projektmeetings')),
  },
  {
    id: 'read-project-history',
    story: '#303',
    title: 'Zusammenhänge eines Projekts',
    messages: ['Was ist im Projekt Atlas bisher passiert?'],
    check: (c) => verdict(...readOnly(c), mentions(c, ['Kickoff'], 'den Kickoff'), mentions(c, ['PostgreSQL', 'Protokoll'], 'das Projektmeeting')),
  },

  // #304 files
  {
    id: 'move-slides',
    story: '#304',
    title: '„Verschiebe alle Folien nach presentations“ – vorhandener Ordner, nichts anderes geändert',
    messages: ['Verschiebe alle Folien nach presentations'],
    check: (c) =>
      verdict(
        inFolder(c, SLIDES, (f) => f === 'Arbeit/presentations', 'Arbeit/presentations'),
        onlyChanged(c, SLIDES, ['archiveRelPath']),
        notFailed(c),
      ),
  },
  {
    id: 'rename-pattern',
    story: '#304',
    title: 'Umbenennen nach Schema mit Datum und Absender',
    messages: ['Benenne die Handwerkerrechnungen nach dem Schema „Datum Rechnung Absender“ um, also z. B. „2025-03-14 Rechnung Malerbetrieb Schulz“.'],
    check: (c) => {
      const wrong = CRAFTSMEN.filter((k) => !fileNameOf(c, k).startsWith(docAfter(c, k).documentDate?.slice(0, 10) ?? '?'));
      return verdict(
        [wrong.length === 0, `nicht nach Schema benannt: ${wrong.map((k) => fileNameOf(c, k)).join(', ')}`],
        onlyChanged(c, CRAFTSMEN, ['archiveRelPath']),
      );
    },
  },
  {
    id: 'archive-inbox-like-siblings',
    story: '#304',
    title: 'Eingang ablegen „zu den anderen“: Ordner aus ähnlichen Ablagen ableiten',
    fixture: { docs: [tilerInbox] },
    messages: ['Leg die neue Rechnung aus dem Eingang zu den anderen Handwerkerrechnungen.'],
    check: (c) =>
      verdict(
        [docAfter(c, 'rechnung-fliesen-2025').status === 'archived', 'Rechnung nicht archiviert'],
        inFolder(c, ['rechnung-fliesen-2025'], (f) => f === 'wohnen/handwerker', 'wohnen/handwerker'),
        onlyChanged(c, ['rechnung-fliesen-2025']),
      ),
  },
  {
    id: 'create-folder-move',
    story: '#304',
    title: 'Ordner anlegen und Dokument hineinlegen',
    messages: ['Leg einen Ordner wohnen/nebenkosten an und verschiebe die Stadtwerke-Rechnung dorthin.'],
    check: (c) =>
      verdict(
        inFolder(c, ['rechnung-stadtwerke-2026-07'], (f) => f === 'wohnen/nebenkosten', 'wohnen/nebenkosten'),
        onlyChanged(c, ['rechnung-stadtwerke-2026-07'], ['archiveRelPath']),
      ),
  },

  // #305 metadata
  {
    id: 'bulk-tag-2025',
    story: '#305',
    title: 'Schlagwort in Serie, nur für das gefragte Jahr',
    messages: ['Gib allen Handwerkerrechnungen aus 2025 das Schlagwort „steuer-2025“.'],
    check: (c) => {
      const missing = CRAFTSMEN_2025.filter((k) => !docAfter(c, k).tags.some((t) => t.toLowerCase() === 'steuer-2025'));
      return verdict([missing.length === 0, `Schlagwort fehlt bei ${missing.join(', ')}`], onlyChanged(c, CRAFTSMEN_2025, ['tags']));
    },
  },
  {
    id: 'set-topic-leases',
    story: '#305',
    title: 'Thema zuordnen',
    messages: ['Ordne die beiden Mietverträge dem Thema „Wohnung Lindenstraße“ zu.'],
    check: (c) => {
      const keys = ['mietvertrag-2021', 'mietvertrag-2026'];
      const wrong = keys.filter((k) => !/lindenstra/i.test(docAfter(c, k).topic ?? ''));
      return verdict([wrong.length === 0, `Thema fehlt bei ${wrong.join(', ')}`], onlyChanged(c, keys, ['topic']));
    },
  },
  {
    id: 'fix-document-date',
    story: '#305',
    title: 'Dokumentdatum korrigieren',
    messages: [`Beim Kaufbeleg der Waschmaschine ist das Dokumentdatum falsch – richtig ist der ${dateForms(DATES.washerCorrected)[0]}.`],
    check: (c) => {
      const wanted = DATES.washerCorrected;
      return verdict(
        [
          docAfter(c, 'kaufbeleg-waschmaschine').documentDate?.slice(0, 10) === wanted,
          `Datum ist ${docAfter(c, 'kaufbeleg-waschmaschine').documentDate} statt ${wanted}`,
        ],
        onlyChanged(c, ['kaufbeleg-waschmaschine'], ['documentDate']),
      );
    },
  },

  // #306 links and cases
  {
    id: 'link-explicit',
    story: '#306',
    title: 'Ausdrücklich gewünschte Verknüpfung wird bestätigt angelegt',
    messages: ['Verknüpfe die Rechnung von Sanitär Meier mit dem finalen Angebot zur Badsanierung.'],
    check: (c) => {
      const inv = c.ids['rechnung-sanitaer-2025'];
      const offers = [c.ids['angebot-bad-final'], c.ids['angebot-bad']];
      const rel = newRelations(c).find((r) => [r.source, r.target].includes(inv!) && offers.some((o) => [r.source, r.target].includes(o!)));
      return verdict(
        [Boolean(rel), 'keine Verknüpfung Rechnung ↔ Angebot'],
        [rel?.status === 'confirmed', `Verknüpfung nur ${rel?.status ?? '–'}`],
        archiveUnchanged(c),
      );
    },
  },
  {
    id: 'case-bathroom',
    story: '#306',
    title: 'Vorgang mit mehreren Dokumenten anlegen',
    messages: ['Leg einen Vorgang „Badsanierung 2025“ an und nimm das Angebot, die E-Mails dazu und die Rechnung von Sanitär Meier auf.'],
    check: (c) => {
      const cs = created(c, 'cases').find((x) => /badsanierung/i.test(x.name));
      const members = cs
        ? newRelations(c)
            .filter((r) => [r.source, r.target].includes(cs.id))
            .map((r) => (r.source === cs.id ? r.target : r.source))
        : [];
      const inCase = BATH.filter((k) => members.includes(c.ids[k]!));
      return verdict(
        [Boolean(cs), 'kein Vorgang „Badsanierung“ angelegt'],
        [inCase.length >= 4, `nur ${inCase.length} der Dokumente im Vorgang`],
        archiveUnchanged(c),
      );
    },
  },
];
