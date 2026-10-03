import { folderOf } from '../../../services/archive-structure';
import type { ToolOutput } from '../../registry';
import { docLine, lower, normalizeFolder, resolveDocs, unknownNote, type ToolDeps, type ToolScope } from '../common';
import { runFileJob } from '../files';
import { businessDate } from './access';

/** The new main category a target folder would create (it always asks), or null. */
export function newMainCategory(deps: ToolDeps, folder: string): string | null {
  try {
    return deps.categories.needsApproval(deps.categories.canonical(folder));
  } catch {
    return null;
  }
}

/** Files the mails of one thread together: confirmed links to the first mail and a shared folder – every step is logged with the run and can be undone. */
export async function fileMailThread(scope: ToolScope, args: { documents: string[]; folder: string }): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const { docs, unknown } = resolveDocs(scope, args.documents);
  const mails = docs.filter((d) => lower(d.ext) === 'eml').toSorted((x, y) => businessDate(x).localeCompare(businessDate(y)));
  if (mails.length < 2)
    return { content: `Ein Verlauf braucht mindestens zwei E-Mails (.eml); gefunden: ${mails.length}.${unknownNote(unknown)}`, isError: true };
  const [first, ...replies] = mails;
  const linked = deps.graph.linkMany({ sourceIds: replies.map((d) => d.id), targetId: first!.id, relationType: 'relates_to' }, { trigger: 'agent' });
  const target = deps.categories.canonical(args.folder);
  const main = deps.categories.needsApproval(target);
  // only reached after the user confirmed (critical) – then the new main category is created with that confirmation
  if (main) deps.categories.create(main, { confirmed: true });
  const movable = mails.filter((d) => d.status === 'archived' && d.archiveRelPath && normalizeFolder(folderOf(d)).toLowerCase() !== target.toLowerCase());
  const moved = movable.length
    ? await runFileJob(
        { deps, ctx },
        { op: 'relocate', items: movable.map((d) => ({ documentId: d.id, categoryPath: target })), label: `Agent: E-Mail-Verlauf nach ${target} legen` },
      )
    : null;
  const failed = moved ? moved.failed + moved.conflicts : 0;
  const change = `E-Mail-Verlauf mit ${mails.length} Nachrichten abgelegt: ${linked} Verknüpfung(en), ${moved?.success ?? 0} nach ${target} verschoben`;
  return {
    content: `${change}${failed ? `, ${failed} nicht verschoben` : ''}.\n${mails.map((d) => `- ${docLine(scope, d)}`).join('\n')}${unknownNote(unknown)}`,
    summary: `${mails.length} Nachrichten abgelegt`,
    change,
    changed: mails.length,
    isError: moved !== null && moved.success === 0 && failed > 0,
  };
}
