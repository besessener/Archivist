import type { VitestPluginContext } from 'vitest/node';
import { defineConfig } from 'vitest/config';

// Stryker filters by the space-joined suite path, Vitest 5 joins with ' > ': without this every mutant run executes no test.
const strykerTestNameSeparator = {
  name: 'stryker-test-name-separator',
  configureVitest({ project }: VitestPluginContext) {
    let pattern = project.config.testNamePattern;
    Object.defineProperty(project.config, 'testNamePattern', {
      get: () => pattern,
      set: (value: RegExp | undefined) => {
        pattern = value && new RegExp(value.source.replaceAll(' ', '(?: | > )'), value.flags);
      },
      configurable: true,
      enumerable: true,
    });
  },
};

// Separate configuration for Stryker: without coverage thresholds; Vitest's `github-actions` reporting would report every killed mutant as an error.
export default defineConfig({
  plugins: [strykerTestNameSeparator],
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['dot'],
  },
});
