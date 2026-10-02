import * as React from 'react';
import { Progress as ProgressPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export function Progress({ className, value, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  return (
    <ProgressPrimitive.Root className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)} value={pct} {...props}>
      <ProgressPrimitive.Indicator className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
    </ProgressPrimitive.Root>
  );
}

/** Indeterminate progress. */
export function ProgressIndeterminate({ className }: { className?: string }) {
  return (
    <div className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)} role="progressbar" aria-busy="true" aria-label="In Arbeit">
      <div className="absolute inset-y-0 w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-primary" />
    </div>
  );
}
