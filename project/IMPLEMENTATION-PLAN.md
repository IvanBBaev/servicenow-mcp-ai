# servicenow-mcp — Implementation plan: full ServiceNow API coverage

Date: 2026-06-11 · Goal: from 7 tools over the Table API → a complete ServiceNow MCP server covering everything usable on the REST surface.
Decisions from the reviews: the `.env` file mode and instance switching are **not problems** (stay as they are); the scope is **maximal**.

---

## What ServiceNow offers (research result)

### Core APIs (available on every instance, no plugin)

| API                  | Endpoint                                         | What it provides                                      |
| -------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| Table                | `/api/now/table/{table}`                         | CRUD on any table — **already covered**               |
| Aggregate            | `/api/now/stats/{table}`                         | COUNT/SUM/AVG/MIN/MAX + GROUP BY without pulling rows |
| Attachment           | `/api/now/attachment`                            | list/metadata/download/upload/delete of files         |
| Import Set           | `/api/now/import/{staging}` (+ `insertMultiple`) | the right way to bulk-load data (incl. CMDB)          |
| Batch                | `/api/now/v1/batch`                              | several REST requests in one — saves roundtrips       |
| Email                | `/api/now/email`                                 | send/read emails from the instance                    |
| CMDB Instance        | `/api/now/cmdb/instance/{class}`                 | CI CRUD + relations, class-aware                      |
| CMDB Meta            | `/api/now/cmdb/meta/{class}`                     | metadata/schema of a CMDB class                       |
| Identify & Reconcile | `/api/now/identifyreconcile`                     | proper CI ingest (IRE) instead of a direct insert     |

### Plugin-scoped APIs (require an active plugin; discovered with a probe → 404 = absent)

| API               | Endpoint                                | What it provides                                                                                    |
| ----------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Service Catalog   | `/api/sn_sc/servicecatalog`             | browse catalogs/categories/items, variables, cart, **order now** — impossible through the Table API |
| Change Management | `/api/sn_chg_rest/change`               | normal/standard/emergency change, **conflict detection**, risk, approvals, CAB                      |
| Knowledge         | `/api/sn_km_api/knowledge`              | article search with relevance, featured/most-viewed                                                 |
| CSM Case          | `/api/sn_customerservice/case`          | customer service case management                                                                    |
| CI/CD             | `/api/sn_cicd`                          | ATF runs, app publish/install, scan — for dev instances                                             |
| Code Search       | `/api/sn_codesearch/code_search/search` | full-text search over the instance's code (used by ServiceNow's VS Code extension)                  |

### Where the scripts live (reachable through the Table API — no new client needed)

| Table                                        | Contents                                                         |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `sys_script`                                 | Business rules (when/order/condition + script)                   |
| `sys_script_include`                         | Script includes (server-side libraries)                          |
| `sys_script_client`                          | Client scripts                                                   |
| `sys_ui_policy` / `sys_ui_policy_action`     | UI policies                                                      |
| `sys_ui_action`                              | UI actions (buttons)                                             |
| `sysauto_script`                             | Scheduled script jobs                                            |
| `sysevent_script_action`                     | Script actions (event-driven)                                    |
| `sys_ws_operation`                           | Scripted REST APIs                                               |
| `sys_transform_map` / `sys_transform_script` | Transform maps + their scripts                                   |
| `sys_security_acl`                           | ACLs (incl. script conditions)                                   |
| `wf_workflow` / `wf_activity`                | Legacy workflows                                                 |
| `sys_hub_flow`                               | Flow Designer (JSON definitions — readable, harder to interpret) |

> Important: incident/problem/user/group/agile records are perfectly manageable through the existing Table API. Dedicated APIs are added only where they offer something beyond CRUD (catalog ordering, change conflicts, KB search, binary attachments).

### Lesson from competing MCP servers

Echelon-ai-labs (~70 tools) and ShunyaAI (60+) show that with that many tools the LLM context overloads and tool-selection quality drops. Their solution — **tool packages** (env `SN_TOOL_PACKAGES=core,catalog,change,...`) — adopted here from day one.

---

## Architecture (target state, as planned on 2026-06-11)

```
src/
├── index.ts              # bootstrap: env, server, transport, shutdown
├── config.ts             # credentials (.env) — as is
├── http.ts               # shared request(): auth, timeout, retry/backoff, errors
├── registry.ts           # registerTool wrapper: annotations, ok/fail, package gating
├── tools/
│   ├── table.ts          # the 5 existing CRUD tools
│   ├── credentials.ts    # set_credentials + get_status (as are)
│   ├── aggregate.ts
│   ├── attachment.ts
│   ├── import-set.ts
│   ├── batch.ts
│   ├── email.ts
│   ├── cmdb.ts           # instance + meta + identifyreconcile
│   ├── catalog.ts        # sn_sc
│   ├── change.ts         # sn_chg_rest
│   ├── knowledge.ts      # sn_km_api
│   ├── schema.ts         # describe_table (sys_dictionary), list_tables
│   ├── scripts.ts        # reading/searching scripts, table logic
│   └── docs.ts           # self-documentation: read/write/search of MD files
└── resources/
    └── status.ts         # connection status as an MCP resource
docs/instance/            # the generated instance documentation (MD + Mermaid)
test/                     # unit (mock fetch) + env round-trip
```

Principles:

- One shared `request()` in `http.ts` — retry, errors, telemetry are done once; every tool benefits.
- Each tools file exports `register(server, ctx)`; `index.ts` only enumerates them.
- Every tool declares `annotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`) and a package membership.

---

> Work completed so far is moved out into [DONE.md](DONE.md).

## Phase 1 — Foundation for growth · ~1 day

> Retry/backoff, the unit tests and ESLint/Prettier are already in DONE.

- [x] **Restructuring** per the scheme above: `http.ts` (extracted `request()`), `registry.ts`, `tools/table.ts`, `tools/admin.ts`. Zero behaviour change — a pure refactor. (see DONE.md)
- [x] **Structured error payload** from `fail()` (`{ status, message, snDetail }`) so the model reacts differently to 401/403/429.
- [x] **Tool annotations** on all existing tools (query/get → readOnly, delete → destructive, update → idempotent).
- [x] **Tool packages**: env `SN_TOOL_PACKAGES` (profile `core` by default = table+schema+aggregate+attachment; `all` for everything; admin tools always active). Gating in `registry.ts` (`resolveEnabledPackages`).
- [x] **Mock-fetch tests + CI**: a `globalThis.fetch` stub for mutations/error mapping/retry; GitHub Actions: build+lint+test.
- [x] Debug logging on stderr: tool name, table, duration, status (env `SN_LOG_LEVEL`).

## Phase 2 — Core APIs · ~2 days

- [x] **Schema tools** (the biggest win for the agent): `servicenow_describe_table` (sys_dictionary → fields, types, mandatory, references) and `servicenow_list_tables` (sys_db_object with a filter). Solves the LLM's #1 problem: "what fields does this table have?"
- [x] **Aggregate**: `servicenow_aggregate` — count/sum/avg/min/max + group_by + having on any table.
- [x] **Attachment** (5 tools): list (by table+sys_id), get (metadata), download (base64 up to a limit), upload (base64), delete (destructive).
- [x] **Import Set**: `servicenow_insert_import_set_row` — POST to a staging table, returns the transform result + `servicenow_get_import_set_row`.
- [x] **Batch**: `servicenow_batch` — an array of sub-requests {method, url, body} → one HTTP request; base64 encode/decode; policy per sub-request.
- [x] **Email**: send/get (behind the `email` package, not in default). _(delivered as X-7)_

## Phase 3 — CMDB + plugin APIs · ~2–3 days

- [x] **CMDB package**: `servicenow_list_cis`/`get_ci`/`create_ci`/`update_ci` (class-aware via the CMDB Instance API, which goes through IRE) + `servicenow_get_cmdb_meta` (class schema). Create/update CI replaces a bare insert into `cmdb_ci`.
- [x] **Capability detection**: `api/plugin.ts` (`pluginCall`) wraps plugin-dependent requests; a missing plugin → the 404 is translated into a clear "API X may not be active on this instance" message instead of a raw 404.
- [x] **Service Catalog package** (sn_sc): `list_catalogs`/`list_catalog_categories`/`list_catalog_items`, `get_catalog_item` (+ variables), `order_catalog_item` (order now). The flagship functionality the Table API cannot do.
- [x] **Change Management package** (sn_chg_rest): `create_change` normal/standard/emergency, `change_conflicts` (**check conflicts** + recalculate), `list_changes`/`get_change`/`update_change`.
- [x] **Knowledge package** (sn_km_api): `search_knowledge` (with relevance), `get_knowledge_article`, `knowledge_highlights` (featured/most-viewed).
- [ ] (Optional, on demand) CSM Case, CI/CD (ATF runs for dev instances → now Phase 8 FT-4).

## Phase 4 — MCP UX polish · ~1 day

- [x] **Resources**: `servicenow://status` (connection), `servicenow://tables`, `servicenow://schema/{table}` — declaratively readable by the client, no tool calls wasted.
- [x] **Prompts**: ready-made templates — `servicenow_incident_triage`, `servicenow_change_impact_analysis`, `servicenow_document_table`. Always registered (like resources).
- [x] **OAuth 2.0** as a second `AuthProvider` (password / client credentials / refresh token) next to Basic; env `SN_AUTH=basic|oauth`.
- [x] README rework: a table of all tools, an env reference, a tool-packages section, examples.

## Phase 5 — Script intelligence + self-documentation · ~2 days

Goal: the server reads and understands the instance's code and accumulates durable understanding in MD files with Mermaid diagrams, which later sessions use as context.

### Script intelligence (package `scripts`, read-only)

- [x] `servicenow_list_scripts` — a list by type (business_rule / script_include / client_script / ui_policy / ui_action / scheduled_job / transform / rest_operation / acl), filters by table, name, active; returns metadata (when, order, condition, last update, author) without the code — saves context.
- [x] `servicenow_get_script` — a script's full source + its execution context (for a business rule: table, when, order, condition, filter; for a script include: client_callable, access).
- [x] `servicenow_search_code` — searches a string/expression across all script tables (encoded `LIKE` query); returns a per-line snippet instead of whole scripts. Answers "where is this script include used?". (The Code Search plugin remains a future option for better relevance.)
- [x] `servicenow_table_logic` — the full picture for one table: all business rules (ordered by when+order), client scripts, UI policies, UI actions, ACLs. The entry-point tool for "understand what happens on insert/update of incident".

### Self-documentation (package `docs`)

- [x] Convention: env `SN_DOCS_DIR` (default `docs/instance/`); `index.md` as a table of contents (auto-regenerated) + a file per area (`tables/incident.md`, ...). Tool descriptions instruct the model: **read the docs first, then ask the instance**.
- [x] `servicenow_docs_list` / `servicenow_docs_read` / `servicenow_docs_search` (content grep) — the read layer; cheap, read-only; path-traversal protection.
- [x] `servicenow_docs_write` — creates/updates an MD file (+ auto-refreshes `index.md`); `.md` only, inside the directory only.
- [x] **Mermaid generators** (deterministic):
  - `servicenow_generate_er_diagram` — reads `sys_dictionary` references for a list of tables and builds an `erDiagram`;
  - `servicenow_generate_table_flow` — builds a lifecycle `flowchart` from a table's business rules (when/order).
- [x] MCP resource `servicenow://docs/{path}` — declarative attachment of the documentation.
- [x] Prompt template `servicenow_document_table` — orchestrates: schema + table_logic + diagrams → writes `tables/{name}.md`.

---

## Execution order and principles

1. Phases 0 → 1 → 2 are strictly sequential (each builds on the previous). The Phase 3 packages are independent of each other — go by priority: Catalog → Change → Knowledge → CMDB (or as needed). Phase 4 any time after Phase 1. Phase 5 depends only on Phase 1 + the schema tools from Phase 2.
2. Every new tool ships with: a zod schema with `.describe()` on every field, annotations, a package tag, a unit test of the mapping, a row in the README.
3. Expected end state: ~45–50 tools in ~12 packages, default profile `core` — the balance between "everything possible" and a usable LLM context. The `scripts` and `docs` packages are read-only/local and good candidates for the default profile.

**Overall estimate: ~8–10 working days** for the full plan; after Phase 2 (≈3½ days) the server already covers all core APIs.

---

# Phase 6 — Harness 2.0: deep analysis and improvement plan

Analysis date: 2026-06-11 · Scope: the whole `src/` (24 files, ~3500 lines), tests, CI, configuration.
This is a **self-contained execution specification** — every task names the file, the what and the why, with a readiness criterion.

> By "harness" we mean the shared infrastructure all tools stand on: `http.ts`, `auth.ts`, `host.ts`, `policy.ts`, `config.ts`, `settings.ts`, `errors.ts`, `logging.ts`, `result.ts`, `registry.ts`, `resources.ts`, `tools/util.ts`.
>
> **Addendum 2026-06-12:** the deep review in [TODO.md](TODO.md) (tasks `S-*`/`A-*`/`Q-*`) is executed together with this phase — `S-7` with K-1, `S-6` with K-4, `A-4` with M-1, `Q-1`/`Q-3` before step 2 (safety net), `A-2` before Phase 7, `A-1` with MI-2.

## 6.0 Analysis findings (state at the time)

**Verified live:** `npm run build` ✅ · `eslint .` ✅ · 50/50 unit tests ✅ (with Node 22; see K-8 for the Node 12 trap). 40 registered tools in 12 packages.

> **Audit 2026-06-12 (after the review implementation):** 107/107 tests · 46 tools in 13 packages · a git repository with one-commit-per-task · SDK **1.29** (X-1 ✅) · prompts.ts exists (X-3 ✅) · the README tools table is generated (M-5 ✅ in substance, see the note) · type-checked ESLint · ConfigStore. The weaknesses "outdated SDK", "not a git repository" and "duplicated truth in the README" from the list below were already solved.

**Strengths (to preserve through refactoring):**

- One shared `snRequest()` with retry/backoff, Retry-After, timeout, SSRF guard, a clean transport-/API-error separation.
- The policy layer (`assertTableAllowed`/`assertWriteAllowed`) is applied consistently in the **api/** layer (not in tools/) — verified for table, attachment, cmdb, importset, batch: all go through it. Batch even extracts the table from sub-URLs.
- Discipline: every tool has annotations, zod `.describe()` on every field, a structured error payload; stdout is sacred (logs to stderr only).
- `config.ts` writes .env atomically (tmp+rename) and preserves foreign keys/comments; `formatEnvValue` holds up against the dotenv round-trip traps.

**Weaknesses (addressed by the tasks below):** ~25 lines of duplicated boilerplate in each of the 40 tools; the tool→package membership lives only in `registry.ts` (apart from the definitions); the SDK lags (1.12 → 1.29); the OAuth token is not invalidated on 401; `fetchAll` paginates without a stable ordering; no schema cache (every `describe_table` hits the instance); pretty-printed JSON wastes ~2× tokens; **the project is not a git repository**.

## 6.1 Prerequisites (before any refactoring)

- [x] **P-1 · Git init.** _(done 2026-06-12, commit `035a77f` — baseline + one-commit-per-task discipline since)_ `.gitignore` covers `node_modules/`, `build/`, `.env`.
- [x] **P-2 · Node 20+ guard.** _(done, commit `a31ee78`)_ A real incident: under system Node 12 `npm run build` fails with cryptic errors and `node --test` won't start. Actions: (a) `package.json` → `"engines": { "node": ">=20" }`; (b) `.npmrc` with `engine-strict=true`; (c) an early check before any import-dependent code: a clear stderr message + `process.exit(1)`.
      _Criterion:_ under Node 12 the launcher prints a human explanation instead of a SyntaxError.

## 6.2 Harness correctness and resilience (small, high-value fixes)

- [x] **K-1 · OAuth: invalidation on 401.** _(done, commit `369f5cf`)_ `auth.ts` caches the token until expiry, but if the token is revoked server-side every request returns 401 until the TTL ends. In `http.ts`: on a 401 with `getAuthMode() === "oauth"` → drop the cached token (`invalidateToken(host)`) and retry the request **once** with a fresh token; a second 401 surfaces as an error. _Test:_ mock fetch: 401 → token endpoint → 200; assert the token was requested again.
- [x] **K-2 · Authorization computed per attempt.** _(done, commit `369f5cf`)_ `authorize(host)` used to run once before the retry loop; with long backoffs (up to 8 s × N tries) an OAuth token can expire between attempts. Moved inside the loop (Basic is just cheap base64; OAuth reads its cache anyway).
- [x] **K-3 · Stable `fetchAll` pagination.** _(done, commit `739c20f`)_ Offset pagination without `ORDERBY` has no ordering guarantee in ServiceNow → concurrent writes can skip/duplicate rows across pages. If `opts.query` contains no `ORDERBY` → append `^ORDERBYsys_id`. _Test:_ a query without ORDERBY gets the suffix; one with ORDERBY stays untouched.
- [x] **K-4 · Batch: restrict sub-URLs to `/api/`.** _(done, commit `9c7f02b`)_ `runBatch` required only a leading `/` — a sub-request could hit `/oauth_token.do`, `/login.do` etc. (same host, but outside the REST surface and the policy model). Require `url.startsWith("/api/")` with a clear error. _Test:_ a sub-request to `/login.do` → error before any network call.
- [x] **K-5 · `searchCode`: neutralise `^` in the text.** _(done, commit `1585efb`)_ The search text went raw into the encoded query; a `^` reads as a condition separator and breaks/distorts the filter (read-only, but wrong results). ServiceNow has no escape for `^` in LIKE → reject text containing `^` with a clear error. Same for the `name`/`table` filters in `listScripts`.
- [x] **K-6 · `set_credentials` validates the host on save.** _(done, commit `d2a354d`)_ An invalid `instance` used to surface only at the first request. The handler calls `resolveHost(args.instance)` in try/catch before `saveCredentials` → an invalid/blocked host is rejected and nothing is written. (The "instance switching is not a problem" decision stands — this is format/SSRF validation, not a domain restriction.)
- [x] **K-7 · Resources respect packages.** _(done, commit `849ff92`)_ `registerResources` used to register `servicenow://tables` and `servicenow://schema/{table}` unconditionally even with the `schema` package off. Now gated by the enabled set; `servicenow://status` stays always-on.
- [x] **K-8 · CI: Node matrix + coverage.** _(done, commit `7d57b66`)_ The workflow tested a single version. Added `strategy.matrix.node: [20, 22, 24]` + a c8 coverage step; `npm test` no longer duplicates the build (CI builds separately; `test:full` locally).

## 6.3 Modularity — separate modules for easy maintenance

The goal: clear layers with one-way dependencies, tool definitions as **data** instead of code, and generated documentation.

### 6.3.1 Target directory structure

```
src/
├── index.ts                  # bootstrap: env, version guard, server, transport, shutdown
├── core/                     # level 0 — no MCP SDK dependencies
│   ├── errors.ts             # ServiceNowError (as is)
│   ├── logging.ts            # stderr JSON logger (as is)
│   ├── settings.ts           # env settings (as is)
│   ├── config.ts             # credentials + .env writes (as is)
│   ├── policy.ts             # allow/deny/readonly (as is)
│   ├── host.ts               # resolveHost/SSRF (as is)
│   ├── auth.ts               # Basic/OAuth + invalidateToken (K-1)
│   └── http.ts               # snRequest (K-1/K-2 changes)
├── api/                      # level 1 — pure ServiceNow clients; import only core/
│   ├── table.ts              # ← the moved src/servicenow.ts (incl. K-3)
│   ├── aggregate.ts … scripts.ts  # as are, with fixed import paths
│   └── plugin.ts
├── mcp/                      # level 2 — everything that knows the MCP SDK
│   ├── registry.ts           # packages/profiles + registration from the manifest
│   ├── define.ts             # defineTool() + the ToolSpec type (new, see 6.3.2)
│   ├── result.ts             # ok/fail/okQueryResult (as is)
│   ├── resources.ts          # with K-7
│   └── prompts.ts            # new (X-3)
└── tools/                    # level 3 — ToolSpec[] declarations only
    ├── table.ts … scripts.ts # rewritten as data (6.3.2)
    └── admin.ts
```

Dependency rules (checkable): `core` imports from no one; `api` imports only `core`; `mcp` imports `core` (not `api`, except `resources.ts` → `api/meta`); `tools` import `api` + `mcp/define` + `mcp/result`.

- [x] **M-1 · Move the files** _(done, commit `08d16ce`)_ per the scheme (a clean move + import fixes, zero behaviour change). Tests import from `build/` — updated in the same commit. _Criterion:_ build/lint/tests green; `git diff --stat` mostly renames.
- [x] **M-2 · ESLint boundaries.** _(done, commit `a53e2cc`)_ `no-restricted-imports` per directory via flat-config overrides: `src/core/**` cannot import from `api|mcp|tools`; `src/api/**` cannot from `mcp|tools`; `src/tools/**` cannot import `core/http` directly (only through `api/`). _Criterion:_ a deliberate bad import fails lint.

### 6.3.2 Declarative tool manifest (the biggest maintenance win)

Before: every tool was ~25 lines of `server.registerTool(...)` + a manual `runTool` wrapper, with the package membership in a separate file. Across 40 tools that was ~1000 lines of mechanical code and two places to keep in sync.

- [x] **M-3 · `mcp/define.ts`.** _(done, commit `cc1b83e`)_ The type and the helper:

  ```ts
  export interface ToolSpec<S extends z.ZodRawShape> {
    name: string; // "servicenow_query_table"
    title: string;
    description: string;
    package: string; // "table" — the only place for the package tag
    annotations: ToolAnnotations;
    input: S; // zod shape, as before
    /** Fields for the log line; no secrets/encoded queries. */
    logFields?: (
      args: z.objectOutputType<S, z.ZodTypeAny>,
    ) => Record<string, unknown>;
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult>;
  }
  export function defineTool<S extends z.ZodRawShape>(
    spec: ToolSpec<S>,
  ): AnyToolSpec;
  ```

  Registration (in `mcp/registry.ts`) walks the manifest and wraps each handler in the uniform logger/error mapper itself — `tools/util.ts` is absorbed here. Each `tools/*.ts` now exports `const specs: AnyToolSpec[]` instead of `registerXxxTools(server)`.

- [x] **M-4 · Migrate the tools to ToolSpec** _(done, commit `cc1b83e`)_ package by package, build+test after each. `TOOL_GROUPS` replaced by the manifest; `ALL_PACKAGES` derived from the data. _Criterion:_ `servicenow_get_status` returns the same `enabledPackages`; tool names/schemas byte-identical (snapshot test against a fixture).
- [x] **M-5 · Generated README table.** _(done in substance 2026-06-12, commit `044cc31` — `scripts/readme-tools.mjs` + `npm run docs:readme` over `describeAllTools()`; the guard is `test/readme-sync.test.js` instead of a CI diff step)_ **Remainder:** the env table in the README is still manual — generate it too once the settings get a declarative registry.
- [x] **M-6 · Manifest snapshot test.** _(done, commit `1d8e141`)_ A test materialises `{name, package, title, annotations}` for all tools and compares it to a checked-in JSON fixture — every surface change becomes a reviewable diff.

## 6.4 New harness capabilities

- [x] **X-1 · SDK upgrade `@modelcontextprotocol/sdk` 1.12 → 1.29.** _(found already done during the 2026-06-12 audit — node_modules was already 1.29.0; InMemoryTransport is used by the smoke tests)_ Brings: elicitation, structured tool output (`outputSchema`/`structuredContent`), the MCP `logging` capability, protocol 2025-06-18. A **prerequisite for X-2, X-4, X-5**.
- [x] **X-2 · Elicitation for `set_credentials`** _(done, commit `8dda598`)_ — closes the open trust-boundary item. The handler calls `elicitInput()` with a summary of the change and saves only on confirmation; clients without the elicitation capability keep the current behaviour (save without confirmation), so nothing breaks. _Test:_ a mocked decline → nothing saved.
- [x] **X-3 · Prompts module** _(found already done during the 2026-06-12 audit — `prompts.ts` with the three templates shipped with Phases 4/5, see DONE.md)_
- [x] **X-4 · MCP logging capability** _(done, commit `8dda598`)_ With an active client logging capability, the logger also sends `server.sendLoggingMessage({ level, data })` besides the stderr line. One place changes: `emit()` gets an optional sink that `index.ts` attaches after `connect()`.
- [x] **X-5 · `outputSchema` for key tools** _(done, commit `8dda598`)_ Deviation: applied to get_status/test_connection (stable schemas); query_table/get_record/aggregate deliberately excluded — dynamic payloads, and duplicating structuredContent contradicts O-2.
- [x] **X-6 · `servicenow_test_connection`.** _(done, commit `3ed5351`)_ `get_status` shows the configuration but not whether it **works**. A new admin tool: `GET /api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id` → returns `{ ok, status, latencyMs, user }`; 401/403 come back structured (not as exceptions) so the model can react. Always registered (admin group).
- [x] **X-7 · Email package** _(done, commit `45ea8bb`)_ — the unfinished Phase 2 item: `servicenow_send_email` (POST `/api/now/email`), `servicenow_get_email` (GET by sys_id). Behind the `email` package, outside all profiles except `all`. Wrapped in `pluginCall` (the Email API requires an activated plugin on some instances).
- [ ] **X-8 · Transport choice (optional).** `SN_TRANSPORT=stdio|http` in `index.ts`: with `http` use `StreamableHTTPServerTransport` (port from `SN_PORT`, default 3000). A clean modular switch — nothing else changes, the code is transport-agnostic. Makes the server usable remotely/in a container. (Securing the HTTP endpoint — auth header/origin checks — is documented as the operator's responsibility.)

## 6.5 Optimisations (tokens, latency, instance load)

- [x] **O-1 · `sysparm_exclude_reference_link=true` by default.** _(done, commit `e57fa9c`)_ The Table API returns reference fields as `{ value, link }` — the `link` URLs are pure token ballast for an LLM. Added by default in `queryPage`/`getRecord`, with opt-out `SN_INCLUDE_REF_LINKS=true`. Expected effect: −20–40% of a reference-heavy response.
- [x] **O-2 · Compact JSON output.** _(done, commit `e57fa9c`)_ Pretty-printing roughly doubled the tokens of large results. Env `SN_RESULT_PRETTY` (default **false** → compact; `true` for readable).
- [x] **O-3 · Schema cache with TTL.** _(done, commit `29b37ec`)_ `describe_table`/`list_tables`/`get_cmdb_meta` return near-static data yet are called often (also by resources). A small generic `core/cache.ts`: `cached(key, fn)` over a `Map` with timestamps; TTL from `SN_SCHEMA_CACHE_TTL_SEC` (default 300, `0` disables). Key includes the instance. Applied only in `api/meta.ts` and `api/cmdb.ts#getCmdbMeta` — deliberately not generalised.
- [x] **O-4 · Concurrency limit (light).** _(done, commit `12d2e97`)_ `tableLogic` fires 5 parallel requests, `fetchAll` can chain dozens — a simple semaphore around `fetch` (env `SN_MAX_CONCURRENT`, default 4). Protects the instance from salvos and makes 429s less likely. No external dependency.
- [x] **O-5 · In-process telemetry.** _(done, commit `12d2e97`)_ Counters in `core/http.ts`: `{ requests, errors: {401: n, 403: n, 429: n, …}, retries, totalMs }`; exposed in `servicenow_get_status` and `servicenow://status`. Zero external dependencies; makes "why is it slow / failing" diagnosable from the client itself.

## 6.6 Execution order

| Step | Tasks                    | Why this order                                                   |
| ---- | ------------------------ | ---------------------------------------------------------------- |
| 0    | P-1, P-2                 | Refactoring safety; a real Node 12 incident                      |
| 1    | K-1 … K-8                | Small, independent, each with a test; raise quality before moves |
| 2    | M-1, M-2                 | A clean move while the diff is small                             |
| 3    | M-3 → M-4 → M-5 → M-6    | The manifest; package by package, always green                   |
| 4    | X-1 → X-2/X-4/X-5        | The SDK upgrade unlocks the three                                |
| 5    | X-3, X-6, X-7, O-1 … O-5 | Independent; by user priority                                    |
| 6    | X-8 (opt.)               | Only when remote access is needed                                |

Working rules (apply to every step):

1. **Always green:** after every task `npm run build && npm run lint && node --test test/*.test.js` (Node ≥ 20!) — no excluded tests.
2. **One task = one commit** with its ID in the title (e.g. `K-3: stable ordering for fetchAll`).
3. A new env variable → a row in the README env reference + `.env.example`; a new tool → through the manifest (M-3), never a direct `registerTool`.
4. Default behaviour changes (O-1, O-2) are noted in the README.
5. The "won't-fix" decisions from TODO.md (`.env` mode, instance switching) **stay in force** — K-6 validates format/SSRF without restricting the domain.
6. **The 2026-06-12 review** (TODO.md, tasks `S-*`/`A-*`/`Q-*`) is **fully implemented** (see DONE.md) — incl. A-1 per-package policy, A-2 ConfigStore, A-8 the generated README tools section. M-1/M-2 moved already-finished modules; M-5 for the tools table is effectively done — only the env table remains.
7. **(Q-6) Test discipline:** every behavioural change ships with a test in the same commit. Guards: the README sync test, the core contract snapshot (mcp-smoke) and the always-green full suite — all three fail on an undisciplined change.

**Effort estimate:** steps 0–2 ≈ 1 day; step 3 ≈ 1 day; step 4 ≈ ½–1 day; step 5 ≈ 1 day. Total **~3½–4 working days** for the full Phase 6. _(Actual: delivered on 2026-06-12.)_

---

# Phase 7 — Multi-instance: profiles, metadata, analysis

Date: 2026-06-11 · User requirement: "I tell it which instance to point to, log in, pull its metadata, run its analysis — I want it to work with many instances."

**Dependency:** requires the finished tool manifest from Phase 6 (M-3/M-4) — otherwise the `instance` parameter must be threaded manually through 40 tools. Also builds on O-3 (the schema cache is already host-keyed) and the Phase 5 docs convention.

## 7.1 Configuration model: named profiles

Principle: **full backwards compatibility** — today's `SN_INSTANCE`/`SN_USER`/`SN_PASSWORD` become the profile named `default`; nothing breaks for existing users.

- [x] **MI-1 · Profiles in `.env`.** _(done, bf6712d)_ Convention: `SN_PROFILE_<NAME>_INSTANCE` / `_USER` / `_PASSWORD` (+ optionally `_AUTH`, `_OAUTH_CLIENT_ID`, `_OAUTH_CLIENT_SECRET`, `_OAUTH_GRANT`, `_READONLY`, `_TABLES_ALLOW`, `_TABLES_DENY`). `<NAME>` is `[A-Z0-9_]+` (lowercase in tools, e.g. `dev`, `test`, `prod`). In `core/config.ts`: `listProfiles()`, `getCredentials(profile = activeProfile())`. The active profile: `SN_ACTIVE_PROFILE` (persisted to `.env` on switch; default `default`).
      _Criterion:_ an old `.env` without profiles works unchanged; tests for parallel profiles + precedence.
- [x] **MI-2 · Per-profile policy.** _(done, 4a129de)_ `policy.ts`: readOnly / allow/deny read `SN_PROFILE_<NAME>_READONLY` etc. first, then the global key as a fallback. Enables the real scenario: **prod = read-only, dev = full rights** in the same server. `resolveHost` stays shared (the SSRF guard applies to all profiles).
- [x] **MI-3 · Request context via `AsyncLocalStorage`.** _(done, 3bf1e12)_ Instead of changing the signatures of 20+ `api/` functions, the profile flows implicitly: an ALS in core; the manifest layer automatically adds an **optional** `instance` input parameter to every tool and runs the handler inside `als.run(profile, …)`. `http`/`auth`/`policy` read the profile from the ALS with a fallback to the active one. The OAuth `tokenCache` is already host-keyed → works unchanged.
      _Criterion:_ `servicenow_query_table` with `instance: "test"` hits the `test` profile's host (a mock-fetch test with two profiles); without the parameter — the active one.
- [x] **MI-4 · Admin tools for profiles.** _(done, 4a129de)_ (a) `servicenow_list_instances` — name, host, readOnly, hasCredentials per profile (**never passwords**); (b) `servicenow_use_instance(name)` — switches `SN_ACTIVE_PROFILE` and persists it; (c) `servicenow_set_credentials` gets an optional `profile` (default — the active one) and writes the prefixed keys; the K-6 validation applies. (d) `servicenow_get_status` and `servicenow://status` show the active profile + the list.
- [x] **MI-5 · Cache and telemetry per host.** _(done, aaab456/29b37ec — delivered earlier via S2-2/O-3)_ The O-3 cache key includes the instance and the O-5 counters break down per host.

## 7.2 Metadata: instance snapshot and analysis

The goal of "pull its metadata and run its analysis": a one-off (or periodic) download of the instance's structural picture into local files that then serve as context and as the basis for instance comparison.

- [x] **MI-6 · `servicenow_snapshot_instance`.** _(done, 17f0fc6 — schema docs for the explicitly passed tables; row counts folded into automation.md)_ Pulls and writes into `docs/instance/<profile>/` (the Phase 5 convention; `SN_DOCS_DIR` root):
  - `tables.md` + `tables.json` — sys_db_object (name, label, extends, optional row counts via Aggregate);
  - `schema/<table>.md` — sys_dictionary for the given or top-N tables (args: `tables?: string[]`);
  - `plugins.md` — active plugins (`v_plugin`, fallback `sys_plugins`);
  - `apps.md` — installed applications (`sys_app`, `sys_store_app`);
  - `automation.md` — script statistics by type (Aggregate over the script tables: count, active, last update);
  - `index.md` — a table of contents + the snapshot date.
    Everything through the existing api/ layers (meta, aggregate, scripts) — zero new HTTP clients. Markdown for humans/LLMs + JSON for machine comparison. _Criterion:_ a mock-fetch test generates a snapshot into a temp dir; an idempotent re-run overwrites cleanly.
- [x] **MI-7 · `servicenow_compare_instances(a, b)`** — _(done, landed inside e265588 — one dictionary pull and one pull per script type per side, no per-table N+1; scripts always live, tables/plugins/apps honour from_snapshot)_ the flagship of the phase. Compares two profiles (live, or from the JSON snapshots when present — arg `from_snapshot?: boolean`):
  - tables present in only one;
  - columns with a different type/mandatory/reference (sys_dictionary diff per table);
  - scripts (by type+name): present in only one / different source (SHA-256 of the script, not a text diff — compact);
  - plugin/app differences.
    Output: an MD report (`docs/instance/_compare/<a>-vs-<b>.md`) + a structured summary in the tool result. Answers "dev → test → prod: what is out of sync?".
- [x] **MI-8 · Per-profile resources.** _(done, fb85be0 — shared profilesPayload() so the tool and the resource cannot drift)_ `servicenow://instances` (the list), `servicenow://{profile}/schema/{table}` as a new template; the old URIs keep pointing at the active profile.

**Estimate:** ~2 days (MI-1…MI-5 ≈ 1 day — done; MI-6…MI-8 ≈ 1 day). **Phase 7 is complete (2026-06-12).**

---

# Phase 8 — Logical flow testing + code checking

Date: 2026-06-11 · Requirement: "it should be able to run logical tests on different flows and to check the code."

Three complementary levels — a static view (what **would** run), evidence (what **did** run) and real tests (ATF). Builds on the `scripts` package (done) and the Phase 5 schema tools.

## 8.1 Flow intelligence (package `flows`, read-only)

- [ ] **FT-1 · `servicenow_list_flows` / `servicenow_get_flow`.** Flow Designer lives in `sys_hub_flow` (+ `sys_hub_trigger_instance`, `sys_hub_action_instance`, `sys_hub_flow_logic`). `list_flows`: filter by table/active/trigger type — metadata without the definition. `get_flow`: parses the JSON definition into a **structured view**: trigger (table, condition, when), ordered steps (action, inputs, branch conditions), subflows. The goal is not full decompilation — just enough for an LLM to reason about the logic. Legacy workflows (`wf_workflow`/`wf_activity`) — the same tool pair with `kind: "workflow"`.
- [ ] **FT-2 · `servicenow_trace_table_event(table, operation)` — deterministic simulation.** For a table + operation (insert/update/delete/query) it builds the **ordered chain** of what ServiceNow would execute: display → before BRs (by order) → engines → after BRs → async BRs + flows/workflows triggered on the table + notifications (`sysevent_email_action`) + events (`sysevent_script_action`). Returns the list with each element's conditions + an optional Mermaid `flowchart` (ties into the Phase 5 Mermaid generators). This is the "logical test without execution": answers "if I create an incident with priority=1, what happens and in what order?" — the LLM evaluates the conditions against the hypothetical record.
- [ ] **FT-3 · `servicenow_get_flow_runs` — execution evidence.** Reads `sys_flow_context` (+ `sys_flow_log` when needed): by flow or by record (document_id) — when it started, status (success/error/waiting), the error. Closes the loop: "did the flow that should have started (FT-2) actually start?" For BR errors: `syslog` reads filtered by source/time are available through the existing `query_table` — add a prompt hint, not a new tool.

## 8.2 Real tests: ATF (package `atf`, requires plugin + roles)

- [ ] **FT-4 · ATF execution through the CI/CD API** (`pluginCall` wrapper): `servicenow_list_atf_tests` / `servicenow_list_atf_suites` (Table API: `sys_atf_test`, `sys_atf_test_suite`); `servicenow_run_atf_test(test_sys_id)` and `servicenow_run_atf_suite(suite_sys_id)` → POST `/api/sn_cicd/testsuite/run` (verify the exact paths in the CI/CD API spec at implementation time) — returns an `execution_id`; `servicenow_get_atf_result(execution_id)` — progress (`/api/sn_cicd/progress/{id}`) + results from `sys_atf_test_result`. Annotations: the run tools are `readOnlyHint: false` (they execute code on the instance!), `destructiveHint: false`. **Not** in the default profile. _This is the official path for "logical flow tests" on a live instance_ — an ATF test can create a record, assert values, validate a UI policy and clean up after itself.

## 8.3 Code checking (package `codecheck`, fully local analysis)

- [ ] **FT-5 · `servicenow_lint_script(type, sys_id)` + `servicenow_lint_table(table)`.** Pulls the source through the existing `api/scripts.ts` layer and runs **deterministic rules** locally (zero network beyond fetching the code). Initial rule set (each rule: id, severity, line, snippet, hint):
  - `hardcoded-sys-id` — a 32-hex literal in the code;
  - `gr-unbounded-query` — `new GlideRecord(...)` + `.query()` without `addQuery`/`addEncodedQuery`/`setLimit` (full table scan);
  - `query-in-loop` — `.query()`/`getReference` inside `while`/`for` (N+1);
  - `current-update-in-br` — `current.update()` in a before BR (double execution) — needs the `when` context from the metadata we already have;
  - `set-workflow-false` — `setWorkflow(false)` (bypasses BRs — warning only);
  - `eval-usage`, `gs-sleep`, `gs-log-deprecated` (gs.log → gs.info), `hardcoded-instance-url` (`https://….service-now.com` in code);
  - client: `gr-on-client` (GlideRecord in a client script — slow), `sync-get-reference` (`getReference` without a callback).
    Implementation: regex-based rules in pure TS (`api/codecheck.ts` — a rule table, easily extended); **no** new runtime dependency. A syntax check via `new Function(source)` in try/catch is a cheap bonus for server-side ES5 — note the limitations (SN globals, scoped API) in the description. `lint_table` = lint of all active BR/CS/UI-policy scripts of a table (through `tableLogic`).
- [ ] **FT-6 · `servicenow_code_health(scope?)`** — an aggregate report for an instance or table: script counts by type, active/inactive, last touched, FT-5 findings by severity, top offenders. Writes MD to `docs/instance/<profile>/code-health.md` (ties into the MI-6 snapshot). This is "check the code" in bulk — a health picture from which the LLM proposes concrete fixes.
- [ ] **FT-7 · Code Search upgrade (optional, deferred from Phase 5).** If `/api/sn_codesearch/code_search/search` is available (probe via `pluginCall`) — `search_code` uses it instead of the LIKE iteration; the fallback stays. Better relevance on large instances.

## 8.4 Order and estimate

| Step | Tasks       | Note                                                             |
| ---- | ----------- | ---------------------------------------------------------------- |
| 1    | FT-2        | Highest value, zero new APIs (builds on tableLogic)              |
| 2    | FT-1, FT-3  | Flow Designer reading + evidence                                 |
| 3    | FT-5 → FT-6 | The lint rules first, the report on top of them                  |
| 4    | FT-4        | ATF — needs a PDI with the CI/CD plugin active for manual checks |
| 5    | FT-7        | Optional                                                         |

The 6.6 rules (always green, one commit per task, README/env discipline, new tools only through the manifest) apply in full. New packages: `flows`, `atf`, `codecheck` — `flows` and `codecheck` are read-only and candidates for the `core` profile; `atf` never enters the default.

**Estimate:** ~2–3 days (FT-2 ≈ ½ day; FT-1/FT-3 ≈ ½–1 day; FT-5/FT-6 ≈ 1 day; FT-4 ≈ ½ day).

---

## Optional (no phase, on user request)

- [ ] **Integration suite against a live PDI** — e2e tests behind an env gate (`SN_E2E=1` + real credentials), run manually/nightly, not in CI by default. (From the 2026-06-11 architecture review.)
- [ ] **Export API (CSV/XLSX)** — downloading table data through Table API content negotiation. (The remaining candidate from the old roadmap; Identify&Reconcile and Batch are covered.)

## Summary roadmap (Phases 6–8)

```
Phase 6 (harness 2.0, ~4 days) — DONE except optional X-8
  └─ the M-3/M-4 manifest is the critical path
       ├─ Phase 7 (multi-instance, ~2 days) ← requires the manifest
       │    ├─ MI-1…MI-5 core — DONE
       │    └─ MI-6/MI-7 snapshot+compare ← uses the Phase 5 docs convention
       └─ Phase 8 (flow testing + code, ~2–3 days) ← independent of Phase 7;
            FT-2/FT-5 can start immediately
```

Total Phases 6–8: **~8–9 working days**. The unfinished pieces of the old phases (Email X-7, Prompts X-3, the Phase 5 docs package) were folded into the Phase 6 order / referenced from Phases 7–8.
