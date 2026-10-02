'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Paperclip, SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useApp } from '@/lib/app-context';
import { SUPPORTED_TYPES_TEXT } from '@/lib/labels';

const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.eml,.png,.jpg,.jpeg';

const MIN_INPUT_HEIGHT = 36;
/** Maximum height of the input field: 60% of the window height (a fixed value when prerendering without a window). */
const maxInputHeight = () => (typeof window === 'undefined' ? 600 : Math.round(window.innerHeight * 0.6));
const clampHeight = (height: number) => Math.round(Math.max(MIN_INPUT_HEIGHT, Math.min(maxInputHeight(), height)));

export interface ChatComposerProps {
  text: string;
  onTextChange: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  working: boolean;
  onSend: (text: string) => void;
  aiNotice: string;
}

/** Input field with file picker and a resize handle; it grows with the text unless resized by hand. */
export function ChatComposer({ text, onTextChange, inputRef, working, onSend, aiNotice }: ChatComposerProps) {
  const { importFiles } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  // manually set height of the input field (null = grow automatically with the text)
  const [manualHeight, setManualHeight] = useState<number | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || manualHeight !== null) return;
    if (text === '') input.style.height = '';
    else if (input.scrollHeight > input.clientHeight) input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.6)}px`;
  }, [text, manualHeight, inputRef]);

  /** Dragging the handle up enlarges the field, dragging down shrinks it. */
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    const input = inputRef.current;
    if (!input) return;
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = input.clientHeight;
    const max = maxInputHeight();
    const move = (event: PointerEvent) => setManualHeight(Math.round(Math.max(MIN_INPUT_HEIGHT, Math.min(max, startHeight + (startY - event.clientY)))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function resizeByKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const input = inputRef.current;
    if (!input || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    setManualHeight(clampHeight(input.clientHeight + (e.key === 'ArrowUp' ? 24 : -24)));
  }

  return (
    <div className="border-t bg-background px-4 pb-3 pt-1">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- focusable separator (WAI-ARIA window splitter), intentionally interactive */}
      <div
        role="separator"
        aria-orientation="horizontal"
        // A focusable separator needs aria-valuenow; without a manual setting the field grows automatically (minimum height).
        aria-valuemin={MIN_INPUT_HEIGHT}
        aria-valuemax={maxInputHeight()}
        aria-valuenow={manualHeight ?? MIN_INPUT_HEIGHT}
        aria-label="Höhe des Eingabefelds ändern (Pfeiltasten hoch/runter, Doppelklick setzt zurück)"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the window splitter is a focusable widget
        tabIndex={0}
        title="Ziehen, um das Eingabefeld zu vergrößern oder zu verkleinern (Doppelklick: zurücksetzen)"
        className="group mx-auto flex h-3 w-full max-w-3xl cursor-row-resize touch-none items-center justify-center focus-visible:outline-2 focus-visible:outline-ring"
        onPointerDown={startResize}
        onDoubleClick={() => setManualHeight(null)}
        onKeyDown={resizeByKey}
        data-testid="chat-resize"
      >
        <span className="h-1 w-10 rounded-full bg-border group-hover:bg-muted-foreground" aria-hidden />
      </div>
      <form
        className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border bg-card p-2 shadow-xs focus-within:border-ring"
        onSubmit={(e) => {
          e.preventDefault();
          onSend(text);
        }}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          data-testid="file-input"
          aria-label="Dateien auswählen"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length > 0) void importFiles(files);
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Dateien auswählen"
          title={`Dateien auswählen (${SUPPORTED_TYPES_TEXT})`}
          data-testid="file-pick"
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip aria-hidden />
        </Button>
        <Textarea
          ref={inputRef}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend(text);
            }
          }}
          rows={1}
          placeholder="Nachricht an Archivist …"
          aria-label="Nachricht"
          data-testid="chat-input"
          style={manualHeight !== null ? { height: manualHeight } : undefined}
          className="max-h-[60vh] min-h-9 flex-1 resize-none overflow-y-auto border-0 bg-transparent shadow-none focus-visible:outline-none"
        />
        <Button type="submit" size="icon" disabled={working || !text.trim()} aria-label="Senden" data-testid="chat-send">
          <SendHorizontal aria-hidden />
        </Button>
      </form>
      <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-muted-foreground" data-testid="chat-ai-notice">
        {aiNotice} Dateien (PDF, Word, PowerPoint, Excel, Text, E-Mail, Bilder) kannst du auch einfach in das Fenster ziehen.
      </p>
    </div>
  );
}
