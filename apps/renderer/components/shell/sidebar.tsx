'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Archive, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/lib/app-context';
import { SECTIONS, sectionOf, type NavBadge } from '@/lib/sections';
import { useQuery } from '@/lib/use-query';
import { cn } from '@/lib/utils';

/** One counter next to a navigation entry: `urgent` ones (overdue, failed) are red, `muted` ones (link proposals) grey after the others. */
type NavCount = { value: number; ariaLabel: string; testIdSuffix: string; emphasis: 'normal' | 'urgent' | 'muted' };

const COUNT_CLASSES: Record<NavCount['emphasis'], string> = {
  normal: 'border-transparent bg-foreground/10 text-foreground',
  urgent: 'border-transparent bg-destructive text-destructive-foreground',
  muted: 'border-muted-foreground/40 text-muted-foreground',
};

export function Sidebar() {
  const current = sectionOf(usePathname() ?? '');
  const { status } = useApp();
  // counts per status instead of the newest 1000 documents: the badge is exact and cheap (#214)
  const { data: byStatus } = useQuery('documents:counts', {}, { scopes: ['documents'], jobs: true });
  const inboxCount = ['staged', 'analyzing', 'proposed', 'failed', 'quarantined'].reduce((n, s) => n + (byStatus?.[s] ?? 0), 0);
  const inboxProblems = (byStatus?.failed ?? 0) + (byStatus?.quarantined ?? 0);
  const { data: openItemCount } = useQuery('openItems:count', { onlyActive: true }, { scopes: ['openItems'] });
  const overdue = status?.overdueOpenItems ?? 0;
  const openInsights = status?.openInsights ?? 0;
  const openLinkProposals = status?.openLinkProposals ?? 0;
  const counts: Record<NavBadge, NavCount[]> = {
    inbox: [
      {
        value: inboxCount,
        ariaLabel: inboxProblems > 0 ? `${inboxCount} offen, davon ${inboxProblems} mit Problemen` : `${inboxCount} offen`,
        testIdSuffix: 'count',
        emphasis: inboxProblems > 0 ? 'urgent' : 'normal',
      },
    ],
    openItems: [
      {
        value: openItemCount ?? 0,
        ariaLabel: overdue > 0 ? `${openItemCount ?? 0} offen, davon ${overdue} überfällig` : `${openItemCount ?? 0} offen`,
        testIdSuffix: 'count',
        emphasis: overdue > 0 ? 'urgent' : 'normal',
      },
    ],
    insights: [
      { value: openInsights, ariaLabel: `offene Hinweise: ${openInsights}`, testIdSuffix: 'count', emphasis: 'normal' },
      { value: openLinkProposals, ariaLabel: `offene Verknüpfungsvorschläge: ${openLinkProposals}`, testIdSuffix: 'links-count', emphasis: 'muted' },
    ],
  };

  return (
    <nav aria-label="Hauptnavigation" className="flex h-full w-16 shrink-0 flex-col border-r bg-sidebar md:w-56">
      <div className="flex h-14 items-center gap-2 px-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Archive className="size-4" aria-hidden />
        </span>
        <span className="hidden min-w-0 flex-col md:flex">
          <span className="text-base font-semibold leading-tight tracking-tight">Archivist</span>
          <span className="truncate text-xs leading-tight tracking-tight text-muted-foreground">dein persönlicher Archivar</span>
        </span>
      </div>
      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2">
        {SECTIONS.map((item) => {
          const active = item === current;
          const shown = (item.badge ? counts[item.badge] : []).filter((count) => count.value > 0);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                data-testid={item.testId}
                aria-current={active ? 'page' : undefined}
                title={item.label}
                className={cn(
                  'relative flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                  active
                    ? 'bg-card text-foreground shadow-card ring-1 ring-border before:absolute before:inset-y-1.5 before:-left-2 before:w-[3px] before:rounded-r-full before:bg-primary'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <item.icon className={cn('size-4 shrink-0', active && 'text-primary')} />
                <span className="hidden flex-1 md:inline">{item.label}</span>
                {shown.length > 0 && (
                  <span className="absolute right-1 top-0.5 flex flex-col items-end gap-0.5 md:static md:flex-row">
                    {shown.map((count) => (
                      <Badge
                        key={count.testIdSuffix}
                        variant="outline"
                        data-testid={`${item.testId}-${count.testIdSuffix}`}
                        data-emphasis={count.emphasis}
                        className={cn('min-w-5 justify-center px-1.5', COUNT_CLASSES[count.emphasis])}
                        aria-label={count.ariaLabel}
                      >
                        {count.value > 99 ? '99+' : count.value}
                      </Badge>
                    ))}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="hidden items-center gap-1.5 border-t px-4 py-3 text-xs text-muted-foreground md:flex">
        <Sparkles className="size-3.5" aria-hidden />
        Version {status?.version ?? '–'}
      </div>
    </nav>
  );
}
