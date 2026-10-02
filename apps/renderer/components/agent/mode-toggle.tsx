'use client';

import { useId } from 'react';
import type { AgentMode } from '@archivist/shared';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { useSettings } from '@/lib/use-settings';
import { cn } from '@/lib/utils';

const MODE_LABEL: Record<AgentMode, string> = { auto: 'Auto', ask: 'Fragen' };
const HINT =
  'Auto führt Änderungen selbst aus (protokolliert, rückgängig machbar). Fragen bereitet jede Änderung als Vorschlag vor. Löschen, Originaldateien, Datenschutz und Massenaktionen fragen immer.';

/** Effective agent mode of the conversation, switchable for this conversation only (#298). */
export function AgentModeToggle({ conversationId }: { conversationId: string | null }) {
  const hintId = useId();
  const { settings } = useSettings();
  const { run, busy } = useRun();
  const state = useQuery('agent:conversation', conversationId ? { conversationId } : {}, { scopes: ['settings', 'agent'] });
  const settingMode = settings?.agent.mode ?? 'auto';
  // without a conversation (new one) the setting applies
  const effective: AgentMode = conversationId ? (state.data?.mode ?? settingMode) : settingMode;
  const override = conversationId ? (state.data?.override ?? null) : null;

  async function choose(mode: AgentMode) {
    if (!conversationId || mode === effective) return;
    // choosing the mode of the setting goes back to the setting
    const out = await run(() => call('agent:setConversationMode', { conversationId, mode: mode === settingMode ? null : mode }), {
      errorTitle: 'Modus konnte nicht geändert werden',
    });
    if (out) void state.refetch();
  }

  return (
    <div className="flex items-center gap-1.5" title={HINT}>
      <div
        role="group"
        aria-label="Agentenmodus dieser Unterhaltung"
        aria-describedby={hintId}
        className="inline-flex rounded-md border bg-muted p-0.5"
        data-testid="agent-mode"
      >
        {(['auto', 'ask'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={effective === m}
            disabled={busy || !conversationId}
            onClick={() => void choose(m)}
            data-testid={`agent-mode-${m}`}
            className={cn(
              'rounded px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed',
              effective === m && 'bg-background text-foreground shadow-xs',
            )}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      {override && (
        <span className="text-[11px] text-muted-foreground" data-testid="agent-mode-override">
          nur hier
        </span>
      )}
      <span id={hintId} className="sr-only">
        {HINT}
        {!conversationId ? ' Für eine neue Unterhaltung gilt die Einstellung; umschalten kannst du nach der ersten Nachricht.' : ''}
      </span>
    </div>
  );
}
