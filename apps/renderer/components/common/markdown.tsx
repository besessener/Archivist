import { Fragment } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/** Where a `[[Name]]` leads (#285): the entry's page, or null for a name without entry (shown as unknown). */
export type WikiResolver = (name: string) => { href: string; title: string } | null;

/** Hint shown under text fields whose content is rendered with {@link Markdown}. */
export const MARKDOWN_HINT = 'Markdown möglich: **fett**, *kursiv*, `Code`, Listen mit „-“ oder „1.“, Überschriften mit „#“.';

/** In-app pages a `[text](/documents/?id=…)` link may lead to (weekly review, agent answers). */
const APP_PAGE = String.raw`\/(?:documents|decisions|open-items|knowledge)\/(?:\?id=[\w-]{1,64})?`;
const APP_LINK = new RegExp(String.raw`^\[([^\]]+)\]\((${APP_PAGE})\)$`);

/** Inline: **bold**, *italic*, `code`, [links](https://…), [in-app links](/documents/?id=…), [[wiki links]]. React elements only, no HTML. */
function renderInline({ text, keyPrefix, wiki }: { text: string; keyPrefix: string; wiki?: WikiResolver }): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = new RegExp(
    String.raw`(\[\[[^[\]\n]{1,401}\]\]|\[[^\]\n]{1,300}\]\((?:https?:\/\/[^\s)]{1,2000}|${APP_PAGE})\)|\*\*[^*]+\*\*|\x60[^\x60]+\x60|\*[^*\s][^*]*\*|_[^_\s][^_]*_)`,
    'g',
  );
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const token = match[0];
    nodes.push(renderToken({ token, key: `${keyPrefix}-${i++}`, wiki }));
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderToken({ token, key, wiki }: { token: string; key: string; wiki?: WikiResolver }): React.ReactElement {
  if (token.startsWith('[[')) return renderWikiLink({ token, key, wiki });
  // only http(s) links; they open in the system browser (the main process hands new windows to the OS)
  const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
  if (link)
    return (
      <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener" className="text-primary underline underline-offset-2 hover:opacity-80">
        {link[1]}
      </a>
    );
  const appLink = APP_LINK.exec(token);
  if (appLink)
    return (
      <Link key={key} href={appLink[2] ?? '/'} className="text-primary underline underline-offset-2 hover:opacity-80" data-testid="app-link">
        {appLink[1]}
      </Link>
    );
  if (token.startsWith('**')) return <strong key={key}>{token.slice(2, -2)}</strong>;
  if (token.startsWith('`'))
    return (
      <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
        {token.slice(1, -1)}
      </code>
    );
  return <em key={key}>{token.slice(1, -1)}</em>;
}

function renderWikiLink({ token, key, wiki }: { token: string; key: string; wiki?: WikiResolver }): React.ReactElement {
  if (!wiki) return <Fragment key={key}>{token}</Fragment>;
  const [target = '', shown] = token.slice(2, -2).split('|');
  const name = target.trim();
  const hit = wiki(name);
  if (hit)
    return (
      <Link key={key} href={hit.href} title={hit.title} className="text-primary underline underline-offset-2 hover:opacity-80" data-testid="wiki-link">
        {(shown ?? name).trim()}
      </Link>
    );
  return (
    <span key={key} className="underline decoration-dashed underline-offset-2" title={`Noch kein Eintrag „${name}“`} data-testid="wiki-link-unknown">
      {(shown ?? name).trim()}
    </span>
  );
}

function withBreaks({ lines, keyPrefix, wiki }: { lines: string[]; keyPrefix: string; wiki?: WikiResolver }): React.ReactNode[] {
  return lines.flatMap((line, i) => [
    ...(i > 0 ? [<br key={`${keyPrefix}-br-${i}`} />] : []),
    <Fragment key={`${keyPrefix}-l-${i}`}>{renderInline({ text: line, keyPrefix: `${keyPrefix}-${i}`, wiki })}</Fragment>,
  ]);
}

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] } | { kind: 'ol'; items: string[] } | { kind: 'h'; level: number; text: string };

/** The block a single non-empty line starts. */
function lineBlock(line: string): Block {
  // eslint-disable-next-line sonarjs/super-linear-regex -- anchored at the start of the line, input is a single line
  const heading = /^(#{1,3})\s+(.*)$/.exec(line);
  if (heading) return { kind: 'h', level: (heading[1] ?? '#').length, text: heading[2] ?? '' };
  // eslint-disable-next-line sonarjs/super-linear-regex -- anchored at the start of the line, input is a single line
  const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
  if (bullet) return { kind: 'ul', items: [bullet[1] ?? ''] };
  // eslint-disable-next-line sonarjs/super-linear-regex -- anchored at the start of the line, input is a single line
  const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
  if (numbered) return { kind: 'ol', items: [numbered[1] ?? ''] };
  return { kind: 'p', lines: [line] };
}

/** Continues the previous block with a line of the same kind of paragraph or list; false if it starts a new block. */
function appendTo(previous: Block | undefined, block: Block): boolean {
  if (previous?.kind === 'p' && block.kind === 'p') {
    previous.lines.push(...block.lines);
    return true;
  }
  if ((previous?.kind === 'ul' && block.kind === 'ul') || (previous?.kind === 'ol' && block.kind === 'ol')) {
    previous.items.push(...block.items);
    return true;
  }
  return false;
}

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  // an empty line or a heading closes the block before it
  let open = false;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      open = false;
      continue;
    }
    const block = lineBlock(line);
    if (!(open && appendTo(blocks[blocks.length - 1], block))) blocks.push(block);
    open = block.kind !== 'h';
  }
  return blocks;
}

function renderBlock({ block, key, wiki }: { block: Block; key: string; wiki?: WikiResolver }): React.ReactNode {
  switch (block.kind) {
    case 'p':
      return <p key={key}>{withBreaks({ lines: block.lines, keyPrefix: key, wiki })}</p>;
    case 'ul':
      return (
        <ul key={key} className="list-disc space-y-1 pl-5">
          {block.items.map((item, j) => (
            <li key={`${key}-${j}`}>{renderInline({ text: item, keyPrefix: `${key}-${j}`, wiki })}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} className="list-decimal space-y-1 pl-5">
          {block.items.map((item, j) => (
            <li key={`${key}-${j}`}>{renderInline({ text: item, keyPrefix: `${key}-${j}`, wiki })}</li>
          ))}
        </ol>
      );
    case 'h':
      return (
        <p key={key} className="pt-1 font-semibold">
          {renderInline({ text: block.text, keyPrefix: key, wiki })}
        </p>
      );
  }
}

/** Lightweight, safe Markdown rendering (paragraphs, lists, headings, bold, italic, code, http(s) links). */
export function Markdown({ text, className, testId, wiki }: { text: string; className?: string; testId?: string; wiki?: WikiResolver }) {
  const blocks = parse(text);
  return (
    <div className={cn('space-y-2 break-words', className)} data-testid={testId}>
      {blocks.map((block, i) => renderBlock({ block, key: `b${i}`, wiki }))}
    </div>
  );
}
