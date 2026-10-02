'use client';

import { useId, useMemo, useState } from 'react';
import { BellRing, Clock, X } from 'lucide-react';
import type { IpcOutput } from '@archivist/shared';
import { QuickDate } from '@/components/common/quick-date';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { formatDate, relativeDay } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { cn } from '@/lib/utils';

type ReminderRecord = IpcOutput<'reminders:list'>[number];

/**
 * Pending reminders („Anstehende Erinnerungen“) with „Verschieben“ and „Verwerfen“, shared by the open-items page and
 * the notification bell. Renders nothing while there is no pending reminder (for the given target type).
 */
export function UpcomingReminders({
  targetType,
  enabled = true,
  className,
}: {
  /** Only reminders for this kind of target (e.g. `open_item`); all pending reminders when omitted. */
  targetType?: ReminderRecord['targetType'];
  enabled?: boolean;
  className?: string;
}) {
  const { data, refetch } = useQuery('reminders:list', { status: 'pending' }, { scopes: ['reminders'], enabled });
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const headingId = useId();
  const { run, busy } = useRun();
  const list = useMemo(
    () => (data ?? []).filter((r) => !targetType || r.targetType === targetType).sort((a, b) => a.remindAt.localeCompare(b.remindAt)),
    [data, targetType],
  );
  if (!enabled || list.length === 0) return null;

  async function snooze(r: ReminderRecord, day: string) {
    const out = await run(() => call('reminders:snooze', { id: r.id, remindAt: day }), { success: `Erinnerung auf den ${formatDate(day)} verschoben.` });
    if (out) {
      setSnoozeFor(null);
      void refetch();
    }
  }

  async function dismiss(r: ReminderRecord) {
    const out = await run(() => call('reminders:dismiss', { id: r.id }), { success: 'Erinnerung verworfen.' });
    if (out) void refetch();
  }

  return (
    <section aria-labelledby={headingId} className={cn('flex flex-col gap-2', className)} data-testid="upcoming-reminders">
      <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
        <BellRing className="size-4 text-primary" aria-hidden /> Anstehende Erinnerungen
      </h2>
      <ul className="flex flex-col gap-2">
        {list.map((r) => (
          <li key={r.id} className="rounded-lg border bg-card p-3 text-sm" data-testid="reminder-row">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{r.title}</p>
                <p className="text-xs text-muted-foreground" data-testid="reminder-when">
                  {formatDate(r.remindAt)} ({relativeDay(r.remindAt)})
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  aria-expanded={snoozeFor === r.id}
                  onClick={() => setSnoozeFor((cur) => (cur === r.id ? null : r.id))}
                  data-testid="reminder-snooze"
                >
                  <Clock aria-hidden /> Verschieben
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void dismiss(r)} data-testid="reminder-dismiss">
                  <X aria-hidden /> Verwerfen
                </Button>
              </div>
            </div>
            {snoozeFor === r.id && (
              <div className="mt-2 rounded-md bg-muted p-2" data-testid="reminder-snooze-options">
                <QuickDate disabled={busy} onPick={(day) => void snooze(r, day)} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
