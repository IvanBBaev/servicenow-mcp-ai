<!-- Generated from AGENTS.md by scripts/agent-instructions.mjs — edit the source, then run: npm run docs:instructions -->

# AGENTS.md — servicenow-mcp-ai

Instructions for coding agents (Codex, Copilot, Cursor, Claude and others) that
work on this repository. Humans: CONTRIBUTING.md has the same
rules with more detail.

This is a **Model Context Protocol (MCP) server** written in **TypeScript** that
lets an MCP client operate a **ServiceNow** instance across its REST surface:
100 tools in 28 packages (Table, Aggregate, Attachment, Import Set, Batch,
CMDB/IRE, Catalog, Change, Knowledge, Email, Flows, Codecheck, ATF…), plus
script intelligence, multi-instance profiles and plan-and-apply write safety.

## Commands

- `npm install`, then `npm run check` — the full gate (build, eval mocks, lint,
  format, docs drift checks, surface scan, coverage-gated tests, tarball guard,
  audit). Run it before you finish any change and report its real result.
- `npm run dev` / `npm start` / `npm run watch`; debug with
  `npm run inspector` (MCP Inspector) or `.vscode/mcp.json`.
- Single test file: `npm run build`, then `node --test test/<file>.test.js`.
- Regenerators (each has a `-- --check` twin in the gate):
  - `npm run docs:sync` — tool/package counts (this file too), `docs/tools/`,
    `docs/llms-full.txt`, `docs/index.md`.
  - `npm run docs:env` — README env reference, `.env.example`, `server.json`
    from the settings manifest.
  - `npm run docs:readme` — the README tools table.
  - `npm run docs:instructions` — `.github/instructions/` and
    `.github/copilot-instructions.md` from their sources.
  - `npm run roadmap:sync` — the `project/ROADMAP-V3.md` table from
    `project/roadmap.yaml`.
  - `npm run gen:manifest` — `test/fixtures/tools-manifest.json` after a
    deliberate tool change; `npm run eval:mocks` — `evals/mocks/`.

## Architecture (layered — boundaries are ESLint-enforced)

`src/core/` (plumbing) ← `src/api/` (one module per REST area) ← `src/mcp/`
(server wiring, registry) ← `src/tools/` (tool definitions as data). `bin/`
holds the CommonJS launcher; `src/index.ts` is the server entry (stdio by
default, Streamable HTTP with `SN_TRANSPORT=http`). `extension/` is the VS Code
extension; `skills/`, `hooks/` and `.claude-plugin/` are the agent plugin.

Each area has path-scoped rules in `.github/agent-instructions/<area>.md`
(rendered to `.github/instructions/<area>.instructions.md` with an `applyTo`
glob). Read the one for the files you edit. The same rules are rendered to a
nested `AGENTS.md` in `src/api/`, `src/core/`, `src/mcp/`, `src/tools/`,
`test/`, `scripts/` and `extension/` for agents that read the nearest one.

## Rules

- **stdio:** never write to `stdout` (no `console.log` in `src/`) — structured
  JSON logs go to stderr via `src/core/logging.ts`.
- ES modules with `.js` import specifiers; TypeScript strict +
  `noUncheckedIndexedAccess`; untyped JSON is `unknown` and narrowed.
- Tool inputs are bounded `zod` raw shapes with `.describe()`; all four
  annotation hints are explicit. Adding a tool: CONTRIBUTING.md → "Adding a
  tool".
- Every `SN_*` variable is declared in the settings manifest
  (`src/core/settings-manifest.ts`); invalid values stop the server unless
  `SN_STRICT_SETTINGS=0`.
- Credentials come from `SN_ENV_FILE` or `~/.config/servicenow-mcp-ai/.env`
  (written `0600`); real env vars win. Never log or echo passwords, tokens or
  keys.
- Writes are **plan-by-default** (`SN_WRITE_MODE`) and journaled per profile;
  a destructive apply needs the preview's `plan_token`.
- Every behavioural change ships with a test in the same commit; docs move with
  the code (CHANGELOG `Unreleased`, the item's row in `project/roadmap.yaml`).
- One commit per task: English, imperative subject, a body with what + why.

## Do not

- Change the `tools/list` surface without stating its byte delta: budgets live
  in `test/fixtures/token-budgets.json` (`npm run tokens:budget`); raising one
  is an owner decision (O-10).
- Start or widen a breaking change without an owner decision. The breaking
  register (B1–B24) is in `project/ROADMAP-V3.md`; decisions are ADRs in
  `project/adr/`.
- Edit `scripts/pack-check.mjs` (the 3 MB tarball ceiling).
- Edit generated files by hand: `.github/instructions/`, the nested
  `AGENTS.md` files,
  `.github/copilot-instructions.md`, `docs/tools/`, `docs/llms-full.txt`,
  `docs/index.md`, `.env.example`, `evals/mocks/`. Edit the source and rerun
  its generator.
- Commit secrets, `.env*` files (except `.env.example`) or assistant harness
  files (`CLAUDE.md`, `CLAUDE.local.md`, `WORKLOG.md`, `.claude/`, `docs/ai/`);
  `test/harness-files.test.js` fails if one is tracked.
- Write to a real ServiceNow instance from tests: the HTTP layer is mocked.

## Plan and status

The tracker is `project/ROADMAP-V3.md` (pillars H/M/S/D/E/P/N, owner gates
O-1…O-25, breaking register B1–B24), its status table mirrored from
`project/roadmap.yaml`. Open owner decisions are in `project/TODO.md`; the
analyses behind the N items are the `project/*-2026-10.md` files. Non-breaking
items ship on the 2.x line; the breaking cluster goes to 3.0.0, previewed as
`3.0.0-beta.n` on the npm `next` tag until 3.0.0 shipped (2026-10-19).

## References

- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP docs: https://modelcontextprotocol.io/docs
- ServiceNow REST APIs: https://developer.servicenow.com/dev.do#!/reference/api/latest/rest
