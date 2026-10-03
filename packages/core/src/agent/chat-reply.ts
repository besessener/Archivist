import type { AgentMode } from '@archivist/shared';
import { webSourcesMarkdown } from './prompt';
import type { RunOutcome } from './runner';

const ASK_RE =
  /\b(?:frag(?:e)?\s+mich\s+(?:diesmal\s+|lieber\s+|bitte\s+)?(?:vorher|zuerst|erst)|vorher\s+fragen|erst\s+fragen|nur\s+vorschlagen|modus\s+„?fragen)/i;
const AUTO_RE = /\b(?:mach\s+(?:es\s+|das\s+)?einfach|ohne\s+(?:nach)?(?:zu)?fragen|frag\s+(?:mich\s+)?nicht|modus\s+„?auto)/i;

/** „Frag mich diesmal vorher“ / „mach einfach“ switch the mode for this conversation (#298). */
export function modeOverrideIn(text: string): AgentMode | null {
  if (ASK_RE.test(text)) return 'ask';
  if (AUTO_RE.test(text)) return 'auto';
  return null;
}

export interface ReplyInput {
  outcome: RunOutcome;
  /** The final answer, trimmed, with refs turned into names. */
  text: string;
  /** The open question with refs turned into names (only read for `ask_user`). */
  question: string;
  changes: string[];
  /** First answer after „frag mich diesmal vorher“. */
  announceAskMode: boolean;
}

const bullets = (lines: string[]) => lines.map((line) => `• ${line}`).join('\n');

/** The chat answer of a run: the model's text completed by what the run's status means for the user. */
export function replyContent(input: ReplyInput): string {
  let content = statusContent(input) || (input.changes.length ? `Erledigt:\n${bullets(input.changes)}` : 'Erledigt.');
  if (input.outcome.webSources.length) content = `${content}\n\n${webSourcesMarkdown(input.outcome.webSources)}`;
  return input.announceAskMode ? `_Für dieses Gespräch frage ich vor jeder Änderung._\n\n${content}` : content;
}

function statusContent({ outcome, text, question, changes }: ReplyInput): string {
  if (outcome.status === 'ask_user' && outcome.question) return text ? `${text}\n\n${question}` : question;
  if (outcome.status === 'cancelled')
    return [text, changes.length ? `Abgebrochen. Bereits erledigt:\n${bullets(changes)}` : 'Abgebrochen.'].filter(Boolean).join('\n\n');
  if (outcome.status === 'error') return `${text ? `${text}\n\n` : ''}Das hat nicht geklappt: ${outcome.error ?? 'unbekannter Fehler'}`;
  if (outcome.status === 'refusal') return text || 'Das Modell hat diese Anfrage abgelehnt.';
  return text;
}

export function quickReplies(outcome: RunOutcome): string[] {
  if (outcome.status === 'ask_user' && outcome.question) return [...outcome.question.options];
  return outcome.status === 'limit' ? ['Weitermachen'] : [];
}
