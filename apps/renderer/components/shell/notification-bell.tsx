'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellOff, Check, Clock } from 'lucide-react';
import { ActionCard } from '@/components/common/action-card';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { UpcomingReminders } from '@/components/reminders/upcoming-reminders';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useApp } from '@/lib/app-context';
import { call } from '@/lib/ipc';
import { NOTIFICATION_TYPE_LABELS } from '@/lib/labels';
import { formatDateTime } from '@/lib/format';
import { useToast } from '@/lib/toast';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { ActionRecord, NotificationRecord } from '@/lib/types';
import { addDays, nextMonday, toIsoDay } from '@/lib/utils';

type NotifAction = NotificationRecord['proposedActions'][number];

export function NotificationBell() {
  const router = useRouter();
  const { status, refreshStatus } = useApp();
  const [open, setOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ActionRecord | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const { run, busy } = useRun();
  const { toast } = useToast();
  const { data, loading, error, refetch } = useQuery('notifications:list', { includeResolved: false, limit: 50 }, { scopes: ['notifications'], enabled: open });
  const unread = status?.unreadNotifications ?? 0;

  useEffect(() => {
    if (!open || !data) return;
    const ids = data.filter((n) => !n.readAt).map((n) => n.id);
    if (ids.length > 0) {
      void call('notifications:markRead', { ids })
        .then(() => refreshStatus())
        .catch(() => undefined);
    }
  }, [open, data, refreshStatus]);

  async function handle(n: NotificationRecord, a: NotifAction) {
    switch (a.kind) {
      case 'navigate':
      case 'open':
        if (a.target && a.target.startsWith('/')) {
          setOpen(false);
          router.push(a.target);
        }
        break;
      case 'resolve':
      case 'ignore':
        await run(() => call('notifications:resolve', { id: n.id }));
        void refetch();
        break;
      case 'snooze':
        setSnoozeFor((cur) => (cur === n.id ? null : n.id));
        break;
      case 'confirm_action': {
        if (!a.target) break;
        const actions = await run(() => call('actions:list', { status: 'proposed' }));
        const found = actions?.find((x) => x.id === a.target);
        if (found) setConfirmAction(found);
        else toast({ variant: 'info', title: 'Diese Aktion ist nicht mehr offen.' });
        break;
      }
    }
  }

  async function snooze(id: string, day: string) {
    await run(() => call('notifications:snooze', { id, remindAt: day }), { success: 'Erinnerung gesetzt.' });
    setSnoozeFor(null);
    void refetch();
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={unread > 0 ? `Benachrichtigungen (${unread} ungelesen)` : 'Benachrichtigungen'}
            data-testid="bell"
            className="relative"
          >
            <Bell aria-hidden />
            {unread > 0 && (
              <span
                data-testid="bell-count"
                className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white"
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[26rem] p-0" data-testid="bell-panel">
          <div className="border-b px-4 py-3 text-sm font-semibold">Benachrichtigungen</div>
          <div className="max-h-[28rem] overflow-y-auto p-2">
            {error && !data && <ErrorNote error={error} onRetry={() => void refetch()} />}
            {!data && loading && <Loading />}
            {data && data.length === 0 && (
              <EmptyState icon={<BellOff />} title="Alles erledigt" description="Es gibt keine neuen Benachrichtigungen." className="border-0 py-8" />
            )}
            <ul className="flex flex-col gap-2">
              {(data ?? []).map((n) => (
                <li key={n.id} className="rounded-lg border p-3 text-sm" data-testid="bell-item" data-read={n.readAt ? 'true' : 'false'}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium">{n.title}</p>
                    {n.priority === 'high' && <Badge variant="danger">Wichtig</Badge>}
                  </div>
                  <p className="mt-0.5 text-muted-foreground">{n.description}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {NOTIFICATION_TYPE_LABELS[n.type]} · {formatDateTime(n.createdAt)}
                  </p>
                  {n.proposedActions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {n.proposedActions.map((a, i) => (
                        <Button
                          key={`${a.kind}-${i}`}
                          size="sm"
                          variant={a.kind === 'confirm_action' || a.kind === 'navigate' || a.kind === 'open' ? 'default' : 'outline'}
                          disabled={busy}
                          data-testid={`bell-action-${a.kind}`}
                          onClick={() => void handle(n, a)}
                        >
                          {a.kind === 'snooze' && <Clock aria-hidden />}
                          {(a.kind === 'resolve' || a.kind === 'ignore') && <Check aria-hidden />}
                          {a.label}
                        </Button>
                      ))}
                    </div>
                  )}
                  {snoozeFor === n.id && (
                    <div className="mt-2 flex flex-wrap gap-1.5 rounded-md bg-muted p-2" data-testid="bell-snooze-options">
                      <Button size="sm" variant="outline" onClick={() => void snooze(n.id, toIsoDay(addDays(1)))}>
                        Morgen
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void snooze(n.id, toIsoDay(addDays(7)))}>
                        In 7 Tagen
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void snooze(n.id, toIsoDay(nextMonday()))}>
                        Nächsten Montag
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <UpcomingReminders enabled={open} className="mt-3 border-t px-1 pt-3" />
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={confirmAction !== null} onOpenChange={(o) => !o && setConfirmAction(null)}>
        <DialogContent data-testid="notification-action-dialog">
          <DialogHeader>
            <DialogTitle>Aktion bestätigen</DialogTitle>
            <DialogDescription>Bitte prüfen Sie den Vorschlag, bevor Sie ihn bestätigen.</DialogDescription>
          </DialogHeader>
          {confirmAction && (
            <ActionCard
              action={confirmAction}
              onResolved={() => {
                void refetch();
                void refreshStatus();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
