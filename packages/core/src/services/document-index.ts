import type { IndexStatus } from '@archivist/shared';
import type { AppContext } from '../context';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { DocumentAccess } from './document-model';
import type { JobContext } from './jobs';

/** Job type that re-indexes archived documents missing from the search index (#220). */
export const DOCUMENT_REINDEX_JOB = 'documents.reindex';

const YIELD_EVERY = 50;
const ARCHIVED = `('archived', 'indexed_only')`;

/** Finds archived documents without index entries (a crash or an error between archiving and indexing) and indexes them again. */
export class DocumentIndexRepair {
  constructor(
    private readonly ctx: AppContext,
    private readonly documents: Pick<DocumentAccess, 'indexDocument'>,
  ) {}

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  missingIds(): string[] {
    const rows = this.sqlite
      .prepare(
        `SELECT d.id AS id FROM documents d WHERE d.status IN ${ARCHIVED} AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.entity_id = d.id) ORDER BY d.id`,
      )
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private isIndexed(id: string): boolean {
    return this.sqlite.prepare('SELECT 1 FROM chunks WHERE entity_id = ? LIMIT 1').get(id) !== undefined;
  }

  status(): IndexStatus {
    const { n } = this.sqlite.prepare(`SELECT count(*) AS n FROM documents WHERE status IN ${ARCHIVED}`).get() as { n: number };
    return { documents: n, missing: this.missingIds().length };
  }

  /** Indexes the missing documents; indexing never throws, so success is checked against the index. */
  async rebuild(job: JobContext<Record<string, never>>): Promise<{ summary: string }> {
    const missing = this.missingIds();
    let failed = 0;
    for (const [index, id] of missing.entries()) {
      job.throwIfCancelled();
      job.report(index / missing.length, `${index} von ${missing.length} Dokumenten indexiert`);
      await this.documents.indexDocument(id);
      if (!this.isIndexed(id)) failed += 1;
      if (index % YIELD_EVERY === YIELD_EVERY - 1) await yieldToEventLoop();
    }
    const done = missing.length - failed;
    return { summary: `${done} von ${missing.length} Dokumenten indexiert${failed ? `, ${failed} fehlgeschlagen` : ''}` };
  }
}
