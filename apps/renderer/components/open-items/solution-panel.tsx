'use client';

import { FilePlus2, ListPlus, Sparkles, StickyNote } from 'lucide-react';
import { EntityChip } from '@/components/common/entity-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import type { OpenItemRecord } from '@/lib/types';

type Solution = NonNullable<OpenItemRecord['solution']>;
type Claim = Solution['nextSteps'][number];

export function Refs({ claim }: { claim: Pick<Claim, 'sourceRefs' | 'uncertain'> }) {
  if (claim.uncertain)
    return (
      <Badge variant="warning" className="ml-1 align-middle" title="Kein gültiger Quellenbeleg – unsicher" data-testid="solution-unbacked">
        unbelegt
      </Badge>
    );
  return <span className="ml-1 text-xs text-muted-foreground">[{(claim.sourceRefs ?? []).join(', ')}]</span>;
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h4>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export function SolutionPanel({
  solution,
  busy,
  onDescription,
  onNote,
  onSteps,
}: {
  solution: Solution;
  busy: boolean;
  onDescription: () => void;
  onNote: () => void;
  onSteps: () => void;
}) {
  const sources = solution.sources ?? [];
  const shown = sources.some((source) => source.used) ? sources.filter((source) => source.used) : sources;
  return (
    <section aria-label="Lösungsvorschlag" className="basis-full rounded-lg border bg-muted/40 p-3 text-sm" data-testid="solution-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 font-semibold">
          <Sparkles className="size-4 text-primary" aria-hidden /> Lösungsvorschlag
        </h3>
        <span className="text-xs text-muted-foreground" data-testid="solution-meta">
          vom {formatDateTime(solution.generatedAt)} · Modell: {solution.model}
        </span>
      </div>
      <p className="mt-2">
        {solution.assessment}
        <Refs claim={{ sourceRefs: solution.assessmentSourceRefs ?? [], uncertain: solution.assessmentUncertain }} />
      </p>
      {solution.nextSteps.length > 0 && (
        <Block title="Nächste Schritte">
          <ol className="list-decimal space-y-1 pl-5">
            {solution.nextSteps.map((step, i) => (
              <li key={i}>
                {step.text}
                <Refs claim={step} />
                {step.detail && <span className="block text-xs text-muted-foreground">{step.detail}</span>}
              </li>
            ))}
          </ol>
        </Block>
      )}
      {solution.openQuestions.length > 0 && (
        <Block title="Offene Fragen / fehlende Informationen">
          <ul className="list-disc space-y-1 pl-5">
            {solution.openQuestions.map((question, i) => (
              <li key={i}>{question}</li>
            ))}
          </ul>
        </Block>
      )}
      {solution.risks.length > 0 && (
        <Block title="Risiken">
          <ul className="list-disc space-y-1 pl-5">
            {solution.risks.map((risk, i) => (
              <li key={i}>
                {risk.text}
                <Refs claim={risk} />
              </li>
            ))}
          </ul>
        </Block>
      )}
      {solution.uncertainties.length > 0 && (
        <Block title="Unsicherheiten">
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {solution.uncertainties.map((uncertainty, i) => (
              <li key={i}>{uncertainty}</li>
            ))}
          </ul>
        </Block>
      )}
      {shown.length > 0 && (
        <Block title="Verwendete Quellen">
          <div className="flex flex-wrap gap-1.5">
            {shown.map((source) => (
              <EntityChip
                key={source.ref}
                type={source.type}
                id={source.id}
                label={`${source.ref} ${source.title}`}
                detail={source.contentIncluded ? null : 'nur Titel gesendet'}
              />
            ))}
          </div>
        </Block>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onDescription} data-testid="solution-apply-description">
          <FilePlus2 aria-hidden /> Zur Beschreibung hinzufügen
        </Button>
        <Button size="sm" variant="outline" disabled={busy || solution.nextSteps.length === 0} onClick={onSteps} data-testid="solution-apply-items">
          <ListPlus aria-hidden /> Schritte als offene Punkte …
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onNote} data-testid="solution-apply-note">
          <StickyNote aria-hidden /> Als Notiz speichern
        </Button>
      </div>
    </section>
  );
}
