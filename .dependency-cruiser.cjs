/** Architekturregeln: Schichten bleiben getrennt, damit Renderer, Core und Desktop-Hülle einzeln testbar bleiben. */
const RENDERER = '^(apps/renderer|node_modules/@archivist/renderer)/';
// Workspace-Pakete werden über node_modules/@archivist/* verlinkt und können unter beiden Pfaden aufgelöst werden
const CORE = '^(packages/core|node_modules/@archivist/core)/';
const DESKTOP = '^(apps/desktop|node_modules/archivist)/';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Ein Zyklus zwischen Modulen zur Laufzeit erschwert Verständnis und isolierte Tests. Reine Typ-Importe (`import type`) sind erlaubt: sie verschwinden beim Kompilieren (z. B. Services, die sich gegenseitig typisieren).',
      from: {},
      to: { circular: true, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Ein Import, den dependency-cruiser nicht auflösen kann, ist meist ein Tippfehler oder eine fehlende Abhängigkeit.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'renderer-only-shared',
      severity: 'error',
      comment:
        'Der Renderer spricht ausschließlich über die IPC-Schicht (lib/ipc.ts) mit dem Hauptprozess und kennt nur @archivist/shared – nie Core, Desktop, Electron oder Node-Module.',
      from: { path: '^apps/renderer/' },
      to: {
        path: [CORE, DESKTOP, '^node_modules/electron/', '^node_modules/better-sqlite3/'],
      },
    },
    {
      name: 'renderer-no-node-builtins',
      severity: 'error',
      comment: 'Der Renderer läuft im Browserkontext (kontextisoliert, ohne Node-Integration).',
      from: { path: '^apps/renderer/', pathNot: '/next\\.config\\.mjs$' },
      to: { dependencyTypes: ['core'], pathNot: '^(?:node:)?(?:path)$' },
    },
    {
      name: 'shared-depends-on-nothing-local',
      severity: 'error',
      comment: '@archivist/shared enthält nur Schemas und Typen und darf keine andere Schicht importieren.',
      from: { path: '^packages/shared/' },
      to: { path: [RENDERER, DESKTOP, CORE] },
    },
    {
      name: 'core-no-ui-no-electron',
      severity: 'error',
      comment: 'Der Core ist von Oberfläche und Electron unabhängig (Electron-Funktionen kommen per Schnittstelle in den Core, siehe context.ts).',
      from: { path: '^packages/core/' },
      to: { path: [RENDERER, DESKTOP, '^node_modules/electron/'] },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    tsPreCompilationDeps: true,
    // Eigene tsconfig nur für die Auflösung: `@/…` zeigt auf apps/renderer
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    exclude: { path: ['/\\.next/', '/out/', '/dist/', '/release/', '/coverage/', 'next-env\\.d\\.ts$'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
