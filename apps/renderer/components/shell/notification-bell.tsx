'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellOff, Check, CheckCheck, Clock, MailCheck, Undo2 } from 'lucide-react';
import { ActionCard } from '@/components/common/action-card';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { UpcomingReminders } from '@/components/reminders/upcoming-reminders';
import { RecentlyResolvedNotifications } from '@/components/shell/recently-resolved-notifications';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useApp } from '@/lib/app-context';
import { call } from '@/lib/ipc';
import { NOTIFICATION_TYPE_LABELS } from '@/lib/labels';
import { formatDateTime } from '@/lib/format';
import { useToast } from '@/lib/toast';
import { uniqueById, usePagedQuery } from '@/lib/use-paged-query';
import { useRun } from '@/lib/use-run';
import type { ActionRecord, NotificationRecord } from '@/lib/types';
import { addDays, nextMonday, toIsoDay } from '@/lib/utils';

const PAGE_SIZE = 50;

type NotifAction = NotificationRecord['proposedActions'][number];

export function NotificationBell() {
  const router = useRouter();
  const { status, refreshStatus } = useApp();
  const [open, setOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ActionRecord | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const { run, busy } = useRun();
  const { toast, reportError } = useToast();
  const paged = usePagedQuery('notifications:list', { includeResolved: false }, { pageSize: PAGE_SIZE, scopes: ['notifications'], enabled: open });
  const { loading, error, refetch } = paged;
  const data = useMemo(() => (paged.pages ? uniqueById(paged.pages) : undefined), [paged.pages]);
  const hasOlder = (paged.pages?.at(-1)?.length ?? 0) === PAGE_SIZE;
  const unread = status?.unreadNotifications ?? 0;

  // Marking as read waits until the panel closes, so new entries stay recognisable while it is open.
  function changeOpen(next: boolean) {
    setOpen(next);
    const ids = next ? [] : (data ?? []).filter((n) => !n.readAt).map((n) => n.id);
    if (ids.length === 0) return;
    void call('notifications:markRead', { ids })
      .then(() => refreshStatus())
      .catch((err: unknown) => reportError(err, undefined, 'Benachrichtigungen konnten nicht als gelesen markiert werden'));
  }

  async function handle(n: NotificationRecord, a: NotifAction) {
    switch (a.kind) {
      case 'navigate':
      case 'open':
        if (a.target && a.target.startsWith('/')) {
          await run(() => call('notifications:resolve', { id: n.id }));
          changeOpen(false);
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
      case 'undo_run': {
        if (!a.target) break;
        const result = await run(() => call('agent:undoRun', { runId: a.target! }));
        if (!result) break;
        toast({ variant: 'success', title: result.undone ? `${result.undone} Änderung(en) rückgängig gemacht.` : 'Es gab nichts rückgängig zu machen.' });
        await run(() => call('notifications:resolve', { id: n.id }));
        void refetch();
        break;
      }
      case 'confirm_action': {
        if (!a.target) break;
        const found = await run(() => call('actions:get', { id: a.target! }));
        if (found?.status === 'proposed') setConfirmAction(found);
        else if (found) toast({ variant: 'info', title: 'Diese Aktion ist nicht mehr offen.' });
        break;
      }
    }
  }

  async function clearAll() {
    const result = await run(() => call('notifications:resolveAll', {}), { success: 'Benachrichtigungen geleert.' });
    if (result) {
      setSnoozeFor(null);
      void refetch();
      void refreshStatus();
    }
  }

  async function markAllRead() {
    const result = await run(() => call('notifications:markAllRead', {}), { errorTitle: 'Benachrichtigungen konnten nicht als gelesen markiert werden' });
    if (result) {
      void refetch();
      void refreshStatus();
    }
  }

  async function snooze(id: string, day: string) {
    await run(() => call('notifications:snooze', { id, remindAt: day }), { success: 'Erinnerung gesetzt.' });
    setSnoozeFor(null);
    void refetch();
  }

  return (
    <>
      <Popover open={open} onOpenChange={changeOpen}>
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
                className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground"
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[26rem] p-0" data-testid="bell-panel">
          <div className="flex flex-wrap items-center justify-between gap-x-2 border-b px-4 py-2">
            <span className="py-1 text-sm font-semibold">Benachrichtigungen</span>
            {data && data.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" disabled={busy} data-testid="bell-mark-all-read" onClick={() => void markAllRead()}>
                  <MailCheck aria-hidden />
                  Alle als gelesen markieren
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} data-testid="bell-clear-all" onClick={() => void clearAll()}>
                  <CheckCheck aria-hidden />
                  Alle leeren
                </Button>
              </div>
            )}
          </div>
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
                    <p className={n.readAt ? 'font-medium' : 'font-semibold'}>
                      {!n.readAt && (
                        <span data-testid="bell-item-new">
                          <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full bg-primary align-middle" />
                          <span className="sr-only">Neu: </span>
                        </span>
                      )}
                      {n.title}
                    </p>
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
                          {a.kind === 'undo_run' && <Undo2 aria-hidden />}
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
            {hasOlder && (
              <div className="mt-2 flex justify-center">
                <Button size="sm" variant="outline" disabled={loading} onClick={paged.loadMore} data-testid="bell-load-older">
                  Ältere laden
                </Button>
              </div>
            )}
            <UpcomingReminders enabled={open} className="mt-3 border-t px-1 pt-3" />
            <RecentlyResolvedNotifications />
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={confirmAction !== null} onOpenChange={(o) => !o && setConfirmAction(null)}>
        <DialogContent data-testid="notification-action-dialog">
          <DialogHeader>
            <DialogTitle>Aktion bestätigen</DialogTitle>
            <DialogDescription>Bitte prüfe den Vorschlag, bevor du ihn bestätigst.</DialogDescription>
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
