# Copilot instructions — servicenow-mcp-ai server

This is a **Model Context Protocol (MCP) server** written in **TypeScript** that
lets an MCP client operate a **ServiceNow** instance across its full REST
surface: 97 tools in 26 packages (Table, Aggregate, Attachment, Import Set,
Batch, CMDB/IRE, Catalog, Change, Knowledge, Email, Flows, Codecheck, ATF…),
plus script intelligence, multi-instance profiles and plan-and-apply write
safety.

## Architecture (layered — boundaries are ESLint-enforced)

`src/core/` (plumbing) ← `src/api/` (one module per REST area) ← `src/mcp/`
(server wiring, registry) ← `src/tools/` (tool definitions as data). `bin/`
holds the CommonJS launcher; `src/index.ts` is the server entry (stdio by
default, Streamable HTTP with `SN_TRANSPORT=http`). There is no Jira client:
the dark scaffold was deleted (E-8, O-1 NO-GO).

The rules for each area are path-scoped in `.github/instructions/`
(`<area>.instructions.md`, applied by `applyTo` glob). They are generated from
`.github/agent-instructions/<area>.md` — edit the source, then run
`npm run docs:instructions`.

## Credentials & policy

- Env-file chain: `SN_ENV_FILE` → `~/.config/servicenow-mcp-ai/.env` → project
  `.env` (git-ignored, written `0600`); real env vars take precedence. Runtime
  updates go through the `servicenow_set_credentials` tool.
- Never log or echo `SN_PASSWORD` / tokens.
- Writes are **plan-by-default** (`SN_WRITE_MODE`), journaled per profile;
  policy axes: `SN_TABLES_ALLOW`/`SN_TABLES_DENY`/`SN_READONLY` +
  `SN_PACKAGES_DENY`/`SN_PACKAGES_READONLY`.

## Conventions

- stdio transport: **never** write to `stdout` (no `console.log`) — structured
  JSON logs go to stderr via `core/logging.ts`.
- ES modules with `.js` import specifiers (Node16 module resolution);
  TypeScript strict + `noUncheckedIndexedAccess`.
- Tool input schemas are `zod` raw shapes; a handler may throw — `runSpec`
  turns the error into an `isError` result with the flat error contract.
- Every `SN_*` variable is declared in `src/core/settings-manifest.ts`;
  `npm run docs:env` regenerates the README env reference, `.env.example` and
  `server.json` from it (a sync test fails the build otherwise).
- The README tools table is generated: `npm run docs:readme`.

## Build & run

- `npm install`, then `npm run check` — the full gate (build + lint + format +
  coverage-gated tests + tarball guard + audit). Run it before finishing any change.
- `npm run dev` / `npm start` / `npm run watch`; debug with
  `npm run inspector` (MCP Inspector) or the VS Code config in `.vscode/mcp.json`.
- `npm run gen:manifest` — regenerate the tool manifest after tool changes
  (the full list of steps: CONTRIBUTING.md → "Adding a tool").

## Plan & status

- v2.0.1 is the published release. The tracker is `project/ROADMAP-V3.md`
  (pillars H/M/S/D/E/P/N, owner gates O-1…O-22, breaking register B1–B13);
  its status table is mirrored in `project/roadmap.yaml`
  (`npm run roadmap:sync`, checked in the gate). Open owner decisions are in
  `project/TODO.md`. The live analyses behind the N items are
  `project/GAP-ANALYSIS-2026-10.md` (N-0…N-24), `project/UIB-ANALYSIS-2026-10.md`
  (N-25…N-34), `project/TOKEN-DOCS-ANALYSIS-2026-10.md` (N-35…N-56) and
  `project/TOKEN-OPTIMIZATION-PLAN-2026-10.md` (N-57…N-65); older passes are in
  `project/archive/`. Non-breaking items ship on the 2.x line; the breaking
  cluster goes to 3.0.0 (previewed as `3.0.0-beta.n` on the npm `next` tag).
- Do not start an item marked BREAKING before owner gate O-4. Any `tools/list` change is gated by N-0 / O-10: budgets in
  `test/fixtures/token-budgets.json`, measured with `npm run tokens:budget`.
  Each finished item gets a `project/DONE.md` entry with its gate line.
- Adding a tool: CONTRIBUTING.md → "Adding a tool".
- A red `npm audit` step (the last step of the gate) has a fixed recipe:
  CONTRIBUTING.md → "Dependencies and the audit gate".

## SDK references

- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Concepts & guides: https://modelcontextprotocol.io/docs
- ServiceNow REST APIs: https://developer.servicenow.com/dev.do#!/reference/api/latest/rest
