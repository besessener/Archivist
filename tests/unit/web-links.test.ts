import { describe, expect, it } from 'vitest';
import { isExternalWebUrl } from '../../apps/desktop/src/external-links';
import { webSourcesMarkdown } from '../../packages/core/src/agent/prompt';

describe('links to web sources', () => {
  it('webSourcesMarkdown: a list of links; brackets in titles and parentheses in URLs cannot break the syntax', () => {
    expect(
      webSourcesMarkdown([
        { url: 'https://example.org/a', title: 'Seite [A]\nzwei' },
        { url: 'https://de.wikipedia.org/wiki/Steuer_(Abgabe)', title: '' },
      ]),
    ).toBe(
      '**Quellen aus dem Web**\n- [Seite A zwei](https://example.org/a)\n- [https://de.wikipedia.org/wiki/Steuer_(Abgabe)](https://de.wikipedia.org/wiki/Steuer_%28Abgabe%29)',
    );
    const many = Array.from({ length: 12 }, (_, i) => ({ url: `https://e.example/${i}`, title: `T${i}` }));
    expect(webSourcesMarkdown(many).split('\n')).toHaveLength(9);
  });

  it('isExternalWebUrl: only http(s) pages leave the app window', () => {
    expect(isExternalWebUrl('https://example.org/x?y=1')).toBe(true);
    expect(isExternalWebUrl('http://example.org')).toBe(true);
    for (const url of [
      'app://archivist/chat/',
      'file:///C:/Windows/system32/calc.exe',
      'javascript:alert(1)',
      'http://localhost:3000',
      'https://user:pw@example.org',
      'kein link',
    ])
      expect(isExternalWebUrl(url)).toBe(false);
  });
});
