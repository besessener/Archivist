import { eq } from 'drizzle-orm';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { AppContext } from '../context';
import { documentLshBands, documentMinhash } from '../db/schema';
import type { JobContext } from './jobs';
import { areNearDuplicates, bandBuckets, minhashSignature, signatureFromBytes, signatureToBytes, type Signature } from '../util/minhash';

/** Documents that take part in the near-duplicate comparison (inbox included, failed and trashed ones not). */
const COMPARED_STATUSES = ['archived', 'indexed_only', 'proposed'];
const IN_COMPARED = COMPARED_STATUSES.map((status) => `'${status}'`).join(', ');

/** Documents per backfill step. */
export const BACKFILL_BATCH = 200;

/** Shingled MinHash signatures with an LSH band table: finds documents with nearly the same text without comparing all pairs (#230). */
export class NearDuplicateIndex {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.database.db;
  }

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  /** Stores the signature of the document's current text; a text too short to compare leaves no entry. */
  record(documentId: string, text: string): void {
    const signature = minhashSignature(text);
    this.ctx.database.transaction(() => {
      this.remove(documentId);
      if (!signature) return;
      this.db.insert(documentMinhash).values({ documentId, signature: signatureToBytes(signature) }).run();
      this.db
        .insert(documentLshBands)
        .values(bandBuckets(signature).map((bucket, band) => ({ documentId, band, bucket })))
        .run();
    });
  }

  remove(documentId: string): void {
    this.db.delete(documentLshBands).where(eq(documentLshBands.documentId, documentId)).run();
    this.db.delete(documentMinhash).where(eq(documentMinhash.documentId, documentId)).run();
  }

  signatureOf(documentId: string): Signature | null {
    const row = this.db.select({ signature: documentMinhash.signature }).from(documentMinhash).where(eq(documentMinhash.documentId, documentId)).get();
    return row ? signatureFromBytes(row.signature) : null;
  }

  /** Whether two documents have nearly the same text (false if one of them has no signature). */
  areSimilar(a: string, b: string): boolean {
    const first = this.signatureOf(a);
    const second = first && this.signatureOf(b);
    return Boolean(first && second && areNearDuplicates(first, second));
  }

  /** Groups of documents whose texts are near-duplicates of each other (transitively); at least two members each. */
  groups(): string[][] {
    const pairs = this.sqlite
      .prepare(
        `SELECT DISTINCT a.document_id AS first, b.document_id AS second
         FROM document_lsh_bands a
         JOIN document_lsh_bands b ON b.band = a.band AND b.bucket = a.bucket AND b.document_id > a.document_id
         JOIN documents da ON da.id = a.document_id AND da.status IN (${IN_COMPARED})
         JOIN documents db ON db.id = b.document_id AND db.status IN (${IN_COMPARED})`,
      )
      .all() as Array<{ first: string; second: string }>;
    const signatures = new Map<string, Signature | null>();
    const signature = (id: string) => {
      if (!signatures.has(id)) signatures.set(id, this.signatureOf(id));
      return signatures.get(id)!;
    };
    const parent = new Map<string, string>();
    const root = (id: string): string => {
      const up = parent.get(id) ?? id;
      return up === id ? id : root(up);
    };
    for (const { first, second } of pairs) {
      const a = signature(first);
      const b = signature(second);
      if (a && b && areNearDuplicates(a, b)) parent.set(root(first), root(second));
    }
    const members = new Map<string, string[]>();
    for (const id of new Set(pairs.flatMap((pair) => [pair.first, pair.second]))) members.set(root(id), [...(members.get(root(id)) ?? []), id]);
    return [...members.values()].filter((group) => group.length > 1);
  }

  /** The next documents after `afterId` (by id) with a comparable text but no signature yet, for the resumable backfill. */
  unindexedAfter(afterId: string): Array<{ id: string; text: string }> {
    return this.sqlite
      .prepare(
        `SELECT d.id AS id, d.extracted_text AS text FROM documents d
         WHERE d.id > ? AND length(d.extracted_text) > 200 AND d.status IN (${IN_COMPARED})
           AND NOT EXISTS (SELECT 1 FROM document_minhash m WHERE m.document_id = d.id)
         ORDER BY d.id LIMIT ?`,
      )
      .all(afterId, BACKFILL_BATCH) as Array<{ id: string; text: string }>;
  }
}

/** Job type that gives documents read before signatures existed theirs (#230). */
export const NEAR_DUPLICATE_BACKFILL_JOB = 'documents.near-duplicates';

const YIELD_EVERY = 10;

/** Signs the documents without a signature in id order; the checkpoint is the last id, so a quit or crash resumes there. */
export async function backfillNearDuplicates(index: NearDuplicateIndex, job: JobContext<Record<string, never>>): Promise<{ summary: string }> {
  const stored = (job.checkpoint ?? {}) as { after?: string; indexed?: number };
  let after = stored.after ?? '';
  let indexed = stored.indexed ?? 0;
  for (let batch = index.unindexedAfter(after); batch.length > 0; batch = index.unindexedAfter(after)) {
    for (const [position, document] of batch.entries()) {
      job.throwIfCancelled();
      index.record(document.id, document.text);
      if (position % YIELD_EVERY === YIELD_EVERY - 1) await yieldToEventLoop();
    }
    after = batch.at(-1)!.id;
    indexed += batch.length;
    job.saveCheckpoint({ after, indexed });
    job.report(null, `${indexed} Dokumente verglichen`);
  }
  return { summary: indexed === 1 ? '1 Dokument verglichen' : `${indexed} Dokumente verglichen` };
}
