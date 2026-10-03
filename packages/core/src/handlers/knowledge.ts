import { RelationType, type EntityType, type IpcParsedInput, type KnowledgeCreateResult } from '@archivist/shared';
import type { Services } from '../create-services';
import { AppError } from '../util/errors';
import { UI_TRIGGER, type HandlerGroup } from './types';

type CreateEntityInput = IpcParsedInput<'knowledge:createEntity'>;
type CreateEventInput = Extract<CreateEntityInput, { type: 'event' }>;
type CreateNamedInput = Exclude<CreateEntityInput, { type: 'event' }>;

function createEvent(services: Services, input: CreateEventInput): KnowledgeCreateResult {
  const { event, created } = services.eventRecords.createUnlessExists(input, { actor: 'user', trigger: UI_TRIGGER });
  const entity = services.graph.getEntity(event.id) ?? {
    id: event.id,
    type: 'event' as const,
    name: event.title,
    description: event.description,
    aliases: [],
    roles: [],
    duplicateOfId: event.duplicateOfId,
    isSelf: false,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
  return { entity, created };
}

async function createNote(services: Services, input: CreateNamedInput): Promise<KnowledgeCreateResult> {
  const { note, created } = await services.notes.createUnlessExists({ title: input.name, content: input.description?.trim() || input.name });
  if (created)
    services.audit.log({ action: 'note.create', actor: 'user', trigger: UI_TRIGGER, confirmed: true, entityIds: [note.id], after: { title: note.name } });
  return { entity: note, created };
}

/** Persons go through the central resolution (roles, spellings, no pronouns or answer words). */
function createPerson(services: Services, input: CreateNamedInput): KnowledgeCreateResult {
  const person = services.persons.resolve(input.name, { context: 'manual', description: input.description?.trim() || null });
  if (!person.entity) throw new AppError('validation_error', `„${input.name.trim()}“ ist kein Personenname.`);
  const created = person.matchedBy === 'created';
  if (created)
    services.audit.log({
      action: 'person.create',
      actor: 'user',
      trigger: UI_TRIGGER,
      confirmed: true,
      entityIds: [person.entity.id],
      after: { name: person.entity.name },
    });
  return { entity: person.entity, created };
}

function createGraphEntity(services: Services, input: { type: 'topic' | 'project'; name: string; description?: string }): KnowledgeCreateResult {
  // a merged-away name (alias) also counts as existing
  const existing = services.graph.findByNameOrAlias(input.type, input.name);
  if (existing) return { entity: existing, created: false };
  const entity = services.graph.ensureEntity({ type: input.type, name: input.name, description: input.description?.trim() || null });
  services.audit.log({
    action: `${input.type}.create`,
    actor: 'user',
    trigger: UI_TRIGGER,
    confirmed: true,
    entityIds: [entity.id],
    after: { name: entity.name },
  });
  return { entity, created: true };
}

async function createEntity(services: Services, input: CreateEntityInput): Promise<KnowledgeCreateResult> {
  if (input.type === 'event') return createEvent(services, input);
  if (input.type === 'note') return createNote(services, input);
  if (input.type === 'case') {
    const result = services.cases.create({ name: input.name, description: input.description, trigger: UI_TRIGGER });
    return { entity: result.case, created: result.created };
  }
  if (input.type === 'person') return createPerson(services, input);
  return createGraphEntity(services, { type: input.type, name: input.name, description: input.description });
}

const MERGEABLE_TYPES = new Set<EntityType>(['topic', 'project', 'person', 'tag']);

function proposeMerge(services: Services, input: { sourceId: string; targetId: string }) {
  const source = services.graph.getEntity(input.sourceId);
  const target = services.graph.getEntity(input.targetId);
  if (!source || !target) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
  if (source.id === target.id || source.type !== target.type || !MERGEABLE_TYPES.has(source.type))
    throw new AppError('validation_error', 'Nur zwei verschiedene Themen, Projekte, Personen oder Schlagwörter lassen sich zusammenführen.');
  return services.actions.propose({
    actionType: 'merge_entities',
    label: `„${source.name}“ in „${target.name}“ zusammenführen`,
    rationale: 'Vom Benutzer vorgeschlagen.',
    confidence: 0.9,
    affectedEntities: [
      { type: source.type, id: source.id, label: source.name },
      { type: target.type, id: target.id, label: target.name },
    ],
    requiredConfirmation: 'confirm',
    proposedParameters: { sourceIds: [source.id], targetId: target.id, allowCrossType: false },
  });
}

/** The knowledge graph, link proposals, several topics per entry and cases. */
export function knowledgeHandlers(services: Services): HandlerGroup<'knowledge' | 'links' | 'subjects' | 'entries' | 'cases'> {
  return {
    'knowledge:listEntities': (input) => services.graph.listEntities(input),
    'knowledge:getEntity': (input) => services.graph.getDetail(input.id),
    'knowledge:link': (input) => {
      const type = RelationType.safeParse(input.relationType);
      if (!type.success) throw new AppError('validation_error', 'Unbekannte Art der Beziehung.');
      return services.graph.linkEntries(
        { sourceId: input.sourceId, targetId: input.targetId, relationType: type.data },
        {
          status: 'confirmed',
          trigger: UI_TRIGGER,
          method: input.method,
          evidence: input.evidence,
        },
      ).relation;
    },
    'knowledge:updateNote': (input) => services.notes.update(input.id, { patch: { title: input.title, content: input.content }, trigger: UI_TRIGGER }),
    'knowledge:deleteNote': (input) => {
      services.notes.delete(input.id, { confirmed: input.confirmed, trigger: UI_TRIGGER });
      return { ok: true as const };
    },
    'knowledge:unlink': (input) => {
      services.graph.unlinkEntries(input.relationId, { trigger: UI_TRIGGER });
      return { ok: true as const };
    },
    'knowledge:related': (input) => services.links.related(input.id, input),
    'knowledge:hierarchy': () => services.graph.hierarchy(),
    'knowledge:neighborhood': (input) => services.graph.neighborhood(input.id, input),
    'knowledge:wikiSuggest': (input) => services.notes.wiki.suggest(input.query, { limit: input.limit, excludeId: input.excludeId }),
    'knowledge:wikiResolve': (input) => services.notes.wiki.resolveAll(input.names, input.noteId),
    'knowledge:resolveRelation': (input) => {
      // confirming and rejecting are undoable decisions (#280); other statuses are only logged
      if (input.status === 'confirmed' || input.status === 'rejected')
        services.graph.decideRelation(input.relationId, { status: input.status, trigger: UI_TRIGGER });
      else {
        services.graph.setRelationStatus(input.relationId, { status: input.status });
        services.audit.log({ action: `relation.${input.status}`, actor: 'user', trigger: UI_TRIGGER, confirmed: true, entityIds: [input.relationId] });
      }
      return { ok: true as const };
    },
    'knowledge:createEntity': (input) => createEntity(services, input),
    'knowledge:confirmEntity': (input) => {
      const entity = services.graph.confirmEntity(input.id);
      services.audit.log({
        action: `${entity.type}.confirm`,
        actor: 'user',
        trigger: UI_TRIGGER,
        confirmed: true,
        entityIds: [entity.id],
        after: { name: entity.name },
      });
      return entity;
    },
    'knowledge:proposeMerge': (input) => proposeMerge(services, input),

    'links:suggestions': (input) => services.links.candidates(input.id, { limit: input.limit }),
    'links:unlinked': (input) => services.links.orphans(input),
    'links:startRun': () => ({ jobId: services.enqueueLinkRun('manual').id }),
    'links:proposals': (input) => services.links.proposals(input),
    'links:metrics': () => services.links.metrics(),
    'links:thresholds': () => services.linkThresholds.list(),
    'links:resetThresholds': () => {
      services.linkThresholds.reset();
      services.audit.log({ action: 'links.thresholds.reset', actor: 'user', trigger: UI_TRIGGER, confirmed: true, entityIds: [] });
      return { ok: true as const };
    },
    'links:decide': (input) => ({ decided: services.graph.decideRelations(input.relationIds, { status: input.decision, trigger: UI_TRIGGER }) }),
    'links:decideGroup': (input) => ({
      decided: services.links.decideGroup({ groupBy: input.groupBy, key: input.key }, { status: input.decision, trigger: UI_TRIGGER }),
    }),

    'subjects:of': (input) => services.subjects.ofMany(input.ids),
    'subjects:setExtras': (input) => services.subjects.setExtras(input.id, { patch: { topics: input.topics, projects: input.projects }, trigger: UI_TRIGGER }),
    'entries:bulkAssign': (input) =>
      services.subjects.bulkAssign(input.ids, {
        patch: {
          topics: input.topic ? [input.topic] : [],
          projects: input.project ? [input.project] : [],
          tags: input.tag ? [input.tag] : [],
          caseId: input.caseId,
        },
        trigger: UI_TRIGGER,
      }),

    'cases:list': (input) => services.cases.list(input),
    'cases:detail': (input) => services.cases.detail(input.id),
    'cases:create': (input) => services.cases.create({ name: input.name, description: input.description, trigger: UI_TRIGGER }),
    'cases:assign': (input) => ({ assigned: services.cases.assign({ entryIds: input.entryIds, caseId: input.caseId, trigger: UI_TRIGGER }) }),
    'cases:setStatus': (input) => services.graph.setCaseStatus(input.id, { status: input.status, trigger: UI_TRIGGER }),
  };
}
