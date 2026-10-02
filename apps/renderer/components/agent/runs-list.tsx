'use client';

import { useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import type { AgentRun, AgentRunStatus } from '@archivist/shared';
import { EmptyState, ErrorNote, Field, Loading } from '@/components/common/states';
import { Section } from '@/components/settings/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { LinkMethodsSection } from './link-methods';
import { RunCard } from './run-card';
import { normalizeRun, RUN_STATUS } from './run-utils';

const BACKGROUND_JOBS: Array<['inbox' | 'archive_check' | 'links', string]> = [
  ['inbox', 'Eingang sortieren'],
  ['archive_check', 'Archivprüfung auswerten'],
  ['links', 'Verknüpfungen vorschlagen'],
];

/** Agent runs with filter, steps, undo and manual start of background runs (#299). */
export function AgentRunsList({ focusRunId }: { focusRunId?: string | null }) {
  const [trigger, setTrigger] = useState<'' | 'chat' | 'background'>('');
  const [status, setStatus] = useState<'' | AgentRunStatus>('');
  const { run, busy } = useRun();
  const [backgroundMessage, setBackgroundMessage] = useState<string | null>(null);
  const query = useQuery('agent:runs', { limit: 200, ...(trigger ? { trigger } : {}), ...(status ? { status } : {}) }, { scopes: ['agent'] });
  const runs = useMemo(() => (query.data ?? []).map(normalizeRun).filter((agentRun): agentRun is AgentRun => agentRun !== null), [query.data]);

  return (
    <div className="flex flex-col gap-4">
      <Section title="Hintergrund-Lauf starten" description="Startet einen Lauf sofort, unabhängig vom Zeitplan.">
        <div className="flex flex-wrap gap-2">
          {BACKGROUND_JOBS.map(([kind, label]) => (
            <Button
              key={kind}
              variant="outline"
              size="sm"
              disabled={busy}
              data-testid={`agent-run-bg-${kind}`}
              onClick={async () => {
                const started = await run(() => call('agent:runBackground', { kind }), { errorTitle: 'Start fehlgeschlagen' });
                if (!started) return;
                setBackgroundMessage(started.message);
                void query.refetch();
              }}
            >
              <Play aria-hidden /> {label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground" role="status" data-testid="agent-run-bg-message">
          {backgroundMessage ?? 'Der Fortschritt erscheint unter „Verarbeitung“, das Ergebnis in der Liste unten.'}
        </p>
      </Section>

      <LinkMethodsSection />

      <Section title="Agentenläufe" description="Was Archivist als Agent getan hat – im Chat und im Hintergrund. Jede Änderung ist protokolliert.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Auslöser" htmlFor="runs-trigger">
            <Select id="runs-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value as typeof trigger)} data-testid="agent-runs-trigger">
              <option value="">alle</option>
              <option value="chat">Chat</option>
              <option value="background">Hintergrund</option>
            </Select>
          </Field>
          <Field label="Status" htmlFor="runs-status">
            <Select id="runs-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} data-testid="agent-runs-status">
              <option value="">alle</option>
              {(Object.keys(RUN_STATUS) as AgentRunStatus[]).map((option) => (
                <option key={option} value={option}>
                  {RUN_STATUS[option].label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {query.error && <ErrorNote error={query.error} onRetry={() => void query.refetch()} />}
        {!query.data && query.loading && <Loading />}
        {query.data && runs.length === 0 && (
          <EmptyState title="Keine Agentenläufe" description="Sobald Archivist als Agent arbeitet, erscheinen die Läufe hier." />
        )}
        {runs.length > 0 && (
          <ul className="flex flex-col gap-2" data-testid="agent-runs">
            {runs.map((agentRun) => (
              <RunCard key={agentRun.id} run={agentRun} initiallyOpen={agentRun.id === focusRunId} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
