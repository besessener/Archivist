import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.resolve(__dirname, '../../apps/renderer/app/globals.css'), 'utf8');

/** The declarations of the first rule whose selector line is exactly `selector`. */
function declarationsOf(selector: string): string[] {
  const start = css.indexOf(`${selector} {\n`);
  expect(start, `rule "${selector}" in globals.css`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 3, css.indexOf('}', start));
  return body
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean);
}

const names = (declarations: string[]) => declarations.map((declaration) => declaration.split(':')[0]);

describe('colour scheme tokens in globals.css', () => {
  const systemDark = declarationsOf("  :root:not([data-theme='light'])");
  const chosenDark = declarationsOf(":root[data-theme='dark']");

  it('the dark scheme of the system and the chosen dark scheme are the same tokens with the same values', () => {
    expect(systemDark.length).toBeGreaterThan(0);
    expect(chosenDark).toEqual(systemDark);
  });

  it('the dark scheme redefines every light token', () => {
    expect(names(chosenDark).toSorted()).toEqual(names(declarationsOf(':root')).toSorted());
  });
});
