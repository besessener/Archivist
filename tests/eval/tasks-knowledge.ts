import fs from 'node:fs';
import { archiveUnchanged, avoids, created, docAfter, mentions, moneyForms, onlyChanged, readOnly, usedTool, verdict, type EvalTask } from './checks';
import { DATES, dateForms } from './fixture';

export const KNOWLEDGE_TASKS: EvalTask[] = [
  // #307 knowledge
  {
    id: 'reminder-explicit',
    story: '#307',
    title: 'Erinnerung mit genanntem Datum',
    messages: [`Erinnere mich am ${dateForms(DATES.inThreeWeeks)[0]} an die Steuererklärung.`],
    check: (c) => {
      const r = created(c, 'reminders').find((x) => x.remindAt.startsWith(DATES.inThreeWeeks));
      return verdict(
        [Boolean(r), `keine Erinnerung am ${DATES.inThreeWeeks}`],
        [/steuer/i.test(r?.title ?? ''), 'Titel nennt die Steuererklärung nicht'],
        archiveUnchanged(c),
      );
    },
  },
  {
    id: 'decision-record',
    story: '#307',
    title: 'Entscheidung festhalten',
    messages: ['Halte fest: Wir haben entschieden, das Bad im Frühjahr 2026 komplett zu sanieren und das Angebot von Sanitär Meier anzunehmen.'],
    check: (c) => {
      const d = created(c, 'decisions');
      return verdict([d.some((x) => /bad|meier/i.test(`${x.title} ${x.text}`)), 'keine Entscheidung zur Badsanierung erfasst'], archiveUnchanged(c));
    },
  },
  {
    id: 'open-item-record',
    story: '#307',
    title: 'Offenen Punkt mit Frist erfassen',
    messages: [`Ich muss noch die Nebenkostenabrechnung prüfen, spätestens bis ${dateForms(DATES.inTenDays)[0]}.`],
    check: (c) => {
      const o = created(c, 'openItems').find((x) => /nebenkosten/i.test(x.title));
      return verdict(
        [Boolean(o), 'kein offener Punkt „Nebenkosten…“'],
        [o?.dueAt?.startsWith(DATES.inTenDays) ?? false, `Fälligkeit ${o?.dueAt ?? '–'} statt ${DATES.inTenDays}`],
        archiveUnchanged(c),
      );
    },
  },
  {
    id: 'note-record',
    story: '#307',
    title: 'Notiz erfassen',
    messages: ['Notiz: Der Hausmeister heißt Herr Kowalski, seine Telefonnummer hängt im Flur.'],
    check: (c) =>
      verdict([created(c, 'notes').some((n) => /kowalski/i.test(`${n.name} ${n.description}`)), 'keine Notiz zu Herrn Kowalski'], archiveUnchanged(c)),
  },
  {
    id: 'reminders-notice-periods',
    story: '#307',
    title: '„Leg zu allen Kündigungsfristen Erinnerungen an“ – je Vertrag rechtzeitig vor der Frist',
    messages: ['Leg zu allen Kündigungsfristen Erinnerungen an.'],
    check: (c) => {
      const fresh = created(c, 'reminders');
      const expect: Array<[key: string, deadline: string, re: RegExp]> = [
        ['mietvertrag-2026', DATES.leaseNewNotice, /miet/i],
        ['hausrat-schreiben', DATES.insuranceNotice, /hausrat|versicherung/i],
        ['mobilfunkvertrag', DATES.mobileNotice, /mobil|handy|funk/i],
      ];
      const missing = expect.filter(
        ([key, deadline, re]) =>
          !fresh.some((r) => (r.targetId === c.ids[key] || re.test(r.title)) && r.remindAt.slice(0, 10) <= deadline && r.remindAt.slice(0, 10) >= DATES.today),
      );
      return verdict(
        [missing.length === 0, `keine rechtzeitige Erinnerung für ${missing.map(([k, d]) => `${k} (Frist ${d})`).join(', ')}`],
        archiveUnchanged(c),
      );
    },
  },

  // #308 duplicates and versions
  {
    id: 'find-duplicates',
    story: '#308',
    title: 'Duplikate finden, ohne etwas zu ändern',
    messages: ['Habe ich doppelte Dokumente im Archiv?'],
    check: (c) => verdict(...readOnly(c), mentions(c, ['Garantiebedingungen'], 'die doppelten Garantiebedingungen')),
  },
  {
    id: 'mark-duplicates',
    story: '#308',
    title: 'Duplikat markieren, nichts löschen',
    messages: ['Markiere die doppelten Garantiebedingungen als Duplikat, lösche aber nichts.'],
    check: (c) => {
      const keys = ['garantie-bedingungen', 'garantie-bedingungen-kopie'];
      const marked = keys.filter((k) => docAfter(c, k).tags.some((t) => /duplikat/i.test(t)));
      return verdict(
        [keys.every((k) => c.after.docs[c.ids[k]!]), 'ein Dokument wurde gelöscht'],
        [marked.length === 1, `${marked.length} statt genau eines als Duplikat markiert`],
        onlyChanged(c, keys, ['tags', 'archiveRelPath']),
      );
    },
  },
  {
    id: 'versions-current',
    story: '#308',
    title: 'Aktuelle Fassung unter Versionen erkennen',
    messages: ['Welche Fassung des Angebots zur Badsanierung ist die aktuelle, und was kostet sie?'],
    check: (c) => verdict(...readOnly(c), mentions(c, ['final'], 'die finale Fassung'), mentions(c, moneyForms(3095.5), '3.095,50 €')),
  },

  // #309 research
  {
    id: 'sum-craftsmen-2025',
    story: '#309',
    title: '„Wie viel habe ich 2025 für Handwerker ausgegeben?“ – deterministische Summe',
    messages: ['Wie viel habe ich 2025 für Handwerker ausgegeben?'],
    check: (c) => verdict(...readOnly(c), mentions(c, moneyForms(2485.4), '2.485,40 €'), avoids(c, moneyForms(4585.4), 'die Summe inklusive 2024')),
  },
  {
    id: 'missing-statement',
    story: '#309',
    title: '„Fehlt ein Kontoauszug?“ – Lücke im Mai 2025',
    messages: ['Fehlt ein Kontoauszug?'],
    check: (c) => verdict(...readOnly(c), mentions(c, ['Mai', '2025-05', '05/2025', '05.2025'], 'Mai 2025')),
  },
  {
    id: 'unpaid-invoices',
    story: '#309',
    title: 'Rechnungen mit Kontoauszügen abgleichen',
    messages: ['Welche Handwerkerrechnungen aus 2025 sind laut meinen Kontoauszügen noch nicht bezahlt?'],
    check: (c) => verdict(...readOnly(c), mentions(c, ['Wagner', 'Elektro'], 'die Rechnung von Elektro Wagner')),
  },
  {
    id: 'compare-leases',
    story: '#309',
    title: 'Zwei Vertragsfassungen vergleichen',
    messages: ['Was hat sich im neuen Mietvertrag gegenüber dem alten geändert?'],
    check: (c) => verdict(...readOnly(c), mentions(c, ['890'], 'die neue Miete 890 €'), mentions(c, dateForms(DATES.leaseNewEnd), 'das neue Vertragsende')),
  },

  // #310 deadlines
  {
    id: 'lease-deadline',
    story: '#310',
    title: '„Wann muss ich den Mietvertrag spätestens kündigen?“ – Frist aus der neuen Fassung',
    messages: ['Wann muss ich den Mietvertrag spätestens kündigen?'],
    check: (c) => verdict(...readOnly(c), mentions(c, dateForms(DATES.leaseNewNotice), `den ${dateForms(DATES.leaseNewNotice)[0]}`)),
  },
  {
    id: 'warranty-end',
    story: '#310',
    title: 'Garantieende aus relativer Frist',
    messages: ['Bis wann habe ich Garantie auf die Waschmaschine?'],
    check: (c) => verdict(...readOnly(c), mentions(c, dateForms(DATES.washerWarrantyEnd), dateForms(DATES.washerWarrantyEnd)[0])),
  },
  {
    id: 'upcoming-deadlines',
    story: '#310',
    title: 'Fristen der nächsten drei Monate',
    messages: ['Welche Fristen laufen in den nächsten drei Monaten ab?'],
    check: (c) => verdict(...readOnly(c), mentions(c, ['Hausrat'], 'die Hausratversicherung'), mentions(c, ['Ausweis'], 'den Personalausweis')),
  },

  // #311 results
  {
    id: 'export-csv',
    story: '#311',
    title: 'CSV-Liste mit Datum und Betrag',
    messages: ['Erstelle mir eine CSV-Liste aller Handwerkerrechnungen mit Datum und Betrag.'],
    check: (c) => {
      const csv = c.files.find((f) => f.toLowerCase().endsWith('.csv') && fs.existsSync(f));
      const text = csv ? fs.readFileSync(csv, 'utf8') : '';
      return verdict(
        [Boolean(csv), 'keine CSV-Datei erzeugt'],
        [/1\.?250[,.]00/.test(text) && /845[,.]50/.test(text), 'CSV ohne die Beträge'],
        archiveUnchanged(c),
      );
    },
  },
  {
    id: 'bundle-tax',
    story: '#311',
    title: 'Mappe für die Steuer (Kopien, Archiv unverändert)',
    messages: ['Stell mir für die Steuer eine Mappe mit allen Handwerkerrechnungen aus 2025 zusammen.'],
    check: (c) => verdict([c.files.length > 0, 'keine Mappe erzeugt'], archiveUnchanged(c)),
  },
  {
    id: 'draft-reply',
    story: '#311',
    title: 'Antwortentwurf, nichts wird versendet',
    messages: ['Schreib mir einen Antwortentwurf auf die letzte E-Mail von Sanitär Meier: Ich nehme die finale Fassung des Angebots an.'],
    check: (c) => verdict(usedTool(c, ['draft_reply']), [c.files.some((f) => f.endsWith('.md')), 'kein Entwurf als Datei'], archiveUnchanged(c)),
  },
];
