import { DECISION_FIELD_LABELS, type ChatContext, type ChatIntent, type Decision, type DecisionField, type StoredAgentAction } from '@archivist/shared';
import { normalizeDecisionDate, parseDecisionDate } from '../../util/dates';
import { normalizeName } from '../../util/text';
import { decisionRef, decisionSource, TOPIC_KIND_QUICK_REPLIES, UNKNOWN_RE, type ConvState, type Pending, type Reply } from '../chat-state';
import { topicProjectMergeProposal } from '../cleanup/topic-project-names';
import { questionFor, type DecisionService } from '../decisions';
import type { CaptureDeps, CaptureRequest } from './capture-deps';
import type { DecisionSupersede } from './decision-supersede';

type Extracted = NonNullable<ChatIntent['decision']>;
type DecisionPending = Extract<Pending, { kind: 'decision' }>;
type DecisionPatch = Parameters<DecisionService['update']>[1]['patch'];

/** A capture request plus whether the LLM understood it (then all missing fields are asked at once) and the status of a new decision (unreviewed agent extractions are `unclear`). */
type DecisionRequest = CaptureRequest & { viaLlm: boolean; status?: 'unclear' };

/** Details of the request: fields confirmed as unknown, topic/project and the „Thema oder Projekt?“ question. */
interface DecisionFields {
  asked: DecisionField[];
  unknownFields: Set<DecisionField>;
  topic: string | null;
  project: string | null;
  clarify: string | null;
}

/** Proposal cards for the reply, each with the line that explains it. */
interface Proposals {
  actions: StoredAgentAction[];
  lines: string[];
}

/** A stored decision and what is still to be asked or proposed about it. */
interface DecisionChange {
  decision: Decision;
  clarifyTopic: string | null;
  supersedesHint: string | null;
  supersedesId: string | null;
  topicMerge: Proposals;
}

const NO_PROPOSALS: Proposals = { actions: [], lines: [] };

const emptyExtraction = (): Extracted => ({ participants: [], alternatives: [], unknownFields: [], confidence: 0.5 });

/** The patch of the list and text details an addition names; lists are merged with what is stored. */
function detailPatch(target: Decision, addition: { extracted: Extracted; unknownFields: Set<DecisionField> }): DecisionPatch {
  const { extracted, unknownFields } = addition;
  const patch: DecisionPatch = {};
  if ((extracted.participants ?? []).length) patch.participants = [...new Set([...target.participants, ...extracted.participants])];
  if (extracted.rationale) patch.rationale = extracted.rationale;
  if (extracted.consequences) patch.consequences = extracted.consequences;
  if ((extracted.alternatives ?? []).length) patch.alternatives = [...new Set([...target.alternatives, ...extracted.alternatives])];
  if (extracted.validFrom) patch.validFrom = extracted.validFrom;
  if (extracted.validUntil) patch.validUntil = extracted.validUntil;
  // the patch replaces the stored list, so keep what was confirmed as unknown before
  if (unknownFields.size) patch.unknownFields = [...new Set([...target.unknownFields, ...unknownFields])];
  return patch;
}

/** Decisions from chat and agent: required fields with follow-up questions, additions, superseding and the contradiction check. */
export class DecisionCapture {
  constructor(
    private readonly deps: CaptureDeps,
    private readonly supersede: DecisionSupersede,
  ) {}

  async flow(request: CaptureRequest, options: { viaLlm: boolean; status?: 'unclear' }): Promise<Reply> {
    const { intent, state } = request;
    const extracted = intent.decision ?? emptyExtraction();
    const pending = state.pending?.kind === 'decision' ? state.pending : null;
    // an addition always changes an existing decision – also without a running follow-up question (#177)
    const isNew = intent.intent !== 'decision_amend';
    const target = pending ? this.deps.decisions.get(pending.decisionId) : isNew ? null : this.amendTarget(request, extracted);
    if (!pending && !isNew && !target)
      return {
        intent: intent.intent,
        content: 'Zu welcher Entscheidung möchtest du etwas ergänzen? Nenne bitte das Thema oder formuliere die Entscheidung neu.',
        confidence: 0.4,
        state,
      };
    const fields = this.fieldsOf(request, { extracted, pending, isNew });
    const scope: DecisionRequest = { ...request, viaLlm: options.viaLlm, status: options.status };
    if (isNew) return this.create(scope, { extracted, fields });
    return this.amend(scope, { target: target!, extracted, pending, fields });
  }

  /** The decision an addition without a running follow-up question refers to: the last one, or one with the named topic. */
  private amendTarget(request: CaptureRequest, extracted: Extracted): Decision | null {
    const id = request.state.last?.decisionId;
    if (id) return this.deps.decisions.get(id);
    const topic = extracted.topic ?? request.intent.topic;
    if (!topic) return null;
    return this.deps.decisions.list().find((decision) => normalizeName(decision.topicName ?? '') === normalizeName(topic)) ?? null;
  }

  private fieldsOf(request: CaptureRequest, scope: { extracted: Extracted; pending: DecisionPending | null; isNew: boolean }): DecisionFields {
    const { extracted, pending } = scope;
    // answers to follow-up questions: recognize „unbekannt“ details (in addition to the LLM's evaluation)
    const asked = pending?.asked ?? [];
    const unknownFields = new Set<DecisionField>(extracted.unknownFields ?? []);
    if (pending && UNKNOWN_RE.test(request.text) && unknownFields.size === 0 && asked.length === 1) unknownFields.add(asked[0]!);
    return { asked, unknownFields, ...this.topicAndProject(request, scope) };
  }

  /** Topic vs. project; a new decision with an unclear topic name asks „Thema oder Projekt?“ unless the name is known. */
  private topicAndProject(request: CaptureRequest, scope: { extracted: Extracted; isNew: boolean }): Pick<DecisionFields, 'topic' | 'project' | 'clarify'> {
    const { extracted, isNew } = scope;
    const topic = extracted.topic?.trim() || null;
    let project = extracted.project?.trim() || null;
    if (extracted.topicIsProject === true && topic) project = project ?? topic;
    const unclear = isNew && topic && !project && request.intent.intent === 'decision_new' && extracted.topicIsProject === null ? topic : null;
    if (!unclear) return { topic, project, clarify: null };
    // do not ask for names that are already known, use the existing entry instead
    if (this.deps.graph.findByNameOrAlias('project', unclear)) return { topic, project: unclear, clarify: null };
    if (this.deps.graph.findByNameOrAlias('topic', unclear)) return { topic, project, clarify: null };
    return { topic, project, clarify: unclear };
  }

  /** A name confirmed as project: a topic of the same name is offered for merging into it, a level-2 action the user confirms (#188). */
  private proposeTopicMerge(conv: string, name: string): Proposals {
    const { graph } = this.deps;
    const topic = graph.findByNameOrAlias('topic', name);
    const project = graph.findByNameOrAlias('project', name);
    if (!topic || !project) return NO_PROPOSALS;
    const action = this.deps.actions().propose({ ...topicProjectMergeProposal({ topic, project }, 'project'), conversationId: conv });
    return {
      actions: [action],
      lines: [
        `Es gibt auch noch das Thema „${topic.name}“. Soll ich es mit dem Projekt „${project.name}“ zusammenführen? Das lässt sich rückgängig machen – bitte bestätige den Vorschlag.`,
      ],
    };
  }

  private create(request: DecisionRequest, scope: { extracted: Extracted; fields: DecisionFields }): Promise<Reply> {
    const { text, intent } = request;
    const { extracted, fields } = scope;
    const decisionText = extracted.decisionText?.trim() || text;
    const supersedes = intent.intent === 'decision_supersede';
    const duplicate = this.deps.decisions.findDuplicate({ decisionText, topic: fields.topic, project: fields.project });
    // an incomplete draft continues with its follow-up question instead
    if (duplicate && !supersedes && duplicate.missingFields.length === 0) return Promise.resolve(this.duplicateReply(request, duplicate));
    const created = duplicate
      ? this.fillDraft(duplicate, { extracted, fields, status: request.status })
      : this.deps.decisions.create(
          {
            title: extracted.title?.trim() || undefined,
            decisionText,
            decidedAt: normalizeDecisionDate(extracted.decidedAt ?? null) ?? undefined,
            topic: fields.topic,
            project: fields.project,
            participants: extracted.participants ?? [],
            rationale: extracted.rationale,
            consequences: extracted.consequences,
            alternatives: extracted.alternatives ?? [],
            validFrom: extracted.validFrom,
            validUntil: extracted.validUntil,
            unknownFields: [...fields.unknownFields],
            sourceIds: [],
            confidence: extracted.confidence ?? 0.8,
            asDraft: false,
          },
          { actor: 'user', trigger: 'chat', status: request.status },
        );
    const namedAsProject = extracted.topicIsProject === true && fields.topic && fields.project && normalizeName(fields.topic) === normalizeName(fields.project);
    return this.afterChange(request, {
      decision: created,
      clarifyTopic: fields.clarify,
      supersedesHint: supersedes ? (intent.topic ?? fields.topic ?? intent.query ?? '') : null,
      supersedesId: supersedes ? (extracted.supersedesId ?? null) : null,
      topicMerge: namedAsProject ? this.proposeTopicMerge(request.conv, fields.project!) : NO_PROPOSALS,
    });
  }

  /** A re-stated incomplete draft takes the details the new statement names. */
  private fillDraft(draft: Decision, addition: { extracted: Extracted; fields: DecisionFields; status?: 'unclear' }): Decision {
    // an unreviewed background capture is no request of the user's, so it does not change the user's draft
    if (draft.missingFields.length === 0 || addition.status === 'unclear') return draft;
    const { extracted, fields } = addition;
    const decidedAt = normalizeDecisionDate(extracted.decidedAt ?? null);
    const patch: DecisionPatch = { ...(decidedAt ? { decidedAt } : {}), ...detailPatch(draft, { extracted, unknownFields: fields.unknownFields }) };
    return Object.keys(patch).length ? this.deps.decisions.update(draft.id, { patch, trigger: 'chat' }) : draft;
  }

  /** The same decision (text and topic) is already stored: it is not recorded twice. */
  private duplicateReply(request: DecisionRequest, existing: Decision): Reply {
    return {
      intent: 'decision_new',
      content: `Diese Entscheidung habe ich schon erfasst, ich lege sie nicht noch einmal an.\n\n${this.deps.decisions.format(existing)}`,
      sources: [decisionSource(existing)],
      context: this.decisionContext(existing),
      confidence: 0.9,
      state: { pending: null, last: { ...(request.state.last ?? {}), decisionId: existing.id } },
    };
  }

  private amendPatch(change: { target: Decision; extracted: Extracted; pending: DecisionPending | null; fields: DecisionFields }, text: string): DecisionPatch {
    const { target, extracted, pending, fields } = change;
    const patch: DecisionPatch = {};
    if (extracted.decisionText && !target.decisionText) patch.decisionText = extracted.decisionText;
    const askedDate = fields.asked.includes('decidedAt') && !fields.unknownFields.has('decidedAt') ? parseDecisionDate(text) : null;
    const date = normalizeDecisionDate(extracted.decidedAt ?? null) ?? askedDate;
    if (date) patch.decidedAt = date;
    if (fields.topic) patch.topic = fields.topic;
    if (fields.project) patch.project = fields.project;
    if (extracted.topicIsProject === true && !patch.project && pending?.clarifyTopic) {
      patch.project = pending.clarifyTopic;
      if (!patch.topic && !target.topicName) patch.topic = pending.clarifyTopic;
    }
    return { ...patch, ...detailPatch(target, { extracted, unknownFields: fields.unknownFields }) };
  }

  private amend(
    request: DecisionRequest,
    change: { target: Decision; extracted: Extracted; pending: DecisionPending | null; fields: DecisionFields },
  ): Promise<Reply> {
    const { intent, state } = request;
    const { target, extracted, pending, fields } = change;
    const patch = this.amendPatch(change, request.text);
    if (!pending && Object.keys(patch).length === 0)
      return Promise.resolve({
        intent: intent.intent,
        content: `Was soll ich an der Entscheidung „${target.title}“ ergänzen? Nenne bitte Datum, Beteiligte, Begründung, Thema oder Projekt.`,
        sources: [decisionSource(target)],
        confidence: 0.4,
        state: { ...state, last: { ...(state.last ?? {}), decisionId: target.id } },
      });
    const updated = this.deps.decisions.update(target.id, { patch, trigger: 'chat' });
    const answeredProject = extracted.topicIsProject === true ? (pending?.clarifyTopic ?? null) : null;
    // „Thema oder Projekt?“ stays asked until it is answered (or another topic was named)
    const unanswered = extracted.topicIsProject === null || extracted.topicIsProject === undefined;
    const sameTopic = !fields.topic || normalizeName(fields.topic) === normalizeName(pending?.clarifyTopic ?? '');
    const stillClarify = pending?.clarifyTopic && unanswered && sameTopic ? pending.clarifyTopic : null;
    return this.afterChange(request, {
      decision: updated,
      clarifyTopic: stillClarify,
      supersedesHint: pending?.supersedes ?? null,
      supersedesId: pending?.supersedesId ?? null,
      topicMerge: answeredProject ? this.proposeTopicMerge(request.conv, answeredProject) : NO_PROPOSALS,
    });
  }

  private decisionContext(decision: Decision): Partial<ChatContext> {
    return {
      decisions: [decisionRef(decision)],
      topics: decision.topicId ? [{ type: 'topic', id: decision.topicId, label: decision.topicName ?? '' }] : [],
      projects: decision.projectId ? [{ type: 'project', id: decision.projectId, label: decision.projectName ?? '' }] : [],
      persons: decision.participants.map((participant) => {
        const entity = this.deps.persons.resolve(participant, { context: 'chat', create: false }).entity;
        return { type: 'person' as const, id: entity?.id ?? participant, label: participant };
      }),
    };
  }

  private afterChange(request: DecisionRequest, change: DecisionChange): Promise<Reply> {
    const last = { ...(request.state.last ?? {}), decisionId: change.decision.id };
    if (change.decision.missingFields.length > 0) return Promise.resolve(this.draftReply(change, { viaLlm: request.viaLlm, last }));
    return this.completeReply(request, { change, last });
  }

  /** The decision still lacks required fields: it stays a draft and the reply asks for them. */
  private draftReply(change: DecisionChange, scope: { viaLlm: boolean; last: ConvState['last'] }): Reply {
    const { decision, clarifyTopic } = change;
    const missing = decision.missingFields;
    // targeted follow-up questions (with LLM several at once, otherwise one after the other)
    const askFields = scope.viaLlm ? missing : [missing[0]!];
    const questions = askFields.map((field) => `• ${questionFor(field, { topic: decision.topicName })}`);
    if (clarifyTopic) questions.push(`• Ist „${clarifyTopic}“ das Thema oder der Name des Projekts?`);
    const known = this.deps.decisions.format(decision);
    const merge = change.topicMerge.lines.map((line) => `\n\n${line}`).join('');
    return {
      intent: 'decision_new',
      content: `Ich habe die Entscheidung als **Entwurf** gespeichert. Damit sie vollständig ist, brauche ich noch:\n\n${questions.join('\n')}\n\n(Wenn du etwas nicht weißt, sage „unbekannt“ – dann speichere ich es so.)\n\n${known}${merge}`,
      actions: change.topicMerge.actions,
      sources: [decisionSource(decision)],
      context: this.decisionContext(decision),
      confidence: decision.confidence,
      uncertainties: missing.map((field) => `${DECISION_FIELD_LABELS[field]} fehlt noch`),
      state: {
        pending: {
          kind: 'decision',
          decisionId: decision.id,
          asked: askFields,
          clarifyTopic,
          supersedes: change.supersedesHint,
          supersedesId: change.supersedesId,
        },
        last: scope.last,
      },
    };
  }

  /** The decision is complete: check for contradictions and propose superseding if needed. */
  private async completeReply(request: DecisionRequest, scope: { change: DecisionChange; last: ConvState['last'] }): Promise<Reply> {
    const { change } = scope;
    const { decision } = change;
    const actions: StoredAgentAction[] = [...change.topicMerge.actions];
    const lines: string[] = [...change.topicMerge.lines];
    const conflicts = await this.deps.contradictions.checkDecision(decision.id);
    for (const conflict of conflicts) {
      const insight = this.deps.insights.byDedupeKey(`contradiction:${conflict.id}`);
      if (insight?.recommendedActionId) actions.push(this.deps.actions().get(insight.recommendedActionId));
      lines.push(`⚠ ${conflict.title}: ${conflict.description.split('\n')[0]}`);
    }
    let next: Pending | null = null;
    if (change.supersedesHint !== null) {
      const followUp = this.supersede.followUp({
        conv: request.conv,
        decision,
        hint: change.supersedesHint,
        supersedesId: change.supersedesId,
        proposed: actions,
      });
      actions.push(...followUp.actions);
      lines.push(...followUp.lines);
      next = followUp.next;
    }
    // „Thema oder Projekt?“ even for an otherwise complete decision – the question blocks no further requests
    const clarify = !next && change.clarifyTopic ? change.clarifyTopic : null;
    if (clarify) {
      lines.push(`Ist „${clarify}“ das Thema oder der Name des Projekts?`);
      next = { kind: 'decision', decisionId: decision.id, asked: [], clarifyTopic: clarify, optional: true };
    }
    if (decision.status === 'unclear') lines.unshift('Ich habe sie als „unklar“ markiert, weil du sie noch nicht bestätigt hast.');
    return {
      intent: 'decision_new',
      content: `Die Entscheidung ist gespeichert.\n\n${this.deps.decisions.format(decision)}${lines.length ? `\n\n${lines.join('\n')}` : ''}`,
      ...(clarify ? { quickReplies: TOPIC_KIND_QUICK_REPLIES } : {}),
      sources: [decisionSource(decision)],
      context: {
        ...this.decisionContext(decision),
        contradictions: conflicts.map((conflict) => ({ type: 'contradiction' as const, id: conflict.id, label: conflict.title })),
      },
      actions,
      confidence: decision.confidence,
      uncertainties: decision.unknownFields.map((field) => `${DECISION_FIELD_LABELS[field]}: als unbekannt bestätigt`),
      state: { pending: next, last: scope.last },
    };
  }
}
