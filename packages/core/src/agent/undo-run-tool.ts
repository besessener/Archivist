import { z } from 'zod';
import { defineTool, type AgentTool } from './registry';
import type { AgentRunService, UndoRunResult } from './runs';

interface UndoRunDeps {
  runs: AgentRunService;
  /** Undoes a run and records the correction. */
  undoRun: (runId: string) => Promise<UndoRunResult>;
}

export function undoPreviousRunTool({ runs, undoRun }: UndoRunDeps): AgentTool {
  return defineTool({
    name: 'undo_previous_run',
    description:
      'Macht die Änderungen des vorigen Agentenlaufs in diesem Gespräch rückgängig (in umgekehrter Reihenfolge, mit Konfliktprüfung) – nur auf Wunsch des Benutzers.',
    schema: z.object({}),
    risk: 'write',
    label: () => 'Mache den vorigen Lauf rückgängig',
    run: async (_args, ctx) => {
      if (!ctx.conversationId) return { content: 'Nur im Gespräch möglich.', isError: true };
      const previous = runs.list({ conversationId: ctx.conversationId, limit: 10 }).find((r) => r.id !== ctx.runId && r.undoable > 0);
      if (!previous) return { content: 'Es gibt keinen vorigen Lauf mit rückgängig zu machenden Änderungen.', summary: 'nichts zu tun' };
      const result = await undoRun(previous.id);
      return {
        content: `${result.message}${result.conflicts.length ? ` Konflikte: ${result.conflicts.join(' ')}` : ''}`,
        summary: result.message,
        isError: !result.undone && result.failed > 0,
      };
    },
  });
}
