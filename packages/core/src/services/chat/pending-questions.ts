import type { ChatIntent } from '@archivist/shared';
import { nameSimilarity, truncate } from '../../util/text';
import type { CaptureService } from '../capture';
import type { OpenItemPending, Pending } from '../chat-state';
import type { DecisionService } from '../decisions';
import type { OpenItemService } from '../open-items';

const sameTitle = (a: string | null | undefined, b: string) => !a?.trim() || nameSimilarity(a, b) >= 0.6;

/** Whether a request answers the open follow-up question, and what the user is told when the question lapses. */
export class PendingQuestions {
  constructor(private readonly deps: { capture: CaptureService; openItems: OpenItemService; decisions: DecisionService }) {}

  /** Does this intent answer the open follow-up question? New events/reminders with a title of their own do not. */
  answers(intent: ChatIntent, pending: Pending): boolean {
    switch (pending.kind) {
      case 'decision':
        return intent.intent === 'decision_amend';
      case 'reminder':
        return (
          (intent.intent === 'reminder_create' || intent.intent === 'reminder_snooze') &&
          (!intent.reminder?.targetId || intent.reminder.targetId === pending.targetId) &&
          sameTitle(intent.reminder?.title, pending.title) &&
          sameTitle(intent.reminder?.targetHint, pending.title)
        );
      case 'event':
        return intent.intent === 'event_record' && sameTitle(intent.event?.title, pending.title);
      case 'open_item':
        return intent.intent === 'open_item_update' && this.targetsGroup(intent, pending);
      default:
        return false;
    }
  }

  private targetsGroup(intent: ChatIntent, pending: OpenItemPending): boolean {
    const ids = this.deps.capture.openItemGroup(pending).map((g) => g.item.id);
    if (intent.openItem?.targetId) return ids.includes(intent.openItem.targetId);
    const hint = intent.openItem?.targetHint;
    if (!hint?.trim()) return ids.length > 0;
    const found = this.deps.openItems.findByHint(hint)?.id;
    return Boolean(found && ids.includes(found));
  }

  /** Visible hint when an open follow-up question was not answered by this message and lapses. */
  droppedHint(pending: Pending): string | null {
    switch (pending.kind) {
      case 'decision': {
        const decision = this.deps.decisions.get(pending.decisionId);
        return decision.status === 'draft'
          ? `Die Entscheidung „${truncate(decision.title, 80)}“ bleibt als Entwurf gespeichert; fehlende Angaben kannst du jederzeit ergänzen.`
          : null;
      }
      case 'reminder':
        return `Die Frage, wann ich an „${truncate(pending.title, 80)}“ erinnern soll, habe ich verworfen – dazu ist keine Erinnerung angelegt.`;
      case 'event':
        return `Das Ereignis „${truncate(pending.title, 80)}“ habe ich ohne Datum nicht eingetragen.`;
      case 'open_item': {
        const group = this.deps.capture.openItemGroup(pending);
        if (pending.optional || !group.length) return null;
        return `Die fehlenden Angaben zu ${group.length === 1 ? 'dem offenen Punkt' : 'den offenen Punkten'} ${group.map((g) => `„${truncate(g.item.title, 80)}“`).join(', ')} kannst du jederzeit nachtragen.`;
      }
      case 'confirm_save':
        return `Zu „${truncate(pending.intent.segment ?? pending.text, 80)}“ habe ich nichts gespeichert.`;
      default:
        return null;
    }
  }
}
