import type { AppErrorInfo, ArchivistBridge, ErrorCategory, IpcChannel, IpcInput, IpcOutput } from '@archivist/shared';

declare global {
  interface Window {
    archivist?: ArchivistBridge;
  }
}

const CATEGORY_TITLES: Record<ErrorCategory, string> = {
  validation_error: 'Ungültige Eingabe',
  database_error: 'Datenbankfehler',
  database_corrupt: 'Datenbank beschädigt',
  filesystem_error: 'Dateifehler',
  parser_error: 'Datei konnte nicht gelesen werden',
  llm_error: 'Fehler bei der KI-Verbindung',
  network_error: 'Netzwerkfehler',
  permission_error: 'Keine Berechtigung',
  scan_error: 'Fehler bei der Dokumentensuche',
  archive_conflict: 'Konflikt beim Archivieren',
  native_module_error: 'Fehler in einer Systemkomponente',
  internal_error: 'Unerwarteter Fehler',
};

export class IpcError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details: string | undefined;
  readonly title: string;

  constructor(info: AppErrorInfo) {
    super(info.message || CATEGORY_TITLES[info.category]);
    this.name = 'IpcError';
    this.category = info.category;
    this.retryable = info.retryable;
    this.details = info.details;
    this.title = CATEGORY_TITLES[info.category];
  }
}

export function getBridge(): ArchivistBridge | null {
  if (typeof window === 'undefined') return null;
  return window.archivist ?? null;
}

/** Calls an IPC channel and throws an IpcError with a German message on errors. */
export async function call<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcOutput<C>> {
  const bridge = getBridge();
  if (!bridge) {
    throw new IpcError({
      category: 'permission_error',
      message: 'Die Verbindung zur Archivist-App ist nicht verfügbar.',
      retryable: false,
    });
  }
  let result;
  try {
    result = await bridge.invoke(channel, input ?? ({} as IpcInput<C>));
  } catch (err) {
    throw new IpcError({
      category: 'internal_error',
      message: err instanceof Error ? err.message : 'Unbekannter Fehler bei der Kommunikation mit der App.',
      retryable: true,
    });
  }
  if (!result.ok) throw new IpcError(result.error);
  return result.data;
}

export function errorMessage(err: unknown): string {
  if (err instanceof IpcError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Es ist ein unbekannter Fehler aufgetreten.';
}
