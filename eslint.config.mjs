import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/.next/**',
      '**/release/**',
      '**/node_modules/**',
      '**/migrations/**',
      '**/next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports', fixStyle: 'separate-type-imports' }],
      'no-console': 'warn',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', '**/scripts/**', 'tests/**', '**/*.config.*', 'tools/**'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
  // Typbasierte Regeln (u. a. no-floating-promises für IPC/Worker/Services); nur für Dateien, die ein tsconfig abdeckt.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['packages/*/src/**/*.ts', 'apps/desktop/src/**/*.ts', 'apps/renderer/**/*.{ts,tsx}', 'tests/**/*.ts'],
  })),
  {
    files: ['packages/*/src/**/*.ts', 'apps/desktop/src/**/*.ts', 'apps/renderer/**/*.{ts,tsx}', 'tests/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Services und Handler implementieren gemeinsame async-Schnittstellen, auch ohne eigenes await.
      '@typescript-eslint/require-await': 'off',
      // `onClick={async () => …}` ist in React üblich; floating promises prüft no-floating-promises weiterhin.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  // Barrierefreiheit im Renderer (strict). label-has-associated-control wird von axe im E2E geprüft.
  {
    files: ['tests/**/*.ts'],
    rules: {
      // expect.stringContaining() & Co. liefern `any`
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    files: ['apps/renderer/**/*.tsx'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: { ...jsxA11y.flatConfigs.strict.rules, 'jsx-a11y/label-has-associated-control': 'off' },
  },
  // Code-Smells für Produktivcode; Tests dürfen wiederholen.
  {
    files: ['packages/*/src/**/*.ts', 'apps/**/*.{ts,tsx}'],
    ignores: ['**/*.test.*'],
    ...sonarjs.configs.recommended,
    rules: {
      ...sonarjs.configs.recommended.rules,
      // Reiner Stil: würde jeden Props-Typ in Readonly<...> wickeln bzw. `void promise` verbieten, das no-floating-promises verlangt.
      'sonarjs/prefer-read-only-props': 'off',
      'sonarjs/void-use': 'off',
      // Verschachtelte Ternaries/Templates sind in JSX und Pfadbau üblich und hier gut lesbar.
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-nested-template-literals': 'off',
      // Absichtlich NaN-sicher: `!(Number(x) >= 5)` ist nicht dasselbe wie `Number(x) < 5` (leere/ungültige Eingabe).
      'sonarjs/no-inverted-boolean-check': 'off',
      // Pfade und Namen werden bewusst nach Codepunkt sortiert (deterministisch, unabhängig von der Systemsprache).
      'sonarjs/no-alphabetical-sort': 'off',
      // Datums-, Schlüssel- und Absichtserkennung sind bewusst komplexe Muster und durch Tests abgedeckt.
      'sonarjs/regex-complexity': 'off',
      // Ratchet: höchster gemessener Wert ist 59; der Grenzwert wird gesenkt, wenn Funktionen aufgeteilt werden.
      'sonarjs/cognitive-complexity': ['error', 60],
    },
  },
);
