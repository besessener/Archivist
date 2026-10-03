import type { DocumentRecord } from '@archivist/shared';
import type { ToolOutput } from '../../registry';
import { docLine, resolveDocs, unknownNote, type ToolScope } from '../common';
import { archivedDocs, documentText, skippedNote } from './access';
import { detectLanguage, LANGUAGE_NAME, type DocumentLanguage } from './languages';

/** Archived documents not written in the user's language, grouped by the detected language (stopword counts – a clear hint, not a certainty). */
export async function foreignLanguageReport(scope: ToolScope, args: { documents?: readonly string[] | null; language: DocumentLanguage }): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const source = args.documents?.length ? resolveDocs(scope, args.documents) : { docs: archivedDocs(deps), unknown: [] as string[] };
  const shareable = source.docs.filter((d) => deps.privacy.mayShareDocument(d));
  const byLanguage = new Map<DocumentLanguage, DocumentRecord[]>();
  let unclear = 0;
  for (const d of shareable) {
    const guess = detectLanguage(documentText(deps, d.id));
    if (!guess) unclear += 1;
    else if (guess.language !== args.language) byLanguage.set(guess.language, [...(byLanguage.get(guess.language) ?? []), d]);
  }
  const foreign = [...byLanguage.values()].reduce((sum, group) => sum + group.length, 0);
  const notes = `${skippedNote(source.docs.length - shareable.length)}${unknownNote(source.unknown)}`;
  const summary = `${shareable.length} Dokumente geprüft, ${unclear} ohne eindeutige Sprache (zu kurz, Zahlen oder gemischt).`;
  if (!foreign)
    return {
      content: `Keine Dokumente in einer anderen Sprache als ${LANGUAGE_NAME[args.language]} gefunden. ${summary}${notes}`,
      summary: 'keine fremdsprachigen',
    };
  const sections = [...byLanguage]
    .toSorted((a, b) => b[1].length - a[1].length)
    .map(
      ([language, group]) =>
        `${LANGUAGE_NAME[language]} (${group.length}, Ergebnismenge ${ctx.refs.set(group.map((d) => d.id))}):\n${group
          .slice(0, 30)
          .map((d) => `- ${docLine(scope, d)}`)
          .join('\n')}${group.length > 30 ? `\n… und ${group.length - 30} weitere` : ''}`,
    );
  return {
    content: `${foreign} Dokument(e) nicht auf ${LANGUAGE_NAME[args.language]}:\n${sections.join('\n')}\n${summary}\nSuchbegriffe in diesen Sprachen übersetzt du selbst; search nimmt sie als alsoTry mit.${notes}`,
    summary: `${foreign} fremdsprachig`,
  };
}
