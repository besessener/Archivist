import type { DiagnosticsReport, EndpointCheck } from '../../services/diagnostics/diagnostics';
import { LOCAL_MODEL } from '../../services/embedding';
import { REMOTE_QUERY_EMBEDDING_TIMEOUT_MS } from '../../services/search';
import { asData } from '../security';

const MODE_LABEL = { auto: 'automatisch', confirm: 'vorher fragen', local_only: 'nur lokal' } as const;

const megabytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
const gigabytes = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(1)} GB`;

function endpointLines(endpoint: EndpointCheck): string[] {
  if (endpoint.state === 'skipped') return [`Embedding-Endpunkt: nicht geprüft – ${endpoint.reason}`];
  const limit = `Die Suche wartet höchstens ${REMOTE_QUERY_EMBEDDING_TIMEOUT_MS} ms auf die Anfrage-Einbettung; dauert sie länger, liefert sie nur lokale Treffer (Eintrag „Embedding endpoint did not answer in time“ im Protokoll).`;
  if (endpoint.state === 'failed') return [`Embedding-Endpunkt: Anfrage nach ${endpoint.ms} ms fehlgeschlagen – ${endpoint.message}`, limit];
  return [
    `Embedding-Endpunkt: antwortete nach ${endpoint.ms} ms (${endpoint.ms > REMOTE_QUERY_EMBEDDING_TIMEOUT_MS ? 'über' : 'unter'} dem Suchlimit).`,
    limit,
  ];
}

function embeddingLines({ models }: DiagnosticsReport): string[] {
  const rows = models.chunksByModel.map(
    ({ model, chunks }) => `  - ${model ?? 'ohne Vektor'}: ${chunks} Textabschnitte${model === LOCAL_MODEL ? ' (lokal)' : ''}`,
  );
  const current = models.embedding || null;
  const behind = models.chunksByModel.filter(({ model }) => model !== current).reduce((sum, { chunks }) => sum + chunks, 0);
  const note = current
    ? `${behind} Textabschnitte stammen nicht vom eingestellten Modell „${current}“.`
    : 'Kein Embedding-Modell eingestellt: Die Suche arbeitet lexikalisch und mit lokalen Vektoren.';
  return ['Textabschnitte je Embedding-Modell:', ...(rows.length ? rows : ['  - keine']), note];
}

/** Text for the model; job errors are outside text and therefore marked as data. */
export function diagnosticsText(report: DiagnosticsReport): string {
  const { environment, storage, models } = report;
  const jobs = report.failedJobs.map((job) =>
    job.detail
      ? `${job.finishedAt ?? '–'} ${job.type} (${job.attempts} Versuche) „${job.detail.label}“: ${job.detail.error || 'ohne Fehlertext'}`
      : `${job.finishedAt ?? '–'} ${job.type} (${job.attempts} Versuche): [nicht freigegeben]`,
  );
  return [
    `Umgebung: Archivist ${environment.appVersion}, Electron ${environment.electron ?? 'nicht vorhanden'}, Node ${environment.node}, ${environment.platform}`,
    `Datenordner: ${megabytes(storage.dataDirectoryBytes)}${storage.dataDirectoryComplete ? '' : ' (mindestens, Zählung abgebrochen)'}; freier Speicher: ${storage.freeDiskBytes === null ? 'nicht ermittelbar' : gigabytes(storage.freeDiskBytes)}`,
    `Datenbank: ${megabytes(storage.databaseBytes)}`,
    `Zeilen je Tabelle: ${report.tableRows.map(({ label, rows }) => `${label} ${rows}`).join(', ')}`,
    `LLM-Modell: ${models.llm || 'keins'} (${models.llmHost || 'keine Adresse'}); Embedding-Modell: ${models.embedding || 'keins'}`,
    ...embeddingLines(report),
    `Datenschutzmodus: ${MODE_LABEL[report.privacyMode]}`,
    ...endpointLines(report.endpoint),
    jobs.length ? `Letzte fehlgeschlagene Aufträge:\n${asData('Aufträge', jobs.join('\n'))}` : 'Keine fehlgeschlagenen Aufträge.',
  ].join('\n');
}
