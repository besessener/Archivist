const KIND_LABELS: Record<string, string> = {
  orphan_document: 'Dokumente ohne Zuordnung',
  missing_metadata: 'fehlende Metadaten',
  duplicate: 'mögliche Duplikate',
  duplicate_note: 'doppelte Notizen',
  duplicate_event: 'doppelte Ereignisse',
  misplaced_file: 'Ablageort-Auffälligkeiten',
  scattered_documents: 'verstreut abgelegte Dokumente',
  similar_topics: 'ähnliche Themen',
  topic_project_name: 'gleiche Namen bei Thema und Projekt',
  similar_entities: 'mögliche Dubletten',
  incomplete_decision: 'unvollständige Entscheidungen',
  possibly_superseded: 'möglicherweise überholte Entscheidungen',
  contradiction: 'Widersprüche',
  open_item: 'offene Punkte mit Handlungsbedarf',
  outdated_info: 'widersprüchliche Status',
  low_confidence_relation: 'ungeklärte Beziehungen',
  external_file: 'externe Dateien mit Archivbezug',
  duplicate_open_item: 'doppelte offene Punkte',
  persons_merged: 'automatisch zusammengeführte Personen-Einträge',
  unclear_person: 'unklare Personen-Zuordnungen',
  orphan_entries: 'Einträge ohne Verknüpfung',
  topic_cluster: 'Vorschläge für neue Themen',
  relation_refinement: 'genauere Arten von Verknüpfungen',
};

/** Key prefixes of the hints this check owns; a hint whose cause no longer exists is closed after each run. */
export const RECONCILED_INSIGHTS = [
  'missing-topic',
  'missing-category',
  'dup:',
  'missing-file:',
  'changed-file:',
  'missing-source:',
  'misplaced:',
  'incomplete-decision:',
  'superseded:',
  'stale:',
  'open-closed:',
  'low-rel',
  'external:',
];
export const RECONCILED_NOTIFICATIONS = ['dup:', 'incomplete-decision:', 'no-owner:', 'no-due:', 'overdue:', 'due:'];

export interface RunSummary {
  total: number;
  /** All hints of the run by kind, e.g. „3 Hinweis(e): 2× Widersprüche, …“. */
  overview: string;
  /** Short German summary for the job history. */
  summary: string;
}

/** The German summary of a run from its hints per kind and the number of new findings (pure). */
export function summarize(run: { byKind: Record<string, number>; newFindings: number }): RunSummary {
  const { byKind, newFindings } = run;
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  const overview =
    total === 0
      ? 'keine Auffälligkeiten'
      : `${total} Hinweis(e): ${Object.entries(byKind)
          .map(([kind, n]) => `${n}× ${KIND_LABELS[kind] ?? kind}`)
          .join(', ')}`;
  const news = newFindings === 0 ? 'Nichts Neues' : newFindings === 1 ? '1 neuer Hinweis' : `${newFindings} neue Hinweise`;
  return { total, overview, summary: `${news} – ${overview}.` };
}
