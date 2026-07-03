# Copilot instructions — servicenow-mcp-ai server

This is a **Model Context Protocol (MCP) server** written in **TypeScript** that
lets an MCP client operate a **ServiceNow** instance across its full REST
surface: 67 tools in 18 packages (Table, Aggregate, Attachment, Import Set,
Batch, CMDB/IRE, Catalog, Change, Knowledge, Email, Flows, Codecheck, ATF…),
plus script intelligence, multi-instance profiles and plan-and-apply write
safety.

## Architecture (layered — boundaries are ESLint-enforced)

- `src/core/` — instance-agnostic plumbing: `config.ts` (env-file ConfigStore),
  `settings.ts` (every `SN_*` knob), `policy.ts` (two-axis table/package
  policy), `http.ts` + `http-util.ts` (retry matrix, per-host semaphore,
  telemetry), `auth.ts`/`oauth-login.ts`/`jwt.ts`/`mtls.ts` (all auth methods),
  `host.ts` (SSRF guard + host allow-list), `write-journal.ts`, `errors.ts`.
- `src/api/` — one module per ServiceNow REST area (table, aggregate, cmdb,
  catalog, change, flows, codecheck, atf…), all over mock-testable `fetch`.
- `src/mcp/` — server wiring: `registry.ts` (declarative tool manifest — a
  package is a plug-in), `define.ts`, result shaping, `redact.ts` (DF-5),
  prompts and resources.
- `src/tools/` — the per-package tool definitions consumed by the registry.
- `src/core/jira/` + `src/api/jira/` — Jira Cloud client scaffolding; **no
  Jira tools are exposed yet** (pending the ARCH-14 decision in TODO.md).
- `bin/` — entry points; `src/index.ts` is the server entry (stdio by default,
  Streamable HTTP with `SN_TRANSPORT=http`).

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
- Tool input schemas are `zod` raw shapes; handlers must not throw — catch and
  return `{ isError: true }` results.
- Every `SN_*` variable read in `src/` must be documented in the README env
  reference **and** `.env.example` (a sync test fails the build otherwise).
- The README tools table is generated: `npm run docs:readme`.

## Build & run

- `npm install`, then `npm run check` — the full gate (build + lint + format +
  380 tests + coverage + audit). Run it before finishing any change.
- `npm run dev` / `npm start` / `npm run watch`; debug with
  `npm run inspector` (MCP Inspector) or the VS Code config in `.vscode/mcp.json`.
- `npm run gen:manifest` — regenerate the tool manifest after tool changes.

## SDK references

- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Concepts & guides: https://modelcontextprotocol.io/docs
- ServiceNow REST APIs: https://developer.servicenow.com/dev.do#!/reference/api/latest/rest
