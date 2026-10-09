'use client';

import { useState } from 'react';
import { CheckCheck, ChevronDown, ChevronRight } from 'lucide-react';
import { NOTIFICATION_TYPE_LABELS } from '@/lib/labels';
import { formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';

/** Collapsed list of the most recently handled notifications, so the bell shows what is already done. */
export function RecentlyResolvedNotifications() {
  const [expanded, setExpanded] = useState(false);
  const { data } = useQuery('notifications:recentlyResolved', {}, { scopes: ['notifications'], enabled: expanded });
  const resolved = data ?? [];
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <section className="mt-3 border-t px-1 pt-3" data-testid="bell-resolved">
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-semibold"
        aria-expanded={expanded}
        data-testid="bell-resolved-toggle"
        onClick={() => setExpanded((cur) => !cur)}
      >
        <Chevron className="size-4" aria-hidden /> Zuletzt erledigt
      </button>
      {expanded && resolved.length === 0 && <p className="mt-2 text-sm text-muted-foreground">Noch nichts erledigt.</p>}
      {expanded && resolved.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {resolved.map((n) => (
            <li key={n.id} className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="bell-resolved-item">
              <p className="font-medium">{n.title}</p>
              <p className="mt-1 flex items-center gap-1 text-xs">
                <CheckCheck className="size-3" aria-hidden />
                Erledigt am {formatDateTime(n.resolvedAt)} · {NOTIFICATION_TYPE_LABELS[n.type]}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
