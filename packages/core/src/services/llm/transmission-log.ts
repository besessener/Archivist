import type { LlmTransmission } from '@archivist/shared';
import { desc, inArray, lt } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { documents, llmTransmissions } from '../../db/schema';
import { newId, nowIso } from '../../util/ids';

export type Transmission = Omit<LlmTransmission, 'id' | 'at' | 'documents'>;

/** What went to the LLM endpoint (masked, shortened): the user's view of every transmission. */
export class TransmissionLog {
  constructor(private readonly ctx: AppContext) {}

  record(transmission: Transmission): void {
    try {
      this.ctx.database.db
        .insert(llmTransmissions)
        .values({ id: newId(), at: nowIso(), ...transmission })
        .run();
      const { purpose, model, bytes, redactions, success } = transmission;
      this.ctx.logger.info('llm', 'LLM transmission', { purpose, model, bytes, redactions, success });
    } catch (error) {
      // a failing record must not make the call fail
      this.ctx.logger.error('llm', 'Recording the LLM transmission failed', { error });
    }
  }

  /** Newest first; `offset` skips the entries already shown. Document titles are the current ones (null: the document is gone). */
  list({ limit, offset = 0 }: { limit: number; offset?: number }): LlmTransmission[] {
    const rows = this.ctx.database.db.select().from(llmTransmissions).orderBy(desc(llmTransmissions.at)).limit(limit).offset(offset).all();
    const titles = this.titlesOf(rows.flatMap((row) => row.documentIds));
    return rows.map((row) => ({ ...row, documents: row.documentIds.map((id) => ({ id, title: titles.get(id) ?? null })) }));
  }

  /** Deletes entries older than `days` days; returns how many. */
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.ctx.database.db.delete(llmTransmissions).where(lt(llmTransmissions.at, cutoff)).run().changes;
  }

  private titlesOf(ids: string[]): Map<string, string> {
    const unique = [...new Set(ids)];
    const titles = new Map<string, string>();
    for (let start = 0; start < unique.length; start += 500)
      for (const { id, title } of this.ctx.database.db
        .select({ id: documents.id, title: documents.title })
        .from(documents)
        .where(inArray(documents.id, unique.slice(start, start + 500)))
        .all())
        titles.set(id, title);
    return titles;
  }
}
