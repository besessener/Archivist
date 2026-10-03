'use client';

import { ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CheckboxField } from '@/components/ui/checkbox';
import { ARCHIVE_MODE_SHORT } from '@/lib/labels';
import type { ArchivePlanRecord } from '@/lib/types';
import { ConfidenceBadge } from './confidence';
import { EntityChip } from './entity-chip';
import { Notice } from './states';
import { PathText } from '@/components/common/path-text';

type PlanItem = ArchivePlanRecord['items'][number];

export function ArchivePlanItem({ item, included, onIncludedChange }: { item: PlanItem; included: boolean; onIncludedChange: (included: boolean) => void }) {
  return (
    <li className="rounded-lg border p-3 text-sm" data-testid="archive-plan-item">
      <div className="flex items-start gap-2">
        <CheckboxField
          checked={included}
          disabled={item.blocked}
          aria-label={`${item.title} einbeziehen`}
          onCheckedChange={(checked) => onIncludedChange(checked === true)}
          label={<span className="font-medium">{item.title}</span>}
          className="min-w-0 flex-1"
        />
        <Badge variant={item.action === 'move' ? 'warning' : 'secondary'}>{ARCHIVE_MODE_SHORT[item.action]}</Badge>
        {item.confidence !== null && <ConfidenceBadge value={item.confidence} />}
      </div>
      {(item.sourcePath || item.targetPath) && (
        <div className="mt-2 grid items-center gap-1 text-xs sm:grid-cols-[1fr_auto_1fr]">
          <code className="rounded bg-muted px-1.5 py-1" data-testid="archive-plan-source" title="Quelle">
            <PathText path={item.sourcePath ?? '–'} />
          </code>
          <ArrowRight className="mx-auto size-4 rotate-90 text-muted-foreground sm:rotate-0" aria-hidden />
          <code className="rounded bg-muted px-1.5 py-1" data-testid="archive-plan-target" title="Ziel">
            {item.targetPath ? (
              <PathText path={item.targetPath} />
            ) : item.action === 'index_only' ? (
              'Wird nur durchsuchbar gemacht (keine Datei wird kopiert)'
            ) : (
              '–'
            )}
          </code>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {item.renamed && <Badge variant="info">Wird umbenannt</Badge>}
        {item.willRemoveSource && (
          <Badge variant="warning" data-testid="archive-plan-removes-source">
            Original wird entfernt
          </Badge>
        )}
        {item.removesInboxCopy && (
          <Badge variant="secondary" data-testid="archive-plan-inbox-copy">
            {item.willRemoveSource ? 'Inbox-Kopie wird aufgeräumt' : 'Inbox-Kopie wird aufgeräumt, Original bleibt erhalten'}
          </Badge>
        )}
        {item.blocked && <Badge variant="danger">Blockiert</Badge>}
      </div>
      {item.rationale && <p className="mt-2 text-xs text-muted-foreground">{item.rationale}</p>}
      <PlanItemNotes item={item} />
    </li>
  );
}

function PlanItemNotes({ item }: { item: PlanItem }) {
  return (
    <>
      {item.duplicates.length > 0 && (
        <Notice tone="warning" title="Mögliche Duplikate" className="mt-2">
          <ul className="list-disc pl-5">
            {item.duplicates.map((duplicate) => (
              <li key={duplicate.documentId}>
                {duplicate.title}
                {duplicate.archivePath ? ` – ${duplicate.archivePath}` : ''}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {item.conflicts.length > 0 && (
        <Notice tone="danger" title="Konflikte" className="mt-2" data-testid="archive-conflicts">
          <ul className="list-disc pl-5">
            {item.conflicts.map((conflict) => (
              <li key={conflict}>{conflict}</li>
            ))}
          </ul>
        </Notice>
      )}
      {item.affected.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Betroffen:</span>
          {item.affected.map((entry) => (
            <EntityChip key={`${entry.type}-${entry.id}`} type={entry.type} id={entry.id} label={entry.label} detail={entry.detail} />
          ))}
        </div>
      )}
    </>
  );
}

export function NewCategoriesNotice({
  categories,
  approved,
  onApprovedChange,
}: {
  categories: string[];
  approved: Set<string>;
  onApprovedChange: (category: string, approved: boolean) => void;
}) {
  return (
    <Notice tone="info" title="Neue Hauptkategorien">
      <p className="mb-2">Dafür werden neue Ordner angelegt. Bitte bestätige jede Neuanlage einzeln.</p>
      <div className="flex flex-col gap-1.5">
        {categories.map((category) => (
          <CheckboxField
            key={category}
            checked={approved.has(category)}
            onCheckedChange={(checked) => onApprovedChange(category, checked === true)}
            label={
              <span>
                Neue Kategorie <strong>{category}</strong> anlegen
              </span>
            }
            data-testid="archive-new-category"
          />
        ))}
      </div>
    </Notice>
  );
}
