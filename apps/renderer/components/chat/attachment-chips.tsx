'use client';

import { AlertCircle, FileText, ImageIcon, Loader2, X } from 'lucide-react';
import type { PendingAttachment } from '@/lib/use-chat-attachments';
import { cn } from '@/lib/utils';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

/** Symbol of an attached file: a picture for images, a page for everything else. */
export function AttachmentIcon({ ext, className }: { ext: string; className?: string }) {
  const Icon = IMAGE_EXTENSIONS.has(ext.toLowerCase()) ? ImageIcon : FileText;
  return <Icon className={cn('size-3.5 shrink-0', className)} aria-hidden />;
}

const extOf = (name: string) => name.split('.').pop() ?? '';

/** Files attached to the message being written; each can be taken off again (the document stays in the inbox). */
export function AttachmentChips({ items, onRemove }: { items: PendingAttachment[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="mx-auto mb-1.5 flex w-full max-w-3xl 2xl:max-w-5xl flex-wrap gap-1.5" aria-label="Anhänge" data-testid="chat-attachments">
      {items.map((item) => (
        <li
          key={item.key}
          data-testid="chat-attachment"
          data-state={item.state}
          title={item.state === 'rejected' ? item.reason : item.name}
          className={cn(
            'flex max-w-64 items-center gap-1.5 rounded-lg border bg-card py-1 pl-2 pr-1 text-xs',
            item.state === 'rejected' && 'border-destructive/50 bg-destructive/8',
          )}
        >
          {item.state === 'importing' && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
          {item.state === 'ready' && <AttachmentIcon ext={item.ext} />}
          {item.state === 'rejected' && <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />}
          <span className="min-w-0 truncate">
            {item.name}
            {item.state === 'importing' && <span className="sr-only"> wird übernommen</span>}
            {item.state === 'rejected' && <span className="sr-only">: {item.reason}</span>}
          </span>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={`Anhang „${item.name}“ entfernen`}
            data-testid="chat-attachment-remove"
            onClick={() => onRemove(item.key)}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Attachments of a sent message, shown in its bubble. */
export function SentAttachments({ attachments }: { attachments: Array<{ documentId: string; name: string; ext: string }> }) {
  if (!attachments.length) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Anhänge" data-testid="chat-message-attachments">
      {attachments.map((attachment) => (
        <li key={attachment.documentId} className="flex max-w-64 items-center gap-1.5 rounded-md bg-background/60 px-2 py-0.5 text-xs">
          <AttachmentIcon ext={attachment.ext || extOf(attachment.name)} />
          <span className="truncate">{attachment.name}</span>
        </li>
      ))}
    </ul>
  );
}
