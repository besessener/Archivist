import { Fragment } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/** Where a `[[Name]]` leads (#285): the entry's page, or null for a name without entry (shown as unknown). */
export type WikiResolver = (name: string) => { href: string; title: string } | null;

/** Hint shown under text fields whose content is rendered with {@link Markdown}. */
export const MARKDOWN_HINT = 'Markdown möglich: **fett**, *kursiv*, `Code`, Listen mit „-“ oder „1.“, Überschriften mit „#“.';

/** Inline: **bold**, *italic*, `code`, [links](https://…), [[wiki links]]. React elements only, no HTML. */
function renderInline(text: string, keyPrefix: string, wiki?: WikiResolver): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\[\[[^[\]\n]{1,401}\]\]|\[[^\]\n]{1,300}\]\(https?:\/\/[^\s)]{1,2000}\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    // only http(s) links; they open in the system browser (the main process hands new windows to the OS)
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(tok);
    if (tok.startsWith('[[')) {
      const [target = '', shown] = tok.slice(2, -2).split('|');
      const name = target.trim();
      const hit = wiki?.(name);
      out.push(
        hit ? (
          <Link key={key} href={hit.href} title={hit.title} className="text-primary underline underline-offset-2 hover:opacity-80" data-testid="wiki-link">
            {(shown ?? name).trim()}
          </Link>
        ) : wiki ? (
          <span key={key} className="underline decoration-dashed underline-offset-2" title={`Noch kein Eintrag „${name}“`} data-testid="wiki-link-unknown">
            {(shown ?? name).trim()}
          </span>
        ) : (
          tok
        ),
      );
    } else if (link)
      out.push(
        <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener" className="text-primary underline underline-offset-2 hover:opacity-80">
          {link[1]}
        </a>,
      );
    else if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`'))
      out.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {tok.slice(1, -1)}
        </code>,
      );
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(lines: string[], keyPrefix: string, wiki?: WikiResolver): React.ReactNode[] {
  return lines.flatMap((line, i) => [
    ...(i > 0 ? [<br key={`${keyPrefix}-br-${i}`} />] : []),
    <Fragment key={`${keyPrefix}-l-${i}`}>{renderInline(line, `${keyPrefix}-${i}`, wiki)}</Fragment>,
  ]);
}

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] } | { kind: 'ol'; items: string[] } | { kind: 'h'; level: number; text: string };

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flush();
      continue;
    }
    // eslint-disable-next-line sonarjs/super-linear-regex -- anchored at the start of the line, input is a single line
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    // eslint-disable-next-line sonarjs/super-linear-regex -- anchored at the start of the line, input is a single line
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    // eslint-disable-next-line sonarjs/super-linear-regex -- anchored at the start of the line, input is a single line
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'h', level: (heading[1] ?? '#').length, text: heading[2] ?? '' });
    } else if (ul) {
      if (current?.kind !== 'ul') {
        flush();
        current = { kind: 'ul', items: [] };
      }
      current.items.push(ul[1] ?? '');
    } else if (ol) {
      if (current?.kind !== 'ol') {
        flush();
        current = { kind: 'ol', items: [] };
      }
      current.items.push(ol[1] ?? '');
    } else {
      if (current?.kind !== 'p') {
        flush();
        current = { kind: 'p', lines: [] };
      }
      current.lines.push(line);
    }
  }
  flush();
  return blocks;
}

/** Lightweight, safe Markdown rendering (paragraphs, lists, headings, bold, italic, code, http(s) links). */
export function Markdown({ text, className, testId, wiki }: { text: string; className?: string; testId?: string; wiki?: WikiResolver }) {
  const blocks = parse(text);
  return (
    <div className={cn('space-y-2 break-words', className)} data-testid={testId}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case 'p':
            return <p key={key}>{withBreaks(b.lines, key, wiki)}</p>;
          case 'ul':
            return (
              <ul key={key} className="list-disc space-y-1 pl-5">
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`, wiki)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key} className="list-decimal space-y-1 pl-5">
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`, wiki)}</li>
                ))}
              </ol>
            );
          case 'h':
            return (
              <p key={key} className="pt-1 font-semibold">
                {renderInline(b.text, key, wiki)}
              </p>
            );
        }
      })}
    </div>
  );
}
