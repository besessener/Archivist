import Link from 'next/link';
import type { EntityType } from '@archivist/shared';
import { Briefcase, FileText, Gavel, Hash, Folder, HelpCircle, ListChecks, StickyNote, Tag, User, CalendarDays, Lightbulb } from 'lucide-react';
import { cn } from '@/lib/utils';
import { entityHref, ENTITY_TYPE_LABELS } from '@/lib/nav';

const ICONS: Record<EntityType, React.ComponentType<{ className?: string }>> = {
  document: FileText,
  decision: Gavel,
  topic: Lightbulb,
  project: Briefcase,
  person: User,
  event: CalendarDays,
  question: HelpCircle,
  task: ListChecks,
  note: StickyNote,
  category: Folder,
  tag: Tag,
};

export function EntityIcon({ type, className }: { type: EntityType; className?: string }) {
  const Icon = ICONS[type] ?? Hash;
  return <Icon className={className} />;
}

/** Obsidian-artiger, klickbarer Verweis auf ein Wissensobjekt. */
export function EntityChip({
  type,
  id,
  label,
  detail,
  className,
  suffix,
}: {
  type: EntityType;
  id: string;
  label: string;
  detail?: string | null;
  className?: string;
  suffix?: React.ReactNode;
}) {
  return (
    <Link
      href={entityHref(type, id)}
      title={`${ENTITY_TYPE_LABELS[type]}${detail ? ` – ${detail}` : ''}`}
      data-testid="entity-chip"
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border bg-secondary/60 px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:border-primary/60 hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring',
        className,
      )}
    >
      <EntityIcon type={type} className="size-3 shrink-0 text-primary" />
      <span className="truncate">{label}</span>
      {suffix}
    </Link>
  );
}
