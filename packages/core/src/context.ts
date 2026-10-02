import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseService } from './db/database';
import type { Logger } from './util/logger';

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
  const r = path.resolve(root);
  return {
    root: r,
    archive: archiveOverride ? path.resolve(archiveOverride) : path.join(r, 'archive'),
    database: path.join(r, 'database'),
    index: path.join(r, 'index'),
    config: path.join(r, 'config'),
    logs: path.join(r, 'logs'),
    backups: path.join(r, 'backups'),
    inbox: path.join(r, 'inbox'),
    quarantine: path.join(r, 'quarantine'),
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
  | 'status';

/** Event bus: services report data changes, the host layer forwards them to the renderer. */
export class EventBus extends EventEmitter {
  changed(...scopes: ChangeScope[]): void {
    this.emit('data:changed', { scopes });
  }
}

export interface AppContext {
  paths: DataPaths;
  database: DatabaseService;
  logger: Logger;
  events: EventBus;
}
