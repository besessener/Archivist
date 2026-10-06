'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Search } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { EntityIcon } from '@/components/common/entity-chip';
import { call, errorMessage } from '@/lib/ipc';
import { entityHref, ENTITY_TYPE_LABELS } from '@/lib/nav';
import { formatDate } from '@/lib/format';
import type { IpcOutput } from '@archivist/shared';

type Results = IpcOutput<'search:global'>;

export function SearchBox() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setError(null);
      setLoading(false);
      return undefined;
    }
    const id = ++seq.current;
    setLoading(true);
    // outdated responses are discarded via seq
    const search = async () => {
      try {
        const found = await call('search:global', { query: trimmed, limit: 15 });
        if (id !== seq.current) return;
        setResults(found);
        setError(null);
      } catch (err) {
        if (id === seq.current) setError(errorMessage(err));
      } finally {
        if (id === seq.current) setLoading(false);
      }
    };
    const timer = setTimeout(() => void search(), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const showPanel = open && query.trim().length >= 2;

  return (
    <Popover open={showPanel} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Alles durchsuchen …"
            aria-label="Globale Suche"
            data-testid="search-input"
            className="pl-9"
          />
          {loading && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />}
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-[min(32rem,calc(100vw-2rem))] p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (e.target instanceof HTMLElement && e.target.closest('[data-testid="search-input"]')) e.preventDefault();
        }}
        data-testid="search-results"
      >
        {error && <p className="p-3 text-sm text-destructive">{error}</p>}
        {!error && !loading && results.length === 0 && <p className="p-3 text-sm text-muted-foreground">Keine Treffer für „{query.trim()}“.</p>}
        <ul className="max-h-96 overflow-y-auto">
          {results.map((r) => (
            <li key={`${r.type}-${r.id}`}>
              <button
                type="button"
                data-testid="search-result"
                className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => {
                  setOpen(false);
                  setQuery('');
                  router.push(entityHref(r.type, r.id));
                }}
              >
                <EntityIcon type={r.type} className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.title}</span>
                  {r.snippet && <span className="line-clamp-2 text-xs text-muted-foreground">{r.snippet}</span>}
                  <span className="text-xs text-muted-foreground">
                    {ENTITY_TYPE_LABELS[r.type]}
                    {r.date ? ` · ${formatDate(r.date)}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
