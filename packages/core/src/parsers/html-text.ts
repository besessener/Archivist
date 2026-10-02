/**
 * Visible text of an HTML body (HTML-only e-mails). Elements a reader never sees – display:none,
 * visibility:hidden, font-size:0, opacity:0, collapsed boxes, the `hidden` attribute – are left out, so text
 * hidden from the reader does not reach the document text and the LLM prompts (#199).
 */
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
  const m = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  return (m?.[1] ?? m?.[2] ?? '').toLowerCase().replace(/\s+/g, '');
}

function isHidden(attrs: string): boolean {
  if (/(?:^|\s)hidden(?:\s|=|\/|$)/i.test(attrs)) return true;
  const css = styleOf(attrs);
  if (!css) return false;
  if (HIDDEN_CSS.some((re) => re.test(css))) return true;
  return COLLAPSED.test(css) && /(?:^|;)overflow:hidden/.test(css);
}

const decodeEntities = (s: string) =>
  s
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
  for (let i = from; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i + 1;
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
    const m = NAME.exec(html);
    if (!m) {
      at = html.indexOf('<', at + 1);
      continue;
    }
    const end = tagEnd(html, NAME.lastIndex);
    yield { start: at, end, name: m[2]!.toLowerCase(), closing: m[1] === '/', attrs: html.slice(NAME.lastIndex, end - 1) };
    at = html.indexOf('<', end);
  }
}

export function visibleHtmlText(html: string): string {
  const out: string[] = [];
  // open elements; tags closed implicitly (an unclosed <p>) are dropped when an enclosing element closes
  const open: string[] = [];
  // index in `open` of the element being skipped (hidden or non-content); -1 = nothing is skipped
  let skipAt = -1;
  let last = 0;
  for (const tag of scanTags(html)) {
    if (skipAt < 0) out.push(html.slice(last, tag.start));
    last = tag.end;
    const { name } = tag;
    if (!name) continue; // comment
    if (BLOCK.has(name) && skipAt < 0) out.push('\n');
    if (tag.closing) {
      const at = open.lastIndexOf(name);
      if (at === -1) continue;
      open.length = at;
      if (skipAt >= at) skipAt = -1;
      continue;
    }
    if (VOID.has(name) || tag.attrs.trimEnd().endsWith('/')) continue;
    open.push(name);
    if (skipAt < 0 && (SKIPPED.has(name) || isHidden(tag.attrs))) skipAt = open.length - 1;
  }
  if (skipAt < 0) out.push(html.slice(last));
  return decodeEntities(out.join(''))
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
