import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { Settings } from '../../packages/shared/src/settings';
import { settingLabel } from '../../apps/renderer/lib/setting-labels';

interface SchemaDefinition {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  valueType?: z.ZodType;
}

const WRAPPERS = new Set(['default', 'prefault', 'nullable', 'optional', 'readonly', 'catch']);

/** Every leaf path of a settings schema as the audit log writes it; `*` stands for the key of a record. */
function leafPaths(schema: z.ZodType, path = ''): string[] {
  const definition = schema.def as unknown as SchemaDefinition;
  if (WRAPPERS.has(definition.type)) return leafPaths(definition.innerType!, path);
  if (definition.type === 'pipe') return leafPaths(definition.in!, path);
  if (definition.type === 'object') return Object.entries(definition.shape!).flatMap(([key, child]) => leafPaths(child, path ? `${path}.${key}` : key));
  if (definition.type === 'record') return leafPaths(definition.valueType!, `${path}.*`);
  return [path];
}

describe('setting labels', () => {
  const paths = leafPaths(Settings);

  it('finds the leaf paths of the settings, also inside records', () => {
    expect(paths).toEqual(expect.arrayContaining(['llm.maxInputChars', 'privacy.llmMode', 'agent.background.weeklyReviewDay', 'agent.prices.*.input']));
  });

  it('has a German label for every leaf path of the settings', () => {
    const unlabelled = paths.filter((path) => {
      const concrete = path.replaceAll('*', 'inbox');
      return settingLabel(concrete) === concrete;
    });
    expect(unlabelled).toEqual([]);
  });

  it('names the key of a record entry in its label', () => {
    expect(settingLabel('agent.backgroundKindLimits.archive_check.maxRounds')).toBe('Eigene Grenzen für „Archivprüfung auswerten“: Runden');
    expect(settingLabel('agent.prices.modell-x.cacheRead')).toBe('Eigener Preis für modell-x: Cache lesen (US$ je 1 Mio. Tokens)');
  });

  it('keeps an unknown path as it is', () => {
    expect(settingLabel('unknown.path')).toBe('unknown.path');
  });
});
