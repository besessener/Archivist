import type { AppStateService } from '../services/app-state';
import { truncate } from '../util/text';

/** Entries a weekly review listed; the next one only mentions them as „weiterhin“. */
export interface ReviewRemembered {
  openItems: string[];
  deadlines: string[];
  proposals: string[];
}

const KEYS: Record<keyof ReviewRemembered, string> = {
  openItems: 'agent.review.listed',
  deadlines: 'agent.review.listedDeadlines',
  proposals: 'agent.review.listedProposals',
};

function loadList(appState: AppStateService, key: string): string[] {
  try {
    const listed: unknown = JSON.parse(appState.get(key) ?? '[]');
    return Array.isArray(listed) ? (listed as string[]) : [];
  } catch {
    return [];
  }
}

export function loadRemembered(appState: AppStateService): Record<keyof ReviewRemembered, Set<string>> {
  return {
    openItems: new Set(loadList(appState, KEYS.openItems)),
    deadlines: new Set(loadList(appState, KEYS.deadlines)),
    proposals: new Set(loadList(appState, KEYS.proposals)),
  };
}

export function saveRemembered(appState: AppStateService, remembered: ReviewRemembered): void {
  for (const [name, key] of Object.entries(KEYS)) appState.set(key, JSON.stringify(remembered[name as keyof ReviewRemembered]));
}

export interface ReviewLine {
  title: string;
  /** In-app page of the entry; without one the title stays plain. */
  href: string | null;
  note?: string;
}

const MAX_LINES = 8;

/** Markdown bullet list with links to the entries (the chat renders in-app links), the rest counted. */
export function reviewList(lines: readonly ReviewLine[]): string {
  const shown = lines.slice(0, MAX_LINES).map(({ title, href, note }) => {
    const label = truncate(title.replace(/[[\]\n]/g, ' ').trim(), 100);
    return `- ${href ? `[${label}](${href})` : label}${note ?? ''}`;
  });
  return [...shown, ...(lines.length > MAX_LINES ? [`- … und ${lines.length - MAX_LINES} weitere`] : [])].join('\n');
}

/** Plain text of a review for a notification: links keep only their label. */
export const plainReview = (markdown: string) =>
  truncate(
    markdown
      .replace(/\]\([^)\s]*\)/g, '')
      .replaceAll('[', '')
      .replace(/[#*_]/g, '')
      .replace(/\s+/g, ' '),
    300,
  );
