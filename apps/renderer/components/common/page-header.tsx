'use client';

import { usePathname } from 'next/navigation';
import { sectionOf } from '@/lib/sections';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  const section = sectionOf(usePathname() ?? '');
  return (
    <div className={cn('mb-6 flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {section && (
          <span
            data-tone={section.tone}
            data-testid="page-header-tile"
            className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-tone/12 text-tone ring-1 ring-tone/20 ring-inset"
          >
            <section.icon className="size-5" aria-hidden />
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-7xl p-4 sm:p-6 2xl:max-w-[96rem]', className)}>{children}</div>;
}

/** A small uppercase label above a group of cards; quieter than the page title, clearly above card titles. */
export const GROUP_HEADING = 'flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground';
