import type { OpenItem } from '@archivist/shared';
import { normalizeName, truncate } from '../../util/text';
import { openItemAsks, type ConvState, type OpenItemField, type OpenItemPending, type Pending, type Reply } from '../chat-state';
import { ACTIVE_STATUSES, hintTokens, matchOpenItems, type OpenItemService } from '../open-items';
import type { CaptureRequest } from './capture-deps';

/** The open item a message means: by id, by a unique hint match, or ambiguous candidates for a follow-up question. */
export interface OpenItemTarget {
  item: OpenItem | null;
  ambiguous: OpenItem[];
  /** the message names something of its own – then there is no fallback to the item mentioned last */
  hinted: boolean;
}

const NUMBER_ANSWER = /^(?:nummer\s+|nr\s+)?(\d+)$/;

/** Finding the open item a capture request or a follow-up answer refers to. */
export class OpenItemLookup {
  constructor(private readonly openItems: OpenItemService) {}

  /** The item if it exists and is still active. */
  openItemOrNull(id: string | null | undefined): OpenItem | null {
    if (!id) return null;
    try {
      const item = this.openItems.get(id);
      return ACTIVE_STATUSES.includes(item.status) ? item : null;
    } catch {
      return null;
    }
  }

  /** Items of an open-item follow-up question that still lack an asked field – answered, closed or deleted ones drop out. */
  openItemGroup(pending: OpenItemPending): Array<{ item: OpenItem; asked: OpenItemField[] }> {
    return openItemAsks(pending).flatMap(({ openItemId, asked }) => {
      const item = this.openItemOrNull(openItemId);
      if (!item) return [];
      const still = asked.filter((field) => (field === 'due' ? !item.dueAt && !item.dueUnknown : !item.responsiblePersonId && !item.responsibleUnknown));
      return still.length ? [{ item, asked: still }] : [];
    });
  }

  /** The open item meant: id from the LLM, otherwise a unique match for the hint; ambiguous → candidates for the follow-up question. */
  target(targetId: string | null | undefined, hint: string | null | undefined): OpenItemTarget {
    const byId = this.openItemOrNull(targetId);
    if (byId) return { item: byId, ambiguous: [], hinted: true };
    if (!hint?.trim() || hintTokens(hint).length === 0) return { item: null, ambiguous: [], hinted: false };
    const match = this.openItems.matchByHint(hint);
    if (match.status === 'match') return { item: match.item, ambiguous: [], hinted: true };
    return { item: null, ambiguous: match.status === 'ambiguous' ? match.items : [], hinted: true };
  }

  /** The item mentioned last – only if the message contains no hint of its own („der ist erledigt“). */
  lastOpenItem(state: ConvState, target: { hinted: boolean }): OpenItem | null {
    return target.hinted ? null : this.openItemOrNull(state.last?.openItemId);
  }

  /** „Meinst du ‚A‘ oder ‚B‘?“ – choice by button, number or title; afterwards the request continues. */
  askWhich(request: Pick<CaptureRequest, 'text' | 'intent' | 'state'>, candidates: OpenItem[]): Reply {
    const { text, intent, state } = request;
    const names = candidates.map((candidate) => `‚${candidate.title}‘`);
    return {
      intent: intent.intent,
      content: `Meinst du ${names.slice(0, -1).join(', ')} oder ${names.at(-1)}?`,
      quickReplies: candidates.map((candidate) => candidate.title),
      context: { openItems: candidates.map((candidate) => ({ type: 'task' as const, id: candidate.id, label: candidate.title })) },
      confidence: 0.5,
      state: { ...state, pending: { kind: 'open_item_choice', text, intent, candidateIds: candidates.map((candidate) => candidate.id) } },
    };
  }

  /** Answer to „Meinst du …?“: number, exact title or a unique match among the candidates. Otherwise null. */
  answerOpenItemChoice(text: string, pending: Extract<Pending, { kind: 'open_item_choice' }>): OpenItem | null {
    const candidates = pending.candidateIds.map((id) => this.openItemOrNull(id)).filter((item): item is OpenItem => Boolean(item));
    const normalized = normalizeName(text);
    const number = NUMBER_ANSWER.exec(normalized)?.[1];
    if (number) return candidates[Number(number) - 1] ?? null;
    const exact = candidates.find((candidate) => normalizeName(candidate.title) === normalized);
    if (exact) return exact;
    const match = matchOpenItems(text, candidates);
    return match.status === 'match' ? match.item : null;
  }
}

/** „Welchen offenen Punkt …?“ when nothing matches; names the hint if it had words of its own. */
export function noOpenItemQuestion(hint: string | null | undefined, verb: string): string {
  const tokens = hint ? hintTokens(hint) : [];
  return `Welchen offenen Punkt ${verb}?${tokens.length ? ` Zu „${truncate(hint!.trim(), 80)}“ finde ich keinen aktiven Punkt.` : ''} Nenne bitte den Titel.`;
}
