'use client';

import { useCallback, useMemo, useState } from 'react';
import { CHAT_ATTACHMENT_LIMIT, CHAT_CONTENT_MAX_BYTES, type ChatAttachOutcome } from '@archivist/shared';
import { formatBytes } from './format';
import { filePaths } from './file-paths';
import { call, errorMessage } from './ipc';

/** A file picked for the next message: being imported, attached as a document, or refused with a reason. */
export type PendingAttachment =
  | { key: string; name: string; state: 'importing' }
  | { key: string; name: string; state: 'ready'; documentId: string; ext: string }
  | { key: string; name: string; state: 'rejected'; reason: string };

/** A file to import: by its path, or by its content when it has no place on disk (pasted image, browser). */
type Source = { key: string; name: string } & ({ path: string } | { file: File });

const LIMIT_REASON = `Höchstens ${CHAT_ATTACHMENT_LIMIT} Dateien pro Nachricht.`;
const TOO_LARGE_REASON = `Die Datei ist zu groß (ohne Dateipfad höchstens ${formatBytes(CHAT_CONTENT_MAX_BYTES)}).`;
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

let counter = 0;
const nextKey = () => `attachment-${++counter}`;

/** Files attached to the message being written; they are imported right away, without leaving the chat. */
export function useChatAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);

  const settle = useCallback((key: string, next: PendingAttachment) => setItems((current) => current.map((item) => (item.key === key ? next : item))), []);

  const settleOutcome = useCallback(
    (key: string, outcome: ChatAttachOutcome) => {
      if (outcome.kind === 'attached') {
        const { documentId, name, ext } = outcome.attachment;
        settle(key, { key, name, state: 'ready', documentId, ext });
      } else settle(key, { key, name: baseName(outcome.path), state: 'rejected', reason: outcome.reason });
    },
    [settle],
  );

  const attachPaths = useCallback(
    async (sources: Array<{ key: string; path: string }>) => {
      if (!sources.length) return;
      try {
        const results = await call('chat:attach', { paths: sources.map((source) => source.path) });
        results.forEach((result, i) => settleOutcome(sources[i]!.key, result));
      } catch (err) {
        for (const { key, path } of sources) settle(key, { key, name: baseName(path), state: 'rejected', reason: errorMessage(err) });
      }
    },
    [settle, settleOutcome],
  );

  const attachContent = useCallback(
    async ({ key, file }: { key: string; file: File }) => {
      if (file.size > CHAT_CONTENT_MAX_BYTES) {
        settle(key, { key, name: file.name, state: 'rejected', reason: TOO_LARGE_REASON });
        return;
      }
      try {
        settleOutcome(key, await call('chat:attachContent', { name: file.name, content: new Uint8Array(await file.arrayBuffer()) }));
      } catch (err) {
        settle(key, { key, name: file.name, state: 'rejected', reason: errorMessage(err) });
      }
    },
    [settle, settleOutcome],
  );

  const add = useCallback(
    async (files: File[]) => {
      const { paths, unknown } = filePaths(files);
      const sources: Source[] = [
        ...paths.map((path) => ({ key: nextKey(), name: baseName(path), path })),
        ...unknown.map((file) => ({ key: nextKey(), name: file.name, file })),
      ];
      const taken = items.filter((item) => item.state !== 'rejected').length;
      const room = Math.max(0, CHAT_ATTACHMENT_LIMIT - taken);
      const accepted = sources.slice(0, room);
      const refused = sources.slice(room).map(({ key, name }) => ({ key, name, state: 'rejected' as const, reason: LIMIT_REASON }));
      setItems((current) => [...current, ...accepted.map(({ key, name }) => ({ key, name, state: 'importing' as const })), ...refused]);
      await Promise.all([
        attachPaths(accepted.filter((source) => 'path' in source)),
        ...accepted.filter((source) => 'file' in source).map((source) => attachContent(source)),
      ]);
    },
    [items, attachPaths, attachContent],
  );

  const remove = useCallback((key: string) => setItems((current) => current.filter((item) => item.key !== key)), []);
  const clear = useCallback(() => setItems([]), []);

  return useMemo(() => {
    const ready = items.filter((item): item is Extract<PendingAttachment, { state: 'ready' }> => item.state === 'ready');
    return { items, ready, importing: items.some((item) => item.state === 'importing'), add, remove, clear };
  }, [items, add, remove, clear]);
}
