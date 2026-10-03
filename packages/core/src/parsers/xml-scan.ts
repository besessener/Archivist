// Linear XML scanning with indexOf: lazy regexes over crafted Office parts run in quadratic time.

interface StartTag {
  /** Text between the tag name and the closing `>` (without a trailing `/`). */
  attributes: string;
  selfClosing: boolean;
  /** Index just after the `>`. */
  end: number;
}

const NAME_END = new Set([' ', '>', '/', '\t', '\n', '\r']);

/** The first `<tag …>` at or after `from`; a longer name that merely starts with `tag` (`<a:pPr` for `a:p`) is skipped. */
function nextStartTag(xml: string, tag: string, from: number): StartTag | null {
  const opening = `<${tag}`;
  let position = from;
  while (position < xml.length) {
    const start = xml.indexOf(opening, position);
    if (start === -1) return null;
    const afterName = start + opening.length;
    if (!NAME_END.has(xml[afterName] ?? '')) {
      position = afterName;
      continue;
    }
    const close = xml.indexOf('>', afterName);
    if (close === -1) return null;
    const selfClosing = xml[close - 1] === '/';
    return { attributes: xml.slice(afterName, selfClosing ? close - 1 : close), selfClosing, end: close + 1 };
  }
  return null;
}

/** Attribute text of every `<tag …>` start tag, in order. */
export function* startTags(xml: string, tag: string): Generator<string> {
  let from = 0;
  for (let found = nextStartTag(xml, tag, from); found; found = nextStartTag(xml, tag, from)) {
    yield found.attributes;
    from = found.end;
  }
}

/** Every `<tag …>body</tag>` (a self-closing tag has an empty body), in order; tags of the same name do not nest in Office XML. */
export function* elements(xml: string, tag: string): Generator<{ attributes: string; body: string }> {
  const closing = `</${tag}>`;
  let from = 0;
  for (let found = nextStartTag(xml, tag, from); found; found = nextStartTag(xml, tag, from)) {
    if (found.selfClosing) {
      yield { attributes: found.attributes, body: '' };
      from = found.end;
      continue;
    }
    const bodyEnd = xml.indexOf(closing, found.end);
    if (bodyEnd === -1) return;
    yield { attributes: found.attributes, body: xml.slice(found.end, bodyEnd) };
    from = bodyEnd + closing.length;
  }
}
