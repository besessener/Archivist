'use client';

import { useState } from 'react';
import { Check, Link2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import type { ActionRecord } from '@/lib/types';

/** A link suggestion after capturing (#283) – other relation proposals keep their full card. */
export const isLinkSuggestion = (action: ActionRecord) => action.actionType === 'confirm_relation' && action.proposedParameters.offered === true;

/** Link suggestions under an answer that captured something (#283); ignored ones stay in the link proposals under Insights. */
export function LinkSuggestions({ actions }: { actions: ActionRecord[] }) {
  const [state, setState] = useState<Record<string, ActionRecord>>({});
  const { run, busy } = useRun();
  const [working, setWorking] = useState<string | null>(null);
  const confirm = async (a: ActionRecord) => {
    setWorking(a.id);
    const out = await run(() => call('actions:resolve', { decision: 'approve', actionId: a.id, confirmed: true, strongConfirmed: false }), {
      success: 'Verknüpft. Rückgängig im Änderungsprotokoll.',
    });
    setWorking(null);
    if (out) setState((s) => ({ ...s, [a.id]: out }));
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="chat-link-suggestions">
      <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Link2 className="size-3.5" aria-hidden /> Passende Verknüpfungen
      </p>
      <ul className="flex flex-col gap-1.5">
        {actions.map((orig) => {
          const a = state[orig.id] ?? orig;
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-2" data-testid="chat-link-suggestion" data-status={a.status}>
              {a.status === 'proposed' ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  title={a.rationale}
                  onClick={() => void confirm(a)}
                  data-testid="chat-link-suggestion-confirm"
                >
                  {working === a.id ? <Loader2 className="animate-spin" aria-hidden /> : <Link2 aria-hidden />} {a.label}
                </Button>
              ) : (
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  {a.status === 'executed' && <Check className="size-4 text-success" aria-hidden />}
                  {a.label.replace(/ – verknüpfen\?$| verknüpfen\?$/, '')}:{' '}
                  {a.status === 'executed' ? 'verknüpft' : a.status === 'rejected' ? 'abgelehnt' : 'nicht mehr aktuell'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
