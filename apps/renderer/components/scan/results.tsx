'use client';

import { useMemo, useState } from 'react';
import { Ban, ExternalLink, FolderX, Microscope } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState, ErrorNote, Loading, Notice } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, CheckboxField } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { call } from '@/lib/ipc';
import { LLM_STATUS_LABELS, SCAN_STATUS_LABELS } from '@/lib/labels';
import { formatBytes, formatDateTime, formatNumber } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { useSettings } from '@/lib/use-settings';
import type { ScanFileRecord } from '@/lib/types';
import type { ScanFileStatus } from '@archivist/shared';

function statusVariant(s: ScanFileStatus) {
  switch (s) {
    case 'new':
    case 'changed':
      return 'info' as const;
    case 'analyzed':
    case 'archived':
      return 'success' as const;
    case 'duplicate':
      return 'warning' as const;
    default:
      return 'secondary' as const;
  }
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}

export function ScanResults() {
  const [filter, setFilter] = useState<ScanFileStatus | ''>('');
  const { data, loading, error, refetch } = useQuery(
    'scanner:getResults',
    { ...(filter ? { status: filter } : {}), limit: 500 },
    { scopes: ['scanner', 'documents'], jobs: true },
  );
  const roots = useQuery('scanner:listDirectories', {}, { scopes: ['scanner'] });
  const { settings } = useSettings();
  const { run } = useRun();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [llmOk, setLlmOk] = useState(false);
  const [excluding, setExcluding] = useState<{ kind: 'file' | 'dir'; path: string } | null>(null);

  const files = data?.files ?? [];
  const summary = data?.lastSummary ?? null;
  const selectedFiles = useMemo(() => files.filter((f) => selected.has(f.id)), [files, selected]);
  const llmAllowedRoots = new Set((roots.data ?? []).filter((r) => r.llmAllowed).map((r) => r.id));
  const llmFiles = selectedFiles.filter((f) => llmAllowedRoots.has(f.rootId) && f.llmStatus !== 'excluded');
  const mode = settings?.privacy.llmMode ?? 'confirm';
  const toggle = (f: ScanFileRecord, v: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (v) next.add(f.id);
      else next.delete(f.id);
      return next;
    });

  return (
    <section aria-labelledby="scan-results" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="scan-results" className="text-base font-semibold">
          Gefundene Dateien
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-44">
            <Select
              value={filter}
              onChange={(e) => setFilter(e.target.value as ScanFileStatus | '')}
              aria-label="Status filtern"
              data-testid="scan-status-filter"
            >
              <option value="">Alle Status</option>
              {(Object.keys(SCAN_STATUS_LABELS) as ScanFileStatus[]).map((s) => (
                <option key={s} value={s}>
                  {SCAN_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
          <Button
            disabled={selectedFiles.length === 0}
            onClick={() => {
              setLlmOk(false);
              setAnalyzeOpen(true);
            }}
            data-testid="scan-analyze"
          >
            <Microscope aria-hidden /> Ausgewählte analysieren ({selectedFiles.length})
          </Button>
        </div>
      </div>

      {summary && (
        <Notice title="Letzte Suche" data-testid="scan-summary">
          {formatNumber(summary.scanned)} Dateien geprüft: <strong>{formatNumber(summary.newFiles)} neu</strong>, {formatNumber(summary.changedFiles)} geändert,{' '}
          {formatNumber(summary.unchanged)} unverändert, {formatNumber(summary.duplicates)} Duplikate, {formatNumber(summary.excluded)} ausgeschlossen,{' '}
          {formatNumber(summary.skipped)} übersprungen.
          {summary.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-destructive">
              {summary.errors.slice(0, 5).map((e, i) => (
                <li key={`${i}-${e}`}>{e}</li>
              ))}
              {summary.errors.length > 5 && <li>… und {summary.errors.length - 5} weitere</li>}
            </ul>
          )}
        </Notice>
      )}

      {error && !data && <ErrorNote error={error} onRetry={() => void refetch()} />}
      {!data && loading && <Loading />}
      {data && files.length === 0 && (
        <EmptyState
          title="Noch keine Dateien gefunden"
          description="Starten Sie oben eine Suche, nachdem Sie Verzeichnisse hinzugefügt und die Dokumentensuche aktiviert haben."
        />
      )}
      {files.length > 0 && (
        <div className="rounded-xl border bg-card">
          <Table data-testid="scan-results-table">
            <THead>
              <tr>
                <TH className="w-8">
                  <Checkbox
                    aria-label="Alle auswählen"
                    checked={selected.size > 0 && selected.size === files.length}
                    onCheckedChange={(v) => setSelected(v === true ? new Set(files.map((f) => f.id)) : new Set())}
                    data-testid="scan-select-all"
                  />
                </TH>
                <TH>Datei</TH>
                <TH>Status</TH>
                <TH>KI</TH>
                <TH>Größe</TH>
                <TH>Gesehen</TH>
                <TH>
                  <span className="sr-only">Aktionen</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {files.map((f) => (
                <TR key={f.id} data-testid="scan-file-row" data-status={f.status}>
                  <TD>
                    <Checkbox
                      checked={selected.has(f.id)}
                      onCheckedChange={(v) => toggle(f, v === true)}
                      aria-label={`${f.name} auswählen`}
                      data-testid="scan-file-checkbox"
                    />
                  </TD>
                  <TD className="max-w-sm">
                    <p className="truncate font-medium" title={f.name}>
                      {f.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" title={f.path}>
                      {f.path}
                    </p>
                  </TD>
                  <TD>
                    <Badge variant={statusVariant(f.status)} data-testid="scan-file-status">
                      {SCAN_STATUS_LABELS[f.status]}
                    </Badge>
                  </TD>
                  <TD>
                    <Badge variant="outline" data-testid="scan-file-llm">
                      {LLM_STATUS_LABELS[f.llmStatus]}
                    </Badge>
                  </TD>
                  <TD className="whitespace-nowrap">{formatBytes(f.size)}</TD>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(f.lastSeenAt)}</TD>
                  <TD className="whitespace-nowrap">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${f.name} öffnen`}
                      title="Datei öffnen"
                      onClick={() => void run(() => call('app:openScanFile', { scanFileId: f.id }), { errorTitle: 'Datei konnte nicht geöffnet werden' })}
                      data-testid="scan-file-open"
                    >
                      <ExternalLink aria-hidden />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${f.name} ausschließen`}
                      title="Diese Datei nie wieder anzeigen"
                      onClick={() => setExcluding({ kind: 'file', path: f.path })}
                      data-testid="scan-file-exclude"
                    >
                      <Ban aria-hidden />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Ordner von ${f.name} ausschließen`}
                      title="Den ganzen Ordner ausschließen"
                      onClick={() => setExcluding({ kind: 'dir', path: dirname(f.path) })}
                      data-testid="scan-dir-exclude"
                    >
                      <FolderX aria-hidden />
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      <ConfirmDialog
        open={analyzeOpen}
        onOpenChange={setAnalyzeOpen}
        title={`${selectedFiles.length} Datei${selectedFiles.length === 1 ? '' : 'en'} analysieren`}
        confirmLabel={llmOk ? 'Mit KI analysieren' : 'Nur lokal analysieren'}
        confirmTestId="scan-analyze-confirm"
        onConfirm={async () => {
          const out = await run(() => call('scanner:analyze', { fileIds: selectedFiles.map((f) => f.id), confirmLlm: llmOk }), {
            success: llmOk ? 'Analyse mit KI gestartet.' : 'Lokale Analyse gestartet.',
          });
          if (out) {
            setAnalyzeOpen(false);
            setSelected(new Set());
            void refetch();
          }
        }}
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>
            <strong>Lokal</strong> liest Archivist die Texte nur auf diesem Computer und schlägt einfache Zuordnungen vor. Dabei verlässt nichts Ihren Rechner.
          </p>
          <Notice tone="warning" title="Was bei einer KI-Analyse gesendet wird" data-testid="scan-llm-explain">
            <p>
              Der extrahierte <strong>Textinhalt</strong> der ausgewählten Dateien (gekürzt, erkannte Passwörter und Schlüssel werden maskiert) sowie Dateiname
              und Typ werden an den eingerichteten KI-Dienst
              {settings?.llm.baseUrl ? (
                <>
                  {' '}
                  (<code className="break-all">{settings.llm.baseUrl}</code>)
                </>
              ) : (
                ''
              )}{' '}
              gesendet. Die Originaldateien selbst werden nicht hochgeladen.
            </p>
            <p className="mt-1">
              {llmFiles.length} von {selectedFiles.length} Dateien dürfen laut Ihren Einstellungen an die KI gesendet werden
              {selectedFiles.length - llmFiles.length > 0 ? '; die übrigen werden nur lokal analysiert.' : '.'}
            </p>
            {mode === 'local_only' && (
              <p className="mt-1 font-medium text-foreground">Ihr Datenschutzmodus ist „Nur lokal“ – es wird nichts an die KI gesendet.</p>
            )}
          </Notice>
          <CheckboxField
            checked={llmOk}
            disabled={mode === 'local_only'}
            onCheckedChange={(v) => setLlmOk(v === true)}
            label="Ja, ich erlaube, dass die Textinhalte dieser Dateien an den KI-Dienst gesendet werden."
            data-testid="scan-llm-checkbox"
          />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={excluding !== null}
        onOpenChange={(o) => !o && setExcluding(null)}
        title={excluding?.kind === 'dir' ? 'Ordner ausschließen?' : 'Datei ausschließen?'}
        description={
          excluding?.kind === 'dir'
            ? 'Dateien in diesem Ordner werden bei künftigen Suchen nicht mehr angezeigt.'
            : 'Diese Datei wird bei künftigen Suchen nicht mehr angezeigt.'
        }
        confirmLabel="Ausschließen"
        onConfirm={async () => {
          if (!excluding) return;
          const ok = await run(() => call('scanner:exclude', excluding), { success: 'Ausschluss gespeichert.' });
          if (ok) {
            setExcluding(null);
            void refetch();
          }
        }}
      >
        {excluding && <code className="break-all rounded bg-muted px-2 py-1 text-xs">{excluding.path}</code>}
      </ConfirmDialog>
    </section>
  );
}
