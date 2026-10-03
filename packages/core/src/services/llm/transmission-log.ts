import type { LlmTransmission } from '@archivist/shared';
import { desc } from 'drizzle-orm';
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

  list(limit: number): LlmTransmission[] {
    return this.ctx.database.db.select().from(llmTransmissions).orderBy(desc(llmTransmissions.at)).limit(limit).all();
  }
}
