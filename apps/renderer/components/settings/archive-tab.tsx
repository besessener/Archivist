'use client';

import { useState } from 'react';
import { Loader2, Plus, ShieldCheck } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ErrorNote, Field, Loading, Notice } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { IpcOutput } from '@archivist/shared';
import { ArchiveRootSection } from './archive-root';
import { Section, SwitchRow, useSaveSettings, type TabProps } from './shared';
import { TrashSection } from './trash-section';

export function ArchiveTab({ settings, reload }: TabProps) {
  const { save, busy } = useSaveSettings(reload);
  const { run, busy: runBusy } = useRun();
  const categories = useQuery('categories:list', {}, { scopes: ['knowledge', 'settings', 'documents'] });
  const [newCat, setNewCat] = useState('');
  const [confirmCat, setConfirmCat] = useState(false);
  const [report, setReport] = useState<IpcOutput<'archive:verify'> | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [staleDays, setStaleDays] = useState(String(settings.consistency.staleOpenItemDays));
  const [intervalH, setIntervalH] = useState(String(settings.consistency.intervalHours));

  async function verify() {
    setVerifying(true);
    const r = await run(() => call('archive:verify'));
    if (r) setReport(r);
    setVerifying(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <ArchiveRootSection archiveRoot={settings.archiveRoot} reload={reload} />

      <Section
        title="Kategorien"
        description="Ordnerstruktur, in die Dokumente einsortiert werden können. Neue Kategorien werden erst nach deiner Bestätigung angelegt."
      >
        {categories.error && !categories.data && <ErrorNote error={categories.error} onRetry={() => void categories.refetch()} />}
        {!categories.data && categories.loading && <Loading />}
        <ul className="flex flex-wrap gap-1.5" data-testid="category-list">
          {(categories.data ?? []).map((c) => (
            <li key={c.id}>
              <Badge variant={c.approved ? 'secondary' : 'warning'}>
                {c.path}
                {!c.approved && ' (nicht bestätigt)'}
              </Badge>
            </li>
          ))}
          {categories.data && categories.data.length === 0 && <li className="text-sm text-muted-foreground">Noch keine Kategorien.</li>}
        </ul>
        <div className="flex gap-2">
          <Input
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            placeholder="Neue Kategorie, z. B. Arbeit/Verträge"
            aria-label="Neue Kategorie"
            data-testid="category-new"
          />
          <Button variant="outline" disabled={!newCat.trim()} onClick={() => setConfirmCat(true)} data-testid="category-create">
            <Plus aria-hidden /> Anlegen …
          </Button>
        </div>
      </Section>

      <Section title="Archivzustand" description="Prüft, ob alle archivierten Dateien noch an ihrem Platz und unverändert sind.">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void verify()} disabled={verifying} data-testid="archive-verify">
            {verifying ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />} Archivzustand prüfen
          </Button>
          <Button
            variant="outline"
            disabled={runBusy}
            data-testid="settings-consistency-run"
            onClick={() => void run(() => call('consistency:run'), { success: 'Archivprüfung gestartet.' })}
          >
            Archivprüfung starten
          </Button>
        </div>
        {report && (
          <div data-testid="verify-report" className="flex flex-col gap-2 text-sm">
            <Notice tone={report.ok ? 'info' : 'warning'} title={report.ok ? 'Alles in Ordnung' : 'Es gibt Abweichungen'}>
              {report.checkedDocuments} Dokumente geprüft.
            </Notice>
            {report.missingFiles.length > 0 && (
              <div>
                <p className="font-medium">Fehlende Dateien ({report.missingFiles.length})</p>
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {report.missingFiles.map((f) => (
                    <li key={f.documentId}>
                      {f.title} – <code className="break-all">{f.path}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.changedFiles.length > 0 && (
              <div>
                <p className="font-medium">Veränderte Dateien ({report.changedFiles.length})</p>
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {report.changedFiles.map((f) => (
                    <li key={f.documentId}>
                      {f.title} – <code className="break-all">{f.path}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.untrackedFiles.length > 0 && (
              <div>
                <p className="font-medium">Dateien im Archiv, die Archivist nicht kennt ({report.untrackedFiles.length})</p>
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {report.untrackedFiles.map((f) => (
                    <li key={f}>
                      <code className="break-all">{f}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
          <SwitchRow label="Beim Start prüfen" hint="Automatische Archivprüfung beim Programmstart.">
            <Switch
              checked={settings.consistency.onStartup}
              onCheckedChange={(v) => void save({ consistency: { onStartup: v } })}
              aria-label="Beim Start prüfen"
            />
          </SwitchRow>
          <SwitchRow
            label="Personen-Dubletten automatisch zusammenführen"
            hint="Eindeutig gleiche Personen („Monika Lor-Zade (Chefin)“ = „Lor-Zade, Monika“) führt die Archivprüfung ohne Rückfrage zusammen – rückgängig machbar."
          >
            <Switch
              checked={settings.consistency.autoMergePersons}
              onCheckedChange={(v) => void save({ consistency: { autoMergePersons: v } })}
              aria-label="Personen-Dubletten automatisch zusammenführen"
              data-testid="settings-auto-merge-persons"
            />
          </SwitchRow>
          <SwitchRow label="Texterkennung in Bildern (OCR)" hint="Liest Text aus Bildern und gescannten PDFs – lokal, ohne Internet.">
            <Switch checked={settings.ocr.enabled} onCheckedChange={(v) => void save({ ocr: { enabled: v } })} aria-label="OCR" data-testid="settings-ocr" />
          </SwitchRow>
          <Field label="Prüfung alle … Stunden" htmlFor="s-interval-h" hint="0 = nur beim Start / manuell.">
            <Input id="s-interval-h" type="number" min={0} value={intervalH} onChange={(e) => setIntervalH(e.target.value)} />
          </Field>
          <Field label="Offene Punkte gelten als vergessen nach … Tagen" htmlFor="s-stale">
            <Input id="s-stale" type="number" min={1} value={staleDays} onChange={(e) => setStaleDays(e.target.value)} />
          </Field>
          <div>
            <Button
              variant="outline"
              disabled={busy || !(Number(intervalH) >= 0) || !(Number(staleDays) >= 1)}
              onClick={() => void save({ consistency: { intervalHours: Number(intervalH), staleOpenItemDays: Math.round(Number(staleDays)) } })}
            >
              Prüfintervalle speichern
            </Button>
          </div>
        </div>
      </Section>

      <TrashSection />

      <ConfirmDialog
        open={confirmCat}
        onOpenChange={setConfirmCat}
        title="Neue Kategorie anlegen?"
        description="Dabei wird im Archiv ein neuer Ordner vorgesehen."
        confirmLabel="Kategorie anlegen"
        confirmTestId="category-confirm"
        onConfirm={async () => {
          const c = await run(() => call('categories:create', { path: newCat.trim(), confirmed: true }), { success: 'Kategorie angelegt.' });
          if (c) {
            setNewCat('');
            setConfirmCat(false);
            void categories.refetch();
          }
        }}
      >
        <code className="break-all rounded bg-muted px-2 py-1 text-sm">{newCat.trim()}</code>
      </ConfirmDialog>
    </div>
  );
}
