'use client';

import { useMemo, useState } from 'react';
import { BellPlus, Check, Lightbulb, Play, ShieldAlert, X } from 'lucide-react';
import type { InsightChoice, InsightKind } from '@archivist/shared';
import { ConfidenceBadge } from '@/components/common/confidence';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EntityChip } from '@/components/common/entity-chip';
import { LinkProposals } from '@/components/knowledge/link-proposals';
import { Page, PageHeader } from '@/components/common/page-header';
import { QuickDate } from '@/components/common/quick-date';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { INSIGHT_KIND_LABELS } from '@/lib/labels';
import { formatDate, formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { InsightRecord } from '@/lib/types';
import type { IpcOutput } from '@archivist/shared';
import { CheckboxField } from '@/components/ui/checkbox';

type Contradiction = IpcOutput<'contradictions:list'>[number];
type InsightStatus = 'open' | 'accepted' | 'rejected' | 'snoozed';
const STATUS_LABELS: Record<InsightStatus, string> = { open: 'Offen', snoozed: 'Zurückgestellt', accepted: 'Bestätigt', rejected: 'Abgelehnt' };
/** Duplicate questions: confirming merges, rejecting remembers permanently that the entries are different. */
const DUPLICATE_KINDS = new Set<InsightKind>(['similar_entities']);
/** Reports of automatic changes: confirming undoes the change, rejecting keeps it. */
const UNDO_KINDS = new Set<InsightKind>(['persons_merged']);
const acceptLabel = (k: InsightKind) => (DUPLICATE_KINDS.has(k) ? 'Zusammenführen' : UNDO_KINDS.has(k) ? 'Rückgängig' : 'Bestätigen');
const rejectLabel = (k: InsightKind) => (DUPLICATE_KINDS.has(k) ? 'Verschieden' : UNDO_KINDS.has(k) ? 'Behalten' : 'Ablehnen');
const rejectSuccess = (k: InsightKind) =>
  DUPLICATE_KINDS.has(k) ? 'Als verschieden gemerkt.' : UNDO_KINDS.has(k) ? 'Zusammenführung behalten.' : 'Hinweis abgelehnt.';

export default function InsightsPage() {
  const [status, setStatus] = useState<InsightStatus>('open');
  const insights = useQuery('insights:list', { status }, { scopes: ['insights'] });
  const contradictions = useQuery('contradictions:list', {}, { scopes: ['contradictions'] });
  const { run, busy } = useRun();
  const [accepting, setAccepting] = useState<InsightRecord | null>(null);
  const [choosing, setChoosing] = useState<{ insight: InsightRecord; choice: InsightChoice } | null>(null);
  const [snoozing, setSnoozing] = useState<InsightRecord | null>(null);
  const [resolving, setResolving] = useState<Contradiction | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<InsightKind, InsightRecord[]>();
    for (const i of insights.data ?? []) {
      const list = map.get(i.kind) ?? [];
      list.push(i);
      map.set(i.kind, list);
    }
    return [...map.entries()].sort((a, b) => INSIGHT_KIND_LABELS[a[0]].localeCompare(INSIGHT_KIND_LABELS[b[0]], 'de'));
  }, [insights.data]);

  /** Answers a question insight; an answer that changes data is confirmed in a dialog first. */
  const choose = async (insight: InsightRecord, choice: InsightChoice, strongConfirmed = false): Promise<void> => {
    await run(() => call('insights:respond', { response: 'choose', id: insight.id, choiceId: choice.id, confirmed: true, strongConfirmed }), {
      success: `Antwort „${choice.label}“ übernommen.`,
    });
    // also after an error: an outdated question is removed by the backend
    void insights.refetch();
  };

  const openContradictions = (contradictions.data ?? []).filter((c) => c.status === 'detected' || c.status === 'acknowledged');

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
      <LinkProposals />

      <div className="mb-4 w-52">
        <Select value={status} onChange={(e) => setStatus(e.target.value as InsightStatus)} aria-label="Status filtern" data-testid="insight-status-filter">
          {(Object.keys(STATUS_LABELS) as InsightStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>

      {insights.error && !insights.data && <ErrorNote error={insights.error} onRetry={() => void insights.refetch()} />}
      {!insights.data && insights.loading && <Loading />}
      {insights.data && grouped.length === 0 && (
        <EmptyState icon={<Lightbulb />} title="Keine Hinweise" description="Im Moment gibt es nichts, was deine Aufmerksamkeit braucht." />
      )}

      <div className="flex flex-col gap-8">
        {grouped.map(([kind, list]) => (
          <section key={kind} aria-labelledby={`k-${kind}`}>
            <h2 id={`k-${kind}`} className="mb-2 flex items-center gap-2 text-sm font-semibold">
              {INSIGHT_KIND_LABELS[kind]} <Badge variant="secondary">{list.length}</Badge>
            </h2>
            <ul className="flex flex-col gap-3">
              {list.map((i) => (
                <li key={i.id} className="rounded-xl border bg-card p-4" data-testid="insight-card" data-kind={i.kind}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="font-semibold">{i.title}</h3>
                    <ConfidenceBadge value={i.confidence} />
                  </div>
                  <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{i.explanation}</p>
                  {i.affected.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Betrifft:</span>
                      {i.affected.map((e) => (
                        <EntityChip key={`${e.type}-${e.id}`} type={e.type} id={e.id} label={e.label} detail={e.detail} />
                      ))}
                    </div>
                  )}
                  {i.recommendedActionLabel && (
                    <p className="mt-2 text-sm">
                      <span className="font-medium">Empfehlung: </span>
                      {i.recommendedActionLabel}
                    </p>
                  )}
                  {i.chosenChoiceId && (
                    <p className="mt-2 text-sm" data-testid="insight-chosen">
                      <span className="font-medium">Antwort: </span>
                      {i.choices.find((c) => c.id === i.chosenChoiceId)?.label ?? i.chosenChoiceId}
                    </p>
                  )}
                  {i.status === 'snoozed' && i.snoozedUntil && (
                    <p className="mt-2 text-xs text-muted-foreground">Zurückgestellt bis {formatDate(i.snoozedUntil)}</p>
                  )}
                  {i.status === 'open' && (
                    // a question insight shows its answers; a classic one shows Bestätigen. Ablehnen is offered unless an answer already means „nein“.
                    <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={i.choices.length > 0 ? 'Antworten' : 'Aktionen'}>
                      {i.choices.map((c) => (
                        <Button
                          key={c.id}
                          size="sm"
                          variant={c.actionId ? 'default' : 'outline'}
                          disabled={busy}
                          title={c.description ?? undefined}
                          data-testid="insight-choice"
                          data-choice-id={c.id}
                          onClick={() => (c.actionId ? setChoosing({ insight: i, choice: c }) : void choose(i, c))}
                        >
                          {c.label}
                        </Button>
                      ))}
                      {i.choices.length === 0 && (
                        <Button size="sm" onClick={() => setAccepting(i)} data-testid="insight-accept">
                          <Check aria-hidden /> {acceptLabel(i.kind)}
                        </Button>
                      )}
                      {!i.choices.some((c) => c.actionId === null) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          data-testid="insight-reject"
                          onClick={async () => {
                            await run(() => call('insights:respond', { response: 'reject', id: i.id }), {
                              success: rejectSuccess(i.kind),
                            });
                            void insights.refetch();
                          }}
                        >
                          <X aria-hidden /> {rejectLabel(i.kind)}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setSnoozing(i)} data-testid="insight-snooze">
                        <BellPlus aria-hidden /> Später erinnern
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section aria-labelledby="contradictions" data-testid="contradictions">
          <h2 id="contradictions" className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <ShieldAlert className="size-4 text-warning" aria-hidden /> Widersprüche <Badge variant="secondary">{openContradictions.length}</Badge>
          </h2>
          {contradictions.error && !contradictions.data && <ErrorNote error={contradictions.error} onRetry={() => void contradictions.refetch()} />}
          {contradictions.data && openContradictions.length === 0 && <p className="text-sm text-muted-foreground">Keine offenen Widersprüche gefunden.</p>}
          <ul className="flex flex-col gap-3">
            {openContradictions.map((c) => (
              <li key={c.id} className="rounded-xl border border-warning/50 bg-card p-4" data-testid="contradiction-card">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="font-semibold">{c.title}</h3>
                  <div className="flex gap-1.5">
                    {c.status === 'acknowledged' && <Badge variant="info">Zur Kenntnis genommen</Badge>}
                    <ConfidenceBadge value={c.confidence} />
                  </div>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{c.description}</p>
                {c.excerpts.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {c.excerpts.map((e, idx) => (
                      <li key={`${e.entityId}-${idx}`} className="rounded-md border-l-2 border-warning bg-muted/50 px-3 py-1.5 text-sm italic">
                        „{e.text}“
                      </li>
                    ))}
                  </ul>
                )}
                {c.timestamps.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">Zeitpunkte: {c.timestamps.map((t) => formatDateTime(t, t)).join(' · ')}</p>
                )}
                <Button size="sm" className="mt-3" onClick={() => setResolving(c)} data-testid="contradiction-resolve">
                  Auflösen …
                </Button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <ConfirmDialog
        open={accepting !== null}
        onOpenChange={(o) => !o && setAccepting(null)}
        title="Empfehlung ausführen?"
        description={accepting?.recommendedActionLabel ?? accepting?.title}
        confirmLabel="Bestätigen und ausführen"
        requireCheckbox="Ich habe die betroffenen Objekte geprüft und möchte diese Aktion ausführen."
        confirmTestId="insight-accept-confirm"
        onConfirm={async (checked) => {
          if (!accepting) return;
          const out = await run(() => call('insights:respond', { response: 'accept', id: accepting.id, confirmed: true, strongConfirmed: checked }), {
            success: 'Erledigt.',
          });
          if (out) {
            setAccepting(null);
            void insights.refetch();
          }
        }}
      >
        {accepting && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="whitespace-pre-line text-muted-foreground">{accepting.explanation}</p>
            {accepting.affected.length > 0 && (
              <ul className="list-disc pl-5">
                {accepting.affected.map((e) => (
                  <li key={`${e.type}-${e.id}`}>{e.label}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={choosing !== null}
        onOpenChange={(o) => !o && setChoosing(null)}
        title={choosing ? `Antwort „${choosing.choice.label}“ übernehmen?` : ''}
        description={choosing?.insight.title}
        confirmLabel="Übernehmen"
        requireCheckbox="Ich habe die betroffenen Objekte geprüft und möchte diese Aktion ausführen."
        confirmTestId="insight-choice-confirm"
        onConfirm={async (checked) => {
          if (!choosing) return;
          await choose(choosing.insight, choosing.choice, checked);
          setChoosing(null);
        }}
      >
        {choosing && (
          <div className="flex flex-col gap-2 text-sm">
            {choosing.choice.description && <p>{choosing.choice.description}</p>}
            {choosing.insight.affected.length > 0 && (
              <ul className="list-disc pl-5">
                {choosing.insight.affected.map((e) => (
                  <li key={`${e.type}-${e.id}`}>
                    {e.label}
                    {e.detail ? ` (${e.detail})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </ConfirmDialog>

      <Dialog open={snoozing !== null} onOpenChange={(o) => !o && setSnoozing(null)}>
        <DialogContent data-testid="snooze-dialog">
          <DialogHeader>
            <DialogTitle>Später erinnern</DialogTitle>
            <DialogDescription>{snoozing?.title}</DialogDescription>
          </DialogHeader>
          <QuickDate
            disabled={busy}
            onPick={async (day) => {
              if (!snoozing) return;
              const out = await run(() => call('insights:respond', { response: 'remind_later', id: snoozing.id, remindAt: day }), {
                success: `Erinnerung für den ${formatDate(day)} gesetzt.`,
              });
              if (out) {
                setSnoozing(null);
                void insights.refetch();
              }
            }}
          />
        </DialogContent>
      </Dialog>

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

function ResolveContradictionDialog({ contradiction, onClose, onDone }: { contradiction: Contradiction | null; onClose: () => void; onDone: () => void }) {
  const { run } = useRun();
  const [resolution, setResolution] = useState<'acknowledged' | 'resolved' | 'false_positive'>('resolved');
  const [supersede, setSupersede] = useState(true);
  const decisions = useQuery('decisions:list', {}, { enabled: contradiction !== null });
  const involved = useMemo(() => {
    if (!contradiction) return [];
    return (decisions.data ?? [])
      .filter((d) => contradiction.affectedEntityIds.includes(d.id))
      .sort((a, b) => (a.decidedAt ?? a.createdAt).localeCompare(b.decidedAt ?? b.createdAt));
  }, [contradiction, decisions.data]);
  const older = involved[0];
  const newer = involved.length >= 2 ? involved[involved.length - 1] : undefined;
  const canSupersede = !!older && !!newer && resolution === 'resolved';

  return (
    <ConfirmDialog
      open={contradiction !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Widerspruch auflösen"
      description={contradiction?.title}
      confirmLabel="Auflösen"
      confirmTestId="contradiction-resolve-confirm"
      onConfirm={async () => {
        if (!contradiction) return;
        const out = await run(
          () =>
            call('contradictions:resolve', {
              id: contradiction.id,
              resolution,
              confirmed: true,
              ...(canSupersede && supersede && older && newer ? { supersedeOldDecisionId: older.id, supersedeNewDecisionId: newer.id } : {}),
            }),
          { success: 'Widerspruch bearbeitet.' },
        );
        if (out) {
          onDone();
          onClose();
        }
      }}
    >
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1.5">
          <span className="font-medium">Wie soll der Widerspruch behandelt werden?</span>
          <Select value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)} data-testid="contradiction-resolution">
            <option value="resolved">Geklärt / aufgelöst</option>
            <option value="acknowledged">Zur Kenntnis genommen (bleibt sichtbar)</option>
            <option value="false_positive">Kein echter Widerspruch</option>
          </Select>
        </label>
        {canSupersede && older && newer && (
          <div className="rounded-md border bg-muted/50 p-3">
            <CheckboxField
              checked={supersede}
              onCheckedChange={(v) => setSupersede(v === true)}
              label={
                <span>
                  Die neuere Entscheidung ersetzt die ältere:
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Neu: {newer.title || newer.decisionText} ({formatDate(newer.decidedAt, 'ohne Datum')})
                    <br />
                    Alt: {older.title || older.decisionText} ({formatDate(older.decidedAt, 'ohne Datum')})
                  </span>
                </span>
              }
              data-testid="contradiction-supersede"
            />
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}
