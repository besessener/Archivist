'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import { AgentProgress } from '@archivist/shared';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { subscribe } from '@/lib/events';
import { RUN_STATUS, StepList, usageLine } from './run-utils';

type Progress = AgentProgress;

function parseProgress(payload: unknown): Progress | null {
  const result = AgentProgress.safeParse(payload);
  return result.success ? result.data : null;
}

/** Live state of a conversation's agent run (#300); while `pending` in a new conversation, the first running chat run is adopted. */
export function useAgentProgress({ conversationId, pending }: { conversationId: string | null; pending: boolean }): Progress | null {
  const [progress, setProgress] = useState<Progress | null>(null);
  const adopted = useRef<string | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    let alive = true;
    setProgress(null);
    adopted.current = null;
    if (conversationId) {
      call('agent:conversation', { conversationId })
        .then((state) => {
          if (!alive || !state.activeRun) return;
          const p = parseProgress(state.activeRun);
          // an event may already have arrived in the meantime – it is newer
          if (p) setProgress((prev) => prev ?? p);
        })
        .catch(() => undefined);
    } else if (pendingRef.current) {
      // a new conversation whose id is not known here yet (e.g. back from another tab): adopt its running run
      call('agent:active', {})
        .then((runs) => {
          const p = runs.map(parseProgress).findLast((r) => r !== null && r.conversationId !== null && r.status === 'running') ?? null;
          if (!alive || !p || adopted.current !== null) return;
          adopted.current = p.runId;
          setProgress((prev) => prev ?? p);
        })
        .catch(() => undefined);
    }
    const off = subscribe('agent:progress', (payload) => {
      const p = parseProgress(payload);
      if (!p || p.conversationId === null) return;
      if (p.conversationId === conversationId) {
        setProgress(p);
        return;
      }
      if (conversationId === null && pendingRef.current && (adopted.current === null || adopted.current === p.runId)) {
        adopted.current = p.runId;
        setProgress(p);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [conversationId]);

  // A new request starts: forget the finished run shown before.
  useEffect(() => {
    if (pending) setProgress((prev) => (prev && prev.status !== 'running' ? null : prev));
    else adopted.current = null;
  }, [pending]);

  return progress;
}

const PREVIEW_CHARS = 600;

/** Replaces „Archivist denkt nach …“ while a run works: steps in plain language, streamed text, tokens and cost. */
export function AgentLiveView({ progress, onStop, stopping }: { progress: Progress | null; onStop: () => void; stopping?: boolean }) {
  const steps = progress?.steps ?? [];
  const last = steps[steps.length - 1];
  // calm announcement: the current step label (and its outcome once done), not every token
  const announcement = useMemo(() => {
    if (!progress) return 'Archivist denkt nach.';
    if (progress.status !== 'running') return `Lauf beendet: ${RUN_STATUS[progress.status].label}.`;
    if (!last) return 'Archivist denkt nach.';
    return last.outcome === 'running' ? `${last.label} …` : `${last.label}${last.summary ? `: ${last.summary}` : ''}.`;
  }, [progress, last]);
  const preview = progress?.text ? (progress.text.length > PREVIEW_CHARS ? `… ${progress.text.slice(-PREVIEW_CHARS)}` : progress.text) : '';
  const running = !progress || progress.status === 'running';

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm" data-testid="chat-loading">
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="agent-live-announcement">
        {announcement}
      </div>
      <div className="flex items-center gap-2 text-muted-foreground">
        {running && <Loader2 className="size-4 animate-spin" aria-hidden />}
        <span className="flex-1">{running ? (steps.length > 0 ? 'Archivist arbeitet …' : 'Archivist denkt nach …') : RUN_STATUS[progress.status].label}</span>
        {progress && (
          <span className="text-[11px]" data-testid="agent-live-usage">
            {usageLine({ usage: progress.usage, costUsd: progress.costUsd })}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={onStop} disabled={stopping || !running} data-testid="chat-cancel">
          <Square aria-hidden /> Stopp
        </Button>
      </div>
      {steps.length > 0 && <StepList steps={steps} />}
      {preview && (
        <p className="max-h-40 overflow-hidden whitespace-pre-wrap break-words border-l-2 pl-2 text-muted-foreground" data-testid="agent-live-text">
          {preview}
        </p>
      )}
    </div>
  );
}
