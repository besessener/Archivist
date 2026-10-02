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
  // Type-aware rules (including no-floating-promises for IPC/workers/services); only for files covered by a tsconfig.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['packages/*/src/**/*.ts', 'apps/desktop/src/**/*.ts', 'apps/renderer/**/*.{ts,tsx}', 'tests/**/*.ts'],
  })),
  {
    files: ['packages/*/src/**/*.ts', 'apps/desktop/src/**/*.ts', 'apps/renderer/**/*.{ts,tsx}', 'tests/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Services and handlers implement shared async interfaces, even without an await of their own.
      '@typescript-eslint/require-await': 'off',
      // `onClick={async () => …}` is common in React; floating promises are still checked by no-floating-promises.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // expect.stringContaining() & co. return `any`
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  // Accessibility in the renderer (strict). label-has-associated-control is checked by axe in the E2E tests.
  {
    files: ['apps/renderer/**/*.tsx'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: { ...jsxA11y.flatConfigs.strict.rules, 'jsx-a11y/label-has-associated-control': 'off' },
  },
  // Code smells for production code; tests may repeat themselves.
  {
    files: ['packages/*/src/**/*.ts', 'apps/**/*.{ts,tsx}'],
    ignores: ['**/*.test.*'],
    ...sonarjs.configs.recommended,
    rules: {
      ...sonarjs.configs.recommended.rules,
      // Pure style: would wrap every props type in Readonly<...> or forbid `void promise`, which no-floating-promises requires.
      'sonarjs/prefer-read-only-props': 'off',
      'sonarjs/void-use': 'off',
      // Nested ternaries/templates are common in JSX and path building and are readable here.
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-nested-template-literals': 'off',
      // Intentionally NaN-safe: `!(Number(x) >= 5)` is not the same as `Number(x) < 5` (empty/invalid input).
      'sonarjs/no-inverted-boolean-check': 'off',
      // Paths and names are deliberately sorted by code point (deterministic, independent of the system locale).
      'sonarjs/no-alphabetical-sort': 'off',
      // Date, key and intent detection are deliberately complex patterns and are covered by tests.
      'sonarjs/regex-complexity': 'off',
      // Ratchet: the highest measured value is 59; the limit is lowered when functions are split up.
      'sonarjs/cognitive-complexity': ['error', 60],
    },
  },
);
