import type { AgentActionStatus, AgentActionType, EntityRef, StoredAgentAction } from '@archivist/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/database';
import { agentActions } from '../db/schema';
import type { ActionDeps } from './action-deps';
import { EXTRACTED_NOTIFICATION_PREFIX } from './notifications';

export type ActionRow = typeof agentActions.$inferSelect;

export const toStoredAction = (r: ActionRow): StoredAgentAction => ({
  id: r.id,
  conversationId: r.conversationId,
  actionType: r.actionType as AgentActionType,
  label: r.label,
  rationale: r.rationale,
  confidence: r.confidence,
  affectedEntities: r.affectedEntities as EntityRef[],
  requiredConfirmation: r.requiredConfirmation as StoredAgentAction['requiredConfirmation'],
  proposedParameters: r.params as Record<string, unknown>,
  status: r.status as AgentActionStatus,
  result: r.result,
  createdAt: r.createdAt,
  resolvedAt: r.resolvedAt,
});

/** Upper bound of one page of actions. */
export const MAX_PAGE_SIZE = 200;

/** One page of actions, newest first, optionally of one status and type. */
export function pageOfActions(db: Db, query: { status?: AgentActionStatus; actionType?: AgentActionType; limit: number; offset: number }): StoredAgentAction[] {
  const filters = [query.status && eq(agentActions.status, query.status), query.actionType && eq(agentActions.actionType, query.actionType)];
  return db
    .select()
    .from(agentActions)
    .where(and(...filters.filter((f) => f !== undefined)))
    .orderBy(desc(agentActions.createdAt), desc(agentActions.id))
    .limit(Math.min(query.limit, MAX_PAGE_SIZE))
    .offset(query.offset)
    .all()
    .map(toStoredAction);
}

/** Document notifications („Dokument enthält …“) are done once every proposal they offer is decided; the proposals stay on the page. */
export function resolveSettledNotifications(notifications: ActionDeps['notifications'], actionsOf: (actionIds: string[]) => StoredAgentAction[]): void {
  const open = notifications.openByDedupePrefix(EXTRACTED_NOTIFICATION_PREFIX);
  const targetsOf = (notification: (typeof open)[number]) =>
    notification.proposedActions.flatMap((a) => (a.kind === 'confirm_action' && a.target ? [a.target] : []));
  // one lookup for the targets of all notifications, not one per target (a bulk approval resolves many actions in a row)
  const undecided = new Set(
    actionsOf([...new Set(open.flatMap(targetsOf))])
      .filter((action) => action.status === 'proposed')
      .map((action) => action.id),
  );
  for (const notification of open) if (!targetsOf(notification).some((target) => undecided.has(target))) notifications.resolve(notification.id);
}
