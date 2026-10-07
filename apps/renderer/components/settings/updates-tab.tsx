'use client';

import { Download, RefreshCw, RotateCw } from 'lucide-react';
import type { UpdateStatus } from '@archivist/shared';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import { useUpdateStatus } from '@/lib/use-update-status';
import { Section, SwitchRow, useSaveSettings, type TabProps } from './shared';

function describe(status: UpdateStatus | undefined): string {
  if (!status) return 'Wird geladen …';
  switch (status.state) {
    case 'unsupported':
      return status.reason;
    case 'idle':
      return 'Noch nicht geprüft.';
    case 'checking':
      return 'Suche nach Updates …';
    case 'upToDate':
      return 'Du hast die neueste Version.';
    case 'available':
      return `Version ${status.version} ist verfügbar.`;
    case 'downloading':
      return `Version ${status.version} wird heruntergeladen (${status.percent} %) …`;
    case 'downloaded':
      return `Version ${status.version} ist heruntergeladen und bereit zur Installation.`;
    case 'error':
      return status.message;
  }
}

export function UpdatesTab({ settings, reload }: TabProps) {
  const { save, busy: saving } = useSaveSettings(reload);
  const { run, busy } = useRun();
  const status = useUpdateStatus();
  const state = status?.state;
  const working = busy || state === 'checking' || state === 'downloading';
  return (
    <Section
      title="Updates"
      description="Archivist sucht auf GitHub nach neuen Versionen (Releases). Dabei wird nur deine aktuelle Version übertragen, keine Daten aus deinem Archiv. Heruntergeladen und installiert wird erst, wenn du es bestätigst."
    >
      <p className="text-sm" role="status" data-testid="settings-update-status">
        {describe(status)}
      </p>
      {state !== 'unsupported' && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={working || state === 'available' || state === 'downloaded'}
            onClick={() => void run(() => call('update:check'))}
            data-testid="settings-update-check"
          >
            <RefreshCw aria-hidden /> Nach Updates suchen
          </Button>
          {state === 'available' && (
            <Button disabled={working} onClick={() => void run(() => call('update:download', { confirmed: true }))} data-testid="settings-update-download">
              <Download aria-hidden /> Herunterladen
            </Button>
          )}
          {state === 'downloaded' && (
            <Button disabled={working} onClick={() => void run(() => call('update:install', { confirmed: true }))} data-testid="settings-update-install">
              <RotateCw aria-hidden /> Jetzt installieren und neu starten
            </Button>
          )}
        </div>
      )}
      {state !== 'unsupported' && (
        <SwitchRow
          label="Beim Start nach Updates suchen"
          hint="Fragt bei jedem Start bei GitHub nach einer neueren Version. Ausgeschaltet suchst du nur von Hand."
        >
          <Switch
            checked={settings.updates.checkOnStartup}
            disabled={saving}
            onCheckedChange={(v) => void save({ updates: { checkOnStartup: v } })}
            aria-label="Beim Start nach Updates suchen"
            data-testid="settings-update-startup"
          />
        </SwitchRow>
      )}
    </Section>
  );
}
