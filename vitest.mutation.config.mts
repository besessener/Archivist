import type { VitestPluginContext } from 'vitest/node';
import { defineConfig } from 'vitest/config';

// Stryker filtert Tests über den mit Leerzeichen verbundenen Suite-Pfad; Vitest 5 gleicht Namen ab, die mit ' > ' verbunden sind.
// Ohne diese Anpassung führt jeder gefilterte Mutantenlauf keinen Test aus und alle Mutanten überleben (Idee aus CollectionBuddy).
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

// Eigene Konfiguration für Stryker: ohne Coverage-Schwellen; das `github-actions`-Reporting von Vitest würde jeden getöteten Mutanten als Fehler melden.
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
