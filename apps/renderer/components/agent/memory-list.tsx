'use client';

import { useMemo, useRef, useState } from 'react';
import { Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { MemoryInput, type MemoryEntry, type MemoryKind } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState, ErrorNote, Field, Loading } from '@/components/common/states';
import { Section } from '@/components/settings/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { call } from '@/lib/ipc';
import { formatDate } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { useToast } from '@/lib/toast';

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

const DATA_TEMPLATES: Partial<Record<MemoryKind, unknown>> = {
  rule: { when: { sender: 'Stadtwerke', docType: 'Rechnung' }, then: { folder: 'finanzen/energie' } },
  workflow: { steps: ['Alle Belege des Vorjahres sammeln', 'Auf Lücken prüfen'], parameters: [{ name: 'Jahr', description: '' }] },
};
const needsData = (k: MemoryKind) => k === 'rule' || k === 'workflow' || k === 'correction';

interface Draft {
  id: string | null;
  kind: MemoryKind;
  name: string;
  content: string;
  data: string;
}

function EntryDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const [d, setD] = useState(draft);
  const { run, busy } = useRun();
  let parsedData: unknown = undefined;
  let dataError: string | null = null;
  if (needsData(d.kind) || d.data.trim()) {
    try {
      parsedData = d.data.trim() ? JSON.parse(d.data) : undefined;
      if (needsData(d.kind) && parsedData === undefined) dataError = 'Bitte die Definition als JSON angeben.';
    } catch {
      dataError = 'Die Definition ist kein gültiges JSON.';
    }
  }
  const valid = d.name.trim() !== '' && d.content.trim() !== '' && dataError === null;

  async function submit() {
    const out = await run(
      () =>
        d.id
          ? call('agent:updateMemory', { id: d.id, name: d.name.trim(), content: d.content.trim(), ...(parsedData !== undefined ? { data: parsedData } : {}) })
          : call('agent:saveMemory', {
              kind: d.kind,
              name: d.name.trim(),
              content: d.content.trim(),
              enabled: true,
              ...(parsedData !== undefined ? { data: parsedData } : {}),
            }),
      { success: 'Gespeichert.', errorTitle: 'Speichern fehlgeschlagen' },
    );
    if (out) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="memory-dialog">
        <DialogHeader>
          <DialogTitle>{d.id ? 'Eintrag bearbeiten' : 'Neuer Eintrag'}</DialogTitle>
          <DialogDescription>Archivist gibt diesen Eintrag jedem Lauf mit, solange er eingeschaltet ist.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void submit();
          }}
        >
          {!d.id && (
            <Field label="Art" htmlFor="memory-kind">
              <Select
                id="memory-kind"
                value={d.kind}
                onChange={(e) => {
                  const kind = e.target.value as MemoryKind;
                  const tpl = DATA_TEMPLATES[kind];
                  setD({ ...d, kind, data: d.data.trim() || !tpl ? d.data : JSON.stringify(tpl, null, 2) });
                }}
              >
                <option value="preference">Vorliebe</option>
                <option value="fact">Wissen</option>
                <option value="rule">Regel</option>
                <option value="workflow">Ablauf</option>
              </Select>
            </Field>
          )}
          <Field label="Name" htmlFor="memory-name">
            <Input id="memory-name" value={d.name} maxLength={200} onChange={(e) => setD({ ...d, name: e.target.value })} data-testid="memory-name" />
          </Field>
          <Field label="Inhalt" htmlFor="memory-content">
            <Textarea
              id="memory-content"
              rows={3}
              maxLength={4000}
              value={d.content}
              onChange={(e) => setD({ ...d, content: e.target.value })}
              data-testid="memory-content"
            />
          </Field>
          {(needsData(d.kind) || d.data.trim()) && (
            <Field
              label="Definition (JSON)"
              htmlFor="memory-data"
              hint={
                d.kind === 'rule'
                  ? '„when“ (sender, docType, nameContains, ext, topic, textContains) → „then“ (folder, topic, project, tags, renamePattern)'
                  : undefined
              }
            >
              <Textarea id="memory-data" rows={6} className="font-mono text-xs" value={d.data} onChange={(e) => setD({ ...d, data: e.target.value })} />
            </Field>
          )}
          {dataError && (
            <p className="text-xs text-destructive" role="alert">
              {dataError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={!valid || busy} data-testid="memory-save">
              Speichern
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const entries = useMemo(() => (query.data ?? []) as Entry[], [query.data]);

  function exportJson() {
    const data = entries.map(({ kind, name, content, data: d, enabled }) => ({ kind, name, content, data: d ?? null, enabled }));
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'archivist-gelernt.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importJson(file: File) {
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      toast({ variant: 'error', title: 'Die Datei ist kein gültiges JSON.' });
      return;
    }
    const list = Array.isArray(raw) ? raw : [];
    let saved = 0;
    let skipped = 0;
    for (const item of list) {
      const parsed = MemoryInput.safeParse(
        item && typeof item === 'object' && (item as { data?: unknown }).data === null ? { ...item, data: undefined } : item,
      );
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const out = await run(() => call('agent:saveMemory', parsed.data), { errorTitle: `„${parsed.data.name}“ nicht übernommen` });
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
        <Button size="sm" onClick={() => setDraft({ id: null, kind: 'preference', name: '', content: '', data: '' })} data-testid="memory-new">
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
                <EntryRow
                  key={e.id}
                  entry={e}
                  onEdit={() =>
                    setDraft({ id: e.id, kind: e.kind, name: e.name, content: e.content, data: e.data == null ? '' : JSON.stringify(e.data, null, 2) })
                  }
                  onDelete={() => setDeleting(e)}
                />
              ))}
            </ul>
          </div>
        );
      })}
      {draft && <EntryDialog draft={draft} onClose={() => setDraft(null)} />}
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
