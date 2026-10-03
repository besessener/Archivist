'use client';

import { useMemo, useState } from 'react';
import { Lightbulb, Play } from 'lucide-react';
import type { InsightChoice, InsightKind, IpcOutput } from '@archivist/shared';
import { LoadMore } from '@/components/common/load-more';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { ContradictionsSection, ResolveContradictionDialog } from '@/components/insights/contradictions';
import { InsightCard, rejectSuccess, type InsightActions } from '@/components/insights/insight-card';
import { AcceptDialog, ChoiceDialog, SnoozeDialog, type PendingChoice } from '@/components/insights/insight-dialogs';
import { LinkageMetrics } from '@/components/knowledge/linkage-metrics';
import { LinkProposals } from '@/components/knowledge/link-proposals';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { INSIGHT_KIND_LABELS } from '@/lib/labels';
import { formatDate } from '@/lib/format';
import { usePagedQuery, usePageWindow } from '@/lib/use-page-window';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { InsightRecord } from '@/lib/types';

type Contradiction = IpcOutput<'contradictions:list'>[number];
type InsightStatus = 'open' | 'accepted' | 'rejected' | 'snoozed';
const STATUS_LABELS: Record<InsightStatus, string> = { open: 'Offen', snoozed: 'Zurückgestellt', accepted: 'Bestätigt', rejected: 'Abgelehnt' };

function groupByKind(insights: InsightRecord[]): Array<[InsightKind, InsightRecord[]]> {
  const byKind = new Map<InsightKind, InsightRecord[]>();
  for (const insight of insights) {
    const list = byKind.get(insight.kind) ?? [];
    list.push(insight);
    byKind.set(insight.kind, list);
  }
  return [...byKind.entries()].sort((a, b) => INSIGHT_KIND_LABELS[a[0]].localeCompare(INSIGHT_KIND_LABELS[b[0]], 'de'));
}

export default function InsightsPage() {
  const [status, setStatus] = useState<InsightStatus>('open');
  const insightWindow = usePageWindow(status);
  const insights = usePagedQuery('insights:list', { status }, insightWindow.window, { scopes: ['insights'] });
  const insightTotal = useQuery('insights:count', { status }, { scopes: ['insights'] });
  const contradictionWindow = usePageWindow('contradictions');
  const contradictions = usePagedQuery('contradictions:list', {}, contradictionWindow.window, { scopes: ['contradictions'] });
  const contradictionTotal = useQuery('contradictions:count', {}, { scopes: ['contradictions'] });
  const { run, busy } = useRun();
  const [accepting, setAccepting] = useState<InsightRecord | null>(null);
  const [choosing, setChoosing] = useState<PendingChoice | null>(null);
  const [snoozing, setSnoozing] = useState<InsightRecord | null>(null);
  const [resolving, setResolving] = useState<Contradiction | null>(null);

  const grouped = useMemo(() => groupByKind(insights.data ?? []), [insights.data]);

  /** Answers a question insight; an answer that changes data is confirmed in a dialog first. */
  const choose = async ({ insight, choice, strongConfirmed }: { insight: InsightRecord; choice: InsightChoice; strongConfirmed: boolean }) => {
    await run(() => call('insights:respond', { response: 'choose', id: insight.id, choiceId: choice.id, confirmed: true, strongConfirmed }), {
      success: `Antwort „${choice.label}“ übernommen.`,
    });
    // also after an error: an outdated question is removed by the backend
    void insights.refetch();
  };

  const actions: InsightActions = {
    choose: (insight, choice) => (choice.actionId ? setChoosing({ insight, choice }) : void choose({ insight, choice, strongConfirmed: false })),
    accept: setAccepting,
    reject: async (insight) => {
      await run(() => call('insights:respond', { response: 'reject', id: insight.id }), { success: rejectSuccess(insight.kind) });
      void insights.refetch();
    },
    snooze: setSnoozing,
  };

  return (
    <Page>
      <PageHeader
        title="Insights"
        description="Hinweise, die Archivist beim Aufräumen und Prüfen deines Archivs gefunden hat. Nichts passiert, ohne dass du es bestätigst."
        actions={
          <Button
            variant="outline"
            disabled={busy}
            data-testid="consistency-run"
            onClick={() =>
              void run(() => call('consistency:run'), { success: 'Archivprüfung gestartet. Den Fortschritt siehst du oben unter „Verarbeitung“.' })
            }
          >
            <Play aria-hidden /> Archivprüfung jetzt starten
          </Button>
        }
      />
      <LinkageMetrics />
      <LinkProposals />

      <div className="mb-4 w-52">
        <Select value={status} onChange={(e) => setStatus(e.target.value as InsightStatus)} aria-label="Status filtern" data-testid="insight-status-filter">
          {(Object.keys(STATUS_LABELS) as InsightStatus[]).map((option) => (
            <option key={option} value={option}>
              {STATUS_LABELS[option]}
            </option>
          ))}
        </Select>
      </div>

      {insights.error && !insights.data && <ErrorNote error={insights.error} onRetry={() => void insights.refetch()} />}
      {!insights.data && insights.loading && <Loading />}

      <div className="flex flex-col gap-8">
        {insights.data && grouped.length === 0 && (
          <EmptyState icon={<Lightbulb />} title="Keine Hinweise" description="Im Moment gibt es nichts, was deine Aufmerksamkeit braucht." />
        )}
        {grouped.map(([kind, list]) => (
          <section key={kind} aria-labelledby={`k-${kind}`}>
            <h2 id={`k-${kind}`} className="mb-2 flex items-center gap-2 text-sm font-semibold">
              {INSIGHT_KIND_LABELS[kind]} <Badge variant="secondary">{list.length}</Badge>
            </h2>
            <ul className="flex flex-col gap-3">
              {list.map((insight) => (
                <InsightCard key={insight.id} insight={insight} busy={busy} actions={actions} />
              ))}
            </ul>
          </section>
        ))}
        <LoadMore
          shown={insights.data?.length ?? 0}
          total={insightTotal.data ?? 0}
          noun="Hinweisen"
          onMore={insightWindow.more}
          loading={insights.loading}
          testId="insights"
        />

        <ContradictionsSection contradictions={contradictions} onResolve={setResolving} />
        <LoadMore
          shown={contradictions.data?.length ?? 0}
          total={contradictionTotal.data ?? 0}
          noun="Widersprüchen"
          onMore={contradictionWindow.more}
          loading={contradictions.loading}
          testId="contradictions"
        />
      </div>

      <AcceptDialog
        insight={accepting}
        onClose={() => setAccepting(null)}
        onConfirm={async (insight, strongConfirmed) => {
          const accepted = await run(() => call('insights:respond', { response: 'accept', id: insight.id, confirmed: true, strongConfirmed }), {
            success: 'Erledigt.',
          });
          if (!accepted) return;
          setAccepting(null);
          void insights.refetch();
        }}
      />

      <ChoiceDialog
        pending={choosing}
        onClose={() => setChoosing(null)}
        onConfirm={async ({ insight, choice }, strongConfirmed) => {
          await choose({ insight, choice, strongConfirmed });
          setChoosing(null);
        }}
      />

      <SnoozeDialog
        insight={snoozing}
        busy={busy}
        onClose={() => setSnoozing(null)}
        onPick={async (insight, day) => {
          const snoozed = await run(() => call('insights:respond', { response: 'remind_later', id: insight.id, remindAt: day }), {
            success: `Erinnerung für den ${formatDate(day)} gesetzt.`,
          });
          if (!snoozed) return;
          setSnoozing(null);
          void insights.refetch();
        }}
      />

      <ResolveContradictionDialog
        contradiction={resolving}
        onClose={() => setResolving(null)}
        onDone={() => {
          void contradictions.refetch();
          void insights.refetch();
        }}
      />
    </Page>
  );
}
