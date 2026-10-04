import { tokenCapPauseText } from '../util/bulk-text';
import { isTokenCapError } from '../util/token-cap';
import type { NotificationService } from './notifications';

/** Runs a bulk step; when the daily token limit stops it, one notification says how far the run got, then the error pauses the job. */
export async function pausingOnTokenCap<T>(
  run: () => Promise<T>,
  pause: { notifications: NotificationService; jobId: string; title: string; progress: () => { done: number; total: number; verb?: string } },
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isTokenCapError(err))
      pause.notifications.create({
        title: pause.title,
        description: tokenCapPauseText(pause.progress()),
        type: 'system',
        priority: 'normal',
        proposedActions: [{ label: 'Einstellungen öffnen', kind: 'navigate', target: '/settings/' }],
        dedupeKey: `token-cap-pause:${pause.jobId}:${new Date().toISOString().slice(0, 10)}`,
      });
    throw err;
  }
}
