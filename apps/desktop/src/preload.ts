import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { EVENT_CHANNELS, IPC_CHANNELS, type ArchivistBridge, type EventChannel, type IpcChannel } from '@archivist/shared';

/**
 * Sichere Preload-Bridge: stellt dem Renderer ausschließlich die explizite IPC-Allowlist bereit.
 * Kein Zugriff auf Node.js, Dateisystem, Shell oder Datenbank.
 */
const channels = new Set<string>(IPC_CHANNELS);
const events = new Set<string>(EVENT_CHANNELS);

const bridge: ArchivistBridge = {
  async invoke(channel: IpcChannel, input?: unknown) {
    if (!channels.has(channel)) {
      return { ok: false, error: { category: 'permission_error', message: `Kanal nicht erlaubt: ${String(channel)}`, retryable: false } } as never;
    }
    try {
      return (await ipcRenderer.invoke(channel, input ?? {})) as never;
    } catch (err) {
      return {
        ok: false,
        error: {
          category: 'validation_error',
          message: 'Die Anfrage an den lokalen Dienst ist fehlgeschlagen.',
          retryable: true,
          details: err instanceof Error ? err.message : String(err),
        },
      } as never;
    }
  },
  on(channel: EventChannel, listener: (payload: unknown) => void) {
    if (!events.has(channel)) return () => undefined;
    const wrapped = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
};

contextBridge.exposeInMainWorld('archivist', bridge);
