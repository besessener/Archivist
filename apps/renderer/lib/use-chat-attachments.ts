'use client';

import { useCallback, useMemo, useState } from 'react';
import { CHAT_ATTACHMENT_LIMIT } from '@archivist/shared';
import { filePaths, PATH_UNKNOWN } from './file-paths';
import { call, errorMessage } from './ipc';

/** A file picked for the next message: being imported, attached as a document, or refused with a reason. */
export type PendingAttachment =
  | { key: string; name: string; state: 'importing' }
  | { key: string; name: string; state: 'ready'; documentId: string; ext: string }
  | { key: string; name: string; state: 'rejected'; reason: string };

const LIMIT_REASON = `Höchstens ${CHAT_ATTACHMENT_LIMIT} Dateien pro Nachricht.`;
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

let counter = 0;
const nextKey = () => `attachment-${++counter}`;

/** Files attached to the message being written; they are imported right away, without leaving the chat. */
export function useChatAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);

  const settle = useCallback((key: string, next: PendingAttachment) => setItems((current) => current.map((item) => (item.key === key ? next : item))), []);

  const add = useCallback(
    async (files: File[]) => {
      const { paths, unknown } = filePaths(files);
      const taken = items.filter((item) => item.state !== 'rejected').length;
      const room = Math.max(0, CHAT_ATTACHMENT_LIMIT - taken);
      const accepted = paths.slice(0, room).map((path) => ({ key: nextKey(), path }));
      const refused: PendingAttachment[] = [
        ...unknown.map((name) => ({ key: nextKey(), name, state: 'rejected' as const, reason: PATH_UNKNOWN })),
        ...paths.slice(room).map((path) => ({ key: nextKey(), name: baseName(path), state: 'rejected' as const, reason: LIMIT_REASON })),
      ];
      setItems((current) => [...current, ...accepted.map(({ key, path }) => ({ key, name: baseName(path), state: 'importing' as const })), ...refused]);
      if (!accepted.length) return;
      try {
        const results = await call('chat:attach', { paths: accepted.map((entry) => entry.path) });
        results.forEach((result, i) => {
          const { key } = accepted[i]!;
          if (result.kind === 'attached') {
            const { documentId, name, ext } = result.attachment;
            settle(key, { key, name, state: 'ready', documentId, ext });
          } else settle(key, { key, name: baseName(result.path), state: 'rejected', reason: result.reason });
        });
      } catch (err) {
        for (const { key, path } of accepted) settle(key, { key, name: baseName(path), state: 'rejected', reason: errorMessage(err) });
      }
    },
    [items, settle],
  );

  const remove = useCallback((key: string) => setItems((current) => current.filter((item) => item.key !== key)), []);
  const clear = useCallback(() => setItems([]), []);

  return useMemo(() => {
    const ready = items.filter((item): item is Extract<PendingAttachment, { state: 'ready' }> => item.state === 'ready');
    return { items, ready, importing: items.some((item) => item.state === 'importing'), add, remove, clear };
  }, [items, add, remove, clear]);
}
