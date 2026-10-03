import type { ChatIntent, DocumentRecord } from '@archivist/shared';
import { tokenize } from '../../util/text';
import type { ConvState, Reply } from '../chat-state';
import { subjectTokens } from './subjects';
import type { ChatDeps, ChatRequest } from './types';

/** Archived documents meant by a request; `choices` lists the topics to ask about when several match. */
export interface SubjectDocuments {
  docs: DocumentRecord[];
  subject: string | null;
  choices: string[];
}

type SubjectDeps = Pick<ChatDeps, 'graph' | 'docs' | 'search'>;

export function archivedWithFile(docs: DocumentRecord[]): DocumentRecord[] {
  return docs.filter((d) => d.status === 'archived' && d.archiveRelPath);
}

/** The topic a filing request names: topic or project, otherwise a query with words of its own. */
function namedSubject(intent: ChatIntent): string | null {
  const named = (intent.topic ?? intent.project)?.trim() || null;
  const query = intent.query?.trim() || null;
  return named ?? (query && subjectTokens(query).length ? query : null);
}

/** A named topic/project takes precedence; only without one do the documents shown last apply („die“, „alle“, „sie“). */
export class FilingSubjects {
  constructor(private readonly deps: SubjectDeps) {}

  /** Documents to look at; without a matching topic a full-text search helps. */
  async toView({ intent, state }: ChatRequest): Promise<SubjectDocuments> {
    const subject = namedSubject(intent);
    if (!subject) return this.lastShown(state);
    const matched = this.matching(subject);
    if (matched) return matched;
    const hits = await this.deps.search.search(subject, { types: ['document'], limit: 30 });
    return { docs: this.archivedByIds(hits.map((h) => h.id)), subject, choices: [] };
  }

  /** Documents to move: never found by a full-text search. */
  toMove({ intent, state }: ChatRequest): SubjectDocuments {
    const subject = namedSubject(intent);
    if (!subject) return this.lastShown(state);
    return this.matching(subject) ?? { docs: [], subject, choices: [] };
  }

  /** „Meinst du „Bildungsurlaub 2025“ oder „Bildungsurlaub 2026“?“ – afterwards the request continues with the chosen topic. */
  askWhich(request: ChatRequest, names: string[]): Reply {
    const list = names.slice(0, 6);
    return {
      intent: request.intent.intent,
      content: `Meinst du ${list
        .slice(0, -1)
        .map((n) => `„${n}“`)
        .join(', ')} oder „${list.at(-1)}“?`,
      quickReplies: list,
      confidence: 0.5,
      state: { ...request.state, pending: { kind: 'subject_choice', text: request.text, intent: request.intent, names: list } },
    };
  }

  /** One matching topic with its documents, or the choices; null when no topic has archived documents. */
  private matching(subject: string): SubjectDocuments | null {
    const candidates = this.candidates(subject);
    if (candidates.length === 1) return { docs: candidates[0]!.docs, subject: candidates[0]!.name, choices: [] };
    if (candidates.length > 1) return { docs: [], subject, choices: candidates.map((c) => c.name) };
    return null;
  }

  private lastShown(state: ConvState): SubjectDocuments {
    const last = this.archivedByIds(state.last?.documentIds ?? []);
    if (last.length) return { docs: last, subject: state.last?.topic ?? null, choices: [] };
    return { docs: [], subject: null, choices: [] };
  }

  /** Topics/projects with archived documents for a given name: exact match, otherwise all that contain every word. */
  private candidates(subject: string): Array<{ name: string; docs: DocumentRecord[] }> {
    const withDocs = (e: { id: string; type: string; name: string }) => ({
      name: e.name,
      docs: archivedWithFile(this.deps.docs.list({ [e.type === 'topic' ? 'topicId' : 'projectId']: e.id, limit: 200 })),
    });
    const exact = this.deps.graph.findByNameOrAlias('topic', subject) ?? this.deps.graph.findByNameOrAlias('project', subject);
    const exactHit = exact ? withDocs(exact) : null;
    if (exactHit?.docs.length) return [exactHit];
    const wanted = subjectTokens(subject);
    if (!wanted.length) return [];
    return [...this.deps.graph.listEntities({ type: 'topic', limit: 500 }), ...this.deps.graph.listEntities({ type: 'project', limit: 500 })]
      .filter((e) => {
        const have = tokenize(e.name, { keepStopwords: true });
        return wanted.every((w) => have.some((h) => h === w || (w.length >= 4 && h.startsWith(w))));
      })
      .map(withDocs)
      .filter((c) => c.docs.length > 0);
  }

  private archivedByIds(ids: string[]): DocumentRecord[] {
    return archivedWithFile(
      ids.flatMap((id) => {
        try {
          return [this.deps.docs.get(id)];
        } catch {
          return [];
        }
      }),
    );
  }
}
