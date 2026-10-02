'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { EntityType } from '@archivist/shared';
import { Search } from 'lucide-react';
import { BulkAssignBar, useSelection } from '@/components/common/bulk-assign';
import { EntityIcon } from '@/components/common/entity-chip';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { CASE_ENTRY_TYPES } from '@/components/knowledge/case-dialog';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import { useDebounced } from '@/lib/use-debounced';
import { useQuery } from '@/lib/use-query';
import { cn } from '@/lib/utils';

const TYPES: EntityType[] = ['topic', 'project', 'person', 'event', 'note', 'category', 'tag', 'document', 'decision', 'task', 'question', 'case'];

/** Entries the list loads; a full list says so instead of passing itself off as everything (#222). */
const ENTITY_LIMIT = 300;

/** Puts each topic/project's subtopics right below it (#282); a child whose parent is not in the list stays at the top level. */
function asTree<T extends { id: string }>(list: T[], links: Array<{ childId: string; parentId: string }>): Array<{ entity: T; depth: number }> {
  const inList = new Set(list.map((entity) => entity.id));
  const parentOf = new Map(links.filter((link) => inList.has(link.parentId) && inList.has(link.childId)).map((link) => [link.childId, link.parentId]));
  const children = new Map<string, T[]>();
  for (const entity of list) {
    const parentId = parentOf.get(entity.id);
    if (parentId) children.set(parentId, [...(children.get(parentId) ?? []), entity]);
  }
  const ordered: Array<{ entity: T; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (entity: T, depth: number) => {
    if (seen.has(entity.id)) return;
    seen.add(entity.id);
    ordered.push({ entity, depth });
    for (const child of children.get(entity.id) ?? []) visit(child, depth + 1);
  };
  for (const entity of list) if (!parentOf.has(entity.id)) visit(entity, 0);
  for (const entity of list) visit(entity, 0);
  return ordered;
}

/** Search, type filter and selection of the knowledge list; the page keeps it to reload the list after creating an entry. */
export function useEntityList() {
  const [type, setType] = useState<EntityType | ''>('');
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 300);
  const list = useQuery('knowledge:listEntities', { ...(type ? { type } : {}), ...(query ? { query } : {}), limit: ENTITY_LIMIT }, { scopes: ['knowledge'] });
  const selection = useSelection();
  const hierarchy = useQuery('knowledge:hierarchy', {}, { scopes: ['knowledge'] });
  const items = useMemo(() => asTree(list.data ?? [], hierarchy.data ?? []), [list.data, hierarchy.data]);
  return { type, setType, search, setSearch, list, selection, items };
}

type EntityListState = ReturnType<typeof useEntityList>;
type ListedEntity = EntityListState['items'][number]['entity'];

export function EntityListPanel({ state, selectedId }: { state: EntityListState; selectedId: string | null }) {
  const { type, setType, search, setSearch, list, selection, items } = state;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Im Wissen suchen …"
          aria-label="Wissen durchsuchen"
          className="pl-9"
          data-testid="knowledge-search"
        />
      </div>
      <Select value={type} onChange={(e) => setType(e.target.value as EntityType | '')} aria-label="Art filtern" data-testid="knowledge-type-filter">
        <option value="">Alle Arten</option>
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {ENTITY_TYPE_LABELS[t]}
          </option>
        ))}
      </Select>
      {(list.data?.length ?? 0) >= ENTITY_LIMIT && (
        <p className="text-xs text-muted-foreground" data-testid="knowledge-capped">
          Angezeigt werden die ersten {ENTITY_LIMIT} Einträge; möglicherweise gibt es weitere. Grenze die Liste mit der Suche oder dem Typ ein.
        </p>
      )}
      {list.error && !list.data && <ErrorNote error={list.error} onRetry={() => void list.refetch()} />}
      {!list.data && list.loading && <Loading />}
      {list.data && list.data.length === 0 && (
        <EmptyState title="Nichts gefunden" description="Lege ein Thema, Projekt oder eine Person an oder ändere den Filter." />
      )}
      <BulkAssignBar ids={selection.ids} noun={['Eintrag', 'Einträge']} onClear={selection.clear} onDone={() => void list.refetch()} />
      <ul className="flex max-h-[65vh] flex-col gap-1 overflow-y-auto" data-testid="knowledge-list">
        {items.map(({ entity, depth }) => (
          <EntityListItem key={entity.id} entity={entity} depth={depth} selection={selection} current={entity.id === selectedId} />
        ))}
      </ul>
    </div>
  );
}

function EntityListItem({
  entity,
  depth,
  selection,
  current,
}: {
  entity: ListedEntity;
  depth: number;
  selection: EntityListState['selection'];
  current: boolean;
}) {
  return (
    <li className="flex items-center gap-1" style={depth ? { paddingLeft: `${Math.min(depth, 4) * 1}rem` } : undefined} data-depth={depth}>
      {CASE_ENTRY_TYPES.has(entity.type) && !entity.duplicateOfId ? (
        <Checkbox
          className="ml-1"
          checked={selection.has(entity.id)}
          onCheckedChange={(v) => selection.toggle(entity.id, v === true)}
          aria-label={`${entity.name} auswählen`}
          data-testid="knowledge-select"
        />
      ) : (
        <span className="w-5 shrink-0" aria-hidden />
      )}
      <Link
        href={`/knowledge/?id=${encodeURIComponent(entity.id)}`}
        data-testid="knowledge-item"
        aria-current={current ? 'true' : undefined}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring',
          current && 'bg-accent',
        )}
      >
        <EntityIcon type={entity.type} className="size-4 shrink-0 text-primary" />
        <span className={cn('min-w-0 flex-1 truncate', entity.duplicateOfId && 'text-muted-foreground line-through')}>{entity.name}</span>
        {entity.isSelf && (
          <Badge variant="info" data-testid="knowledge-item-self">
            Du
          </Badge>
        )}
        {entity.unconfirmed && (
          <span className="text-xs text-muted-foreground" data-testid="knowledge-item-unconfirmed">
            unbestätigt
          </span>
        )}
        {entity.duplicateOfId && (
          <span className="text-xs text-muted-foreground" data-testid="knowledge-item-duplicate">
            Duplikat
          </span>
        )}
        <span className="text-xs text-muted-foreground">{entity.relationCount}</span>
      </Link>
    </li>
  );
}
