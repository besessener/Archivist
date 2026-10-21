'use client';

import { useEffect, useState } from 'react';
import { Check, Code, Copy } from 'lucide-react';
import { IconAction } from '@/components/common/icon-action';
import { useToast } from '@/lib/toast';

const COPIED_FEEDBACK_MS = 2000;

/** The answer as written (Markdown source), selectable and unformatted. */
export function RawAnswer({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 font-mono text-xs" data-testid="chat-message-raw">
      {text}
    </pre>
  );
}

/** „Antwort kopieren“ and the switch between formatted and raw text below an answer; both use the text as written. */
export function AnswerTools({ text, raw, onToggleRaw }: { text: string; raw: boolean; onToggleRaw: () => void }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      toast({ variant: 'error', title: 'Kopieren fehlgeschlagen', description: 'Markiere den Text und kopiere ihn mit Strg+C.' });
    }
  }

  return (
    <div className="-ml-1.5 -mt-2 flex items-center gap-0.5">
      <IconAction label={copied ? 'Kopiert' : 'Antwort kopieren'} onClick={() => void copy()} data-testid="chat-copy">
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </IconAction>
      <IconAction label="Als Rohtext anzeigen" aria-pressed={raw} onClick={onToggleRaw} data-testid="chat-raw-toggle">
        <Code aria-hidden />
      </IconAction>
    </div>
  );
}
