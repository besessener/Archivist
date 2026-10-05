'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { QuickDate } from '@/components/common/quick-date';
import { Field } from '@/components/common/states';
import { RelatedEntries } from '@/components/knowledge/related';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { call } from '@/lib/ipc';
import { formatDate } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { useSettings } from '@/lib/use-settings';
import type { OpenItemRecord } from '@/lib/types';

interface ItemDialogProps {
  item: OpenItemRecord | null;
  onClose: () => void;
  onDone: () => void;
}

export function CloseDialog({ item, onClose, onDone }: ItemDialogProps) {
  const { run } = useRun();
  const [dismiss, setDismiss] = useState(false);
  const [note, setNote] = useState('');
  return (
    <ConfirmDialog
      open={item !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Punkt abschließen?"
      description={item ? `„${item.title}“ wird nicht mehr als offen angezeigt.` : undefined}
      confirmLabel={dismiss ? 'Als verworfen schließen' : 'Als erledigt schließen'}
      confirmTestId="open-item-close-confirm"
      onConfirm={async () => {
        if (!item) return;
        const resolutionNote = note.trim() || undefined;
        const closed = await run(() => call('openItems:close', { id: item.id, status: dismiss ? 'dismissed' : 'resolved', resolutionNote, confirmed: true }), {
          success: 'Punkt abgeschlossen.',
        });
        if (!closed) return;
        setNote('');
        onDone();
        onClose();
      }}
    >
      <CheckboxField
        checked={dismiss}
        onCheckedChange={(checked) => setDismiss(checked === true)}
        label="Nicht erledigt, sondern verworfen (hat sich erübrigt)"
      />
      <Field label={dismiss ? 'Warum verworfen? (optional)' : 'Wie wurde es gelöst? (optional)'} htmlFor="oi-resolution-note">
        <Textarea
          id="oi-resolution-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder={dismiss ? 'z. B. hat sich durch den Umzug erledigt' : 'z. B. Angebot von Müller angenommen, Auftrag am 3.10. erteilt'}
          data-testid="open-item-resolution-input"
        />
      </Field>
    </ConfirmDialog>
  );
}

export function ReminderDialog({ item, onClose, onDone }: ItemDialogProps) {
  const { run, busy } = useRun();
  const { settings } = useSettings();
  const reminderTime = settings?.notifications.reminderTime ?? '08:00';
  const reminders = useQuery('reminders:list', { status: 'pending' }, { scopes: ['reminders'], enabled: item !== null });
  const existing = item ? reminders.data?.find((reminder) => reminder.targetType === 'open_item' && reminder.targetId === item.id) : undefined;
  const finish = (succeeded: unknown) => {
    if (!succeeded) return;
    onDone();
    onClose();
  };
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="reminder-dialog">
        <DialogHeader>
          <DialogTitle>{existing ? 'Erinnerung verschieben' : 'Erinnerung setzen'}</DialogTitle>
          <DialogDescription>{item?.title}</DialogDescription>
        </DialogHeader>
        {existing && <p className="text-sm text-muted-foreground">Aktuell geplant für {formatDate(existing.remindAt)}.</p>}
        <p className="text-xs text-muted-foreground" data-testid="reminder-time-hint">
          Erinnerungen erscheinen am gewählten Tag um {reminderTime} Uhr (Ortszeit, änderbar unter Einstellungen → Benachrichtigungen).
        </p>
        <QuickDate
          disabled={busy || !item}
          onPick={async (day) => {
            if (!item) return;
            const saved = await run(
              () =>
                existing
                  ? call('reminders:snooze', { id: existing.id, remindAt: day })
                  : call('reminders:create', { targetType: 'open_item', targetId: item.id, title: item.title, remindAt: day }),
              { success: `Erinnerung für den ${formatDate(day)} um ${reminderTime} Uhr gesetzt.` },
            );
            finish(saved);
          }}
        />
        {existing && (
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => finish(await run(() => call('reminders:dismiss', { id: existing.id }), { success: 'Erinnerung verworfen.' }))}
              data-testid="reminder-dialog-dismiss"
            >
              <X aria-hidden /> Erinnerung verwerfen
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RelatedDialog({ item, onClose }: Pick<ItemDialogProps, 'item' | 'onClose'>) {
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="open-item-related-dialog">
        <DialogHeader>
          <DialogTitle>Zusammenhänge</DialogTitle>
          <DialogDescription>{item?.title}</DialogDescription>
        </DialogHeader>
        {item && <RelatedEntries id={item.id} link={{ name: item.title }} scan />}
      </DialogContent>
    </Dialog>
  );
}
