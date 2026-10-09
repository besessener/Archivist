import type { Contradiction, Decision } from '@archivist/shared';
import type { DecisionService } from './decisions';

export type ContradictionResolution = Exclude<Contradiction['status'], 'detected'>;

/** How a resolution reads on a proposal card and inside a sentence („…, ihn als aufgelöst zu markieren“). */
export const RESOLUTION_LABELS: Record<ContradictionResolution, { card: string; sentence: string }> = {
  resolved: { card: 'als aufgelöst markieren', sentence: 'als aufgelöst zu markieren' },
  false_positive: { card: 'als Fehlalarm markieren', sentence: 'als Fehlalarm zu markieren' },
  acknowledged: { card: 'zur Kenntnis nehmen', sentence: 'zur Kenntnis zu nehmen' },
};

export type SupersedeCheck = { fits: true } | { fits: false; reason: string };

/** Resolving may supersede one decision of the contradiction by the other one, and only together with „aufgelöst“. */
export function checkSupersede(
  contradiction: Pick<Contradiction, 'affectedEntityIds'>,
  { resolution, olderId, newerId }: { resolution: ContradictionResolution; olderId: string; newerId: string },
): SupersedeCheck {
  if (resolution !== 'resolved') return { fits: false, reason: 'Eine Entscheidung wird nur ersetzt, wenn der Widerspruch als aufgelöst markiert wird.' };
  if (olderId === newerId) return { fits: false, reason: 'Die ältere und die neuere Entscheidung müssen verschieden sein.' };
  if (![olderId, newerId].every((id) => contradiction.affectedEntityIds.includes(id)))
    return { fits: false, reason: 'Ersetzen lässt sich nur eine der beiden Entscheidungen dieses Widerspruchs durch die andere.' };
  return { fits: true };
}

/** The decisions a contradiction is about, in its own order (older first); none for one between documents. */
export function decisionsOf(decisions: Pick<DecisionService, 'list'>, contradiction: Pick<Contradiction, 'affectedEntityIds'>): Decision[] {
  const found = new Map(decisions.list({ ids: contradiction.affectedEntityIds }).map((d) => [d.id, d]));
  return contradiction.affectedEntityIds.flatMap((id) => found.get(id) ?? []);
}
