'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /** Sichtbare Details: Pfade, Auswirkungen etc. */
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Wenn gesetzt, muss diese Checkbox aktiviert werden. */
  requireCheckbox?: string;
  confirmTestId?: string;
  onConfirm: (checked: boolean) => void | Promise<void>;
}

/** Allgemeiner Bestätigungsdialog. Aktionen mit `confirmed: true` werden erst nach dessen Bestätigung gesendet. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = 'Bestätigen',
  cancelLabel = 'Abbrechen',
  destructive = false,
  requireCheckbox,
  confirmTestId = 'confirm-dialog-confirm',
  onConfirm,
}: ConfirmDialogProps) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setChecked(false);
        onOpenChange(o);
      }}
    >
      <DialogContent data-testid="confirm-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription asChild>
              <div>{description}</div>
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </DialogHeader>
        {children}
        {requireCheckbox && (
          <CheckboxField checked={checked} onCheckedChange={(v) => setChecked(v === true)} label={requireCheckbox} data-testid="confirm-dialog-checkbox" />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy || (!!requireCheckbox && !checked)}
            data-testid={confirmTestId}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(checked);
                setChecked(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
