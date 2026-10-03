import type { DocumentRecord } from '@archivist/shared';
import type { ToolOutput } from '../../registry';
import { asData } from '../../security';
import { docLine, resolveDocs, unknownNote, type ToolScope } from '../common';
import { documentText } from './access';
import { MAX_DIFF_LINES, changeLabel, diffLines, type LineDiff } from './diff';

const MAX_SHOWN = 80;
const cell = (text: string) => text.replaceAll('|', '\\|');
const showLines = (lines: string[]) =>
  lines.slice(0, MAX_SHOWN).join('\n') + (lines.length > MAX_SHOWN ? `\n… und ${lines.length - MAX_SHOWN} weitere Zeilen` : '');

function changeTable(changed: LineDiff['changed']): string {
  const rows = changed.slice(0, MAX_SHOWN).map((pair) => `| ${cell(pair.from)} | ${cell(pair.to)} | ${cell(changeLabel(pair))} |`);
  const more = changed.length > MAX_SHOWN ? [`… und ${changed.length - MAX_SHOWN} weitere Änderungen`] : [];
  return ['| In A (alt) | In B (neu) | Änderung |', '| --- | --- | --- |', ...rows, ...more].join('\n');
}

function comparison(scope: ToolScope, pair: { first: DocumentRecord; second: DocumentRecord; label: string }): { text: string; diff: LineDiff } {
  const { deps, ctx } = scope;
  const { first, second, label } = pair;
  const diff = diffLines(documentText(deps, first.id), documentText(deps, second.id));
  const refA = ctx.refs.doc(first.id);
  const refB = ctx.refs.doc(second.id);
  const text = [
    `A = ${docLine(scope, first)}`,
    `${label} = ${docLine(scope, second)}`,
    `${diff.common} gemeinsame Zeilen, ${diff.changed.length} geändert, ${diff.onlyA.length} nur in A, ${diff.onlyB.length} nur in ${label}${diff.capped ? ` (nur die ersten ${MAX_DIFF_LINES} Zeilen verglichen)` : ''}.`,
    diff.changed.length ? `Geändert (Fundstelle ${refA} und ${refB}):\n${asData(`${refA}-${refB}-geändert`, changeTable(diff.changed))}` : 'Geändert: –',
    diff.onlyA.length ? `Nur in A:\n${asData(`${refA}-nur-A`, showLines(diff.onlyA))}` : 'Nur in A: –',
    diff.onlyB.length ? `Nur in ${label}:\n${asData(`${refB}-nur-B`, showLines(diff.onlyB))}` : `Nur in ${label}: –`,
  ].join('\n');
  return { text, diff };
}

/** First document against each further one; every document must be released for transmission. */
export async function compareReport(scope: ToolScope, args: { a: string; b: string; weitere?: string[] | null }): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const refs = [args.a, args.b, ...(args.weitere ?? [])];
  const { docs: found, unknown } = resolveDocs(scope, refs);
  const ordered = refs.map((ref) => found.find((d) => d.id === ctx.refs.resolve(ref)));
  const [first, ...others] = ordered;
  if (!first || !others[0] || others.some((d) => !d)) return { content: `Mindestens zwei bekannte Dokument-IDs nötig.${unknownNote(unknown)}`, isError: true };
  const documents = ordered as DocumentRecord[];
  if (!documents.every((d) => deps.privacy.mayShareDocument(d)))
    return { content: 'Mindestens eines der Dokumente ist nicht zur Übertragung freigegeben – der Vergleich ist nicht möglich.', isError: true };
  const sections = documents.slice(1).map((second, index) => comparison(scope, { first, second, label: documents.length > 2 ? `B${index + 1}` : 'B' }));
  const diffs = sections.map((section) => section.diff);
  const total = (pick: (d: LineDiff) => number) => diffs.reduce((sum, d) => sum + pick(d), 0);
  return {
    content: sections.map((section) => section.text).join('\n\n'),
    summary: `${total((d) => d.changed.length)} geändert, ${total((d) => d.onlyA.length)} nur in A, ${total((d) => d.onlyB.length)} nur in B`,
  };
}
