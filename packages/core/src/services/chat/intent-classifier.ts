import { ChatAnalysis } from '@archivist/shared';
import { promptNow } from '../../util/dates';
import { toErrorInfo } from '../../util/errors';
import { tokenize, truncate } from '../../util/text';
import { throwIfCancelled } from './cancellation';
import { historyHint, INTENT_HELP, pendingHint } from './intent-prompt';
import type { ConversationStore } from './conversation-store';
import type { RuleBasedIntents } from './rule-based';
import type { ChatDeps, ChatTurn } from './types';

/** Short ids in the intent prompt (P1, E1, V1) → real ids. Unknown ids returned by the LLM are discarded. */
interface PromptRefs {
  text: string;
  ids: Map<string, string>;
}

export interface Classification {
  analysis: ChatAnalysis;
  viaLlm: boolean;
  llmError: string | null;
  /** The LLM was tried and failed; false when it is switched off or not configured (no error to show). */
  llmFailed: boolean;
}

type ClassifierDeps = Pick<ChatDeps, 'ctx' | 'llm' | 'graph' | 'settings' | 'openItems' | 'decisions' | 'capture' | 'search'>;

/** Entries the search found for the message get a head start that outweighs any word overlap (#197). */
const SEARCH_BONUS = 100;

/** Ranks a list by search hit order, then by how many words of the message its key shares, keeping the original order on ties. */
function mostRelevant<T extends { id?: string }>(
  list: T[],
  spec: { query: Set<string>; keyOf: (entry: T) => string; limit: number; hits?: Map<string, number> },
): T[] {
  const bonus = (entry: T) => (entry.id !== undefined && spec.hits?.has(entry.id) ? SEARCH_BONUS - spec.hits.get(entry.id)! : 0);
  return list
    .map((entry, index) => ({ entry, index, score: bonus(entry) + tokenize(spec.keyOf(entry)).filter((t) => spec.query.has(t)).length }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, spec.limit)
    .map((ranked) => ranked.entry);
}

/** The intent of a message: by the LLM classifier, or by rules when the LLM is not available. */
export class IntentClassifier {
  constructor(
    private readonly deps: ClassifierDeps,
    private readonly helpers: { store: ConversationStore; rules: RuleBasedIntents },
  ) {}

  async classify(turn: ChatTurn): Promise<Classification> {
    const ruleBased = () => ({ intents: [this.helpers.rules.classify(turn.text, turn.state)] });
    if (!this.deps.llm.canUse()) return { analysis: ruleBased(), viaLlm: false, llmError: 'Das LLM ist nicht konfiguriert.', llmFailed: false };
    try {
      const refs = this.promptContext(turn, await this.searchRanks(turn.text));
      const analysis = await this.deps.llm.completeJson(ChatAnalysis, {
        schemaName: 'ChatIntent',
        purpose: 'Chat-Intent',
        instructions: INTENT_HELP,
        input: this.promptInput(turn, refs),
      });
      resolveRefs(analysis, refs);
      return { analysis, viaLlm: true, llmError: null, llmFailed: false };
    } catch (err) {
      throwIfCancelled();
      return { analysis: ruleBased(), viaLlm: false, llmError: toErrorInfo(err).message, llmFailed: true };
    }
  }

  /** Position of each open item and decision the (local) search finds for the message; a failing search only costs the ranking. */
  private async searchRanks(text: string): Promise<Map<string, number>> {
    try {
      const found = await this.deps.search.search(text, { types: ['task', 'question', 'decision'], limit: 40, allowRemoteEmbedding: false });
      return new Map(found.map((hit, rank) => [hit.id, rank]));
    } catch (err) {
      this.deps.ctx.logger.warn('chat', 'Search for the intent prompt context failed', { error: err });
      return new Map();
    }
  }

  private promptInput(turn: ChatTurn, refs: PromptRefs): string {
    const query = new Set(tokenize(turn.text));
    // names sharing words with the message come first; the rest stay alphabetical (#197)
    const known = (type: 'topic' | 'project') =>
      mostRelevant(this.deps.graph.listEntities({ type, limit: 500, confirmedOnly: true }), { query, keyOf: (e) => e.name, limit: 40 })
        .map((e) => e.name)
        .join(', ') || '–';
    return `Heutiges Datum: ${promptNow(new Date())}\nOffene Rückfrage: ${pendingHint(turn.state.pending, this.deps)}\nZuletzt gezeigte Dokumente: ${turn.state.last?.documentIds?.length ?? 0}\n${refs.text}\nBekannte Themen: ${known('topic')}\nBekannte Projekte: ${known('project')}\n\n${historyHint(this.helpers.store.recent(turn.conversationId, 7))}Nachricht des Benutzers:\n${turn.text}`;
  }

  /** Context for the intent prompt: user, open items, decisions and open proposals – titles and metadata only, most relevant first. */
  private promptContext(turn: ChatTurn, hits: Map<string, number>): PromptRefs {
    const ids = new Map<string, string>();
    const query = new Set(tokenize(turn.text));
    const section = <T extends { id: string }>(spec: { title: string; prefix: string; list: T[]; line: (entry: T) => string }) =>
      `${spec.title}:\n${
        spec.list
          .map((entry, index) => {
            ids.set(`${spec.prefix}${index + 1}`, entry.id);
            return `- ${spec.prefix}${index + 1}: ${spec.line(entry)}`;
          })
          .join('\n') || '- keine'
      }`;
    const items = mostRelevant(this.deps.openItems.list({ onlyActive: true }), { query, keyOf: (i) => `${i.title} ${i.description ?? ''}`, limit: 25, hits });
    const decisions = mostRelevant(
      this.deps.decisions.list().filter((d) => ['active', 'confirmed', 'draft'].includes(d.status)),
      { query, keyOf: (d) => `${d.title} ${d.topicName ?? ''} ${d.projectName ?? ''}`, limit: 20, hits },
    );
    const parts = [
      this.userLine(),
      section({
        title: 'Aktive offene Punkte (ID: Titel | fällig | verantwortlich)',
        prefix: 'P',
        list: items,
        line: (i) =>
          [truncate(i.title, 100), i.dueAt ? `fällig ${i.dueAt.slice(0, 10)}` : 'ohne Fälligkeit', i.responsibleName ?? 'ohne Verantwortlichen'].join(' | '),
      }),
      section({
        title: 'Entscheidungen (ID: Titel | Thema/Projekt | Datum | Status)',
        prefix: 'E',
        list: decisions,
        line: (d) =>
          [
            truncate(d.title, 100),
            d.projectName ?? d.topicName ?? '–',
            d.decidedAt?.slice(0, 10) ?? 'ohne Datum',
            d.status === 'draft' ? 'Entwurf' : 'aktiv',
          ].join(' | '),
      }),
      section({
        title: 'Offene Vorschläge in diesem Gespräch (ID: Beschreibung)',
        prefix: 'V',
        list: this.helpers.store.openCards(turn.conversationId),
        line: (a) => truncate(a.label, 120),
      }),
    ];
    return { text: parts.join('\n'), ids };
  }

  private userLine(): string {
    const profile = this.deps.settings.get().profile;
    const nicknames = profile.nicknames.filter(Boolean);
    return profile.name.trim()
      ? `Der Benutzer heißt ${profile.name.trim()}${nicknames.length ? ` (Spitznamen: ${nicknames.join(', ')})` : ''}. „ich“, „mir“, „mich“, „mein …“ meinen ihn bzw. sie.`
      : 'Der Name des Benutzers ist nicht hinterlegt. „ich“, „mir“, „mich“, „mein …“ meinen den Benutzer.';
  }
}

/** Replaces the LLM's short ids with real ids; unknown or unsuitable ids are discarded. */
function resolveRefs(analysis: ChatAnalysis, refs: PromptRefs): void {
  const real = (value: string | null | undefined, prefix: string) => {
    const key = value?.trim().toUpperCase();
    return key?.startsWith(prefix) ? (refs.ids.get(key) ?? null) : null;
  };
  for (const intent of analysis.intents) {
    if (intent.openItem) intent.openItem.targetId = real(intent.openItem.targetId, 'P');
    if (intent.reminder) intent.reminder.targetId = real(intent.reminder.targetId, 'P');
    if (intent.decision) intent.decision.supersedesId = real(intent.decision.supersedesId, 'E');
    intent.proposalId = real(intent.proposalId, 'V');
  }
}
