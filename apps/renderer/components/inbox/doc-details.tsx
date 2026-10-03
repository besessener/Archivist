'use client';

import { useState } from 'react';
import { Ban, ChevronDown, Loader2 } from 'lucide-react';
import type { ArchiveMode } from '@archivist/shared';
import type { ArchiveEdit } from '@/components/common/archive-dialog';
import { ConfidenceBadge } from '@/components/common/confidence';
import { Field } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { DocCoverage } from './doc-coverage';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { formatBytes, formatDate } from '@/lib/format';
import { ARCHIVE_MODE_LABELS, LLM_STATUS_LABELS } from '@/lib/labels';
import type { DocRecord } from '@/lib/types';

type Proposal = NonNullable<DocRecord['proposal']>;

const MODES: ArchiveMode[] = ['copy', 'move', 'index_only', 'ignore'];

function llmVariant(status: DocRecord['llmStatus']) {
  return status === 'analyzed'
    ? ('success' as const)
    : status === 'excluded'
      ? ('warning' as const)
      : status === 'pending'
        ? ('info' as const)
        : ('secondary' as const);
}

function processingBadge(doc: DocRecord): { label: string; variant: 'secondary' | 'success' | 'warning' | 'danger' | 'info' } {
  if (doc.status === 'analyzing') return { label: 'Wird analysiert …', variant: 'info' };
  if (doc.status === 'quarantined') return { label: 'Nicht verarbeitet', variant: 'secondary' };
  switch (doc.processingStatus) {
    case 'pending':
      return { label: 'Wird verarbeitet', variant: 'info' };
    case 'extracted':
      return { label: 'Text gelesen', variant: 'success' };
    case 'partial':
      return { label: 'Nur teilweise lesbar', variant: 'warning' };
    case 'unsupported':
      return { label: 'Format nicht lesbar', variant: 'warning' };
    case 'failed':
      return { label: 'Verarbeitung fehlgeschlagen', variant: 'danger' };
  }
}

/** Title, file facts and status badges of an inbox document. */
export function DocHeader({ doc }: { doc: DocRecord }) {
  const processing = processingBadge(doc);
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 className="break-words font-semibold leading-tight">{doc.title}</h3>
        <p className="mt-0.5 break-all text-xs text-muted-foreground">
          {doc.originalName} · {formatBytes(doc.size)}
          {doc.docType ? ` · ${doc.docType}` : ''} · {formatDate(doc.createdAt)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={llmVariant(doc.llmStatus)} data-testid="inbox-llm-status">
          {LLM_STATUS_LABELS[doc.llmStatus]}
        </Badge>
        {!doc.folderLlmAllowed && (
          <Badge variant="warning" data-testid="inbox-folder-locked" title="Der Ordner dieser Datei ist von der KI-Analyse ausgeschlossen.">
            Ordner ohne KI-Freigabe
          </Badge>
        )}
        <Badge variant={processing.variant} data-testid="inbox-processing-status">
          {doc.status === 'analyzing' && <Loader2 className="size-3 animate-spin" aria-hidden />}
          {processing.label}
        </Badge>
        {doc.status === 'quarantined' && (
          <Badge variant="danger" data-testid="inbox-quarantine-badge">
            In Quarantäne
          </Badge>
        )}
        {doc.status === 'failed' && <Badge variant="danger">Fehlgeschlagen</Badge>}
        <ConfidenceBadge value={doc.confidence} />
      </div>
    </div>
  );
}

/** Processing error, quarantine note, summary and the collapsible text preview. */
export function DocNotes({ doc }: { doc: DocRecord }) {
  const [showText, setShowText] = useState(false);
  const quarantined = doc.status === 'quarantined';
  return (
    <>
      {doc.processingError && (
        <p className="mt-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive" data-testid="inbox-error">
          {quarantined && <span className="font-medium">Grund: </span>}
          {doc.processingError}
        </p>
      )}
      {quarantined && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="inbox-quarantine-note">
          <Ban className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
          Die Datei wurde aus Sicherheitsgründen zurückgehalten und nicht gelesen. Prüfe sie im Ordner, bevor du sie trotzdem importierst.
        </p>
      )}
      {doc.summary && <p className="mt-2 text-sm">{doc.summary}</p>}
      {doc.textPreview && (
        <div className="mt-2">
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-expanded={showText}
            onClick={() => setShowText((shown) => !shown)}
          >
            <ChevronDown className={`size-3.5 transition-transform ${showText ? 'rotate-180' : ''}`} aria-hidden />
            Textvorschau ({doc.textLength.toLocaleString('de-DE')} Zeichen)
          </button>
          {showText && (
            <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">{doc.textPreview}</p>
          )}
        </div>
      )}
    </>
  );
}

/** Persons, tags, dates and the decisions and open items the analysis found. */
export function DocFindings({ doc }: { doc: DocRecord }) {
  const proposal = doc.proposal;
  const persons = proposal?.persons ?? doc.persons;
  const tags = proposal?.tags ?? doc.tags;
  if (!proposal && doc.persons.length === 0 && doc.tags.length === 0 && doc.dates.length === 0) return null;
  return (
    <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
      {persons.length > 0 && (
        <p>
          <span className="font-medium">Personen: </span>
          {persons.join(', ')}
        </p>
      )}
      {tags.length > 0 && (
        <p className="flex flex-wrap items-center gap-1">
          <span className="font-medium">Schlagwörter: </span>
          {tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </p>
      )}
      {doc.dates.length > 0 && (
        <p>
          <span className="font-medium">Datumsangaben: </span>
          {doc.dates.map((date) => formatDate(date, date)).join(', ')}
        </p>
      )}
      {proposal && <PossibleEntries proposal={proposal} />}
    </div>
  );
}

function PossibleEntries({ proposal }: { proposal: Proposal }) {
  return (
    <>
      {proposal.possibleDecisions.length > 0 && (
        <div className="sm:col-span-2" data-testid="inbox-decisions">
          <span className="font-medium">Mögliche Entscheidungen:</span>
          <ul className="list-disc pl-5 text-muted-foreground">
            {proposal.possibleDecisions.map((decision, i) => (
              <li key={`${i}-${decision.title}`}>
                <span className="text-foreground">{decision.title}</span> – {decision.decisionText}
                {decision.decidedAt ? ` (${formatDate(decision.decidedAt, decision.decidedAt)})` : ''}
                {decision.participants?.length ? ` · Beteiligte: ${decision.participants.join(', ')}` : ' · Beteiligte: nicht angegeben'}
                {decision.evidence && <span className="block italic">„{decision.evidence}“</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposal.possibleOpenItems.length > 0 && (
        <div className="sm:col-span-2" data-testid="inbox-open-items">
          <span className="font-medium">Mögliche offene Punkte:</span>
          <ul className="list-disc pl-5 text-muted-foreground">
            {proposal.possibleOpenItems.map((item, i) => (
              <li key={`${i}-${item.title}`}>
                <span className="text-foreground">{item.title}</span>
                {item.dueAt ? ` (bis ${formatDate(item.dueAt, item.dueAt)})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export function DocProposal({ proposal }: { proposal: Proposal }) {
  return (
    <div className="mt-3 rounded-lg bg-muted/50 p-3 text-xs" data-testid="inbox-proposal">
      <p>
        <span className="font-medium">Vorschlag: </span>
        <code>{proposal.location.categoryPath}</code>
        {proposal.location.fileName ? ` / ${proposal.location.fileName}` : ''}
        {proposal.location.newMainCategory && (
          <Badge variant="warning" className="ml-2">
            Neue Hauptkategorie
          </Badge>
        )}
      </p>
      {proposal.location.rationale && <p className="mt-1 text-muted-foreground">{proposal.location.rationale}</p>}
      <p className="mt-1 text-muted-foreground">Analysiert {proposal.analyzedBy === 'llm' ? 'per KI' : 'lokal'}.</p>
      <DocCoverage proposal={proposal} />
    </div>
  );
}

export function ArchiveFields({ doc, edit, onEdit }: { doc: DocRecord; edit: ArchiveEdit; onEdit: (edit: ArchiveEdit) => void }) {
  const set = <K extends keyof ArchiveEdit>(key: K, value: ArchiveEdit[K]) => onEdit({ ...edit, [key]: value });
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <Field label="Ablageort (Ordnerpfad)" htmlFor={`cat-${doc.id}`}>
        <Input
          id={`cat-${doc.id}`}
          value={edit.categoryPath}
          onChange={(e) => set('categoryPath', e.target.value)}
          placeholder="z. B. Arbeit/Projekte/Alpha"
          data-testid="inbox-category"
        />
      </Field>
      <Field label="Dateiname" htmlFor={`fn-${doc.id}`}>
        <Input
          id={`fn-${doc.id}`}
          value={edit.fileName}
          onChange={(e) => set('fileName', e.target.value)}
          placeholder={doc.originalName}
          data-testid="inbox-filename"
        />
      </Field>
      <Field label="Thema" htmlFor={`topic-${doc.id}`}>
        <Input id={`topic-${doc.id}`} value={edit.topic} onChange={(e) => set('topic', e.target.value)} data-testid="inbox-topic" />
      </Field>
      <Field label="Projekt" htmlFor={`proj-${doc.id}`}>
        <Input id={`proj-${doc.id}`} value={edit.project} onChange={(e) => set('project', e.target.value)} data-testid="inbox-project" />
      </Field>
      <Field label="Was soll mit der Datei passieren?" htmlFor={`mode-${doc.id}`} className="sm:col-span-2">
        <Select id={`mode-${doc.id}`} value={edit.mode} onChange={(e) => set('mode', e.target.value as ArchiveMode)} data-testid="inbox-mode">
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {ARCHIVE_MODE_LABELS[mode]}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
