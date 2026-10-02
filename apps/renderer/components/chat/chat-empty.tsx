'use client';

import { Archive } from 'lucide-react';

const PROMPTS = [
  'Wir haben entschieden, dass …',
  'Welche offenen Punkte gibt es?',
  'Was haben wir zuletzt zu diesem Thema beschlossen?',
  'Zeig mir alle Dokumente zu …',
  'Erinnere mich nächsten Montag an …',
];

export function ChatEmpty({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-5 py-12 text-center" data-testid="chat-empty">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
        <Archive className="size-6" aria-hidden />
      </span>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Wie kann ich helfen?</h1>
        <p className="mt-1 text-muted-foreground">Halte Entscheidungen fest, stelle Fragen an dein Archiv oder zieh Dokumente einfach in dieses Fenster.</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            data-testid="prompt-chip"
            className="rounded-full border bg-card px-3 py-1.5 text-sm transition-colors hover:border-primary/60 hover:bg-primary/8 focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => onPrompt(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
