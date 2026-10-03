import { DeadlineWatcher } from '../../packages/core/src/agent/watcher';
import type { TestApp } from './harness';

/** A deadline watcher over the services of the test app; the review is posted as an assistant message. */
export const deadlineWatcher = (app: TestApp) =>
  new DeadlineWatcher({
    settings: app.services.settings,
    appState: app.services.appState,
    notifications: app.services.notifications,
    runs: app.services.agentRuns,
    tools: {
      openItems: app.services.openItems,
      reminders: app.services.reminders,
      decisions: app.services.decisions,
      docs: app.services.documents,
      actions: app.services.actions,
      insights: app.services.insights,
      privacy: app.services.privacy,
    },
    post: (message) => app.services.chat.postAssistant(message),
  });
