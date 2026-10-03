'use client';

import { useMemo, useRef, useState } from 'react';
import { Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import type { MemoryEntry, MemoryKind } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { Section } from '@/components/settings/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { call } from '@/lib/ipc';
import { formatDate } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { useToast } from '@/lib/toast';
import { MemoryEntryDialog } from './memory-entry-dialog';
import { draftOf, exportMemory, MEMORY_EXPORT_FILE, newDraft, parseMemoryImport, type MemoryDraft } from './memory-forms';

type Entry = Omit<MemoryEntry, 'data'> & { data?: unknown };

const KINDS: Array<[MemoryKind, string, string]> = [
  ['rule', 'Regeln', 'Bedingung → Aktion, z. B. „Rechnungen der Stadtwerke immer nach finanzen/energie“.'],
  ['workflow', 'Abläufe', 'Wiederkehrende Abläufe in Schritten.'],
  ['correction', 'Korrekturen', 'Was Archivist aus deinen Korrekturen gelernt hat.'],
  ['preference', 'Vorlieben', 'Wie du Dinge haben möchtest.'],
  ['fact', 'Wissen', 'Fakten, die Archivist sich merken soll.'],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l])) as Record<MemoryKind, string>;
const ORIGIN_LABEL: Record<MemoryEntry['origin'], string> = { user: 'von dir', correction: 'aus einer Korrektur', confirmed: 'von dir bestätigt' };

function EntryRow({ entry, onEdit, onDelete }: { entry: Entry; onEdit: () => void; onDelete: () => void }) {
  const { run, busy } = useRun();
  return (
    <li className="flex items-start gap-3 rounded-lg border bg-background p-3" data-testid="memory-entry">
      <Switch
        className="mt-0.5"
        checked={entry.enabled}
        disabled={busy}
        aria-label={`${entry.name} verwenden`}
        onCheckedChange={(v) => void run(() => call('agent:updateMemory', { id: entry.id, enabled: v }), { errorTitle: 'Ändern fehlgeschlagen' })}
      />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {entry.name}
          {!entry.enabled && <Badge variant="secondary">aus</Badge>}
        </p>
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{entry.content}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {ORIGIN_LABEL[entry.origin]} · {entry.timesApplied}× angewendet
          {entry.lastAppliedAt ? `, zuletzt am ${formatDate(entry.lastAppliedAt)}` : ''}
        </p>
      </div>
      <Button size="icon-sm" variant="ghost" aria-label={`${entry.name} bearbeiten`} onClick={onEdit}>
        <Pencil aria-hidden />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label={`${entry.name} löschen`} onClick={onDelete}>
        <Trash2 aria-hidden />
      </Button>
    </li>
  );
}

/** What Archivist has learned (#315): rules, workflows, corrections, preferences and knowledge. */
export function AgentMemoryList() {
  const query = useQuery('agent:memory', {}, { scopes: ['agent'] });
  const { run } = useRun();
  const { toast } = useToast();
  const [draft, setDraft] = useState<MemoryDraft | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const entries = useMemo(() => (query.data ?? []) as Entry[], [query.data]);

  function exportJson() {
    const url = URL.createObjectURL(new Blob([exportMemory(entries)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = MEMORY_EXPORT_FILE;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importJson(file: File) {
    const parsed = parseMemoryImport(await file.text());
    if (!parsed.ok) {
      toast({ variant: 'error', title: parsed.error });
      return;
    }
    let saved = 0;
    let skipped = parsed.value.skipped;
    for (const item of parsed.value.items) {
      const out = await run(() => call('agent:saveMemory', item), { errorTitle: `„${item.name}“ nicht übernommen` });
      if (out) saved += 1;
      else skipped += 1;
    }
    toast({ variant: saved > 0 ? 'success' : 'error', title: `${saved} Einträge übernommen${skipped ? `, ${skipped} übersprungen` : ''}.` });
  }

  return (
    <Section
      title="Was Archivist gelernt hat"
      description="Regeln, Abläufe, Korrekturen, Vorlieben und Wissen. Ausgeschaltete Einträge bleiben gespeichert, werden aber nicht verwendet."
    >
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setDraft(newDraft())} data-testid="memory-new">
          <Plus aria-hidden /> Neu
        </Button>
        <Button size="sm" variant="outline" onClick={exportJson} disabled={entries.length === 0}>
          <Download aria-hidden /> Exportieren
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload aria-hidden /> Importieren
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          tabIndex={-1}
          aria-label="Gelernte Einträge importieren (JSON)"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importJson(f);
          }}
        />
      </div>
      {query.error && <ErrorNote error={query.error} onRetry={() => void query.refetch()} />}
      {!query.data && query.loading && <Loading />}
      {query.data && entries.length === 0 && (
        <EmptyState title="Noch nichts gelernt" description="Sag im Chat z. B. „Merk dir: …“ oder korrigiere eine Ablage – Archivist lernt daraus." />
      )}
      {KINDS.map(([kind, label, hint]) => {
        const group = entries.filter((e) => e.kind === kind);
        if (group.length === 0) return null;
        return (
          <div key={kind} data-testid={`memory-group-${kind}`}>
            <h3 className="text-sm font-semibold">
              {label} <span className="font-normal text-muted-foreground">({group.length})</span>
            </h3>
            <p className="text-xs text-muted-foreground">{hint}</p>
            <ul className="mt-2 flex flex-col gap-2">
              {group.map((e) => (
                <EntryRow key={e.id} entry={e} onEdit={() => setDraft(draftOf(e))} onDelete={() => setDeleting(e)} />
              ))}
            </ul>
          </div>
        );
      })}
      {draft && <MemoryEntryDialog draft={draft} onClose={() => setDraft(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Eintrag löschen?"
        description={deleting ? `„${deleting.name}“ (${KIND_LABEL[deleting.kind]}) wird endgültig gelöscht. Ausschalten behält ihn.` : undefined}
        confirmLabel="Löschen"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const out = await run(() => call('agent:deleteMemory', { id: deleting.id }), { success: 'Gelöscht.', errorTitle: 'Löschen fehlgeschlagen' });
          if (out) setDeleting(null);
        }}
      />
    </Section>
  );
}
