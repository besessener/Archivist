'use client';

import { Fragment, useState } from 'react';
import { FolderPlus, Save, Trash2 } from 'lucide-react';
import { EmptyState, ErrorNote, Field, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { call } from '@/lib/ipc';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { cn, parseList } from '@/lib/utils';
import { Section, useSaveSettings, type TabProps } from './shared';

type Mode = 'auto' | 'confirm' | 'local_only';
const MODES: Array<{ id: Mode; title: string; text: string }> = [
  { id: 'confirm', title: 'Vor jeder externen Analyse fragen', text: 'Dokumentinhalte gehen erst nach Ihrer Bestätigung an die KI.' },
  { id: 'auto', title: 'Automatisch analysieren', text: 'Inhalte werden ohne Rückfrage an die KI gesendet.' },
  { id: 'local_only', title: 'Nur lokal', text: 'Es wird nie etwas an die KI gesendet. Vorschläge sind weniger genau.' },
];

export function PrivacyTab({ settings, reload }: TabProps) {
  const { save, busy } = useSaveSettings(reload);
  const { run } = useRun();
  const [mode, setMode] = useState<Mode>(settings.privacy.llmMode);
  const [dirs, setDirs] = useState<string[]>(settings.privacy.neverAnalyzeDirs);
  const [exts, setExts] = useState(settings.privacy.neverAnalyzeExtensions.join(', '));
  const [files, setFiles] = useState(settings.privacy.neverAnalyzeFiles.join('\n'));
  const tx = useQuery('llm:transmissions', { limit: 100 }, { scopes: ['audit'] });
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <Section title="Datenschutzmodus" description="Legt fest, wann Dokumentinhalte an den KI-Dienst gesendet werden dürfen.">
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Datenschutzmodus</legend>
          {MODES.map((m) => (
            <label key={m.id} className={cn('flex cursor-pointer gap-3 rounded-lg border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring', mode === m.id ? 'border-primary bg-primary/8' : 'hover:bg-accent/50')}>
              <input type="radio" name="privacy-mode" className="mt-1 accent-[var(--primary)]" checked={mode === m.id} onChange={() => setMode(m.id)} data-testid={`settings-mode-${m.id}`} />
              <span>
                <span className="block text-sm font-medium">{m.title}</span>
                <span className="block text-sm text-muted-foreground">{m.text}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </Section>

      <Section title="Nie analysieren" description="Was hier steht, wird nie an die KI gesendet – unabhängig vom Modus.">
        <div>
          <p className="mb-1.5 text-sm font-medium">Verzeichnisse</p>
          <ul className="mb-2 flex flex-col gap-1.5">
            {dirs.map((d) => (
              <li key={d} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                <code className="min-w-0 flex-1 break-all text-xs">{d}</code>
                <Button size="icon-sm" variant="ghost" aria-label={`${d} entfernen`} onClick={() => setDirs((prev) => prev.filter((x) => x !== d))}>
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
            {dirs.length === 0 && <li className="text-sm text-muted-foreground">Keine Verzeichnisse.</li>}
          </ul>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const sel = await run(() => call('app:selectDirectory', { title: 'Verzeichnis, das nie analysiert werden soll' }));
              if (sel?.path) {
                const p = sel.path;
                setDirs((prev) => (prev.includes(p) ? prev : [...prev, p]));
              }
            }}
            data-testid="privacy-add-dir"
          >
            <FolderPlus aria-hidden /> Verzeichnis hinzufügen
          </Button>
        </div>
        <Field label="Dateitypen" htmlFor="p-exts" hint="Mit Komma trennen, z. B. xlsx, eml.">
          <Input id="p-exts" value={exts} onChange={(e) => setExts(e.target.value)} data-testid="privacy-exts" />
        </Field>
        <Field label="Einzelne Dateien" htmlFor="p-files" hint="Ein vollständiger Pfad pro Zeile.">
          <Textarea id="p-files" value={files} onChange={(e) => setFiles(e.target.value)} rows={3} data-testid="privacy-files" />
        </Field>
        <div>
          <Button
            disabled={busy}
            data-testid="settings-save"
            onClick={() =>
              void save({
                privacy: {
                  llmMode: mode,
                  neverAnalyzeDirs: dirs,
                  neverAnalyzeExtensions: parseList(exts).map((e) => e.replace(/^\./, '').toLowerCase()),
                  neverAnalyzeFiles: files.split('\n').map((s) => s.trim()).filter(Boolean),
                },
              })
            }
          >
            <Save aria-hidden /> Speichern
          </Button>
        </div>
      </Section>

      <Section title="An die KI übertragene Inhalte" description="Protokoll aller Übertragungen. „Maskiert“ zeigt, wie viele Geheimnisse (z. B. Passwörter) vor dem Senden unkenntlich gemacht wurden.">
        {tx.error && !tx.data && <ErrorNote error={tx.error} onRetry={() => void tx.refetch()} />}
        {!tx.data && tx.loading && <Loading />}
        {tx.data && tx.data.length === 0 && <EmptyState title="Noch nichts übertragen" description="Bisher wurden keine Inhalte an die KI gesendet." />}
        {tx.data && tx.data.length > 0 && (
          <Table data-testid="transmissions-table">
            <THead>
              <tr>
                <TH>Zeit</TH>
                <TH>Zweck</TH>
                <TH>Modell / Dienst</TH>
                <TH>Menge</TH>
                <TH>Maskiert</TH>
                <TH>Ergebnis</TH>
                <TH>
                  <span className="sr-only">Vorschau</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {tx.data.map((t) => (
                <Fragment key={t.id}>
                  <TR data-testid="transmission-row">
                    <TD className="whitespace-nowrap">{formatDateTime(t.at)}</TD>
                    <TD>{t.purpose}</TD>
                    <TD>
                      <span className="block">{t.model}</span>
                      <span className="block break-all text-xs text-muted-foreground">{t.endpoint}</span>
                    </TD>
                    <TD className="whitespace-nowrap">{formatBytes(t.bytes)}</TD>
                    <TD>{t.redactions}</TD>
                    <TD>{t.success ? <Badge variant="success">Gesendet</Badge> : <Badge variant="danger">Fehler</Badge>}</TD>
                    <TD>
                      <Button size="sm" variant="ghost" onClick={() => setOpen(open === t.id ? null : t.id)} aria-expanded={open === t.id}>
                        Vorschau
                      </Button>
                    </TD>
                  </TR>
                  {open === t.id && (
                    <tr>
                      <td colSpan={7} className="px-3 pb-3">
                        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">{t.preview || '(keine Vorschau)'}</p>
                        <p className="mt-1 text-xs text-muted-foreground">Betroffene Dokumente: {t.documentIds.length}</p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
    </div>
  );
}
