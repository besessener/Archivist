import { Clock, FileText, FolderSearch, Gavel, Inbox, Lightbulb, ListChecks, MessageSquare, Network, Settings, type LucideIcon } from 'lucide-react';
import type { Tone } from './nav';

/** Sections whose navigation entry carries a counter. */
export type NavBadge = 'inbox' | 'insights' | 'openItems';

export interface Section {
  href: string;
  label: string;
  testId: string;
  icon: LucideIcon;
  /** Colour of the section's header tile: the type of what the section lists. */
  tone: Tone;
  badge?: NavBadge;
}

export const SECTIONS: Section[] = [
  { href: '/chat/', label: 'Chat', testId: 'nav-chat', icon: MessageSquare, tone: 'primary' },
  { href: '/inbox/', label: 'Inbox', testId: 'nav-inbox', icon: Inbox, tone: 'document', badge: 'inbox' },
  { href: '/knowledge/', label: 'Wissen', testId: 'nav-knowledge', icon: Network, tone: 'topic' },
  { href: '/decisions/', label: 'Entscheidungen', testId: 'nav-decisions', icon: Gavel, tone: 'decision' },
  { href: '/documents/', label: 'Dokumente', testId: 'nav-documents', icon: FileText, tone: 'document' },
  { href: '/timeline/', label: 'Timeline', testId: 'nav-timeline', icon: Clock, tone: 'neutral' },
  { href: '/open-items/', label: 'Offene Punkte', testId: 'nav-open-items', icon: ListChecks, tone: 'task', badge: 'openItems' },
  { href: '/insights/', label: 'Insights', testId: 'nav-insights', icon: Lightbulb, tone: 'primary', badge: 'insights' },
  { href: '/scan/', label: 'Scan', testId: 'nav-scan', icon: FolderSearch, tone: 'neutral' },
  { href: '/settings/', label: 'Einstellungen', testId: 'nav-settings', icon: Settings, tone: 'neutral' },
];

/** The section a route belongs to; sub-routes such as `/decisions/proposed/` belong to their parent. */
export function sectionOf(pathname: string): Section | undefined {
  return SECTIONS.find((section) => pathname.startsWith(section.href.slice(0, -1)));
}
