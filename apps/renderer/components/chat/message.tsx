'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ExternalLink, FileText, HelpCircle } from 'lucide-react';
import { RunSummary } from '@/components/agent/run-summary';
import { ActionCard } from '@/components/common/action-card';
import { DocumentDialog } from '@/components/documents/document-dialog';
import { isLinkSuggestion, LinkSuggestions } from './link-suggestions';
import { EntityIcon } from '@/components/common/entity-chip';
import { Markdown } from '@/components/common/markdown';
import { Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { entityHref } from '@/lib/nav';
import { formatDate } from '@/lib/format';
import { useRun } from '@/lib/use-run';
import type { ChatMessage, SourceRef } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Which date a source shows – an archive date must not look like the document's date (#168). */
const DATE_KIND_LABEL: Record<NonNullable<SourceRef['dateKind']>, string> = {
  document: 'Dokument vom',
  archived: 'archiviert am',
  decided: 'entschieden am',
  occurred: 'am',
  created: 'erfasst am',
};

function SourceChip({ source }: { source: SourceRef }) {
  const { run } = useRun();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const inner = (
    <>
      <EntityIcon type={source.type} className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 text-left">
        <span className="block truncate text-xs font-medium">{source.title}</span>
        {source.snippet && <span className="line-clamp-2 block text-[11px] text-muted-foreground">{source.snippet}</span>}
        {source.via && (
          <span className="block text-[11px] text-muted-foreground" data-testid="chat-source-via">
            über Verknüpfung: {source.via}
          </span>
        )}
        {source.date && (
          <span className="block text-[11px] text-muted-foreground">
            {source.dateKind ? `${DATE_KIND_LABEL[source.dateKind]} ` : ''}
            {formatDate(source.date)}
          </span>
        )}
      </span>
    </>
  );
  const cls =
    'flex w-full items-start gap-2 rounded-lg border bg-background px-2.5 py-1.5 transition-colors hover:border-primary/60 hover:bg-primary/8 focus-visible:outline-2 focus-visible:outline-ring';
  if (source.type === 'document') {
    return (
      <div className="relative">
        <button type="button" className={cn(cls, 'pr-8')} data-testid="chat-source" title={source.snippet || source.title} onClick={() => setDetailsOpen(true)}>
          {inner}
        </button>
        <button
          type="button"
          className="absolute right-1.5 top-1.5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
          data-testid="chat-source-open"
          aria-label={`Datei „${source.title}“ öffnen`}
          title="Datei öffnen"
          onClick={() => void run(() => call('app:openPath', { documentId: source.id }), { errorTitle: 'Datei konnte nicht geöffnet werden' })}
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </button>
        <DocumentDialog id={detailsOpen ? source.id : null} onClose={() => setDetailsOpen(false)} onChanged={() => undefined} />
      </div>
    );
  }
  return (
    <Link href={entityHref(source.type, source.id)} className={cls} data-testid="chat-source" title={source.snippet || source.title}>
      {inner}
    </Link>
  );
}

export function ChatBubble({
  message,
  pending = false,
  onQuickReply,
}: {
  message: ChatMessage;
  pending?: boolean;
  /** Only set for the last reply: clicking a reply button sends its text. */
  onQuickReply?: (text: string) => void;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        data-testid="chat-message"
        data-role={message.role}
        data-pending={pending ? 'true' : undefined}
        className={cn('max-w-[min(48rem,92%)] text-sm', isUser ? 'rounded-2xl bg-user-bubble px-4 py-2.5' : 'w-full')}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {message.content && <Markdown text={message.content} />}
            {message.errorMessage && (
              <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/8 p-3" data-testid="chat-error">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                <div>
                  <p className="font-medium">Dabei ist ein Fehler aufgetreten</p>
                  <p className="text-muted-foreground">{message.errorMessage}</p>
                </div>
              </div>
            )}
            {message.uncertainties.length > 0 && (
              <Notice tone="warning" title="Das ist noch unsicher" data-testid="chat-uncertainties">
                <ul className="list-disc space-y-0.5 pl-5">
                  {message.uncertainties.map((u, i) => (
                    <li key={`${i}-${u}`}>{u}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {onQuickReply && (message.quickReplies?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-2" data-testid="chat-quick-replies">
                {(message.quickReplies ?? []).map((q) => (
                  <Button key={q} size="sm" variant="outline" data-testid="chat-quick-reply" onClick={() => onQuickReply(q)}>
                    {q}
                  </Button>
                ))}
              </div>
            )}
            {message.actions.some((a) => !isLinkSuggestion(a)) && (
              <div className="flex flex-col gap-2" data-testid="chat-actions">
                {message.actions
                  .filter((a) => !isLinkSuggestion(a))
                  .map((a) => (
                    <ActionCard key={a.id} action={a} />
                  ))}
              </div>
            )}
            {message.actions.some((a) => isLinkSuggestion(a)) && <LinkSuggestions actions={message.actions.filter((a) => isLinkSuggestion(a))} />}
            {message.runId && !pending && <RunSummary runId={message.runId} />}
            {message.sources.length > 0 && (
              <div>
                <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <FileText className="size-3.5" aria-hidden /> Quellen
                </p>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {message.sources.map((s) => (
                    <SourceChip key={`${s.type}-${s.id}`} source={s} />
                  ))}
                </div>
              </div>
            )}
            {/* chat answers carry no estimate badge: their values are rule defaults, not measured (#167) */}
            {message.confidence !== null && message.confidence < 0.5 && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <HelpCircle className="size-3.5" aria-hidden /> Bitte prüfe diese Antwort.
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
