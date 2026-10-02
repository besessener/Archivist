'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AgentLiveView, useAgentProgress } from '@/components/agent/live-view';
import { ChatComposer } from '@/components/chat/chat-composer';
import { ChatEmpty } from '@/components/chat/chat-empty';
import { ConversationBar } from '@/components/chat/conversation-bar';
import { ChatBubble } from '@/components/chat/message';
import { ErrorNote } from '@/components/common/states';
import { useApp } from '@/lib/app-context';
import { chatRequests, mergeChatMessages, requestsFor } from '@/lib/chat-requests';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useSettings } from '@/lib/use-settings';
import { useRun } from '@/lib/use-run';

type Settings = ReturnType<typeof useSettings>;

/** Says where messages go – also in „vorher fragen“, where chat messages are sent without a further question (#201). */
function aiNoticeFor({ settings, hasApiKey }: Settings): string {
  if (!settings || settings.privacy.llmMode === 'local_only' || !settings.llm.baseUrl || !hasApiKey) return 'Nachrichten bleiben auf diesem Rechner.';
  return `Nachrichten werden zur Auswertung an die KI (${settings.llm.model}) gesendet.`;
}

export default function ChatPage() {
  const { setContextMessage } = useApp();
  const { run } = useRun();
  // Running requests and the selected conversation live outside the page so that they survive switching tabs.
  const { requests, activeConversationId } = useSyncExternalStore(chatRequests.subscribe, chatRequests.getSnapshot, chatRequests.getSnapshot);
  const conversationId = activeConversationId ?? null;
  const [text, setText] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialised = useRef(false);

  const conversations = useQuery('chat:conversations', {}, { scopes: ['chat'] });
  const aiNotice = aiNoticeFor(useSettings());
  const history = useQuery('chat:history', conversationId ? { conversationId } : undefined, {
    scopes: ['chat'],
    enabled: conversationId !== null,
  });

  useEffect(() => {
    if (initialised.current || !conversations.data) return;
    initialised.current = true;
    // ?c=<id>: jump back from an open item into the conversation it came from
    const wanted = new URLSearchParams(window.location.search).get('c');
    const latest = [...conversations.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const target = conversations.data.find((conversation) => conversation.id === wanted);
    // Without a jump back, the previously selected conversation stays (e.g. after switching tabs); on first open, the most recently active one.
    if (target) chatRequests.setActiveConversation(target.id);
    else if (chatRequests.getSnapshot().activeConversationId === undefined) chatRequests.setActiveConversation(latest?.id ?? null);
  }, [conversations.data]);

  const pendingHere = useMemo(() => requestsFor(requests, conversationId), [requests, conversationId]);
  // A request is still running (even if it was sent before switching tabs)
  const sending = pendingHere.some((request) => request.result === null);
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
    const loaded = conversationId ? (history.data ?? []).filter((message) => message.conversationId === conversationId) : [];
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

  useEffect(() => {
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant') ?? null;
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
      const sent = await chatRequests.send(conversationId, content, () =>
        run(() => call('chat:send', { text: content, ...(conversationId ? { conversationId } : {}) }), {
          errorTitle: 'Nachricht konnte nicht gesendet werden',
        }),
      );
      if (sent) void conversations.refetch();
      // Error: put the text back into the input field, unless something new is already there
      else setText((current) => current || content);
    },
    [conversationId, working, run, conversations],
  );

  async function newConversation() {
    const created = await run(() => call('chat:newConversation'));
    if (!created) return;
    chatRequests.setActiveConversation(created.id);
    void conversations.refetch();
    inputRef.current?.focus();
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-page">
      <ConversationBar
        conversations={conversations.data ?? []}
        conversationId={conversationId}
        onNew={() => void newConversation()}
        onRenamed={() => void conversations.refetch()}
      />

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="chat-scroll">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {history.error && <ErrorNote error={history.error} onRetry={() => void history.refetch()} />}
          {messages.length === 0 && !working && (
            <ChatEmpty
              onPrompt={(prompt) => {
                setText(prompt);
                inputRef.current?.focus();
              }}
            />
          )}
          {messages.map((message, i) => (
            <ChatBubble
              key={message.id}
              message={message}
              pending={message.id.startsWith('pending-')}
              onQuickReply={i === messages.length - 1 && message.role === 'assistant' && !working ? (reply) => void send(reply) : undefined}
            />
          ))}
          {working && <AgentLiveView progress={progress} onStop={() => void stop()} stopping={stopping} />}
          <div ref={bottomRef} />
        </div>
      </div>

      <ChatComposer text={text} onTextChange={setText} inputRef={inputRef} working={working} onSend={(raw) => void send(raw)} aiNotice={aiNotice} />
    </div>
  );
}
