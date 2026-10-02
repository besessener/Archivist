'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Archive, MessageSquarePlus, Paperclip, Pencil, SendHorizontal } from 'lucide-react';
import { ChatBubble } from '@/components/chat/message';
import { AgentLiveView, useAgentProgress } from '@/components/agent/live-view';
import { AgentModeToggle } from '@/components/agent/mode-toggle';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ErrorNote } from '@/components/common/states';
import { useApp } from '@/lib/app-context';
import { chatRequests, mergeChatMessages, requestsFor } from '@/lib/chat-requests';
import { call } from '@/lib/ipc';
import { SUPPORTED_TYPES_TEXT } from '@/lib/labels';
import { useQuery } from '@/lib/use-query';
import { useSettings } from '@/lib/use-settings';
import { useRun } from '@/lib/use-run';
import { formatDateTime } from '@/lib/format';

const PROMPTS = [
  'Wir haben entschieden, dass …',
  'Welche offenen Punkte gibt es?',
  'Was haben wir zuletzt zu diesem Thema beschlossen?',
  'Zeig mir alle Dokumente zu …',
  'Erinnere mich nächsten Montag an …',
];

const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.eml,.png,.jpg,.jpeg';

const MIN_INPUT_HEIGHT = 36;
/** Maximum height of the input field: 60% of the window height (a fixed value when prerendering without a window). */
const maxInputHeight = () => (typeof window === 'undefined' ? 600 : Math.round(window.innerHeight * 0.6));

export default function ChatPage() {
  const { importFiles, setContextMessage } = useApp();
  const { run } = useRun();
  // Running requests and the selected conversation live outside the page so that they survive switching tabs.
  const { requests, activeConversationId } = useSyncExternalStore(chatRequests.subscribe, chatRequests.getSnapshot, chatRequests.getSnapshot);
  const conversationId = activeConversationId ?? null;
  const [text, setText] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialised = useRef(false);
  // manually set height of the input field (null = grow automatically with the text)
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const convs = useQuery('chat:conversations', {}, { scopes: ['chat'] });
  const { settings, hasApiKey } = useSettings();
  // say where messages go – also in „vorher fragen“, where chat messages are sent without a further question (#201)
  const aiNotice =
    !settings || settings.privacy.llmMode === 'local_only' || !settings.llm.baseUrl || !hasApiKey
      ? 'Nachrichten bleiben auf diesem Rechner.'
      : `Nachrichten werden zur Auswertung an die KI (${settings.llm.model}) gesendet.`;
  const history = useQuery('chat:history', conversationId ? { conversationId } : undefined, {
    scopes: ['chat'],
    enabled: conversationId !== null,
  });

  useEffect(() => {
    if (!initialised.current && convs.data) {
      initialised.current = true;
      // ?c=<id>: jump back from an open item into the conversation it came from
      const wanted = new URLSearchParams(window.location.search).get('c');
      const latest = [...convs.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const target = convs.data.find((c) => c.id === wanted);
      // Without a jump back, the previously selected conversation stays (e.g. after switching tabs); on first open, the most recently active one.
      if (target) chatRequests.setActiveConversation(target.id);
      else if (chatRequests.getSnapshot().activeConversationId === undefined) chatRequests.setActiveConversation(latest?.id ?? null);
    }
  }, [convs.data]);

  const pendingHere = useMemo(() => requestsFor(requests, conversationId), [requests, conversationId]);
  // A request is still running (even if it was sent before switching tabs)
  const sending = pendingHere.some((r) => r.result === null);
  // Live state of the agent run (also after switching tabs or a reload, #300)
  const progress = useAgentProgress(conversationId, sending);
  const working = sending || progress?.status === 'running';
  const { run: runStop, busy: stopping } = useRun();
  const stop = useCallback(
    () => runStop(() => call('chat:cancel', conversationId ? { conversationId } : {}), { errorTitle: 'Abbrechen fehlgeschlagen' }),
    [runStop, conversationId],
  );
  const messages = useMemo(() => {
    // Until the history of the newly selected conversation has loaded, do not show messages of the previous one
    const loaded = conversationId ? (history.data ?? []).filter((m) => m.conversationId === conversationId) : [];
    return mergeChatMessages(loaded, pendingHere);
  }, [history.data, conversationId, pendingHere]);

  useEffect(() => {
    if (history.data) chatRequests.settle(history.data);
  }, [history.data]);

  // A run that was already running when the page opened has finished: load its answer.
  const runFinished = progress !== null && progress.status !== 'running';
  const refetchHistory = history.refetch;
  useEffect(() => {
    if (runFinished && !sending) void refetchHistory();
  }, [runFinished, sending, refetchHistory]);

  // The input field grows with the text (up to the maximum height) and can additionally be resized via the handle at the bottom right.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || manualHeight !== null) return;
    if (text === '') el.style.height = '';
    else if (el.scrollHeight > el.clientHeight) el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.6)}px`;
  }, [text, manualHeight]);

  /** Handle above the input field: dragging up enlarges, dragging down shrinks, double-click resets. */
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    const el = inputRef.current;
    if (!el) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = el.clientHeight;
    const max = maxInputHeight();
    const move = (ev: PointerEvent) => setManualHeight(Math.round(Math.max(MIN_INPUT_HEIGHT, Math.min(max, startH + (startY - ev.clientY)))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function resizeByKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const el = inputRef.current;
    if (!el || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    setManualHeight(Math.round(Math.max(MIN_INPUT_HEIGHT, Math.min(maxInputHeight(), el.clientHeight + (e.key === 'ArrowUp' ? 24 : -24)))));
  }

  useEffect(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant') ?? null;
    setContextMessage(lastAssistant);
  }, [messages, setContextMessage]);

  useEffect(() => () => setContextMessage(null), [setContextMessage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, working, progress?.steps.length]);

  const send = useCallback(
    async (raw: string) => {
      const content = raw.trim();
      if (!content || working) return;
      setText('');
      // The request keeps running in the main process and stays in the shared store, even if the page is left in the meantime.
      const res = await chatRequests.send(conversationId, content, () =>
        run(() => call('chat:send', { text: content, ...(conversationId ? { conversationId } : {}) }), {
          errorTitle: 'Nachricht konnte nicht gesendet werden',
        }),
      );
      if (res) void convs.refetch();
      // Error: put the text back into the input field, unless something new is already there
      else setText((current) => current || content);
    },
    [conversationId, working, run, convs],
  );

  async function newConversation() {
    const c = await run(() => call('chat:newConversation'));
    if (c) {
      chatRequests.setActiveConversation(c.id);
      void convs.refetch();
      inputRef.current?.focus();
    }
  }

  const conversations = convs.data ?? [];
  const currentTitle = conversations.find((c) => c.id === conversationId)?.title ?? '';

  function openRename() {
    setRenameValue(currentTitle);
    setRenameOpen(true);
  }

  async function saveRename() {
    if (!conversationId || !renameValue.trim()) return;
    const res = await run(() => call('chat:renameConversation', { id: conversationId, title: renameValue.trim() }), {
      errorTitle: 'Umbenennen fehlgeschlagen',
      success: 'Unterhaltung umbenannt.',
    });
    if (res) {
      setRenameOpen(false);
      void convs.refetch();
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-page">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <label htmlFor="conversation-select" className="sr-only">
          Unterhaltung wählen
        </label>
        <div className="w-full max-w-xs">
          <Select
            id="conversation-select"
            data-testid="conversation-select"
            value={conversationId ?? ''}
            onChange={(e) => chatRequests.setActiveConversation(e.target.value || null)}
          >
            <option value="">Neue Unterhaltung</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title || 'Unterhaltung'} · {formatDateTime(c.updatedAt)}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={() => void newConversation()} data-testid="chat-new">
          <MessageSquarePlus aria-hidden /> Neu
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={openRename}
          disabled={!conversationId}
          aria-label="Unterhaltung umbenennen"
          title="Unterhaltung umbenennen"
          data-testid="chat-rename"
        >
          <Pencil aria-hidden /> Umbenennen
        </Button>
        <div className="ml-auto">
          <AgentModeToggle conversationId={conversationId} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="chat-scroll">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {history.error && <ErrorNote error={history.error} onRetry={() => void history.refetch()} />}
          {messages.length === 0 && !working && (
            <div className="flex flex-col items-center gap-5 py-12 text-center" data-testid="chat-empty">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                <Archive className="size-6" aria-hidden />
              </span>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Wie kann ich helfen?</h1>
                <p className="mt-1 text-muted-foreground">
                  Halte Entscheidungen fest, stelle Fragen an dein Archiv oder zieh Dokumente einfach in dieses Fenster.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    data-testid="prompt-chip"
                    className="rounded-full border bg-card px-3 py-1.5 text-sm transition-colors hover:border-primary/60 hover:bg-primary/8 focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => {
                      setText(p);
                      inputRef.current?.focus();
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <ChatBubble
              key={m.id}
              message={m}
              pending={m.id.startsWith('pending-')}
              onQuickReply={i === messages.length - 1 && m.role === 'assistant' && !working ? (q) => void send(q) : undefined}
            />
          ))}
          {working && <AgentLiveView progress={progress} onStop={() => void stop()} stopping={stopping} />}
          <div ref={bottomRef} />
        </div>
      </div>

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
            void send(text);
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
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text);
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
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent data-testid="rename-dialog">
          <DialogHeader>
            <DialogTitle>Unterhaltung umbenennen</DialogTitle>
            <DialogDescription>Der Titel erscheint in der Auswahl oben. Der Inhalt der Unterhaltung bleibt unverändert.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void saveRename();
            }}
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              maxLength={120}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- rename dialog: focus belongs in the field
              autoFocus
              aria-label="Neuer Titel"
              data-testid="rename-input"
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameOpen(false)}>
                Abbrechen
              </Button>
              <Button type="submit" disabled={!renameValue.trim()} data-testid="rename-save">
                Speichern
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
