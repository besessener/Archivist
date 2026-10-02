'use client';

import { useState } from 'react';
import { DatabaseBackup, HardDriveDownload, Loader2, Save, Undo2 } from 'lucide-react';
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
import { LOCAL_TIME, type AuditEntry } from '@archivist/shared';
import { Section, SwitchRow, useSaveSettings, type TabProps } from './shared';

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

  async function create(includeArchive: boolean) {
    setCreating(includeArchive ? 'full' : 'metadata');
    const b = await run(() => call('backup:create', { includeArchive }), {
      success: includeArchive ? 'Vollständiges Backup erstellt.' : 'Metadaten-Backup erstellt.',
    });
    setCreating(null);
    if (b) void list.refetch();
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
            <Button variant="outline" disabled={creating !== null} onClick={() => void create(false)} data-testid="backup-metadata">
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
            <Button variant="outline" disabled={creating !== null} onClick={() => void create(true)} data-testid="backup-full">
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
                  <TD className="break-all text-xs text-muted-foreground">{b.path}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

export function AuditTab() {
  const { data, loading, error, refetch } = useQuery('audit:list', { limit: 200, onlyUndoable: false }, { scopes: ['audit', 'documents'] });
  const { run } = useRun();
  const [undoing, setUndoing] = useState<AuditEntry | null>(null);
  const [results, setResults] = useState<Record<string, { message: string; conflicts: string[]; undone: boolean }>>({});

  return (
    <Section
      title="Änderungsprotokoll"
      description="Jede Änderung, die Archivist an deinen Daten oder Dateien vornimmt, wird hier festgehalten. Manche Änderungen lassen sich rückgängig machen."
    >
      {error && !data && <ErrorNote error={error} onRetry={() => void refetch()} />}
      {!data && loading && <Loading />}
      {data && data.length === 0 && <EmptyState title="Noch keine Einträge" />}
      {data && data.length > 0 && (
        <Table data-testid="audit-table">
          <THead>
            <tr>
              <TH>Zeit</TH>
              <TH>Aktion</TH>
              <TH>Wer</TH>
              <TH>Pfade</TH>
              <TH>Ergebnis</TH>
              <TH>
                <span className="sr-only">Rückgängig</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {data.map((a) => {
              const r = results[a.id];
              return (
                <TR key={a.id} data-testid="audit-row">
                  <TD className="whitespace-nowrap">{formatDateTime(a.at)}</TD>
                  <TD>
                    {a.action}
                    {!a.confirmed && a.actor === 'agent' && <span className="block text-xs text-muted-foreground">ohne Rückfrage</span>}
                  </TD>
                  <TD>{a.actor === 'user' ? 'Du' : 'Archivist'}</TD>
                  <TD className="max-w-xs">
                    {a.paths.slice(0, 3).map((p) => (
                      <code key={p} className="block break-all text-xs">
                        {p}
                      </code>
                    ))}
                    {a.paths.length > 3 && <span className="text-xs text-muted-foreground">… und {a.paths.length - 3} weitere</span>}
                  </TD>
                  <TD>
                    {a.success ? <Badge variant="success">Erfolgreich</Badge> : <Badge variant="danger">Fehler</Badge>}
                    {a.error && <span className="mt-1 block max-w-48 break-words text-xs text-destructive">{a.error}</span>}
                    {a.undoneAt && <span className="mt-1 block text-xs text-muted-foreground">Rückgängig gemacht am {formatDateTime(a.undoneAt)}</span>}
                    {r && (
                      <span className="mt-1 block text-xs">
                        {r.message}
                        {r.conflicts.length > 0 && (
                          <ul className="list-disc pl-4 text-destructive" data-testid="audit-undo-conflicts">
                            {r.conflicts.map((c) => (
                              <li key={c}>{c}</li>
                            ))}
                          </ul>
                        )}
                      </span>
                    )}
                  </TD>
                  <TD>
                    {a.undoable && !a.undoneAt && !r?.undone && (
                      <Button size="sm" variant="outline" onClick={() => setUndoing(a)} data-testid="audit-undo">
                        <Undo2 aria-hidden /> Rückgängig
                      </Button>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      <ConfirmDialog
        open={undoing !== null}
        onOpenChange={(o) => !o && setUndoing(null)}
        title="Änderung rückgängig machen?"
        description="Archivist versucht, den Zustand vor dieser Aktion wiederherzustellen. Falls sich Dateien inzwischen geändert haben, werden Konflikte angezeigt."
        confirmLabel="Rückgängig machen"
        confirmTestId="audit-undo-confirm"
        onConfirm={async () => {
          if (!undoing) return;
          const result = await run(() => call('audit:undo', { auditId: undoing.id }));
          if (result) {
            setResults((prev) => ({ ...prev, [undoing.id]: result }));
            setUndoing(null);
            void refetch();
          }
        }}
      >
        {undoing && (
          <div className="text-sm">
            <p className="font-medium">{undoing.action}</p>
            {undoing.paths.map((p) => (
              <code key={p} className="block break-all text-xs text-muted-foreground">
                {p}
              </code>
            ))}
          </div>
        )}
      </ConfirmDialog>
      {data?.some((a) => !a.success) && (
        <Notice tone="warning">Fehlgeschlagene Aktionen haben keine Änderungen hinterlassen, soweit nicht anders vermerkt.</Notice>
      )}
    </Section>
  );
}
