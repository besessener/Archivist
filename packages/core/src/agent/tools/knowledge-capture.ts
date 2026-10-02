import type { ChatIntent } from '@archivist/shared';
import { normalizeDateInput, normalizeDecisionDate, normalizeDueDate } from '../../util/dates';
import type { CaptureResult } from '../../services/capture';
import { wikiNames } from '../../services/wiki-links';
import { optText, type ToolContext } from '../registry';
import type { ToolDeps } from './common';

/** An intent of the capture module the rule-based chat uses as well (#307), filled in by the agent's arguments. */
export const agentIntent = (intent: ChatIntent['intent'], segment: string): ChatIntent => ({
  intent,
  confidence: 0.9,
  rationale: 'Agent',
  segment,
  query: null,
  alternativeQueries: null,
  topic: null,
  project: null,
  timeRange: null,
  decision: null,
  openItem: null,
  event: null,
  reminder: null,
  proposalId: null,
  path: null,
  note: null,
  decisionCertainty: null,
});

/** A follow-up question of the capture module: the agent asks it with ask_user and continues with the answer. */
export function followUpQuestion(result: CaptureResult): string {
  if (!result.question) return '';
  const question = result.question.trim() === result.content.trim() ? '(siehe oben)' : result.question;
  return `\nOFFENE RÜCKFRAGE ${question}\nStelle sie dem Benutzer mit ask_user (falls er es nicht schon gesagt hat) und ergänze danach mit dem passenden Werkzeug.`;
}

/** A date given in words or numbers → YYYY-MM-DD (deterministic, also for „31.10.“). */
export const dateArg = optText.transform((v) => (v ? (normalizeDateInput(v) ?? v) : null));
/** A decision lies in the past: „31.10.“ is the last 31 October; a future date is refused by the service. */
export const decisionDateArg = optText.transform((v) => (v ? (normalizeDecisionDate(v) ?? normalizeDateInput(v) ?? v) : null));
/** A due date lies ahead: „15.1.“ without a year is the next 15 January. */
export const dueDateArg = optText.transform((v) => (v ? (normalizeDueDate(v) ?? v) : null));

export const entryRef = (ctx: ToolContext, id: string | null) => (id ? ctx.refs.entry(id) : '');

/** Candidates of „Welche Entscheidung wird ersetzt?“ with their K-refs, so the agent can pass the user's choice on. */
export function candidateNote(ctx: ToolContext, result: CaptureResult): string {
  if (!result.supersedeCandidateIds.length) return '';
  return `\nKandidaten (nach der Antwort des Benutzers supersede_decision aufrufen): ${result.supersedeCandidateIds.map((id) => ctx.refs.entry(id)).join(', ')}`;
}

/** What became of the [[Name]] links of a saved note (#285): linked names, and unknown ones to offer creating. */
export function wikiNote(deps: ToolDeps, note: { text: string; id?: string }): string {
  const names = wikiNames(note.text);
  if (!names.length || !note.id) return '';
  const resolved = deps.notes.wiki.resolveAll(names, note.id);
  const known = resolved.filter((r) => r.entity).map((r) => `„${r.name}“`);
  const unknown = resolved.filter((r) => !r.entity).map((r) => `„${r.name}“`);
  return [
    known.length ? `\nVerlinkt: ${known.join(', ')}.` : '',
    unknown.length ? `\nNoch ohne Eintrag (anbieten, ihn anzulegen): ${unknown.join(', ')}.` : '',
  ].join('');
}
