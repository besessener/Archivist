'use client';

import { Loader2, ScanSearch } from 'lucide-react';
import { ScanDirectories } from '@/components/scan/directories';
import { ScanExclusions } from '@/components/scan/exclusions';
import { ScanProposals } from '@/components/scan/proposals';
import { ScanResults } from '@/components/scan/results';
import { Page, PageHeader } from '@/components/common/page-header';
import { ErrorNote, Field, Loading, Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import { useSettings } from '@/lib/use-settings';
import { useState } from 'react';
import type { SettingsPatch } from '@archivist/shared';

export default function ScanPage() {
  const { settings, loading, error, refetch } = useSettings();
  const { run, busy } = useRun();
  const [starting, setStarting] = useState(false);
  const [interval, setIntervalValue] = useState<string | null>(null);

  async function patch(p: SettingsPatch, success?: string) {
    await run(() => call('settings:update', p), success ? { success } : {});
    void refetch();
  }

  async function start() {
    setStarting(true);
    await run(() => call('scanner:start', {}), { success: 'Die Suche läuft. Den Fortschritt sehen Sie oben unter „Verarbeitung“.' });
    setStarting(false);
  }

  if (error && !settings)
    return (
      <Page>
        <ErrorNote error={error} onRetry={() => void refetch()} />
      </Page>
    );
  if (!settings) return <Page>{loading ? <Loading /> : null}</Page>;
  const scan = settings.scan;

  return (
    <Page wide>
      <PageHeader
        title="Scan"
        description="Archivist kann Ordner auf diesem Computer nach neuen Dokumenten durchsuchen. Es wird nie etwas verändert, ohne dass Sie zustimmen."
      />
      <div className="flex flex-col gap-8">
        <Card>
          <CardContent className="flex flex-col gap-4 pt-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <label htmlFor="scan-enable" className="text-sm font-semibold">
                  Lokale Dokumentensuche aktivieren
                </label>
                <p className="text-sm text-muted-foreground">
                  Standardmäßig ist die Suche <strong>ausgeschaltet</strong>. Wenn Sie sie einschalten, durchsucht Archivist die unten gewählten Ordner – aber
                  nur, solange die App läuft.
                </p>
              </div>
              <Switch
                id="scan-enable"
                checked={scan.enabled}
                onCheckedChange={(v) => void patch({ scan: { enabled: v } }, v ? 'Dokumentensuche aktiviert.' : 'Dokumentensuche ausgeschaltet.')}
                data-testid="scan-enable"
              />
            </div>
            {!scan.enabled && (
              <Notice tone="warning" data-testid="scan-disabled-hint">
                Die Dokumentensuche ist derzeit ausgeschaltet. Es wird nichts durchsucht.
              </Notice>
            )}
            <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Beim Start der App suchen</p>
                  <p className="text-xs text-muted-foreground">Einmal nach jedem Programmstart.</p>
                </div>
                <Switch
                  checked={scan.onStartup}
                  onCheckedChange={(v) => void patch({ scan: { onStartup: v } })}
                  aria-label="Beim Start der App suchen"
                  data-testid="scan-onstartup"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Regelmäßig suchen</p>
                  <p className="text-xs text-muted-foreground">Während die App läuft.</p>
                </div>
                <Switch
                  checked={scan.periodic}
                  onCheckedChange={(v) => void patch({ scan: { periodic: v } })}
                  aria-label="Regelmäßig suchen"
                  data-testid="scan-periodic"
                />
              </div>
              {scan.periodic && (
                <Field label="Abstand in Minuten" htmlFor="scan-interval" hint="Mindestens 5 Minuten.">
                  <div className="flex gap-2">
                    <Input
                      id="scan-interval"
                      type="number"
                      min={5}
                      value={interval ?? String(scan.intervalMinutes)}
                      onChange={(e) => setIntervalValue(e.target.value)}
                      data-testid="scan-interval"
                      className="max-w-32"
                    />
                    <Button
                      variant="outline"
                      disabled={busy || interval === null || !(Number(interval) >= 5)}
                      onClick={async () => {
                        await patch({ scan: { intervalMinutes: Math.round(Number(interval)) } }, 'Abstand gespeichert.');
                        setIntervalValue(null);
                      }}
                    >
                      Speichern
                    </Button>
                  </div>
                </Field>
              )}
            </div>
            <div className="border-t pt-4">
              <Button onClick={() => void start()} disabled={starting} data-testid="scan-start">
                {starting ? <Loader2 className="animate-spin" aria-hidden /> : <ScanSearch aria-hidden />} Jetzt nach neuen Dokumenten suchen
              </Button>
            </div>
          </CardContent>
        </Card>

        <ScanDirectories />
        <ScanResults />
        <ScanProposals />
        <ScanExclusions />
      </div>
    </Page>
  );
}
