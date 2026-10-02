import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseService } from './db/database';
import type { Logger } from './util/logger';
import { noteCreated, type CreatedEntry } from './util/origin-scope';

export interface DataPaths {
  root: string;
  archive: string;
  database: string;
  index: string;
  config: string;
  logs: string;
  backups: string;
  inbox: string;
  quarantine: string;
}

export function resolveDataPaths(root: string, archiveOverride?: string): DataPaths {
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    archive: archiveOverride ? path.resolve(archiveOverride) : path.join(resolvedRoot, 'archive'),
    database: path.join(resolvedRoot, 'database'),
    index: path.join(resolvedRoot, 'index'),
    config: path.join(resolvedRoot, 'config'),
    logs: path.join(resolvedRoot, 'logs'),
    backups: path.join(resolvedRoot, 'backups'),
    inbox: path.join(resolvedRoot, 'inbox'),
    quarantine: path.join(resolvedRoot, 'quarantine'),
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
