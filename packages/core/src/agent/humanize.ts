import type { RefType, SourceReference } from '@archivist/shared';
import { truncate } from '../util/text';
import type { RefStore } from './registry';
import type { ToolDeps } from './tools/common';

const TYPE_TO_REF: Partial<Record<string, RefType>> = { task: 'task', question: 'question' };

interface Named {
  name: string;
  source?: SourceReference;
}

/** Turns D/K references of an answer into names the user understands; documents not shared stay anonymous. */
export class RefHumanizer {
  constructor(private readonly deps: Pick<ToolDeps, 'docs' | 'privacy' | 'graph'>) {}

  humanize(text: string, refs: RefStore): { text: string; sources: SourceReference[] } {
    const sources = new Map<string, SourceReference>();
    const named = text.replace(/\b([DK])(\d{1,5})\b/g, (ref) => {
      const id = refs.resolve(ref);
      if (!id) return ref;
      const { name, source } = ref.startsWith('D') ? this.document(id, ref) : this.entry(id, ref);
      if (source) sources.set(id, source);
      return name;
    });
    return { text: named, sources: [...sources.values()] };
  }

  private document(id: string, ref: string): Named {
    if (!this.deps.docs.findRow(id)) return { name: ref };
    const doc = this.deps.docs.get(id);
    if (!this.deps.privacy.mayShareDocument(doc)) return { name: 'ein Dokument' };
    return {
      name: `„${doc.title}“`,
      source: {
        id,
        type: 'document',
        title: doc.title,
        snippet: truncate(doc.summary ?? doc.textPreview, 200),
        path: doc.archivePath ?? doc.sourcePath,
        date: doc.documentDate ?? doc.archivedAt,
        score: 1,
      },
    };
  }

  private entry(id: string, ref: string): Named {
    const entity = this.deps.graph.getEntity(id);
    if (!entity) return { name: ref };
    const type = TYPE_TO_REF[entity.type] ?? entity.type;
    return {
      name: `„${truncate(entity.name, 80)}“`,
      source: { id, type, title: entity.name, snippet: truncate(entity.description ?? '', 200), path: null, date: entity.createdAt, score: 1 },
    };
  }
}
