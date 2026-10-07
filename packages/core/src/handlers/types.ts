import type { IpcChannel, IpcOutput, IpcParsedInput, UpdateStatus } from '@archivist/shared';

/** App updates; only the Electron main process can check, download and install them. */
export interface UpdateApi {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  /** Closes the application shortly after the answer was sent and runs the installer. */
  install(): void;
}

/** Operating-system-level functions that only the Electron main process can provide. */
export interface HostApi {
  version: string;
  platform: string;
  selectDirectory(title?: string): Promise<string | null>;
  /** Opens a file with the default application; returns an error text or ''. */
  openPath(absPath: string): Promise<string>;
  revealPath(absPath: string): void;
  secretBackend?: () => { available: boolean; backend: string };
  /** Save dialog; returns the chosen path or null (exports of the agent, #311). */
  saveFile?(defaultName: string): Promise<string | null>;
  /** Restarts the application shortly after the answer was sent (a restore takes effect on start). */
  restartApp?(): void;
  updates?: UpdateApi;
}

type Handler<C extends IpcChannel> = (input: IpcParsedInput<C>) => Promise<IpcOutput<C>> | IpcOutput<C>;

export type HandlerMap = { [C in IpcChannel]: Handler<C> };

/** Every handler of the channels whose names start with one of the prefixes, e.g. `HandlerGroup<'app' | 'settings'>`. */
export type HandlerGroup<Prefix extends string> = { [C in Extract<IpcChannel, `${Prefix}:${string}`>]: Handler<C> };

/** Audit trigger of every change made through the UI. */
export const UI_TRIGGER = 'ui';
