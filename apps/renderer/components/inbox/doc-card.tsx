'use client';

import { useState } from 'react';
import { ChevronDown, EyeOff, FolderOpen, Loader2, RefreshCw, ShieldOff, ArchiveRestore, Ban, FileInput } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ConfidenceBadge } from '@/components/common/confidence';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Field } from '@/components/common/states';
import type { ArchiveEdit } from '@/components/common/archive-dialog';
import { call } from '@/lib/ipc';
import { formatBytes, formatDate } from '@/lib/format';
import { ARCHIVE_MODE_LABELS, LLM_STATUS_LABELS } from '@/lib/labels';
import { useRun } from '@/lib/use-run';
import type { DocRecord } from '@/lib/types';
import type { ArchiveMode } from '@archivist/shared';

const MODES: ArchiveMode[] = ['copy', 'move', 'index_only', 'ignore'];

function llmVariant(s: DocRecord['llmStatus']) {
  return s === 'analyzed' ? ('success' as const) : s === 'excluded' ? ('warning' as const) : s === 'pending' ? ('info' as const) : ('secondary' as const);
}

export function processingBadge(doc: DocRecord): { label: string; variant: 'secondary' | 'success' | 'warning' | 'danger' | 'info' } {
  if (doc.status === 'analyzing') return { label: 'Wird analysiert …', variant: 'info' };
  if (doc.status === 'quarantined') return { label: 'Nicht verarbeitet', variant: 'secondary' };
  switch (doc.processingStatus) {
    case 'pending':
      return { label: 'Wird verarbeitet', variant: 'info' };
    case 'extracted':
      return { label: 'Text gelesen', variant: 'success' };
    case 'partial':
      return { label: 'Nur teilweise lesbar', variant: 'warning' };
    case 'unsupported':
      return { label: 'Format nicht lesbar', variant: 'warning' };
    case 'failed':
      return { label: 'Verarbeitung fehlgeschlagen', variant: 'danger' };
  }
}

export interface DocCardProps {
  doc: DocRecord;
  edit: ArchiveEdit;
  onEdit: (e: ArchiveEdit) => void;
  selected: boolean;
  onSelect: (v: boolean) => void;
  onArchive: () => void;
  onChanged: () => void;
}

export function InboxDocCard({ doc, edit, onEdit, selected, onSelect, onArchive, onChanged }: DocCardProps) {
  const { run, busy } = useRun();
  const [showText, setShowText] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const quarantined = doc.status === 'quarantined';
  const proc = processingBadge(doc);
  const archivable = doc.status === 'staged' || doc.status === 'proposed';
  const p = doc.proposal;
  const set = <K extends keyof ArchiveEdit>(k: K, v: ArchiveEdit[K]) => onEdit({ ...edit, [k]: v });

  return (
    <li className="rounded-xl border bg-card p-4" data-testid="inbox-item" data-status={doc.status}>
      <div className="flex items-start gap-3">
        <Checkbox
          checked={selected}
          disabled={!archivable}
          onCheckedChange={(v) => onSelect(v === true)}
          aria-label={`${doc.title} auswählen`}
          className="mt-1"
          data-testid="inbox-select"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="break-words font-semibold leading-tight">{doc.title}</h3>
              <p className="mt-0.5 break-all text-xs text-muted-foreground">
                {doc.originalName} · {formatBytes(doc.size)}
                {doc.docType ? ` · ${doc.docType}` : ''} · {formatDate(doc.createdAt)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={llmVariant(doc.llmStatus)} data-testid="inbox-llm-status">
                {LLM_STATUS_LABELS[doc.llmStatus]}
              </Badge>
              <Badge variant={proc.variant} data-testid="inbox-processing-status">
                {doc.status === 'analyzing' && <Loader2 className="size-3 animate-spin" aria-hidden />}
                {proc.label}
              </Badge>
              {quarantined && (
                <Badge variant="danger" data-testid="inbox-quarantine-badge">
                  In Quarantäne
                </Badge>
              )}
              {doc.status === 'failed' && <Badge variant="danger">Fehlgeschlagen</Badge>}
              <ConfidenceBadge value={doc.confidence} />
            </div>
          </div>

          {doc.processingError && (
            <p className="mt-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive" data-testid="inbox-error">
              {quarantined && <span className="font-medium">Grund: </span>}
              {doc.processingError}
            </p>
          )}
          {quarantined && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="inbox-quarantine-note">
              <Ban className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              Die Datei wurde aus Sicherheitsgründen zurückgehalten und nicht gelesen. Prüfen Sie sie im Ordner, bevor Sie sie trotzdem importieren.
            </p>
          )}
          {doc.summary && <p className="mt-2 text-sm">{doc.summary}</p>}
          {doc.textPreview && (
            <div className="mt-2">
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                aria-expanded={showText}
                onClick={() => setShowText((v) => !v)}
              >
                <ChevronDown className={`size-3.5 transition-transform ${showText ? 'rotate-180' : ''}`} aria-hidden />
                Textvorschau ({doc.textLength.toLocaleString('de-DE')} Zeichen)
              </button>
              {showText && (
                <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">{doc.textPreview}</p>
              )}
            </div>
          )}

          {(p || doc.persons.length > 0 || doc.tags.length > 0 || doc.dates.length > 0) && (
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
              {(p?.persons ?? doc.persons).length > 0 && (
                <p>
                  <span className="font-medium">Personen: </span>
                  {(p?.persons ?? doc.persons).join(', ')}
                </p>
              )}
              {(p?.tags ?? doc.tags).length > 0 && (
                <p className="flex flex-wrap items-center gap-1">
                  <span className="font-medium">Schlagwörter: </span>
                  {(p?.tags ?? doc.tags).map((t) => (
                    <Badge key={t} variant="outline">
                      {t}
                    </Badge>
                  ))}
                </p>
              )}
              {doc.dates.length > 0 && (
                <p>
                  <span className="font-medium">Datumsangaben: </span>
                  {doc.dates.map((d) => formatDate(d, d)).join(', ')}
                </p>
              )}
              {p && p.possibleDecisions.length > 0 && (
                <div className="sm:col-span-2" data-testid="inbox-decisions">
                  <span className="font-medium">Mögliche Entscheidungen:</span>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {p.possibleDecisions.map((d, i) => (
                      <li key={`${i}-${d.title}`}>
                        <span className="text-foreground">{d.title}</span> – {d.decisionText}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {p && p.possibleOpenItems.length > 0 && (
                <div className="sm:col-span-2" data-testid="inbox-open-items">
                  <span className="font-medium">Mögliche offene Punkte:</span>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {p.possibleOpenItems.map((d, i) => (
                      <li key={`${i}-${d.title}`}>
                        <span className="text-foreground">{d.title}</span>
                        {d.dueAt ? ` (bis ${formatDate(d.dueAt, d.dueAt)})` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {p && (
            <div className="mt-3 rounded-lg bg-muted/50 p-3 text-xs" data-testid="inbox-proposal">
              <p>
                <span className="font-medium">Vorschlag: </span>
                <code>{p.location.categoryPath}</code>
                {p.location.fileName ? ` / ${p.location.fileName}` : ''}
                {p.location.newMainCategory && (
                  <Badge variant="warning" className="ml-2">
                    Neue Hauptkategorie
                  </Badge>
                )}
              </p>
              {p.location.rationale && <p className="mt-1 text-muted-foreground">{p.location.rationale}</p>}
              <p className="mt-1 text-muted-foreground">Analysiert {p.analyzedBy === 'llm' ? 'per KI' : 'lokal'}.</p>
            </div>
          )}

          {archivable && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Ablageort (Ordnerpfad)" htmlFor={`cat-${doc.id}`}>
                <Input
                  id={`cat-${doc.id}`}
                  value={edit.categoryPath}
                  onChange={(e) => set('categoryPath', e.target.value)}
                  placeholder="z. B. Arbeit/Projekte/Alpha"
                  data-testid="inbox-category"
                />
              </Field>
              <Field label="Dateiname" htmlFor={`fn-${doc.id}`}>
                <Input
                  id={`fn-${doc.id}`}
                  value={edit.fileName}
                  onChange={(e) => set('fileName', e.target.value)}
                  placeholder={doc.originalName}
                  data-testid="inbox-filename"
                />
              </Field>
              <Field label="Thema" htmlFor={`topic-${doc.id}`}>
                <Input id={`topic-${doc.id}`} value={edit.topic} onChange={(e) => set('topic', e.target.value)} data-testid="inbox-topic" />
              </Field>
              <Field label="Projekt" htmlFor={`proj-${doc.id}`}>
                <Input id={`proj-${doc.id}`} value={edit.project} onChange={(e) => set('project', e.target.value)} data-testid="inbox-project" />
              </Field>
              <Field label="Was soll mit der Datei passieren?" htmlFor={`mode-${doc.id}`} className="sm:col-span-2">
                <Select id={`mode-${doc.id}`} value={edit.mode} onChange={(e) => set('mode', e.target.value as ArchiveMode)} data-testid="inbox-mode">
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {ARCHIVE_MODE_LABELS[m]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {archivable && (
              <Button size="sm" onClick={onArchive} data-testid="inbox-archive" disabled={busy}>
                <ArchiveRestore aria-hidden /> Archivieren …
              </Button>
            )}
            {quarantined && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="inbox-quarantine-reveal"
                  onClick={() => void run(() => call('app:revealPath', { documentId: doc.id }), { errorTitle: 'Ordner konnte nicht geöffnet werden' })}
                >
                  <FolderOpen aria-hidden /> Ordner öffnen
                </Button>
                <Button size="sm" variant="outline" disabled={busy} data-testid="inbox-quarantine-release" onClick={() => setReleaseOpen(true)}>
                  <FileInput aria-hidden /> Trotzdem importieren …
                </Button>
              </>
            )}
            {doc.status !== 'analyzing' && !quarantined && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid="inbox-reprocess"
                onClick={async () => {
                  await run(() => call('documents:classify', { documentId: doc.id, allowLlm: doc.llmStatus !== 'excluded' }), {
                    success: 'Die Verarbeitung wurde gestartet.',
                  });
                  onChanged();
                }}
              >
                <RefreshCw aria-hidden /> Erneut verarbeiten
              </Button>
            )}
            {!quarantined && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid="inbox-exclude-llm"
                onClick={async () => {
                  const excluded = doc.llmStatus !== 'excluded';
                  await run(() => call('documents:setLlmExcluded', { id: doc.id, excluded }), {
                    success: excluded ? 'Wird nicht mehr extern analysiert.' : 'Externe Analyse wieder erlaubt.',
                  });
                  onChanged();
                }}
              >
                <ShieldOff aria-hidden /> {doc.llmStatus === 'excluded' ? 'Externe Analyse erlauben' : 'Von externer Analyse ausschließen'}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              data-testid="inbox-ignore"
              onClick={async () => {
                await run(() => call('documents:ignore', { id: doc.id }), { success: 'Dokument wird ignoriert.' });
                onChanged();
              }}
            >
              <EyeOff aria-hidden /> Ignorieren
            </Button>
          </div>
        </div>
      </div>
      {quarantined && (
        <ConfirmDialog
          open={releaseOpen}
          onOpenChange={setReleaseOpen}
          title="Datei trotzdem importieren?"
          description="Der Inhalt dieser Datei passt nicht zu ihrer Endung. Importieren Sie sie nur, wenn Sie der Datei vertrauen. Archivist liest und analysiert sie danach wie jede andere Datei."
          confirmLabel="Trotzdem importieren"
          destructive
          requireCheckbox="Ich habe die Datei geprüft und vertraue ihr."
          confirmTestId="inbox-quarantine-release-confirm"
          onConfirm={async () => {
            const ok = await run(() => call('documents:releaseQuarantine', { id: doc.id, confirmed: true }), {
              success: 'Die Datei wurde importiert und wird analysiert.',
              errorTitle: 'Import aus der Quarantäne fehlgeschlagen',
            });
            if (ok) {
              setReleaseOpen(false);
              onChanged();
            }
          }}
        >
          <p className="break-all rounded-md border bg-muted/50 p-3 text-xs">
            <span className="font-medium">{doc.originalName}</span>
            {doc.processingError ? ` – ${doc.processingError}` : ''}
          </p>
        </ConfirmDialog>
      )}
    </li>
  );
}
