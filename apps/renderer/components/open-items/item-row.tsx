'use client';

import Link from 'next/link';
import type { EntrySubjects } from '@archivist/shared';
import { BellPlus, Check, MessageSquare, Network, Pencil, Trash2 } from 'lucide-react';
import { TypeBadge } from '@/components/common/entity-chip';
import { ExtraSubjectsNote } from '@/components/common/extra-subjects';
import { IconAction } from '@/components/common/icon-action';
import { Markdown } from '@/components/common/markdown';
import { SolutionSection, type SolutionSectionProps } from '@/components/open-items/solution';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { OPEN_ITEM_STATUS_LABELS } from '@/lib/labels';
import { formatDate, relativeDay } from '@/lib/format';
import type { OpenItemRecord } from '@/lib/types';
import type { OpenItemGroup } from '@/lib/open-item-groups';

const STRIPES: Partial<Record<OpenItemGroup, 'danger' | 'warning'>> = { overdue: 'danger', due: 'warning' };

export interface OpenItemActions {
  onEdit: (item: OpenItemRecord) => void;
  onRemind: (item: OpenItemRecord) => void;
  onRelated: (item: OpenItemRecord) => void;
  onClose: (item: OpenItemRecord) => void;
  onDelete: (item: OpenItemRecord) => void;
  onChanged: () => void;
}

export interface OpenItemRowProps {
  item: OpenItemRecord;
  group: OpenItemGroup;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  subjects: EntrySubjects | undefined;
  llm: { mode: SolutionSectionProps['mode']; configured: boolean };
  actions: OpenItemActions;
}

export function OpenItemRow({ item, group, selected, onSelect, subjects, llm, actions }: OpenItemRowProps) {
  const done = group === 'done';
  return (
    <li
      className="flex gap-3 rounded-xl border bg-card shadow-card p-3"
      data-stripe={STRIPES[group]}
      data-testid="open-item-row"
      data-status={item.status}
      data-group={group}
    >
      <Checkbox
        className="mt-1"
        checked={selected}
        onCheckedChange={(checked) => onSelect(checked === true)}
        aria-label={`${item.title} auswählen`}
        data-testid="open-item-select"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className={done ? 'font-medium text-muted-foreground line-through' : 'font-medium'}>{item.title}</p>
            {item.description && <Markdown text={item.description} className="mt-0.5 text-sm text-muted-foreground" testId="open-item-description" />}
            {item.sourceConversationId && (
              <Link
                href={`/chat/?c=${encodeURIComponent(item.sourceConversationId)}`}
                className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                data-testid="open-item-chat-link"
              >
                <MessageSquare className="size-3.5" aria-hidden /> Im Chat ansehen
              </Link>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {item.priority === 'high' && <Badge variant="danger">Hohe Priorität</Badge>}
            {item.status !== 'open' && (
              <Badge variant="outline" data-testid="open-item-status">
                {OPEN_ITEM_STATUS_LABELS[item.status]}
                {item.duplicateOfId ? ' (Duplikat)' : ''}
              </Badge>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <ResponsibleBadge item={item} group={group} />
          <DueBadge item={item} group={group} />
          {item.reminderAt && <Badge variant="info">Erinnerung {formatDate(item.reminderAt)}</Badge>}
          {item.topicName && <TypeBadge type="topic">{item.topicName}</TypeBadge>}
          {item.projectName && <TypeBadge type="project">{item.projectName}</TypeBadge>}
          <ExtraSubjectsNote subjects={subjects} />
        </div>
        {item.resolutionNote && (
          <p className="mt-2 text-sm" data-testid="open-item-resolution-note">
            <span className="font-medium">{item.status === 'dismissed' ? 'Warum verworfen: ' : 'Lösung: '}</span>
            <span className="whitespace-pre-wrap text-muted-foreground">{item.resolutionNote}</span>
          </p>
        )}
        {!done && <OpenItemButtons item={item} llm={llm} actions={actions} />}
      </div>
    </li>
  );
}

function ResponsibleBadge({ item, group }: { item: OpenItemRecord; group: OpenItemGroup }) {
  if (item.responsibleName) return <Badge variant="outline">Verantwortlich: {item.responsibleName}</Badge>;
  if (item.responsibleUnknown) return <Badge variant="secondary">Verantwortlicher bewusst unbekannt</Badge>;
  if (group === 'done') return null;
  return (
    <Badge variant="warning" data-testid="badge-no-owner">
      Kein Verantwortlicher
    </Badge>
  );
}

function DueBadge({ item, group }: { item: OpenItemRecord; group: OpenItemGroup }) {
  if (item.dueAt)
    return (
      <Badge variant={group === 'overdue' ? 'danger' : 'outline'}>
        Termin: {formatDate(item.dueAt)} ({relativeDay(item.dueAt)})
      </Badge>
    );
  if (item.dueUnknown) return <Badge variant="secondary">Termin bewusst unbekannt</Badge>;
  if (group === 'done') return null;
  return (
    <Badge variant="warning" data-testid="badge-no-due">
      Kein Termin
    </Badge>
  );
}

function OpenItemButtons({ item, llm, actions }: Pick<OpenItemRowProps, 'item' | 'llm' | 'actions'>) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => actions.onClose(item)} data-testid="open-item-close">
        <Check aria-hidden /> Erledigt …
      </Button>
      <span className="flex items-center gap-0.5">
        <IconAction label="Bearbeiten" onClick={() => actions.onEdit(item)} data-testid="open-item-edit">
          <Pencil aria-hidden />
        </IconAction>
        <IconAction label="Erinnern" onClick={() => actions.onRemind(item)} data-testid="open-item-remind">
          <BellPlus aria-hidden />
        </IconAction>
        <IconAction label="Zusammenhänge" onClick={() => actions.onRelated(item)} data-testid="open-item-related">
          <Network aria-hidden />
        </IconAction>
        <IconAction label="Löschen …" onClick={() => actions.onDelete(item)} data-testid="open-item-delete">
          <Trash2 aria-hidden />
        </IconAction>
      </span>
      <SolutionSection item={item} mode={llm.mode} llmConfigured={llm.configured} onChanged={actions.onChanged} />
    </div>
  );
}
