'use client';

import { useEffect, useState } from 'react';
import { MARKDOWN_HINT } from '@/components/common/markdown';
import { Field } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { UnknownWikiLinks, WikiTextarea } from './wiki-textarea';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';

/** Edits title and text of a note (#273); Archivist analyses it again afterwards. Undoable in the change log. */
export function NoteEditDialog({
  open,
  onOpenChange,
  note,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  note: { id: string; name: string; description: string | null };
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(note.name);
  const [content, setContent] = useState(note.description ?? '');
  const { run, busy } = useRun();
  useEffect(() => {
    if (!open) return;
    setTitle(note.name);
    setContent(note.description ?? '');
  }, [open, note.name, note.description]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="note-edit-dialog">
        <DialogHeader>
          <DialogTitle>Notiz bearbeiten</DialogTitle>
          <DialogDescription>
            Nach dem Speichern ordnet Archivist die Notiz neu ein (Thema, Projekt, Personen, Tags). Rückgängig im Änderungsprotokoll.
          </DialogDescription>
        </DialogHeader>
        <Field label="Titel" htmlFor="note-edit-title">
          <Input id="note-edit-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} data-testid="note-edit-title" />
        </Field>
        <Field label="Inhalt" htmlFor="note-edit-content" hint={`${MARKDOWN_HINT} Mit [[Name]] verlinkst du andere Einträge.`}>
          <WikiTextarea id="note-edit-content" value={content} rows={8} onChange={setContent} excludeId={note.id} data-testid="note-edit-content" />
        </Field>
        <UnknownWikiLinks text={content} noteId={note.id} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            disabled={busy || !content.trim()}
            data-testid="note-edit-save"
            onClick={async () => {
              const out = await run(() => call('knowledge:updateNote', { id: note.id, title: title.trim() || null, content: content.trim() }), {
                success: 'Notiz gespeichert.',
              });
              if (out) onSaved();
            }}
          >
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
