'use client';

import { Gauge, ShieldAlert } from 'lucide-react';
import { EntityChip } from '@/components/common/entity-chip';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/lib/app-context';
import { formatPercent } from '@/lib/format';
import type { EntityRef } from '@archivist/shared';

function Section({ title, items }: { title: string; items: EntityRef[] | undefined }) {
  if (!items || items.length === 0) return null;
  return (
    <section className="mb-4">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="flex flex-wrap gap-1.5">
        {items.map((e) => (
          <EntityChip key={`${e.type}-${e.id}`} type={e.type} id={e.id} label={e.label} detail={e.detail} />
        ))}
      </div>
    </section>
  );
}

/** Rechtes Kontextpanel der Chat-Seite: Kontext der letzten Assistentenantwort. */
export function ContextPanel() {
  const { contextMessage: m } = useApp();
  const ctx = m?.context ?? null;
  const hasAny =
    !!m &&
    ((ctx && [ctx.topics, ctx.projects, ctx.persons, ctx.decisions, ctx.openItems, ctx.documents, ctx.contradictions].some((l) => (l?.length ?? 0) > 0)) ||
      m.sources.length > 0 ||
      m.actions.length > 0 ||
      m.confidence !== null);

  return (
    <aside aria-label="Kontext" className="hidden w-72 shrink-0 overflow-y-auto border-l bg-sidebar p-4 xl:block" data-testid="context-panel">
      <h2 className="mb-3 text-sm font-semibold">Kontext der Antwort</h2>
      {!hasAny && (
        <p className="text-sm text-muted-foreground">Hier sehen Sie, welche Themen, Personen, Entscheidungen und Dokumente zur letzten Antwort gehören.</p>
      )}
      {m && hasAny && (
        <>
          {m.confidence !== null && (
            <div className="mb-4 flex items-center gap-2 text-sm">
              <Gauge className="size-4 text-primary" aria-hidden />
              Sicherheit der Antwort: <strong>{formatPercent(m.confidence)}</strong>
            </div>
          )}
          <Section title="Themen" items={ctx?.topics} />
          <Section title="Projekte" items={ctx?.projects} />
          <Section title="Personen" items={ctx?.persons} />
          <Section title="Entscheidungen" items={ctx?.decisions} />
          <Section title="Offene Punkte" items={ctx?.openItems} />
          <Section title="Verwandte Dokumente" items={ctx?.documents} />
          {ctx && (ctx.contradictions?.length ?? 0) > 0 && (
            <section className="mb-4">
              <h3 className="mb-1.5 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-warning">
                <ShieldAlert className="size-3.5" aria-hidden /> Widersprüche
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {(ctx.contradictions ?? []).map((e) => (
                  <EntityChip key={`${e.type}-${e.id}`} type={e.type} id={e.id} label={e.label} detail={e.detail} />
                ))}
              </div>
            </section>
          )}
          {m.sources.length > 0 && (
            <section className="mb-4">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quellen</h3>
              <ul className="flex flex-col gap-1.5">
                {m.sources.map((s) => (
                  <li key={`${s.type}-${s.id}`}>
                    <EntityChip type={s.type} id={s.id} label={s.title} detail={s.snippet} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {m.actions.length > 0 && (
            <section className="mb-4">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Vorgeschlagene Aktionen</h3>
              <ul className="flex flex-col gap-1.5 text-sm">
                {m.actions.map((a) => (
                  <li key={a.id} className="rounded-md border bg-background p-2">
                    <p>{a.label}</p>
                    <Badge variant={a.status === 'proposed' ? 'warning' : 'secondary'} className="mt-1">
                      {
                        {
                          proposed: 'Offen',
                          approved: 'Bestätigt',
                          rejected: 'Abgelehnt',
                          executed: 'Ausgeführt',
                          failed: 'Fehlgeschlagen',
                          withdrawn: 'Nicht mehr aktuell',
                        }[a.status]
                      }
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </aside>
  );
}
