import type { AppContext } from '../context';
import type { WorkerPool } from '../workers/pool';
import type { ArchiveFileOps } from './archive-files';
import type { ArchiveLocks } from './archive-locks';
import type { AuditService } from './audit';
import type { CategoryService } from './categories';
import type { DocumentService } from './documents';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { NotificationService } from './notifications';
import type { PersonService } from './persons';
import type { SettingsService } from './settings';

/** Services and shared state the parts of the archive service work with. */
export interface ArchiveDeps {
  ctx: AppContext;
  settings: SettingsService;
  docs: DocumentService;
  categories: CategoryService;
  graph: KnowledgeGraphService;
  persons: PersonService;
  audit: AuditService;
  notifications: NotificationService;
  pool: WorkerPool;
  locks: ArchiveLocks;
  files: ArchiveFileOps;
}
