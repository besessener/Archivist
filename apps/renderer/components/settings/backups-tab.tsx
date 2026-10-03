'use client';

import { useState } from 'react';
import { DatabaseBackup, HardDriveDownload, Loader2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { PathText } from '@/components/common/path-text';
import { EmptyState, ErrorNote, Field, Loading, Notice } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { call } from '@/lib/ipc';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { BackupInfo } from '@archivist/shared';
import { Section, SwitchRow, useSaveSettings, type TabProps } from './shared';

const BADGE_VARIANTS = { full: 'info', metadata: 'secondary', before_restore: 'warning' } as const;

function kindLabel(backup: BackupInfo): string {
  if (backup.kind === 'before_restore') return `Stand vor der Wiederherstellung vom ${formatDateTime(backup.createdAt)}`;
  return backup.kind === 'full' ? 'Vollständig' : 'Nur Metadaten';
}

export function BackupsTab({ settings, reload }: TabProps) {
  const { save } = useSaveSettings(reload);
  const { run } = useRun();
  const list = useQuery('backup:list', {}, { scopes: ['settings', 'audit'] });
  const [creating, setCreating] = useState<'metadata' | 'full' | null>(null);
  const [keep, setKeep] = useState(String(settings.backups.keep));
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [restartPending, setRestartPending] = useState(false);

  async function create({ includeArchive }: { includeArchive: boolean }) {
    setCreating(includeArchive ? 'full' : 'metadata');
    const backup = await run(() => call('backup:create', { includeArchive }), {
      success: includeArchive ? 'Vollständiges Backup erstellt.' : 'Metadaten-Backup erstellt.',
    });
    setCreating(null);
    if (backup) void list.refetch();
  }

  return (
    <div className="flex flex-col gap-4">
      <Section title="Backup erstellen">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <p className="flex items-center gap-2 font-medium">
              <DatabaseBackup className="size-4 text-primary" aria-hidden /> Metadaten-Backup
            </p>
            <p className="text-sm text-muted-foreground">
              Sichert Entscheidungen, offene Punkte, Wissen und Einstellungen – <strong>nicht</strong> deine Dokumentdateien. Klein und schnell.
            </p>
            <Button
              variant="outline"
              className="mt-auto"
              disabled={creating !== null}
              onClick={() => void create({ includeArchive: false })}
              data-testid="backup-metadata"
            >
              {creating === 'metadata' && <Loader2 className="animate-spin" aria-hidden />} Metadaten sichern
            </Button>
          </div>
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <p className="flex items-center gap-2 font-medium">
              <HardDriveDownload className="size-4 text-primary" aria-hidden /> Vollständiges Archiv-Backup
            </p>
            <p className="text-sm text-muted-foreground">
              Sichert zusätzlich alle archivierten Dokumentdateien. Kann viel Speicherplatz brauchen und länger dauern.
            </p>
            <Button
              variant="outline"
              className="mt-auto"
              disabled={creating !== null}
              onClick={() => void create({ includeArchive: true })}
              data-testid="backup-full"
            >
              {creating === 'full' && <Loader2 className="animate-spin" aria-hidden />} Alles sichern
            </Button>
          </div>
        </div>
      </Section>
      <Section title="Optionen">
        <SwitchRow label="Beim Start automatisch sichern">
          <Switch
            checked={settings.backups.autoOnStartup}
            onCheckedChange={(v) => void save({ backups: { autoOnStartup: v } })}
            aria-label="Beim Start automatisch sichern"
          />
        </SwitchRow>
        <SwitchRow label="Automatische Backups enthalten das Archiv" hint="Sonst nur Metadaten.">
          <Switch
            checked={settings.backups.includeArchive}
            onCheckedChange={(v) => void save({ backups: { includeArchive: v } })}
            aria-label="Automatische Backups enthalten das Archiv"
          />
        </SwitchRow>
        <div className="flex items-end gap-2">
          <Field label="Anzahl aufbewahrter Backups" htmlFor="bk-keep">
            <Input id="bk-keep" type="number" min={1} value={keep} onChange={(e) => setKeep(e.target.value)} className="w-32" />
          </Field>
          <Button variant="outline" disabled={!(Number(keep) >= 1)} onClick={() => void save({ backups: { keep: Math.round(Number(keep)) } })}>
            Speichern
          </Button>
        </div>
      </Section>
      <Section title="Vorhandene Backups">
        {restartPending && (
          <Notice tone="info" data-testid="backup-restart-notice">
            Die Wiederherstellung ist vorbereitet. Archivist startet neu und setzt das Backup beim Start ein.
          </Notice>
        )}
        {list.error && !list.data && <ErrorNote error={list.error} onRetry={() => void list.refetch()} />}
        {!list.data && list.loading && <Loading />}
        {list.data && list.data.length === 0 && <EmptyState title="Noch keine Backups" />}
        {list.data && list.data.length > 0 && (
          <Table data-testid="backup-table">
            <THead>
              <tr>
                <TH>Erstellt</TH>
                <TH>Art</TH>
                <TH>Größe</TH>
                <TH>Ort</TH>
                <TH>
                  <span className="sr-only">Wiederherstellen</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {list.data.map((b) => (
                <TR key={b.path} data-testid="backup-row">
                  <TD className="whitespace-nowrap">{formatDateTime(b.createdAt)}</TD>
                  <TD>
                    <Badge variant={BADGE_VARIANTS[b.kind]}>{kindLabel(b)}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap">{formatBytes(b.sizeBytes)}</TD>
                  <TD className="text-xs text-muted-foreground">
                    <PathText path={b.path} />
                  </TD>
                  <TD>
                    <Button variant="outline" size="sm" disabled={restartPending} onClick={() => setRestoring(b)} data-testid="backup-restore">
                      Wiederherstellen
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(o) => !o && setRestoring(null)}
        title="Backup wiederherstellen?"
        description="Archivist ersetzt die aktuelle Datenbank durch den Stand dieses Backups und startet neu. Änderungen seit diesem Backup gehen in der Datenbank verloren; die bisherige Datenbank bleibt im Datenordner erhalten. Dateien in deinem Archivordner werden nicht gelöscht."
        confirmLabel="Wiederherstellen und neu starten"
        confirmTestId="backup-restore-confirm"
        destructive
        onConfirm={async () => {
          if (!restoring) return;
          const result = await run(() => call('backup:restore', { name: restoring.name, confirmed: true }), {
            success: 'Wiederherstellung vorbereitet.',
          });
          if (result) {
            setRestoring(null);
            setRestartPending(true);
          }
        }}
      >
        {restoring && (
          <p className="text-sm">
            {restoring.kind === 'before_restore' ? (
              <>
                Stand vor der Wiederherstellung vom <strong>{formatDateTime(restoring.createdAt)}</strong>
              </>
            ) : (
              <>
                Backup vom <strong>{formatDateTime(restoring.createdAt)}</strong> ({kindLabel(restoring).toLowerCase()})
              </>
            )}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
