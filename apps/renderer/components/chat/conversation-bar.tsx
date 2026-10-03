'use client';

import { useState } from 'react';
import { MessageSquarePlus, Pencil } from 'lucide-react';
import type { IpcOutput } from '@archivist/shared';
import { AgentModeToggle } from '@/components/agent/mode-toggle';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { chatRequests } from '@/lib/chat-requests';
import { call } from '@/lib/ipc';
import { formatDateTime } from '@/lib/format';
import { useRun } from '@/lib/use-run';

type Conversation = IpcOutput<'chat:conversations'>[number];

/** Conversation choice, „Neu“, „Umbenennen“ and the agent mode of the selected conversation. */
export function ConversationBar({
  conversations,
  conversationId,
  onNew,
  onRenamed,
}: {
  conversations: Conversation[];
  conversationId: string | null;
  onNew: () => void;
  onRenamed: () => void;
}) {
  const { run } = useRun();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const currentTitle = conversations.find((conversation) => conversation.id === conversationId)?.title ?? '';

  async function saveRename() {
    if (!conversationId || !renameValue.trim()) return;
    const renamed = await run(() => call('chat:renameConversation', { id: conversationId, title: renameValue.trim() }), {
      errorTitle: 'Umbenennen fehlgeschlagen',
      success: 'Unterhaltung umbenannt.',
    });
    if (!renamed) return;
    setRenameOpen(false);
    onRenamed();
  }

  return (
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
          {conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.title || 'Unterhaltung'} · {formatDateTime(conversation.updatedAt)}
            </option>
          ))}
        </Select>
      </div>
      <Button variant="outline" size="sm" onClick={onNew} data-testid="chat-new">
        <MessageSquarePlus aria-hidden /> Neu
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setRenameValue(currentTitle);
          setRenameOpen(true);
        }}
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
