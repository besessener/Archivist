'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { IpcOutput } from '@archivist/shared';
import { EntityIcon } from '@/components/common/entity-chip';
import { Textarea } from '@/components/ui/textarea';
import { call } from '@/lib/ipc';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import { useToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

type Suggestion = IpcOutput<'knowledge:wikiSuggest'>[number];

/** The `[[…` the cursor stands in (no `]]` yet): its start and the text typed so far. */
function openLink(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const start = before.lastIndexOf('[[');
  if (start < 0) return null;
  const query = before.slice(start + 2);
  if (query.includes(']]') || query.includes('\n') || query.includes('|') || query.length > 80) return null;
  return { start, query };
}

/** Text field with wiki links (#285): typing `[[` offers entries by name and alias, choosing one inserts `[[Name]]`. */
export function WikiTextarea({
  value,
  onChange,
  excludeId,
  ...props
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onChange: (v: string) => void; excludeId?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [link, setLink] = useState<{ start: number; query: string } | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const { reportError } = useToast();
  const [active, setActive] = useState(0);
  const pendingCursor = useRef<number | null>(null);

  // right after the inserted link is rendered, before the next key press: a later cursor move would scatter typed text
  useLayoutEffect(() => {
    const el = ref.current;
    if (pendingCursor.current === null || !el) return;
    el.focus();
    el.setSelectionRange(pendingCursor.current, pendingCursor.current);
    pendingCursor.current = null;
  }, [value]);

  useEffect(() => {
    if (!link) {
      setItems([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      call('knowledge:wikiSuggest', { query: link.query, limit: 8, ...(excludeId ? { excludeId } : {}) }).then(
        (r) => {
          if (stale) return;
          setItems(r);
          setActive(0);
        },
        (err: unknown) => {
          if (stale) return;
          setItems([]);
          reportError(err, undefined, 'Vorschläge konnten nicht geladen werden');
        },
      );
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [link, excludeId, reportError]);

  const track = (text: string, cursor: number) => setLink(openLink(text, cursor));
  const choose = (s: Suggestion) => {
    const el = ref.current;
    if (!link || !el) return;
    const cursor = el.selectionStart;
    const rest = value.slice(cursor).replace(/^[^\]\n]*\]\]/, '');
    const next = `${value.slice(0, link.start)}[[${s.name}]]${rest}`;
    pendingCursor.current = link.start + s.name.length + 4;
    onChange(next);
    setLink(null);
  };
  const open = link !== null && items.length > 0;

  return (
    <div className="relative">
      <Textarea
        {...props}
        ref={ref}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          track(e.target.value, e.target.selectionStart);
        }}
        onClick={(e) => track(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setLink(null), 150)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            choose(items[active]!);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setLink(null);
          }
        }}
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Einträge zum Verlinken"
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
          data-testid="wiki-suggestions"
        >
          {items.map((s, i) => (
            <div
              key={s.id}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className={cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1', i === active && 'bg-accent')}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
              onMouseEnter={() => setActive(i)}
              data-testid="wiki-suggestion"
            >
              <EntityIcon type={s.type} className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{s.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {s.alias ? `auch „${s.alias}“ · ` : ''}
                {ENTITY_TYPE_LABELS[s.type]}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The names linked with `[[…]]` in a text, each once (like the backend). */
export function wikiNamesOf(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^[\]|\n]{1,200})(?:\|[^[\]\n]{0,200})?\]\]/g)) {
    const name = (m[1] ?? '').replace(/\s+/g, ' ').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** Linked names without an entry (#285), each with the offer to create a note of that name so the link resolves on save. */
export function UnknownWikiLinks({ text, noteId }: { text: string; noteId?: string }) {
  const [unknown, setUnknown] = useState<string[]>([]);
  const [round, setRound] = useState(0);
  const { reportError } = useToast();
  const names = wikiNamesOf(text).join('\u0000');
  useEffect(() => {
    const list = names ? names.split('\u0000') : [];
    if (!list.length) {
      setUnknown([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      call('knowledge:wikiResolve', { names: list, ...(noteId ? { noteId } : {}) }).then(
        (r) => !stale && setUnknown(r.filter((x) => !x.entity).map((x) => x.name)),
        (err: unknown) => !stale && reportError(err, undefined, 'Wiki-Links konnten nicht geprüft werden'),
      );
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [names, noteId, round, reportError]);
  if (!unknown.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="wiki-unknown">
      <span className="text-muted-foreground">Noch ohne Eintrag:</span>
      {unknown.map((n) => (
        <button
          key={n}
          type="button"
          className="rounded border border-dashed px-1.5 py-0.5 hover:bg-accent"
          title={`Notiz „${n}“ anlegen`}
          data-testid="wiki-unknown-create"
          onClick={() =>
            void call('knowledge:createEntity', { type: 'note', name: n }).then(
              () => setRound((x) => x + 1),
              (err: unknown) => reportError(err, undefined, `Notiz „${n}“ konnte nicht angelegt werden`),
            )
          }
        >
          „{n}“ als Notiz anlegen
        </button>
      ))}
    </div>
  );
}
