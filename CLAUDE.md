# CLAUDE.md

Standing instructions for Claude Code and any other AI assistant working in
this repository. Read this file before writing anything.

## What this project is

**Archivist** is a personal, agentic AI archivist for a single user: a local
Windows desktop app that stores, understands and links documents, decisions,
open items and knowledge, and keeps the archive consistent. Features:
[docs/reference/funktionen.md](docs/reference/funktionen.md). Full docs:
[docs/README.md](docs/README.md) (German, Diátaxis).

- **Desktop**: Electron main process, preload, workers. `apps/desktop/`.
- **Renderer**: Next.js as a static export, served via `app://` under a strict
  CSP. `apps/renderer/`.
- **Core**: services, Drizzle schema and migrations (SQLite), parsers, LLM
  client, agent. `packages/core/`.
- **Shared**: Zod schemas and the IPC contract. `packages/shared/`.
- **Packaging**: Windows only, in CI on `windows-latest`. Tests run on Ubuntu.

## Read before you touch

| Area | Read first |
| --- | --- |
| Layers, services, IPC | [architektur.md](docs/explanation/architektur.md), [projektstruktur.md](docs/reference/projektstruktur.md) |
| File actions, confirmations, undo | [aktionsstufen.md](docs/reference/aktionsstufen.md), [sicherheitsmodell.md](docs/explanation/sicherheitsmodell.md) |
| Agent, tools, prompts | [agent.md](docs/explanation/agent.md), [agentenmodus.md](docs/reference/agentenmodus.md) |
| LLM requests, what leaves the machine | [llm-schnittstelle.md](docs/reference/llm-schnittstelle.md), [datenschutz-einstellen.md](docs/how-to/datenschutz-einstellen.md) |
| Schema and migrations | [datenbankschema-aendern.md](docs/how-to/datenbankschema-aendern.md) |
| Tests, CI, quality gates | [qualitaetssicherung.md](docs/reference/qualitaetssicherung.md), [befehle.md](docs/reference/befehle.md) |
| User-facing text, docs style | [texte-und-ansprache.md](docs/reference/texte-und-ansprache.md) |

## Hard rules

Settled decisions and safety rules. If a task seems to need one reversed, stop
and say so; never work around it quietly. Reasoning lives in
`docs/explanation/`, not here.

- **No file is ever lost.** Archivist never overwrites user files and never
  touches the user's originals; every change goes through the audit log and
  can be undone (`UndoService`). Deleting a document moves its own copies into
  the trash (undoable); only emptying the trash deletes for good, as a level-3
  action. Overwrite and archive-wide re-sorting are deliberately not
  implemented.
- **Confirmation is enforced in the schema, not the UI.** A level-2 action runs
  only via `confirmed: z.literal(true)`; level 3 needs the second explicit
  confirmation. Never relax that or add a bypass.
- **Documents are data, not instructions.** Document text, history, tool
  results and web pages stay marked as data in every prompt; changes require
  the user's own request, never the model's reading of it.
- **The renderer is untrusted.** Sandbox, no Node, strict CSP, an allowlist of
  IPC channels whose input and output the main process validates with Zod. No
  new channel without schemas in `packages/shared/src/ipc.ts`.
- **Nothing leaves the machine unchecked.** Anything sent to the LLM honours
  document exclusions, passes masking, and is recorded in the transmission log.
- Never lower a coverage or mutation threshold (`vitest.config.mts`,
  `stryker.config.mjs`) or auto-ratchet one. An unreachable threshold is a
  design problem: redesign, or raise it with the user.
- No `/* v8 ignore */` or `// Stryker disable`. No `.skip`, ESLint or TS
  suppression without understanding the failure first; the reason goes on the
  same line. No test gaming.
- Never commit to `main`, skip hooks (`--no-verify`), force-push over others'
  commits, or rewrite history on a branch you don't own.
- Never modify `.github/workflows/**`, repository secrets, branch protection,
  or `.pre-commit-config.yaml`'s security hooks (gitleaks, zizmor,
  detect-private-key) unless the user explicitly asks.
- Never run `npm audit fix --force` or a from-scratch
  `rm -rf node_modules package-lock.json && npm install`; use targeted
  `overrides`.
- Electron and native modules (`better-sqlite3` & co.) are bumped together and
  never auto-merged; after touching them run `npm run native:check`.
- Never write real API keys or tokens anywhere — code, docs, commits, chat, not
  even as an example. Keys live only in `SecretService` (safeStorage);
  `config.example.json` and `.env.example` stay credential-free.
- `npm run eval:agent` calls real models and costs money: only when asked.

## Database changes

- Change the tables in `packages/core/src/db/tables/` (exported by
  `schema.ts`), run `npm run db:generate`, and read the generated SQL. What
  Drizzle can't express (e.g. FTS5) is a custom migration.
- Roll forward only: never edit, rename or delete a migration on `main`; undo
  with a new one. Migrations run unattended at startup against real user
  archives, so they must apply to a populated database, not just an empty one.
- Never hand-format `packages/core/migrations/` (excluded from Prettier).

## How to work here

- **The LLM is the normal case.** Design, build, test and document every
  feature for a configured LLM. Without one (unconfigured or `local_only`) the
  app stays usable through a plain fallback, but never add behaviour, extra
  questions or heuristics that exist only for that case; the rule-based chat is
  an emergency fallback, not a second product.
- **Ask, don't bury.** A decision that is the user's (a design choice, a rule
  that seems to need reversing, scope beyond the request) is asked with the
  question tool (`AskUserQuestion`) as soon as it comes up, with options and a
  recommendation. A note in a PR description, summary, ticket or comment does
  not count as asking; the user will not notice it there. Without that tool,
  put the question first in your reply and wait for the answer.
- **Smallest necessary change.** Preserve existing behaviour unless changing it
  is what was asked. Boy-scout fixes stay inside the function or file you are
  already editing; if something outside it breaks a rule, say so rather than
  widening the diff.
- **When principles collide:** correctness and security, then KISS/YAGNI, then
  clean code, then DRY, then SOLID. No abstraction for a requirement nobody
  has; extract on the third occurrence. SOLID means modules, services and
  functions — no DI container.
- **Split by responsibility,** along the boundaries dependency-cruiser
  enforces: the renderer knows only `shared`, core has no Electron or UI code,
  no runtime cycles. Electron APIs reach core through small interfaces
  (`SecretCipher`, `HostApi`). Pure logic takes values as parameters and never
  reaches for the database, the filesystem, the network or `Date.now()`.
  Hard-to-reach coverage or a stubborn mutant means extract the logic, not
  force the test. New pure logic that holds its score goes on
  `mutation-targets.mjs`.
- **Clean code, as applied here:** intent-revealing names, no abbreviations or
  type prefixes; small functions with guard clauses; zero to two parameters,
  else a named object, never a boolean flag; command-query separation; no
  `null`/`undefined` as a signal where a type or empty collection models it;
  files under ~350 lines (test files under ~600); no dead code; no dependency
  without clear value over what's here, and none that is deprecated or
  unmaintained.
- **Comments:** one line, hard cap, only for a non-obvious constraint,
  workaround, invariant or external behaviour — never to narrate code or
  record a decision (that goes in the commit or PR). Tighten longer ones you
  touch.
- **Fail fast; measure, don't assume.** Surface errors as a categorised
  `Result`, never swallow them. Performance, coverage and bundle size are
  numbers a tool prints.
- **Language:** everything the user sees (UI, errors, notifications, chat,
  LLM prompts, test data for German input) is German and addresses the user as
  „du“. Everything programmed (identifiers, comments, test names, logs) is
  English.
- **Tests:** a UI change gets a Playwright case for its journey, through the
  page objects in `tests/e2e/pages/`; a new view must pass the axe check in
  `accessibility.spec.ts`. A functional change gets a Vitest test asserting
  behaviour, not implementation, against real SQLite and the fake LLM.
- **Docs sync:** a change to behaviour, setup, configuration, architecture or a
  design decision updates the matching `docs/` file in the same change
  (behaviour → reference, new workflow → how-to). A change to what is sent to
  the LLM or stored updates the privacy docs too. The root `README.md` stays
  short.

## Development commands

```bash
npm install
npm run dev          # Next.js dev server + Electron with hot reload
```

## Definition of done

Not done — no "done", no ready PR, no reported success — until every one of
these is green, from the repo root:

```bash
npm run typecheck
npm run format:check
npm run lint
npm run depcruise         # architectural boundaries
npm run knip              # dead code / unused dependencies
npm run test:coverage
npm run build && xvfb-run -a npx playwright test   # E2E (no xvfb-run on Windows)
npm run native:check      # if you touched Electron or native modules
prek run --all-files      # gitleaks, zizmor, file hygiene
```

Mutation tests are not part of the local gate and never run in full locally.
`mutation.yml` runs them in CI only on push to `main`, not on pull requests.
Locally, only when asked or when chasing a specific surviving mutant, and only
on the files you changed: `npx stryker run --mutate <file>`.

A partial run is a status update, not a stopping point. If a gate blocks
finishing, say so — never relax the gate.
