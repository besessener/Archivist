import type { ConvState, Reply } from '../chat-state';

/** Quick reply (and the text it sends) with which the user continues despite the reached daily token limit. */
export const CONTINUE_ANYWAY = 'Trotzdem fortfahren';

export type CapGate = { kind: 'proceed'; text: string; state: ConvState; override: boolean } | { kind: 'ask'; reply: Reply };

/** Local calendar day as `YYYY-MM-DD`: an override lasts until the day ends. */
export const dayKey = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** With the daily token limit reached, the chat asks first; „Trotzdem fortfahren“ runs the held message and lets the day through. */
export function tokenCapGate(input: { text: string; state: ConvState; reached: boolean; cap: number | null; today: string }): CapGate {
  const { text, state, reached, cap, today } = input;
  if (!reached) return { kind: 'proceed', text, state, override: false };
  if (state.tokenCap?.overrideDay === today) return { kind: 'proceed', text, state, override: true };
  const held = state.tokenCap?.awaiting;
  if (held && text.trim() === CONTINUE_ANYWAY) return { kind: 'proceed', text: held, state: { ...state, tokenCap: { overrideDay: today } }, override: true };
  const limit = cap === null ? '' : ` von ${cap.toLocaleString('de-DE')} Tokens`;
  return {
    kind: 'ask',
    reply: {
      intent: 'token_cap',
      content: `Das Tageslimit${limit} ist erreicht. Wenn du fortfährst, geht deine Nachricht trotzdem an die KI und der Rest des Tages ist ohne weitere Rückfrage frei. Du kannst das Limit auch unter Einstellungen → Datenschutz ändern.`,
      quickReplies: [CONTINUE_ANYWAY],
      confidence: null,
      state: { ...state, tokenCap: { awaiting: text } },
    },
  };
}
