'use client';

import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import type { AuditEntry } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { PathText } from '@/components/common/path-text';
import { EmptyState, ErrorNote, Loading, Notice } from '@/components/common/states';
import { Section } from '@/components/settings/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { auditActionLabel, auditChangeLines } from '@/lib/audit-labels';
import { formatDateTime } from '@/lib/format';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';

const PAGE_SIZE = 100;
const MAX_ENTRIES = 5000;

/** Says whether the entries were left as written; only a break is worth a warning. */
function ChainStatus() {
  const verification = useQuery('audit:verify', {}, { scopes: ['audit'] });
  if (!verification.data) return null;
  if (verification.data.brokenEntryId === null && !verification.data.truncated)
    return (
      <p className="text-xs text-muted-foreground" data-testid="audit-chain-ok">
        {verification.data.checked} Einträge wurden seit dem Schreiben nicht verändert.
      </p>
    );
  return (
    <Notice tone="danger" title="Das Änderungsprotokoll wurde nachträglich verändert" data-testid="audit-chain-broken">
      {verification.data.brokenEntryId !== null && (
        <>Ein Eintrag wurde nach dem Schreiben geändert, entfernt oder eingefügt (erster betroffener Eintrag: {verification.data.brokenEntryId}). </>
      )}
      {verification.data.truncated && <>Es fehlen Einträge am Anfang oder Ende des Protokolls. </>}
      Prüfe, ob andere Programme auf die Datenbank von Archivist zugegriffen haben.
    </Notice>
  );
}

function AuditSubjects({ entry }: { entry: AuditEntry }) {
  const lines = auditChangeLines(entry);
  return (
    <>
      {entry.entities.map((subject) => (
        <span key={subject.id} className="block text-xs text-muted-foreground" data-testid="audit-entity">
          {subject.title}
        </span>
      ))}
      {lines.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground" data-testid="audit-changes">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function AuditTab() {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const { data, loading, error, refetch } = useQuery('audit:list', { limit, onlyUndoable: false }, { scopes: ['audit', 'documents'] });
  const { run } = useRun();
  const [undoing, setUndoing] = useState<AuditEntry | null>(null);
  const [results, setResults] = useState<Record<string, { message: string; conflicts: string[]; undone: boolean }>>({});

  return (
    <Section
      title="Änderungsprotokoll"
      description="Jede Änderung, die Archivist an deinen Daten oder Dateien vornimmt, wird hier festgehalten. Manche Änderungen lassen sich rückgängig machen."
    >
      <ChainStatus />
      {error && !data && <ErrorNote error={error} onRetry={() => void refetch()} />}
      {!data && loading && <Loading />}
      {data && data.length === 0 && <EmptyState title="Noch keine Einträge" />}
      {data && data.length > 0 && (
        <Table data-testid="audit-table">
          <THead>
            <tr>
              <TH>Zeit</TH>
              <TH>Aktion</TH>
              <TH>Betrifft</TH>
              <TH>Wer</TH>
              <TH>Pfade</TH>
              <TH>Ergebnis</TH>
              <TH>
                <span className="sr-only">Rückgängig</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {data.map((a) => {
              const r = results[a.id];
              return (
                <TR key={a.id} data-testid="audit-row">
                  <TD className="whitespace-nowrap">{formatDateTime(a.at)}</TD>
                  <TD>
                    {auditActionLabel(a.action)}
                    {!a.confirmed && a.actor === 'agent' && <span className="block text-xs text-muted-foreground">ohne Rückfrage</span>}
                  </TD>
                  <TD className="max-w-xs">
                    <AuditSubjects entry={a} />
                  </TD>
                  <TD>{a.actor === 'user' ? 'Du' : 'Archivist'}</TD>
                  <TD className="max-w-xs">
                    {a.paths.slice(0, 3).map((p) => (
                      <code key={p} className="block text-xs">
                        <PathText path={p} />
                      </code>
                    ))}
                    {a.paths.length > 3 && <span className="text-xs text-muted-foreground">… und {a.paths.length - 3} weitere</span>}
                  </TD>
                  <TD>
                    {a.success ? <Badge variant="success">Erfolgreich</Badge> : <Badge variant="danger">Fehler</Badge>}
                    {a.error && <span className="mt-1 block max-w-48 break-words text-xs text-destructive">{a.error}</span>}
                    {a.undoneAt && <span className="mt-1 block text-xs text-muted-foreground">Rückgängig gemacht am {formatDateTime(a.undoneAt)}</span>}
                    {r && (
                      <span className="mt-1 block text-xs">
                        {r.message}
                        {r.conflicts.length > 0 && (
                          <ul className="list-disc pl-4 text-destructive" data-testid="audit-undo-conflicts">
                            {r.conflicts.map((c) => (
                              <li key={c}>{c}</li>
                            ))}
                          </ul>
                        )}
                      </span>
                    )}
                  </TD>
                  <TD>
                    {a.undoable && !a.undoneAt && !r?.undone && (
                      <Button size="sm" variant="outline" onClick={() => setUndoing(a)} data-testid="audit-undo">
                        <Undo2 aria-hidden /> Rückgängig
                      </Button>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      {data && data.length >= limit && limit < MAX_ENTRIES && (
        <Button
          variant="outline"
          className="self-start"
          onClick={() => setLimit((current) => Math.min(current + PAGE_SIZE, MAX_ENTRIES))}
          data-testid="audit-more"
        >
          Mehr laden
        </Button>
      )}
      <ConfirmDialog
        open={undoing !== null}
        onOpenChange={(o) => !o && setUndoing(null)}
        title="Änderung rückgängig machen?"
        description="Archivist versucht, den Zustand vor dieser Aktion wiederherzustellen. Falls sich Dateien inzwischen geändert haben, werden Konflikte angezeigt."
        confirmLabel="Rückgängig machen"
        confirmTestId="audit-undo-confirm"
        onConfirm={async () => {
          if (!undoing) return;
          const result = await run(() => call('audit:undo', { auditId: undoing.id }));
          if (result) {
            setResults((prev) => ({ ...prev, [undoing.id]: result }));
            setUndoing(null);
            void refetch();
          }
        }}
      >
        {undoing && (
          <div className="text-sm">
            <p className="font-medium">{auditActionLabel(undoing.action)}</p>
            {undoing.entities.map((subject) => (
              <p key={subject.id} className="text-xs text-muted-foreground">
                {subject.title}
              </p>
            ))}
            {undoing.paths.map((p) => (
              <code key={p} className="block text-xs text-muted-foreground">
                <PathText path={p} />
              </code>
            ))}
          </div>
        )}
      </ConfirmDialog>
      {data?.some((a) => !a.success) && (
        <Notice tone="warning">Fehlgeschlagene Aktionen haben keine Änderungen hinterlassen, soweit nicht anders vermerkt.</Notice>
      )}
    </Section>
  );
}
