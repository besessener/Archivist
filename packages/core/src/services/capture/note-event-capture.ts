import type { SourceReference } from '@archivist/shared';
import { normalizeDateInput, parseGermanDate } from '../../util/dates';
import { truncate } from '../../util/text';
import type { ConvState, Reply } from '../chat-state';
import type { CaptureDeps, CaptureRequest } from './capture-deps';

/** Saves a note (linked to the named topic); an identical note is not stored twice. */
export async function captureNote(deps: CaptureDeps, request: CaptureRequest): Promise<Reply> {
  const { text, intent, state } = request;
  const content = (intent.note ?? text).trim();
  const topic = intent.topic ? deps.graph.ensureEntity({ type: 'topic', name: intent.topic }) : null;
  const { note } = await deps.notes.createUnlessExists({
    content,
    links: topic ? [{ targetId: topic.id, relationType: 'relates_to', confidence: 0.8 }] : [],
  });
  return {
    intent: 'note_capture',
    content: `Notiz gespeichert${intent.topic ? ` (Thema: ${intent.topic})` : ''}.`,
    sources: [{ id: note.id, type: 'note', title: note.name, snippet: truncate(content, 200), score: 1, path: null, date: note.createdAt }],
    context: { topics: topic ? [{ type: 'topic', id: topic.id, label: intent.topic ?? topic.name }] : [] },
    confidence: intent.confidence,
    state,
  };
}

/** The event as far as known: from the running date question, the LLM's extraction or the message itself. */
function eventDraft(request: CaptureRequest) {
  const { text, intent, state } = request;
  const pending = state.pending?.kind === 'event' ? state.pending : null;
  const extracted = intent.event ?? {};
  const segment = intent.segment ?? text;
  const title = (pending?.title ?? extracted.title?.trim() ?? truncate(segment, 100)).slice(0, 160);
  const longSegment = segment.trim().length > title.length + 10 ? segment.trim().slice(0, 2000) : null;
  return {
    pending,
    title,
    occurredAt: normalizeDateInput(extracted.occurredAt ?? null) ?? parseGermanDate(pending ? text : segment),
    description: pending?.description ?? extracted.description?.trim() ?? longSegment,
    participants: pending?.participants ?? (extracted.participants ?? []).map((participant) => participant.trim()).filter(Boolean),
    topic: pending?.topic ?? intent.topic,
    project: pending?.project ?? intent.project,
  };
}

/** Enters an event in the timeline; without a date it asks for one first. */
export async function recordEvent(deps: CaptureDeps, request: CaptureRequest): Promise<Reply> {
  const { text, intent, state } = request;
  const { pending, title, occurredAt, description, participants, topic, project } = eventDraft(request);
  if (!occurredAt) {
    return {
      intent: 'event_record',
      content: `An welchem Datum war das Ereignis „${title}“? Nenne bitte ein Datum, damit ich es in der Timeline einordnen kann.`,
      confidence: 0.4,
      state: {
        ...state,
        pending: {
          kind: 'event',
          title,
          description,
          topic: topic ?? null,
          project: project ?? null,
          participants,
          source: pending?.source ?? text.slice(0, 4000),
        },
      },
    };
  }
  const event = deps.events.create({ title, description, occurredAt, topic, project, participants, sourceIds: [] }, { actor: 'user', trigger: 'chat' });
  const sources: SourceReference[] = [
    { id: event.id, type: 'event', title: event.title, snippet: truncate(event.description ?? '', 200), score: 1, path: null, date: event.occurredAt },
  ];
  const details = [
    event.topicName ? `, Thema: ${event.topicName}` : '',
    event.projectName ? `, Projekt: ${event.projectName}` : '',
    event.participants.length ? `, Beteiligte: ${event.participants.join(', ')}` : '',
  ].join('');
  const cleared: ConvState = { ...state, pending: null };
  return {
    intent: 'event_record',
    content: `Ereignis in der Timeline eingetragen: **${event.title}** (${event.occurredAt.slice(0, 10)})${details}.`,
    sources,
    context: {
      topics: event.topicName ? [{ type: 'topic', id: event.topicId!, label: event.topicName }] : [],
      projects: event.projectName ? [{ type: 'project', id: event.projectId!, label: event.projectName }] : [],
    },
    confidence: intent.confidence,
    state: cleared,
  };
}
