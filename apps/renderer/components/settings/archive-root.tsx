'use client';

import { useState } from 'react';
import { ArrowRightLeft, FolderInput, FolderOpen, Loader2, Truck, Undo2, X } from 'lucide-react';
import { ErrorNote, Field, Loading, Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress, ProgressIndeterminate } from '@/components/ui/progress';
import { formatBytes, formatDateTime } from '@/lib/format';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { IpcOutput } from '@archivist/shared';
import { Section } from './shared';

type Preview = IpcOutput<'archive:previewRootChange'>;
type Presence = Preview['atTarget'];

const MIGRATE_JOB = 'archive.migrateRoot';
const docs = (n: number) => `${n} ${n === 1 ? 'Dokument' : 'Dokumente'}`;
const unreachableOf = (p: Presence) => p.missing + p.different;

function Examples({ presence }: { presence: Presence }) {
  if (presence.examples.length === 0) return null;
  const rest = unreachableOf(presence) - presence.examples.length;
  return (
    <span>
      {' '}
      (z. B. {presence.examples.map((t) => `„${t}“`).join(', ')}
      {rest > 0 ? ` und ${rest} weitere` : ''})
    </span>
  );
}

function Blockers({ items, testId }: { items: string[]; testId: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="list-disc pl-5 text-xs text-destructive" data-testid={testId}>
      {items.map((b) => (
        <li key={b}>{b}</li>
      ))}
    </ul>
  );
}

/** Dialog with the three ways to change the archive root: move the archive, only change the path, or cancel. */
function ChangeRootDialog({ preview, onClose, onStarted }: { preview: Preview; onClose: () => void; onStarted: () => void }) {
  const { run, busy } = useRun();
  const [accept, setAccept] = useState(false);
  const affected = unreachableOf(preview.atTarget);
  const total = preview.atTarget.documents;
  const migrateBlocked = preview.migrate.blockers.length > 0;
  const pathOnlyBlocked = preview.pathOnlyBlockers.length > 0 || (affected > 0 && !accept);

  async function change(mode: 'migrate' | 'pathOnly') {
    const res = await run(() => call('archive:changeRoot', { root: preview.to, mode, confirmed: true, acceptMissing: mode === 'pathOnly' && accept }), {
      success: mode === 'migrate' ? 'Der Umzug des Archivs wurde gestartet.' : 'Archivpfad geändert.',
    });
    if (res) onStarted();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="archive-root-dialog" className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Archivordner ändern</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-1 text-sm">
              <span>
                Bisher: <code className="break-all">{preview.from}</code>
              </span>
              <span>
                Neu: <code className="break-all">{preview.to}</code>
              </span>
              <span>
                Archivierte Dokumente verweisen auf ihren Platz innerhalb des Archivordners. Damit sie erreichbar bleiben, müssen die Dateien auch im neuen
                Ordner liegen.
              </span>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="rounded-lg border p-3" data-testid="archive-root-option-migrate">
            <p className="flex items-center gap-2 font-medium">
              <Truck className="size-4" aria-hidden /> Archiv umziehen
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Kopiert {preview.migrate.files} {preview.migrate.files === 1 ? 'Datei' : 'Dateien'} ({formatBytes(preview.migrate.bytes)}) in den neuen Ordner,
              prüft jede Kopie per Prüfsumme und stellt erst danach um. Nichts wird überschrieben, der bisherige Ordner bleibt unverändert erhalten. Der
              Fortschritt wird hier angezeigt; der Umzug lässt sich danach rückgängig machen.
              {preview.migrate.alreadyPresent > 0 && ` ${preview.migrate.alreadyPresent} Dateien liegen dort bereits und werden nur geprüft.`}
            </p>
            <Blockers items={preview.migrate.blockers} testId="archive-root-migrate-blockers" />
            <Button className="mt-2" disabled={busy || migrateBlocked} onClick={() => void change('migrate')} data-testid="archive-root-migrate">
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Truck aria-hidden />} Archiv umziehen
            </Button>
          </div>

          <div className="rounded-lg border p-3" data-testid="archive-root-option-path">
            <p className="flex items-center gap-2 font-medium">
              <FolderInput className="size-4" aria-hidden /> Nur Pfad ändern (Dateien liegen schon dort)
            </p>
            {affected === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground" data-testid="archive-root-path-ok">
                {total === 0 ? 'Es gibt noch keine archivierten Dokumente.' : `Geprüft: Alle ${docs(total)} liegen im neuen Ordner an ihrem Platz.`}
              </p>
            ) : (
              <Notice tone="danger" title={`${affected} von ${docs(total)} nicht im neuen Ordner`} className="mt-2">
                <span data-testid="archive-root-path-warning">
                  {affected === 1 ? '1 archiviertes Dokument fehlt' : `${affected} archivierte Dokumente fehlen`} im neuen Ordner oder{' '}
                  {affected === 1 ? 'weicht' : 'weichen'} ab
                  <Examples presence={preview.atTarget} />. Wenn Sie trotzdem umstellen, {affected === 1 ? 'ist es' : 'sind sie'} nicht mehr erreichbar: Öffnen
                  schlägt fehl, und die Archivprüfung meldet {affected === 1 ? 'es' : 'sie'} als fehlend.
                </span>
              </Notice>
            )}
            <Blockers items={preview.pathOnlyBlockers} testId="archive-root-path-blockers" />
            {affected > 0 && preview.pathOnlyBlockers.length === 0 && (
              <CheckboxField
                className="mt-2"
                checked={accept}
                onCheckedChange={(v) => setAccept(v === true)}
                label={`Ich habe verstanden: ${docs(affected)} werden unerreichbar.`}
                data-testid="archive-root-accept"
              />
            )}
            <Button
              className="mt-2"
              variant={affected > 0 ? 'destructive' : 'outline'}
              disabled={busy || pathOnlyBlocked}
              onClick={() => void change('pathOnly')}
              data-testid="archive-root-path-only"
            >
              <ArrowRightLeft aria-hidden /> {affected > 0 ? 'Trotzdem nur Pfad ändern' : 'Nur Pfad ändern'}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy} data-testid="archive-root-cancel">
            <X aria-hidden /> Abbrechen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Settings section for the archive root: change it safely, follow a running move, see and undo the last change. */
export function ArchiveRootSection({ archiveRoot, reload }: { archiveRoot: string; reload: () => void }) {
  const { run, busy } = useRun();
  const [root, setRoot] = useState(archiveRoot);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [undoConflicts, setUndoConflicts] = useState<string[]>([]);
  const status = useQuery('archive:rootStatus', {}, { scopes: ['settings', 'documents', 'audit'], jobs: true });
  const jobs = useQuery('jobs:list', { limit: 50 }, { scopes: ['jobs'], jobs: true });
  const migration = jobs.data?.find((j) => j.type === MIGRATE_JOB && (j.status === 'pending' || j.status === 'running'));
  const lastMigration = jobs.data?.find((j) => j.type === MIGRATE_JOB);
  const target = root.trim();
  const st = status.data;

  async function openDialog() {
    const p = await run(() => call('archive:previewRootChange', { root: target }));
    if (p) setPreview(p);
  }

  async function undo(auditId: string) {
    const res = await run(() => call('audit:undo', { auditId }));
    if (!res) return;
    setUndoConflicts(res.conflicts);
    if (res.undone) reload();
  }

  return (
    <Section
      title="Archivordner"
      description="In diesen Ordner legt Archivist Ihre Dokumente ab. Beim Ändern können Sie das Archiv umziehen lassen oder nur den Pfad umstellen, wenn die Dateien schon dort liegen."
    >
      {st && unreachableOf(st.current) > 0 && (
        <Notice tone="danger" title={`${docs(unreachableOf(st.current))} nicht erreichbar`}>
          <span data-testid="archive-root-unreachable">
            Im aktuellen Archivordner {unreachableOf(st.current) === 1 ? 'fehlt' : 'fehlen'} {unreachableOf(st.current)} von {docs(st.current.documents)} oder{' '}
            {unreachableOf(st.current) === 1 ? 'weicht' : 'weichen'} ab
            <Examples presence={st.current} />. Legen Sie die Dateien dorthin oder stellen Sie den bisherigen Archivordner wieder her.
          </span>
        </Notice>
      )}
      {status.error && !st && <ErrorNote error={status.error} onRetry={() => void status.refetch()} />}

      <Field label="Pfad des Archivs" htmlFor="s-archive-root">
        <div className="flex gap-2">
          <Input id="s-archive-root" value={root} onChange={(e) => setRoot(e.target.value)} disabled={!!migration} data-testid="settings-archive-root" />
          <Button
            variant="outline"
            disabled={!!migration}
            onClick={async () => {
              const sel = await run(() => call('app:selectDirectory', { title: 'Archivordner wählen' }));
              if (sel?.path) setRoot(sel.path);
            }}
            data-testid="settings-archive-select"
          >
            <FolderOpen aria-hidden /> Wählen …
          </Button>
        </div>
      </Field>
      <div>
        <Button disabled={busy || !!migration || !target || target === archiveRoot} onClick={() => void openDialog()} data-testid="settings-archive-change">
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowRightLeft aria-hidden />} Archivordner ändern …
        </Button>
      </div>

      {migration && (
        <div className="flex flex-col gap-2 rounded-lg border p-3" data-testid="archive-root-progress">
          <p className="text-sm font-medium">{migration.label}</p>
          {migration.progress !== null ? (
            <Progress value={Math.round(migration.progress * 100)} aria-label="Fortschritt des Archivumzugs" />
          ) : (
            <ProgressIndeterminate />
          )}
          {migration.progressMessage && <p className="text-xs text-muted-foreground">{migration.progressMessage}</p>}
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={migration.cancelRequested}
              onClick={() => void run(() => call('jobs:cancel', { id: migration.id }), { success: 'Der Umzug wird abgebrochen.' })}
              data-testid="archive-root-progress-cancel"
            >
              <X aria-hidden /> Umzug abbrechen
            </Button>
          </div>
        </div>
      )}
      {!migration && lastMigration?.status === 'failed' && (!st?.lastChange || (lastMigration.finishedAt ?? '') > st.lastChange.at) && (
        <Notice tone="warning" title="Archivumzug fehlgeschlagen">
          {lastMigration.error} Der bisherige Archivordner bleibt aktiv.
        </Notice>
      )}

      {!st && status.loading && <Loading />}
      {st?.lastChange && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm" data-testid="archive-root-last-change">
          <p className="text-muted-foreground">
            Zuletzt geändert am {formatDateTime(st.lastChange.at)} ({st.lastChange.mode === 'migrate' ? 'umgezogen' : 'nur Pfad geändert'}): von{' '}
            <code className="break-all">{st.lastChange.from}</code> nach <code className="break-all">{st.lastChange.to}</code>
          </p>
          {st.lastChange.undoable && !migration && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void undo(st.lastChange!.auditId)} data-testid="archive-root-undo">
              <Undo2 aria-hidden /> Rückgängig
            </Button>
          )}
        </div>
      )}
      {undoConflicts.length > 0 && (
        <Notice tone="warning" title="Rückgängig machen nicht möglich">
          <ul className="list-disc pl-5" data-testid="archive-root-undo-conflicts">
            {undoConflicts.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Notice>
      )}

      {preview && (
        <ChangeRootDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onStarted={() => {
            setPreview(null);
            void jobs.refetch();
            void status.refetch();
            reload();
          }}
        />
      )}
    </Section>
  );
}
