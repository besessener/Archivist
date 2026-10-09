import type { Services } from '../create-services';
import { queueContradictionCheck } from '../services/contradiction-check-job';
import { AppError } from '../util/errors';
import { UI_TRIGGER, type HandlerGroup } from './types';

type RecordChannelPrefix =
  | 'actions'
  | 'decisions'
  | 'jobs'
  | 'notifications'
  | 'insights'
  | 'consistency'
  | 'contradictions'
  | 'reminders'
  | 'openItems'
  | 'events'
  | 'timeline'
  | 'search'
  | 'audit';

function proposeSupersede(services: Services, input: { oldDecisionId: string; newDecisionId: string }) {
  const oldDecision = services.decisions.get(input.oldDecisionId);
  const newDecision = services.decisions.get(input.newDecisionId);
  return services.actions.propose({
    actionType: 'supersede_decision',
    label: `„${oldDecision.title}“ durch „${newDecision.title}“ ersetzen`,
    rationale: 'Vom Benutzer vorgeschlagen.',
    confidence: 0.9,
    affectedEntities: [
      { type: 'decision', id: oldDecision.id, label: oldDecision.title },
      { type: 'decision', id: newDecision.id, label: newDecision.title },
    ],
    requiredConfirmation: 'confirm',
    proposedParameters: { oldDecisionId: oldDecision.id, newDecisionId: newDecision.id },
  });
}

/** Decisions, open items, events, reminders, notifications, insights, jobs, audit, timeline and search. */
export function recordHandlers(services: Services): HandlerGroup<RecordChannelPrefix> {
  return {
    'actions:list': (input) => services.actions.page(input),
    'actions:get': (input) => services.actions.get(input.id),
    'actions:resolve': (input) =>
      input.decision === 'approve'
        ? services.actions.resolve(input.actionId, {
            decision: 'approve',
            confirmed: input.confirmed,
            strongConfirmed: input.strongConfirmed,
            overrides: input.parameterOverrides,
          })
        : services.actions.resolve(input.actionId, { decision: 'reject' }),

    'decisions:create': (input) => {
      const duplicate = services.decisions.findDuplicate({ decisionText: input.decisionText, topic: input.topic, project: input.project });
      if (duplicate)
        throw new AppError(
          'validation_error',
          `Diese Entscheidung ist schon erfasst („${duplicate.title}“). Öffne sie unter „Entscheidungen“ und ergänze sie dort.`,
        );
      const decision = services.decisions.create(input, { actor: 'user', trigger: UI_TRIGGER });
      queueContradictionCheck(services.jobs, decision); // only a hint: saving never waits for the LLM's reviews
      return decision;
    },
    'decisions:update': (input) => {
      const decision = services.decisions.update(input.id, { patch: input.patch, trigger: UI_TRIGGER });
      queueContradictionCheck(services.jobs, decision);
      return decision;
    },
    'decisions:get': (input) => services.decisions.get(input.id),
    'decisions:list': (input) => services.decisions.list(input),
    'decisions:count': (input) => services.decisions.count(input),
    'decisions:search': (input) => services.decisions.searchDecisions(input.query, input.limit),
    'decisions:proposeSupersede': (input) => proposeSupersede(services, input),
    'decisions:supersede': (input) => {
      const superseded = services.decisions.supersede({
        oldId: input.oldDecisionId,
        newId: input.newDecisionId,
        confirmed: input.confirmed,
        trigger: UI_TRIGGER,
      });
      // replacing by hand settles the pair's contradiction just like the confirmed proposal (#168)
      services.contradictions.settlePair(input.oldDecisionId, input.newDecisionId);
      return superseded;
    },
    'decisions:revoke': (input) => services.decisions.revoke(input.id, { confirmed: input.confirmed, trigger: UI_TRIGGER }),
    'decisions:delete': (input) => ({ auditId: services.decisions.delete(input.id, { confirmed: input.confirmed, trigger: UI_TRIGGER }) }),

    'jobs:list': (input) => services.jobs.list(input.limit, { type: input.type, activeOnly: input.activeOnly }),
    'jobs:retry': (input) => services.jobs.retry(input.id),
    'jobs:cancel': (input) => services.jobs.cancel(input.id),

    'notifications:list': (input) => services.notifications.list(input),
    'notifications:markRead': (input) => {
      services.notifications.markRead(input.ids);
      return { ok: true as const };
    },
    'notifications:markAllRead': () => ({ marked: services.notifications.markAllRead() }),
    'notifications:resolve': (input) => services.notifications.resolve(input.id),
    'notifications:resolveAll': () => ({ resolved: services.notifications.resolveAll() }),
    'notifications:recentlyResolved': () => services.notifications.recentlyResolved(),
    'notifications:snooze': (input) => {
      const notification = services.notifications.get(input.id);
      services.notifications.resolve(input.id);
      return services.reminders.create({ targetType: 'notification', targetId: input.id, title: notification.title, remindAt: input.remindAt });
    },

    'insights:list': (input) => services.insights.list(input, { limit: input.limit, offset: input.offset }),
    'insights:count': (input) => services.insights.count(input),
    'insights:respond': async (input) => {
      if (input.response === 'accept') return services.insights.accept(input.id, { strongConfirmed: input.strongConfirmed });
      if (input.response === 'reject') return services.insights.reject(input.id);
      if (input.response === 'choose') return services.insights.choose(input.id, { choiceId: input.choiceId, strongConfirmed: input.strongConfirmed });
      return services.insights.remindLater(input.id, input.remindAt);
    },
    'consistency:run': () => ({ jobId: services.enqueueConsistency('manual').id }),
    'contradictions:list': (input) => services.contradictions.list(input, { limit: input.limit, offset: input.offset }),
    'contradictions:count': (input) => services.contradictions.count(input),
    'contradictions:resolve': (input) =>
      services.contradictions.resolve(input.id, {
        resolution: input.resolution,
        confirmed: input.confirmed,
        supersedeOldDecisionId: input.supersedeOldDecisionId,
        supersedeNewDecisionId: input.supersedeNewDecisionId,
      }),

    'reminders:create': (input) => services.reminders.create(input),
    'reminders:snooze': (input) => services.reminders.snooze(input.id, input.remindAt),
    'reminders:dismiss': (input) => {
      services.reminders.dismiss(input.id);
      return { ok: true as const };
    },
    'reminders:list': (input) => services.reminders.list(input.status),

    'openItems:list': (input) => services.openItems.list(input),
    'openItems:count': (input) => services.openItems.count(input),
    'openItems:create': (input) => services.openItems.create(input, { actor: 'user', trigger: UI_TRIGGER }),
    'openItems:update': (input) => services.openItems.update(input.id, { patch: input.patch }),
    'openItems:close': (input) =>
      services.openItems.close(input.id, { status: input.status, confirmed: input.confirmed, trigger: UI_TRIGGER, resolutionNote: input.resolutionNote }),
    'openItems:delete': (input) => {
      services.openItems.delete(input.id, { confirmed: input.confirmed });
      return { ok: true as const };
    },
    'openItems:solutionPreview': (input) => services.solutions.preview(input.id),
    'openItems:generateSolution': (input) => services.solutions.generate(input.id, { confirmed: input.confirmed }),
    'openItems:cancelSolution': (input) => ({ cancelled: services.solutions.cancel(input.id) }),
    'openItems:applySolution': (input) => services.solutions.apply(input),

    'events:list': (input) => services.eventRecords.list(input),
    'events:create': (input) => services.eventRecords.create(input),
    'events:update': (input) => services.eventRecords.update(input.id, { patch: input.patch }),
    'events:delete': (input) => {
      services.eventRecords.delete(input.id, { confirmed: input.confirmed });
      return { ok: true as const };
    },
    // long reads run in the read worker with its own read-only connection, not on the main thread (#215)
    'timeline:get': (input) => services.reader.run('timeline', input),
    'search:global': (input) => services.search.search(input.query, { types: input.types, limit: input.limit }),

    'audit:list': (input) => services.audit.list({ limit: input.limit, onlyUndoable: input.onlyUndoable, entityId: input.entityId }),
    'audit:verify': () => services.audit.verify(),
    'audit:undo': (input) => services.undo.undo(input.auditId),
  };
}
