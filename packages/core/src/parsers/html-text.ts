const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const BLOCK = new Set(['br', 'p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'pre', 'hr', 'ul', 'ol']);
const SKIPPED = new Set(['head', 'style', 'script', 'template', 'noscript', 'title']);

const ZERO = String.raw`0(?:\.0+)?(?:px|pt|em|rem|%)?(?![\d.])`;
const HIDDEN_CSS = [
  /(?:^|;)display:none/,
  /(?:^|;)visibility:hidden/,
  new RegExp(String.raw`(?:^|;)font-size:${ZERO}`),
  new RegExp(String.raw`(?:^|;)opacity:${ZERO}`),
];
const COLLAPSED = new RegExp(String.raw`(?:^|;)(?:max-)?(?:height|width):${ZERO}`);

function styleOf(attrs: string): string {
  const match = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  return (match?.[1] ?? match?.[2] ?? '').toLowerCase().replace(/\s+/g, '');
}

function isHidden(attrs: string): boolean {
  if (/(?:^|\s)hidden(?:\s|=|\/|$)/i.test(attrs)) return true;
  const css = styleOf(attrs);
  if (!css) return false;
  if (HIDDEN_CSS.some((re) => re.test(css))) return true;
  return COLLAPSED.test(css) && /(?:^|;)overflow:hidden/.test(css);
}

const decodeEntities = (text: string) =>
  text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');

interface Tag {
  start: number;
  end: number;
  /** lower-case tag name; null for a comment or a lone „<“ */
  name: string | null;
  closing: boolean;
  attrs: string;
}

/** End of a tag starting at `from` (index after „>“), skipping quoted attribute values; linear, no regex backtracking. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let index = from; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index + 1;
  }
  return html.length;
}

function* scanTags(html: string): Generator<Tag> {
  const NAME = /(\/?)([a-zA-Z][\w-]*)/y;
  let at = html.indexOf('<');
  while (at !== -1) {
    if (html.startsWith('<!--', at)) {
      const close = html.indexOf('-->', at + 4);
      const end = close === -1 ? html.length : close + 3;
      yield { start: at, end, name: null, closing: false, attrs: '' };
      at = html.indexOf('<', end);
      continue;
    }
    NAME.lastIndex = at + 1;
    const match = NAME.exec(html);
    if (!match) {
      at = html.indexOf('<', at + 1);
      continue;
    }
    const end = tagEnd(html, NAME.lastIndex);
    yield { start: at, end, name: match[2]!.toLowerCase(), closing: match[1] === '/', attrs: html.slice(NAME.lastIndex, end - 1) };
    at = html.indexOf('<', end);
  }
}

/** Collects the text between tags, leaving out whatever lies inside a hidden or non-content element. */
class VisibleTextCollector {
  private readonly parts: string[] = [];
  // open elements; tags closed implicitly (an unclosed <p>) are dropped when an enclosing element closes
  private readonly open: string[] = [];
  // index in `open` of the element being skipped (hidden or non-content); -1 = nothing is skipped
  private skipAt = -1;
  private last = 0;

  constructor(private readonly html: string) {}

  private get skipping(): boolean {
    return this.skipAt >= 0;
  }

  add(tag: Tag): void {
    if (!this.skipping) this.parts.push(this.html.slice(this.last, tag.start));
    this.last = tag.end;
    if (!tag.name) return; // comment
    if (BLOCK.has(tag.name) && !this.skipping) this.parts.push('\n');
    if (tag.closing) this.closeElement(tag.name);
    else this.openElement(tag.name, tag.attrs);
  }

  text(): string {
    return [...this.parts, this.skipping ? '' : this.html.slice(this.last)].join('');
  }

  private closeElement(name: string): void {
    const at = this.open.lastIndexOf(name);
    if (at === -1) return;
    this.open.length = at;
    if (this.skipAt >= at) this.skipAt = -1;
  }

  private openElement(name: string, attrs: string): void {
    if (VOID.has(name) || attrs.trimEnd().endsWith('/')) return;
    this.open.push(name);
    if (!this.skipping && (SKIPPED.has(name) || isHidden(attrs))) this.skipAt = this.open.length - 1;
  }
}

/** Visible text of an HTML-only mail: text hidden from the reader (display:none, font-size:0, …) never reaches the LLM (#199). */
export function visibleHtmlText(html: string): string {
  const collector = new VisibleTextCollector(html);
  for (const tag of scanTags(html)) collector.add(tag);
  return decodeEntities(collector.text())
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
