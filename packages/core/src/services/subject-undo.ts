import type { AppContext } from '../context';
import { nowIso } from '../util/ids';
import type { MainUndo, TagUndo } from './subject-assignment';
import type { UndoService } from './undo';

/** Undo of main topics/projects a bulk assignment set (#291). */
export const MAIN_UNDO_TYPE = 'subjects.main';
/** Undo of tags a bulk assignment added to documents (#291). */
export const TAGS_UNDO_TYPE = 'subjects.docTags';

interface SubjectUndoDeps {
  ctx: AppContext;
  reindex: (ids: string[]) => Promise<void>;
}

function storedTags(ctx: AppContext, documentId: string): string[] | undefined {
  const row = ctx.database.sqlite.prepare('SELECT tags FROM documents WHERE id = ?').get(documentId) as { tags: string } | undefined;
  return row ? (JSON.parse(row.tags) as string[]) : undefined;
}

function changedMainCount(ctx: AppContext, items: MainUndo[]): number {
  return items.filter((main) => {
    const row = ctx.database.sqlite.prepare(`SELECT ${main.col} AS v FROM ${main.table} WHERE id = ?`).get(main.id) as { v: string | null } | undefined;
    return row?.v !== main.value;
  }).length;
}

function registerMainUndo(undo: UndoService, { ctx, reindex }: SubjectUndoDeps): void {
  undo.register(MAIN_UNDO_TYPE, {
    check: async (data) => {
      const changed = changedMainCount(ctx, data as MainUndo[]);
      return changed ? [`Bei ${changed} Einträgen wurde Thema bzw. Projekt seither geändert.`] : [];
    },
    run: async (data) => {
      const items = data as MainUndo[];
      for (const main of items) ctx.database.sqlite.prepare(`UPDATE ${main.table} SET ${main.col} = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), main.id);
      await reindex(items.map((main) => main.id));
      ctx.events.changed('documents', 'decisions', 'openItems', 'events');
      return `Zuordnung bei ${items.length} Einträgen zurückgenommen.`;
    },
  });
}

function registerTagsUndo(undo: UndoService, { ctx, reindex }: SubjectUndoDeps): void {
  undo.register(TAGS_UNDO_TYPE, {
    check: async (data) => {
      const changed = (data as TagUndo[]).filter((tagUndo) => {
        const current = storedTags(ctx, tagUndo.id) ?? [];
        return tagUndo.added.some((tag) => !current.includes(tag));
      }).length;
      return changed ? [`Bei ${changed} Dokumenten wurden die Tags seither geändert.`] : [];
    },
    run: async (data) => {
      const items = data as TagUndo[];
      for (const tagUndo of items) {
        const current = storedTags(ctx, tagUndo.id)!;
        ctx.database.sqlite
          .prepare('UPDATE documents SET tags = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(current.filter((tag) => !tagUndo.added.includes(tag))), nowIso(), tagUndo.id);
      }
      await reindex(items.map((tagUndo) => tagUndo.id));
      ctx.events.changed('documents');
      return `Tags bei ${items.length} Dokumenten entfernt.`;
    },
  });
}

/** Registers the undo handlers of the bulk assignment's main values and document tags. */
export function registerSubjectUndo(undo: UndoService, deps: SubjectUndoDeps): void {
  registerMainUndo(undo, deps);
  registerTagsUndo(undo, deps);
}
