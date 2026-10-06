'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Archive, Clock, FileText, FolderSearch, Gavel, Inbox, Lightbulb, ListChecks, MessageSquare, Network, Settings, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/lib/app-context';
import { useQuery } from '@/lib/use-query';
import { cn } from '@/lib/utils';

type NavBadge = 'inbox' | 'insights' | 'openItems';
/** One counter next to a navigation entry; `muted` ones (link proposals) are grey and follow the primary ones. */
type NavCount = { value: number; ariaLabel: string; testIdSuffix: string; muted?: true };

interface NavItem {
  href: string;
  label: string;
  testId: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: NavBadge;
}

const ITEMS: NavItem[] = [
  { href: '/chat/', label: 'Chat', testId: 'nav-chat', icon: MessageSquare },
  { href: '/inbox/', label: 'Inbox', testId: 'nav-inbox', icon: Inbox, badge: 'inbox' },
  { href: '/knowledge/', label: 'Wissen', testId: 'nav-knowledge', icon: Network },
  { href: '/decisions/', label: 'Entscheidungen', testId: 'nav-decisions', icon: Gavel },
  { href: '/documents/', label: 'Dokumente', testId: 'nav-documents', icon: FileText },
  { href: '/timeline/', label: 'Timeline', testId: 'nav-timeline', icon: Clock },
  { href: '/open-items/', label: 'Offene Punkte', testId: 'nav-open-items', icon: ListChecks, badge: 'openItems' },
  { href: '/insights/', label: 'Insights', testId: 'nav-insights', icon: Lightbulb, badge: 'insights' },
  { href: '/scan/', label: 'Scan', testId: 'nav-scan', icon: FolderSearch },
  { href: '/settings/', label: 'Einstellungen', testId: 'nav-settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname() ?? '';
  const { status } = useApp();
  // counts per status instead of the newest 1000 documents: the badge is exact and cheap (#214)
  const { data: byStatus } = useQuery('documents:counts', {}, { scopes: ['documents'], jobs: true });
  const inboxCount = ['staged', 'analyzing', 'proposed', 'failed', 'quarantined'].reduce((n, s) => n + (byStatus?.[s] ?? 0), 0);
  const { data: openItemCount } = useQuery('openItems:count', { onlyActive: true }, { scopes: ['openItems'] });
  const openInsights = status?.openInsights ?? 0;
  const openLinkProposals = status?.openLinkProposals ?? 0;
  const counts: Record<NavBadge, NavCount[]> = {
    inbox: [{ value: inboxCount, ariaLabel: `${inboxCount} offen`, testIdSuffix: 'count' }],
    openItems: [{ value: openItemCount ?? 0, ariaLabel: `${openItemCount ?? 0} offen`, testIdSuffix: 'count' }],
    insights: [
      { value: openInsights, ariaLabel: `offene Hinweise: ${openInsights}`, testIdSuffix: 'count' },
      { value: openLinkProposals, ariaLabel: `offene Verknüpfungsvorschläge: ${openLinkProposals}`, testIdSuffix: 'links-count', muted: true },
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
        {ITEMS.map((item) => {
          const active = pathname.startsWith(item.href.slice(0, -1));
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
                  active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <item.icon className="size-4 shrink-0" />
                <span className="hidden flex-1 md:inline">{item.label}</span>
                {shown.length > 0 && (
                  <span className="absolute right-1 top-0.5 flex flex-col items-end gap-0.5 md:static md:flex-row">
                    {shown.map((count) => (
                      <Badge
                        key={count.testIdSuffix}
                        variant={count.muted ? 'outline' : 'default'}
                        data-testid={`${item.testId}-${count.testIdSuffix}`}
                        className={cn('min-w-5 justify-center px-1.5', count.muted && 'border-muted-foreground/40 text-muted-foreground')}
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
