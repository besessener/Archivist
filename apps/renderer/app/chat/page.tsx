'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Loader2, MessageSquarePlus, Paperclip, SendHorizontal } from 'lucide-react';
import { ChatBubble } from '@/components/chat/message';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ErrorNote } from '@/components/common/states';
import { useApp } from '@/lib/app-context';
import { call } from '@/lib/ipc';
import { SUPPORTED_TYPES_TEXT } from '@/lib/labels';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { formatDateTime } from '@/lib/format';
import type { ChatMsg } from '@/lib/types';

const PROMPTS = [
  'Wir haben entschieden, dass …',
  'Welche offenen Punkte gibt es?',
  'Was haben wir zuletzt zu diesem Thema beschlossen?',
  'Zeig mir alle Dokumente zu …',
  'Erinnere mich nächsten Montag an …',
];

const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.eml,.png,.jpg,.jpeg';

export default function ChatPage() {
  const { importFiles, setContextMessage } = useApp();
  const { run } = useRun();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialised = useRef(false);

  const convs = useQuery('chat:conversations', {}, { scopes: ['chat'] });
  const history = useQuery('chat:history', conversationId ? { conversationId } : undefined, {
    scopes: ['chat'],
    enabled: conversationId !== null,
  });

  useEffect(() => {
    if (!initialised.current && convs.data) {
      initialised.current = true;
      const latest = [...convs.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (latest) setConversationId(latest.id);
    }
  }, [convs.data]);

  useEffect(() => {
    if (history.data && !sending) setMessages(history.data);
  }, [history.data, sending]);

  useEffect(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant') ?? null;
    setContextMessage(lastAssistant);
  }, [messages, setContextMessage]);

  useEffect(() => () => setContextMessage(null), [setContextMessage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, sending]);

  const send = useCallback(
    async (raw: string) => {
      const content = raw.trim();
      if (!content || sending) return;
      setSending(true);
      setText('');
      const temp: ChatMsg = {
        id: `pending-${Date.now()}`,
        conversationId: conversationId ?? 'pending',
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        sources: [],
        context: null,
        actions: [],
        confidence: null,
        uncertainties: [],
        intent: null,
        errorMessage: null,
      };
      setMessages((prev) => [...prev, temp]);
      const res = await run(() => call('chat:send', { text: content, ...(conversationId ? { conversationId } : {}) }), {
        errorTitle: 'Nachricht konnte nicht gesendet werden',
      });
      if (res) {
        setMessages((prev) => [...prev.filter((m) => m.id !== temp.id), res.userMessage, res.assistantMessage]);
        if (res.conversationId !== conversationId) setConversationId(res.conversationId);
        void convs.refetch();
      } else {
        setMessages((prev) => prev.filter((m) => m.id !== temp.id));
        setText(content);
      }
      setSending(false);
    },
    [conversationId, sending, run, convs],
  );

  async function newConversation() {
    const c = await run(() => call('chat:newConversation'));
    if (c) {
      setMessages([]);
      setConversationId(c.id);
      void convs.refetch();
      inputRef.current?.focus();
    }
  }

  const conversations = convs.data ?? [];

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
            onChange={(e) => {
              setMessages([]);
              setConversationId(e.target.value || null);
            }}
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="chat-scroll">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {history.error && <ErrorNote error={history.error} onRetry={() => void history.refetch()} />}
          {messages.length === 0 && !sending && (
            <div className="flex flex-col items-center gap-5 py-12 text-center" data-testid="chat-empty">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                <Archive className="size-6" aria-hidden />
              </span>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Wie kann ich helfen?</h1>
                <p className="mt-1 text-muted-foreground">
                  Halten Sie Entscheidungen fest, stellen Sie Fragen an Ihr Archiv oder ziehen Sie Dokumente einfach in dieses Fenster.
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
          {messages.map((m) => (
            <ChatBubble key={m.id} message={m} pending={m.id.startsWith('pending-')} />
          ))}
          {sending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="chat-loading">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Archivist denkt nach …
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t bg-background px-4 py-3">
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
            className="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:outline-none"
          />
          <Button type="submit" size="icon" disabled={sending || !text.trim()} aria-label="Senden" data-testid="chat-send">
            <SendHorizontal aria-hidden />
          </Button>
        </form>
        <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-muted-foreground">
          Dateien (PDF, Word, PowerPoint, Excel, Text, E-Mail, Bilder) können Sie auch einfach in das Fenster ziehen.
        </p>
      </div>
    </div>
  );
}
