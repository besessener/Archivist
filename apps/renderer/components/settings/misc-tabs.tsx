'use client';

import { useState } from 'react';
import { DatabaseBackup, HardDriveDownload, Loader2, Save } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState, ErrorNote, Field, Loading, Notice } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { call } from '@/lib/ipc';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { LOCAL_TIME, type BackupInfo } from '@archivist/shared';
import { Section, SwitchRow, useSaveSettings, type TabProps } from './shared';
import { PathText } from '@/components/common/path-text';

export function ProfileTab({ settings, reload }: TabProps) {
  const { save, busy } = useSaveSettings(reload);
  const [name, setName] = useState(settings.profile.name);
  const [nicknames, setNicknames] = useState(settings.profile.nicknames.join(', '));
  const list = nicknames
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return (
    <Section
      title="Über dich"
      description="Dein Name und deine Spitznamen helfen Archivist, „ich“, „mir“ und „mich“ im Chat sowie Erwähnungen deiner Person richtig zuzuordnen. Sie werden nur als Kontext für die Auswertung deiner Chat-Nachrichten verwendet."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="profile-name">
          <Input id="profile-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} data-testid="settings-profile-name" />
        </Field>
        <Field label="Spitznamen (durch Komma getrennt)" htmlFor="profile-nicknames">
          <Input id="profile-nicknames" value={nicknames} onChange={(e) => setNicknames(e.target.value)} data-testid="settings-profile-nicknames" />
        </Field>
      </div>
      <div>
        <Button disabled={busy} onClick={() => void save({ profile: { name: name.trim(), nicknames: list } })} data-testid="settings-save">
          <Save aria-hidden /> Speichern
        </Button>
      </div>
    </Section>
  );
}

export function NotificationsTab({ settings, reload }: TabProps) {
  const { save, busy } = useSaveSettings(reload);
  const [reminderTime, setReminderTime] = useState(settings.notifications.reminderTime);
  const validTime = LOCAL_TIME.test(reminderTime);
  return (
    <Section
      title="Benachrichtigungen"
      description="Hinweise erscheinen immer in der Glocke oben rechts. Zusätzlich kannst du Desktop-Hinweise deines Betriebssystems erhalten."
    >
      <Field label="Uhrzeit für Erinnerungen (Ortszeit)" htmlFor="reminder-time" hint="Erinnerungen für einen Tag ohne Uhrzeit erscheinen zu dieser Uhrzeit.">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="reminder-time"
            type="time"
            className="w-36"
            value={reminderTime}
            onChange={(e) => setReminderTime(e.target.value)}
            data-testid="settings-reminder-time"
          />
          <Button
            variant="outline"
            disabled={busy || !validTime || reminderTime === settings.notifications.reminderTime}
            onClick={() => void save({ notifications: { reminderTime } })}
            data-testid="settings-reminder-time-save"
          >
            <Save aria-hidden /> Speichern
          </Button>
        </div>
      </Field>
      <SwitchRow label="Desktop-Benachrichtigungen" hint="Zeigt wichtige Hinweise auch außerhalb des Programmfensters an.">
        <Switch
          checked={settings.notifications.desktop}
          onCheckedChange={(v) => void save({ notifications: { desktop: v } })}
          aria-label="Desktop-Benachrichtigungen"
          data-testid="settings-desktop-notifications"
        />
      </SwitchRow>
    </Section>
  );
}

export function LogsTab({ settings, reload }: TabProps) {
  const { save, busy } = useSaveSettings(reload);
  const [level, setLevel] = useState(settings.logs.level);
  const [days, setDays] = useState(String(settings.logs.retentionDays));
  return (
    <Section title="Protokolle" description="Technische Protokolle helfen bei der Fehlersuche. Inhalte deiner Dokumente werden dort nicht gespeichert.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Detailgrad" htmlFor="log-level">
          <Select id="log-level" value={level} onChange={(e) => setLevel(e.target.value as typeof level)} data-testid="settings-log-level">
            <option value="error">Nur Fehler</option>
            <option value="warn">Warnungen und Fehler</option>
            <option value="info">Normal</option>
            <option value="debug">Ausführlich (Fehlersuche)</option>
          </Select>
        </Field>
        <Field label="Aufbewahrung (Tage)" htmlFor="log-days">
          <Input id="log-days" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
      </div>
      <div>
        <Button
          disabled={busy || !(Number(days) >= 1)}
          onClick={() => void save({ logs: { level, retentionDays: Math.round(Number(days)) } })}
          data-testid="settings-save"
        >
          <Save aria-hidden /> Speichern
        </Button>
      </div>
    </Section>
  );
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
                    <Badge variant={b.kind === 'full' ? 'info' : 'secondary'}>{b.kind === 'full' ? 'Vollständig' : 'Nur Metadaten'}</Badge>
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
            Backup vom <strong>{formatDateTime(restoring.createdAt)}</strong> ({restoring.kind === 'full' ? 'vollständig' : 'nur Metadaten'})
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
