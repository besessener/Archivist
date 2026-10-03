import type { LlmTransmission } from '@archivist/shared';
import { desc, lt } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { llmTransmissions } from '../../db/schema';
import { newId, nowIso } from '../../util/ids';

export type Transmission = Omit<LlmTransmission, 'id' | 'at'>;

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

  /** Deletes entries older than `days` days; returns how many. */
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.ctx.database.db.delete(llmTransmissions).where(lt(llmTransmissions.at, cutoff)).run().changes;
  }

  list(limit: number): LlmTransmission[] {
    return this.ctx.database.db.select().from(llmTransmissions).orderBy(desc(llmTransmissions.at)).limit(limit).all();
  }
}
