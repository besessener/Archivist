import { z } from 'zod';
import { defineTool, list, type AgentTool } from '../registry';
import type { ToolDeps } from './common';
import { mailThreadsReport, problemFilesReport, secretsReport, similarFilingsReport, storageReport } from './research/archive-reports';
import { compareReport } from './research/compare';
import { deadlinesReport, gapsReport, paymentsReport, sumAmountsReport } from './research/document-reports';

const docsArg = list.describe('Dokument-IDs (D…) oder Ergebnismengen (S…)');

/** Research tools (#309, #310, #312): everything is computed deterministically – the model only reads the result. */
export function researchTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'sum_amounts',
      description:
        'Summiert Rechnungs- bzw. Belegbeträge mehrerer Dokumente deterministisch (Gesamt/Summe/Total-Zeile, sonst größter Betrag). Liefert Belegliste mit Fundstelle, Summe, Anzahl und Dokumente ohne Betrag. Rechne nie selbst nach – übernimm die Summe.',
      schema: z.object({ documents: docsArg }),
      risk: 'read',
      label: (a) => `Summiere Beträge aus ${a.documents.length} Angabe(n)`,
      run: (a, ctx) => sumAmountsReport({ deps, ctx }, a.documents),
    }),
    defineTool({
      name: 'find_gaps',
      description:
        'Findet Lücken in einer Serie (z. B. Kontoauszüge, Gehaltsabrechnungen): by="month" prüft die Monate zwischen erstem und letztem Dokument, by="number" die laufenden Nummern aus Titel/Dateiname („Nr. 12“, „Auszug 3“, „2025-07“).',
      schema: z.object({ documents: docsArg, by: z.enum(['month', 'number']).default('month') }),
      risk: 'read',
      label: (a) => `Suche Lücken (${a.by === 'month' ? 'Monate' : 'Nummern'})`,
      run: (a, ctx) => gapsReport({ deps, ctx }, a),
    }),
    defineTool({
      name: 'compare_documents',
      description:
        'Vergleicht Dokumente zeilenweise (z. B. Vertragsfassungen): Tabelle der geänderten Zeilen („alt → neu“ mit Fundstelle), dazu was nur in A und nur in B steht. Mit „weitere“ wird A mit jedem weiteren Dokument verglichen. Alle müssen freigegeben sein.',
      schema: z.object({ a: z.string().min(1), b: z.string().min(1), weitere: list.nullish().describe('weitere D…, jeweils mit A verglichen') }),
      risk: 'read',
      label: (a) => `Vergleiche ${2 + (a.weitere?.length ?? 0)} Dokumente`,
      run: (a, ctx) => compareReport({ deps, ctx }, a),
    }),
    defineTool({
      name: 'find_deadlines',
      description:
        'Erkennt Fristen und Ablaufdaten (Kündigung, Garantie, Ausweis, Versicherung, TÜV/HU, Widerspruch, Ablauf, Fälligkeit) mit Fundstelle und Rechenweg. Nennt, ob für das Dokument schon eine Erinnerung besteht („Erinnerung vorhanden“ – dann keine zweite anlegen).',
      schema: z.object({ documents: docsArg }),
      risk: 'read',
      label: () => 'Suche Fristen und Ablaufdaten',
      run: (a, ctx) => deadlinesReport({ deps, ctx }, a.documents),
    }),
    defineTool({
      name: 'find_secrets',
      description:
        'Prüft Dokumente lokal auf Passwörter, Zugangsdaten, PINs, IBANs und API-Schlüssel. Nennt je Dokument nur Arten und Anzahl, nie die Werte. Ohne Angabe: alle archivierten Dokumente.',
      schema: z.object({ documents: list.nullish().describe('D…/S…; leer = alle archivierten') }),
      risk: 'read',
      label: () => 'Suche nach Passwörtern und Zugangsdaten',
      run: (a, ctx) => secretsReport({ deps, ctx }, a.documents),
    }),
    defineTool({
      name: 'problem_files',
      description:
        'Problemdateien: fehlgeschlagene oder in Quarantäne gelegte Dokumente, verschlüsselte PDFs, Endung passt nicht zum Inhalt, lesbare Dateien ohne Text – mit Erklärung.',
      schema: z.object({}),
      risk: 'read',
      label: () => 'Suche Problemdateien',
      run: (_a, ctx) => problemFilesReport({ deps, ctx }),
    }),
    defineTool({
      name: 'storage_report',
      description: 'Speicherbericht: größte Dateien, exakte Duplikate (verschwendeter Platz), alte Dokumente ohne Verknüpfungen. Nur Hinweise, ändert nichts.',
      schema: z.object({}),
      risk: 'read',
      label: () => 'Erstelle einen Speicherbericht',
      run: (_a, ctx) => storageReport({ deps, ctx }),
    }),
    defineTool({
      name: 'email_threads',
      description: 'Gruppiert E-Mails (.eml) nach Betreff (ohne Re:/AW:/WG:/Fwd:) zu Verläufen mit mindestens zwei Nachrichten, chronologisch.',
      schema: z.object({ documents: list.nullish().describe('D…/S…; leer = alle .eml-Dateien') }),
      risk: 'read',
      label: () => 'Fasse E-Mails zu Verläufen zusammen',
      run: (a, ctx) => mailThreadsReport({ deps, ctx }, a.documents),
    }),
    defineTool({
      name: 'match_payments',
      description:
        'Gleicht Rechnungen mit Kontoauszügen ab: Zahlung mit gleichem Betrag (±0,01) 0–90 Tage nach Rechnungsdatum oder mit der Rechnungsnummer im Verwendungszweck. Liefert bezahlte und offene Rechnungen sowie Zahlungen ohne Rechnung.',
      schema: z.object({ statements: list.describe('Kontoauszüge (D…/S…)'), invoices: list.describe('Rechnungen (D…/S…)') }),
      risk: 'read',
      label: () => 'Gleiche Rechnungen mit Zahlungen ab',
      run: (a, ctx) => paymentsReport({ deps, ctx }, a),
    }),
    defineTool({
      name: 'similar_filings',
      description:
        'Beispiele, wie der Benutzer ähnliche Dokumente (gleicher Typ, gleiche Personen, ähnlicher Titel) abgelegt hat – mit Ordner. Nur Beispiele als Orientierung, keine Regel.',
      schema: z.object({ document: z.string().min(1) }),
      risk: 'read',
      label: () => 'Suche Beispiele ähnlich abgelegter Dokumente',
      run: (a, ctx) => similarFilingsReport({ deps, ctx }, a.document),
    }),
  ];
}
