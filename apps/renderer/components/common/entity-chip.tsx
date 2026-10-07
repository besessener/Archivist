import Link from 'next/link';
import type { RefType } from '@archivist/shared';
import {
  Bell,
  Briefcase,
  FolderKanban,
  FileText,
  Gavel,
  Hash,
  Folder,
  HelpCircle,
  ListChecks,
  ShieldAlert,
  StickyNote,
  Tag,
  User,
  CalendarDays,
  Lightbulb,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { entityHref, ENTITY_TYPE_LABELS, ENTITY_TYPE_TONES } from '@/lib/nav';

const ICONS: Record<RefType, LucideIcon> = {
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
  case: FolderKanban,
  reminder: Bell,
  contradiction: ShieldAlert,
};

/** The type's icon in the type's colour. */
export function EntityIcon({ type, className }: { type: RefType; className?: string }) {
  const Icon = ICONS[type] ?? Hash;
  return <Icon data-tone={ENTITY_TYPE_TONES[type]} className={cn('text-tone', className)} />;
}

/** Obsidian-style clickable link to a knowledge object. */
export function EntityChip({
  type,
  id,
  label,
  detail,
  className,
  suffix,
}: {
  type: RefType;
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
      data-tone={ENTITY_TYPE_TONES[type]}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border border-tone/25 bg-tone/8 px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:border-tone/60 hover:bg-tone/15 focus-visible:outline-2 focus-visible:outline-ring',
        className,
      )}
    >
      <EntityIcon type={type} className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      {suffix}
    </Link>
  );
}

/** A label (not a link) for something of a known type, tinted like an EntityChip. */
export function TypeBadge({ type, children }: { type: RefType; children: React.ReactNode }) {
  return (
    <Badge variant="outline" data-tone={ENTITY_TYPE_TONES[type]} className="border-tone/25 bg-tone/8">
      <EntityIcon type={type} className="size-3" />
      {children}
    </Badge>
  );
}
