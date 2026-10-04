/** Architecture rules: layers stay separate so that renderer, core and desktop shell remain individually testable. */
const RENDERER = '^(apps/renderer|node_modules/@archivist/renderer)/';
// Workspace packages are linked via node_modules/@archivist/* and can be resolved under either path
const CORE = '^(packages/core|node_modules/@archivist/core)/';
const DESKTOP = '^(apps/desktop|node_modules/archivist)/';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A runtime cycle between modules makes understanding and isolated testing harder. Pure type imports (`import type`) are allowed: they disappear during compilation (e.g. services that type each other).',
      from: {},
      to: { circular: true, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-type-only-service-cycles',
      severity: 'warn',
      comment:
        'Type-only cycles between services are resolved at runtime via wire() (see composition/wiring.ts); calling a wired service before wire() throws. The known cycles are frozen in scripts/type-only-cycles.baseline.json (checked by npm run depcruise); new ones fail there.',
      from: { path: '^packages/core/src/services/' },
      to: { path: '^packages/core/src/services/', circular: true, dependencyTypes: ['type-only'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'An import that dependency-cruiser cannot resolve is usually a typo or a missing dependency.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'renderer-only-shared',
      severity: 'error',
      comment:
        'The renderer talks to the main process exclusively through the IPC layer (lib/ipc.ts) and only knows @archivist/shared – never core, desktop, Electron or Node modules.',
      from: { path: '^apps/renderer/' },
      to: {
        path: [CORE, DESKTOP, '^node_modules/electron/', '^node_modules/better-sqlite3/'],
      },
    },
    {
      name: 'renderer-no-node-builtins',
      severity: 'error',
      comment: 'The renderer runs in a browser context (context-isolated, without Node integration).',
      from: { path: '^apps/renderer/', pathNot: '/next\\.config\\.mjs$' },
      to: { dependencyTypes: ['core'], pathNot: '^(?:node:)?(?:path)$' },
    },
    {
      name: 'shared-depends-on-nothing-local',
      severity: 'error',
      comment: '@archivist/shared contains only schemas and types and must not import any other layer.',
      from: { path: '^packages/shared/' },
      to: { path: [RENDERER, DESKTOP, CORE] },
    },
    {
      name: 'core-no-ui-no-electron',
      severity: 'error',
      comment: 'The core is independent of the UI and Electron (Electron functionality reaches the core via an interface, see context.ts).',
      from: { path: '^packages/core/' },
      to: { path: [RENDERER, DESKTOP, '^node_modules/electron/'] },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    tsPreCompilationDeps: true,
    // Dedicated tsconfig only for resolution: `@/…` points to apps/renderer
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    exclude: { path: ['/\\.next/', '/out/', '/dist/', '/release/', '/coverage/', 'next-env\\.d\\.ts$'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
