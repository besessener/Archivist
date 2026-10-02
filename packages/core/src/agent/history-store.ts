import { and, asc, eq, gt, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context';
import { agentMessages } from '../db/schema';
import { newId, nowIso } from '../util/ids';
import type { ArchivistJson } from '../util/json';
import { withholdWithdrawn } from './history-privacy';
import type { RefStore } from './registry';
import type { ToolDeps } from './tools/common';
import type { AgentMessage } from './types';

/** Writes one run's messages; the user's turn goes in right before the run's first message. */
export interface TurnWriter {
  persist: (runId: string, message: AgentMessage) => void;
  /** A run that failed before its first request still keeps the user's turn in the history. */
  close: (runId: string) => void;
}

/** The provider-neutral, append-only agent history of the conversations. */
export class AgentHistoryStore {
  constructor(
    private readonly ctx: AppContext,
    private readonly deps: Pick<ToolDeps, 'docs' | 'privacy'>,
  ) {}

  /** The history as it may go to the model again: answers naming documents withdrawn since are withheld (#202). */
  replayable(conversationId: string, refs: RefStore): AgentMessage[] {
    return withholdWithdrawn(this.messages(eq(agentMessages.conversationId, conversationId)), this.withdrawnRefs(refs));
  }

  /** Agent messages after a sequence number (tests, debugging). */
  after(conversationId: string, afterSeq: number): AgentMessage[] {
    return this.messages(and(eq(agentMessages.conversationId, conversationId), gt(agentMessages.seq, afterSeq)));
  }

  turnWriter(conversationId: string, userTurn: AgentMessage[]): TurnWriter {
    let written = false;
    const writeUserTurn = (runId: string) => {
      if (written) return;
      written = true;
      for (const message of userTurn) this.append({ conversationId, runId, message });
    };
    return {
      persist: (runId, message) => {
        writeUserTurn(runId);
        this.append({ conversationId, runId, message });
      },
      close: writeUserTurn,
    };
  }

  private messages(where: SQL | undefined): AgentMessage[] {
    return this.ctx.database.db
      .select()
      .from(agentMessages)
      .where(where)
      .orderBy(asc(agentMessages.seq))
      .all()
      .map((r) => r.data as unknown as AgentMessage);
  }

  private append(entry: { conversationId: string; runId: string; message: AgentMessage }): void {
    const db = this.ctx.database.db;
    const last = db
      .select({ seq: agentMessages.seq })
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, entry.conversationId))
      .orderBy(asc(agentMessages.seq))
      .all()
      .at(-1);
    db.insert(agentMessages)
      .values({
        id: newId(),
        conversationId: entry.conversationId,
        seq: (last?.seq ?? 0) + 1,
        runId: entry.runId,
        data: entry.message as unknown as ArchivistJson,
        createdAt: nowIso(),
      })
      .run();
  }

  /** D-refs of documents shared earlier in this conversation that may no longer be shared (excluded, locked or gone). */
  private withdrawnRefs(refs: RefStore): Set<string> {
    const withdrawn = new Set<string>();
    const shared = new Set(refs.state.shared ?? []);
    for (const [ref, id] of Object.entries(refs.state.ids)) {
      if (!ref.startsWith('D') || !shared.has(id)) continue;
      if (!this.deps.docs.findRow(id) || !this.deps.privacy.mayShareDocument(this.deps.docs.get(id))) withdrawn.add(ref);
    }
    return withdrawn;
  }
}
