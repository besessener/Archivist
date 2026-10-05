import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseService } from './db/database';
import type { Logger } from './util/logger';
import { noteCreated, type CreatedEntry } from './util/origin-scope';

export interface DataPaths {
  /** Document store: archive, inbox, quarantine, trash, exports. */
  root: string;
  /** Application state: database, index, config, logs, backups, restore marker; equals `root` with ARCHIVIST_DATA_DIR. */
  appData: string;
  archive: string;
  database: string;
  index: string;
  config: string;
  logs: string;
  backups: string;
  inbox: string;
  quarantine: string;
  /** Documents moved to the trash, until restored or the trash is emptied. */
  trash: string;
}

export interface DataLocations {
  /** Folder of the document store (default: Documents/Archivist). */
  root: string;
  /** Folder of the application state (default: the OS per-user data folder); omitted = everything below `root`. */
  appDataRoot?: string;
  archiveOverride?: string;
}

export function resolveDataPaths({ root, appDataRoot, archiveOverride }: DataLocations): DataPaths {
  const resolvedRoot = path.resolve(root);
  const appData = appDataRoot ? path.resolve(appDataRoot) : resolvedRoot;
  return {
    root: resolvedRoot,
    appData,
    archive: archiveOverride ? path.resolve(archiveOverride) : path.join(resolvedRoot, 'archive'),
    database: path.join(appData, 'database'),
    index: path.join(appData, 'index'),
    config: path.join(appData, 'config'),
    logs: path.join(appData, 'logs'),
    backups: path.join(appData, 'backups'),
    inbox: path.join(resolvedRoot, 'inbox'),
    quarantine: path.join(resolvedRoot, 'quarantine'),
    trash: path.join(resolvedRoot, 'trash'),
  };
}

/** Creates the default directory structure (idempotent). */
export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of Object.values(paths) as string[]) fs.mkdirSync(dir, { recursive: true });
}

export type ChangeScope =
  | 'documents'
  | 'decisions'
  | 'openItems'
  | 'events'
  | 'notifications'
  | 'insights'
  | 'jobs'
  | 'scanner'
  | 'knowledge'
  | 'settings'
  | 'chat'
  | 'reminders'
  | 'contradictions'
  | 'audit'
  | 'agent'
  | 'speech'
  | 'status';

/** Event bus: services report data changes, the host layer forwards them to the renderer. */
export class EventBus extends EventEmitter {
  changed(...scopes: ChangeScope[]): void {
    this.emit('data:changed', { scopes });
  }

  /** A knowledge entry was created (decision, open item, event, note): link methods react to it (#272). */
  created(entry: CreatedEntry): void {
    noteCreated(entry);
    this.emit('entry:created', entry);
  }
}

export interface AppContext {
  paths: DataPaths;
  database: DatabaseService;
  logger: Logger;
  events: EventBus;
}
