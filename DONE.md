# servicenow-mcp — Done

Completed and verified work, moved out of the reviews and the plan. Active, not-yet-done tasks live in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) and [TODO.md](TODO.md); the work chronology is in [WORKLOG.md](WORKLOG.md).

State: clean build · clean ESLint (type-checked) · `node:test` suite green — 173 tests, coverage 93.1% lines / 80.1% branches / 69.0% functions · `npm audit --omit=dev` 0 · GitHub Actions CI · git repository with a one-commit-per-task history · **the 2026-06-12 review is fully implemented (22/22)** · **Phase 6 complete** · **Phase 7 core done** · **two full-review passes (2026-06-13) clean** · **release-ready** (pending the owner push + `NPM_TOKEN`, R-2).

## Base functionality

- [x] 7 tools over the Table API: `query_table`, `get_record`, `create_record`, `update_record`, `delete_record`, `set_credentials`, `get_status`.
- [x] ServiceNow Table API client (`fetch` + Basic auth), stdio transport (logs to `stderr` only), `.env` configuration with runtime updates.

## Code review (2026-06-11)

- [x] Errors log only host + path, never the query string (`safeUrl`).
- [x] dotenv round-trip for `formatEnvValue` (single-quote strategy / refusal for unserialisable values) + covered by a test.
- [x] Error detail chain with `||` + `"(no detail)"` fallback (`extractErrorDetail` → `res.statusText` → `text`).
- [x] Validation of `data.result` (array/object) → a meaningful `ServiceNowError` instead of a `TypeError`.
- [x] `cause instanceof Error` in the fetch catch; `json: unknown` + type guards.
- [x] Version from `package.json` (`createRequire`) — a single source.
- [x] `SN_TIMEOUT_MS` and all `SN_*` documented in README + `.env.example`.
- [x] `shuttingDown` guard against repeated SIGINT/SIGTERM.
- [x] Atomic `.env` writes (temp file + `renameSync`).
- [x] `X-Total-Count` → `total` in query results (`{ count, total, records }`).
- [x] Unit tests (`node:test`): `formatEnvValue` round-trip, `_buildBaseUrl` SSRF/allow-list — `npm test`.
- [x] ESLint (flat config + typescript-eslint) + Prettier — `npm run lint` / `npm run format`.
- [x] Folder/package name mismatch (folder `sincronia-mpc`, package since renamed to `servicenow-mcp`) — documented.

## Architecture review (2026-06-11)

- [x] Rate limiting and retry: exponential backoff + `Retry-After` (429/502/503/504; mutations only on connect errors); `SN_MAX_RETRIES`.
- [x] Versioning — a single source from `package.json` (`createRequire`); no duplication.
- [x] **OAuth 2.0 + the `AuthProvider` interface** (`auth.ts`): Basic and OAuth (password / client*credentials / refresh_token) are interchangeable; the token is cached until expiry. `SN_AUTH`, `SN_OAUTH*\*`.
- [x] **Table allowlist/denylist + read-only mode** (`policy.ts`): `SN_TABLES_ALLOW`, `SN_TABLES_DENY`, `SN_READONLY` — enforced in the client layer (defense in depth).
- [x] **Tool annotations** on every tool: `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`.
- [x] **Structured error payload** from `fail()`: `{ error: { message, status, snDetail } }` instead of a flat string.
- [x] **MCP resources**: `servicenow://status`, `servicenow://tables`, `servicenow://schema/{table}`.
- [x] **Structured logging on stderr** with `SN_LOG_LEVEL` (`logging.ts`); no secrets and no raw queries in the logs.
- [x] **`index.ts` refactor**: a thin bootstrap + `registry.ts` + `tools/<group>.ts`; a shared HTTP client `http.ts`; separated `host.ts` / `settings.ts` / `errors.ts` / `result.ts`.
- [x] **Env file location**: env-first (`override:false`) + XDG (`~/.config/servicenow-mcp/.env`) + `SN_ENV_FILE`; atomic writes with directory creation.
- [x] **Test pyramid**: unit + mock-fetch tests (`http.test.js`, `auth.test.js`: error mapping, retry on 429, Basic/Bearer headers, policy, structured `fail`) + GitHub Actions CI (build + lint + test).

## Extended API coverage

- [x] **Aggregate (Stats) API** (`api/aggregate.ts` + `servicenow_aggregate`): count/avg/min/max/sum + group_by + having.
- [x] **Attachment API** (`api/attachment.ts` + 5 tools): list / get / upload (base64) / download (base64, size-guarded) / delete.
- [x] **Import Set API** (`api/importset.ts` + 2 tools): staging-row insert + reading the transform outcome.
- [x] **Metadata** (`api/meta.ts` + `servicenow_list_tables` / `servicenow_describe_table`): `sys_db_object` and `sys_dictionary`.

## Full-coverage plan (IMPLEMENTATION-PLAN.md)

- [x] **Tool packages** (`SN_TOOL_PACKAGES`): tools grouped by package with `core` (default) and `all` profiles; gating in `registry.ts` (`resolveEnabledPackages`), admin tools always on, unknown names ignored. `get_status` returns `enabledPackages`. Covered by tests.
- [x] **Batch API** (`api/batch.ts` + `servicenow_batch`): several REST sub-requests in one HTTP call; base64 encode/decode of bodies; policy enforced per sub-request (read-only + table allow/deny). Covered by mock-fetch tests.
- [x] **Capability detection for plugin APIs** (`api/plugin.ts`): `pluginCall` wraps plugin-scoped requests and, on 404, appends a clear hint that the API/plugin may not be active on the instance (instead of a misleading error).
- [x] **Service Catalog API** (`api/catalog.ts`, package `catalog`): `servicenow_list_catalogs`, `servicenow_list_catalog_categories`, `servicenow_list_catalog_items`, `servicenow_get_catalog_item`, `servicenow_order_catalog_item` (write — respects read-only). Covered by mock-fetch tests.
- [x] **Change Management API** (`api/change.ts`, package `change`): `servicenow_list_changes`, `servicenow_get_change`, `servicenow_create_change` (normal/standard/emergency; standard requires `template_id`), `servicenow_update_change`, `servicenow_change_conflicts` (read or recalculate). Covered by mock-fetch tests.
- [x] **Knowledge API** (`api/knowledge.ts`, package `knowledge`): `servicenow_search_knowledge`, `servicenow_get_knowledge_article`, `servicenow_knowledge_highlights` (featured/most_viewed). Covered by mock-fetch tests.
- [x] **CMDB Instance/Meta API** (`api/cmdb.ts`, package `cmdb`): `servicenow_list_cis`, `servicenow_get_ci`, `servicenow_create_ci`, `servicenow_update_ci` (through IRE), `servicenow_get_cmdb_meta`; the class goes through table allow/deny. Covered by mock-fetch tests.
- [x] **Script intelligence** (`api/scripts.ts`, package `scripts`, read-only): `servicenow_list_scripts` (by type: business_rule/script_include/client_script/ui_policy/ui_action/scheduled_job/transform/rest_operation/acl — metadata without code), `servicenow_get_script` (full source + context), `servicenow_search_code` (searches source, returns a per-line snippet), `servicenow_table_logic` (a table's full automation: BRs by when+order, client scripts, UI policies, UI actions, ACLs). Covered by mock-fetch tests.
- [x] **Self-documentation** (`api/docs.ts` + `api/diagrams.ts`, package `docs`): `servicenow_docs_list/read/search/write` — a local MD store (SN_DOCS_DIR, default `docs/instance`), path-traversal protection, `.md` only, `index.md` regenerated on write; `servicenow_generate_er_diagram` (Mermaid `erDiagram` from `sys_dictionary` references) and `servicenow_generate_table_flow` (Mermaid `flowchart` from business rules by phase). Covered by file + mock-fetch tests.
- [x] **MCP Prompts** (`prompts.ts`, always on): `servicenow_incident_triage`, `servicenow_change_impact_analysis`, `servicenow_document_table` — orchestrate the existing tools and insist all values are read from the instance.
- [x] **MCP resource `servicenow://docs/{path}`** (`resources.ts`): reads an MD file from the local docs store as text/markdown.

## Additional improvements (outside the reviews)

- [x] SSRF guard: `resolveHost` blocks internal/loopback hosts + the `SN_ALLOWED_HOSTS` allow-list.
- [x] `fetchAll` pagination + the `SN_MAX_RECORDS` cap.
- [x] Result size guard `SN_MAX_RESULT_CHARS` (truncates oversized results).

## Deep review 2026-06-12 — implemented findings (one commit per task)

Full finding descriptions live in WORKLOG.md (detailed) and the git history; this is the summary.

### Senior dev (S)

- [x] **S-1 (critical) + S-2** · `describe_table` walks the inheritance chain (`sys_db_object.super_class`, dot-walk, cycle guard) — `incident` now shows the fields from `task` too; child overrides win; new `sourceTable` column; `listTables` returns the parent's real name. _(commit 9d8da51)_
- [x] **S-3** · strict base64 validation on upload — `Buffer.from` never throws; invalid input is now an error with no HTTP call. _(385fd57)_
- [x] **S-4** · download checks `size_bytes` from the metadata before pulling the bytes (no 1 GB in memory "just to check"). _(385fd57)_
- [x] **S-5** · `servicenow_aggregate` requires at least one aggregation — fails fast offline. _(5c31ec7)_
- [x] **S-6** · batch table policy also covers `/stats`, `/import`, `/cmdb/instance` sub-requests. _(6ad6821)_
- [x] **S-7** · `invalidateTokens()` — the OAuth cache is cleared on credential changes (the key contains no password). _(946ea2d)_
- [x] **S-8** · `search_code` logs the text length, not the text itself. _(70a961d)_

### Architect (A)

- [x] **A-1** · per-package policy: `SN_PACKAGES_DENY` (drops a whole package, incl. plugin APIs the table policy cannot see) + `SN_PACKAGES_READONLY` (registers only read tools); `effectivePackages()` — one source for registry and status; README warns that table deny ≠ plugin deny. _(90668d3)_
- [x] **A-2** · ConfigStore: credentials are an atomic in-memory snapshot in `config.ts` — env is only the initial source; `saveCredentials` swaps the snapshot in one assignment (a torn read is structurally impossible); `reloadCredentialsFromEnv()` for startup/tests. The anchor for the MI-1 profiles. _(290a346)_
- [x] **A-3** · capability cache in `pluginCall`: a namespace 404 ("does not represent any resource") is cached for 5 minutes with instant refusal; record 404s are not cached; availability is `pluginApis` in status. _(3cd86cb)_
- [x] **A-4** · `api/shared.ts: expectResult/expectResultArray` — the 7 copies of the result check became one. _(da3f056)_
- [x] **A-5** · one `buildStatusPayload()` for the tool and the resource — drift is impossible. _(4028969)_
- [x] **A-6** · `noUncheckedIndexedAccess` in tsconfig; 6 files fixed with real guards. _(021cfa4)_
- [x] **A-7** · type-checked ESLint + `no-floating-promises`; `no-base-to-string` caught a real trap → new `snString()` (an object at `display_value=all` no longer becomes `"[object Object]"`). _(42e1d5f)_
- [x] **A-8** · the README tools table is generated: `describeAllTools()` → `scripts/readme-tools.mjs` (`npm run docs:readme`) → a section between GENERATED markers; `test/readme-sync.test.js` fails on drift. Only the env table remains manual. _(5bd5489)_

### QA (Q)

- [x] **Q-1 + Q-4** · in-memory MCP smoke tests: a real SDK `Client`+`McpServer` over `InMemoryTransport` — a contract snapshot of the core profile, zod → mapping → ok()/fail() envelopes, package gating, the status resource. _(f13f316)_
- [x] **Q-2** · shared `test/helpers.js` (baselineEnv/withEnv/withFetch/jsonResponse); the 6 older files migrated, ~150 duplicated lines removed. _(edcd07b)_
- [x] **Q-3** · 17 tests for the uncovered: fetchAll pagination + the SN*MAX_RECORDS cap, okQueryResult truncation, the retry matrix (GET/POST, Retry-After as a date), pluginCall, settings parsers. *(b6469f1)\_
- [x] **Q-5** · env override tests (settings) + SN*LOG_LEVEL filter tests. *(b6469f1, be291e6)\_
- [x] **Q-6** · test discipline institutionalised: rule 7 in the plan + three automatic guards — the README sync test, the core contract snapshot and the full suite. An undisciplined change breaks at least one of them.

### Alongside the review

- [x] **П-1** · `git init` + baseline; one task = one commit. _(2424fcf)_
- [x] Auto-approval of the recurring dev commands in `.claude/settings.json` (build/lint/test/commit; no push, no broad wildcards).
- [x] **CHANGELOG.md** created (Keep a Changelog) — closes the old optional "changelog at publish time" item.
- [x] The old optional items from the 2026-06-11 architecture review moved into the plan: trust boundary → Х-2 (elicitation), MCP logging capability → Х-4, PDI integration suite + Export API → the "Optional" section; the roadmap item is exhausted (Batch/Catalog/Knowledge/CMDB/IRE covered, Email was Х-7).

## Phase 6 (Harness 2.0) — completed tasks

### Prerequisites and audit

- [x] **П-1 · git init** + baseline; one-commit-per-task history. _(2424fcf)_
- [x] **П-2 · Node 20+ guard on three levels**: a CJS launcher (`bin/servicenow-mcp.cjs`) with a guard before the ESM graph is parsed, a second guard in index.ts, `engines >=20` + `.npmrc engine-strict`. Verified under a real Node 12. _(2a84eb3)_
- [x] **Х-1 · SDK upgrade 1.12 → 1.29** — found already done during the 2026-06-12 audit; InMemoryTransport is used by the smoke tests.
- [x] **Х-3 · Prompts module** — `prompts.ts` with the three templates (triage / change impact / document table), delivered with Phases 4/5.

### Correctness (the К series, complete)

- [x] **К-1 · OAuth 401 → invalidation + a single retry** with a fresh token; a second 401 is a real error. _(b48a4f1)_
- [x] **К-2 · Authorization per attempt** — a token cannot expire between backoff tries. _(b48a4f1)_
- [x] **К-3 · Stable fetchAll pagination** — automatic `ORDERBYsys_id` when the query has no ordering. _(61cbd26)_
- [x] **К-4 · Batch restricted to `/api/` paths** — `/oauth_token.do`, `/login.do` etc. unreachable. _(b10a50c)_
- [x] **К-5 · `^` rejected in search/list filters** (the encoded-query separator has no escape). _(ff3e826)_
- [x] **К-6 · `set_credentials` validates the host (resolveHost) before saving** — nothing is persisted for an invalid one. _(d0e2822)_
- [x] **К-7 · Resources follow the package policy** (schema/docs packages; status always). _(07006b5)_
- [x] **К-8 · CI Node matrix 20/22/24 + c8 coverage**; `npm test` without a duplicated build (`test:full` locally). _(5002c2d)_

### Modularity and new capabilities

- [x] **М-5 · Generated README tools table** — `describeAllTools()` + `scripts/readme-tools.mjs` + a sync test (see A-8); remainder: the env table.
- [x] **М-6 · Manifest snapshot** — `{name, package, title, annotations}` for all tools against a checked-in fixture (`npm run gen:manifest`). _(ae7d123)_
- [x] **Х-6 · `servicenow_test_connection`** — reads 1 sys*user record, returns `{ok, status, latencyMs, user}`; 401/403/timeout come back structured, not as exceptions. *(373688b)\_

### Optimisations (the О series, complete)

- [x] **О-1 · `sysparm_exclude_reference_link=true` by default** (opt-out `SN_INCLUDE_REF_LINKS`) — −20–40% tokens on reference-heavy responses. _(05b0341)_
- [x] **О-2 · Compact JSON output** (opt-in `SN_RESULT_PRETTY`) — pretty roughly doubled the tokens. _(05b0341)_
- [x] **О-3 · Schema cache with TTL** (`SN_SCHEMA_CACHE_TTL_SEC`, default 300 s; instance in the key) for list*tables/describe_table/get_cmdb_meta. *(103ab7f)\_
- [x] **О-4 · Semaphore `SN_MAX_CONCURRENT`** (default 4) around fetch. _(84ccbb5)_
- [x] **О-5 · Telemetry** `{requests, retries, errors, totalMs}` in get*status and servicenow://status. *(84ccbb5)\_

### Modularity (the М series, complete) — the afternoon sprint

- [x] **М-1 · Directories `core/` / `api/` / `mcp/` / `tools/`** — a layered structure with one-way dependencies; a clean git mv + 56 rewritten import paths; zero behaviour change. _(5e6cd04)_
- [x] **М-2 · ESLint layer boundaries** (no-restricted-imports zones: core⇍api/mcp/tools; api⇍mcp/tools; tools⇍core/http) + `api/diagnostics.ts` (test*connection logic moved out of tools). A deliberate bad import fails lint — verified. *(ab6c252)\_
- [x] **М-3+М-4 · Declarative tool manifest** — `mcp/define.ts` (ToolSpec + defineTool + runSpec, absorbing tools/util), the 13 tools files rewritten as `specs: AnyToolSpec[]`, `ALL_TOOLS` in the registry (a package = one spread), readonly packages = a filter on annotations (the Proxy facade deleted), describeAllTools reads the manifest directly. The contract stayed byte-identical (the snapshot tests passed without regeneration). _(71b6058)_

### New capabilities (the Х series) — the afternoon sprint

- [x] **Х-7 · Email package** — api/email.ts + tools/email.ts (send/get, pluginCall, write policy); plugging in = 1 import + 1 spread. _(5f95db9)_
- [x] **Х-2 · Elicitation for set_credentials** — a client with the elicitation capability confirms the change (decline → nothing saved); without the capability → the old behaviour. _(f15bb5d)_
- [x] **Х-4 · MCP logging capability** — `setLogSink` in core/logging + a `sendLoggingMessage` mirror after connect; a throwing sink is swallowed. _(f15bb5d)_
- [x] **Х-5 · outputSchema + structuredContent** — `ToolSpec.output` / `okStructured()`; applied to get*status and test_connection. Deviation from the plan: query_table/get_record/aggregate deliberately excluded — duplicating structuredContent contradicts О-2. *(f15bb5d)\_

## Phase 7 (Multi-instance) — core done

- [x] **MI-1 · Named profiles** — `SN_PROFILE_<NAME>_INSTANCE/_USER/_PASSWORD`; the bare keys = `default` (full backwards compatibility); store = Map<profile, snapshot> with the same atomicity; `useProfile()` switches + persists SN*ACTIVE_PROFILE. *(07170cf)\_
- [x] **MI-2 · Per-profile policy** — `SN_PROFILE_<NAME>_READONLY/_TABLES_ALLOW/_TABLES_DENY` with a global fallback: "prod read-only, dev full rights" in one server. _(84f283f)_
- [x] **MI-3 · AsyncLocalStorage context** — every tool has an optional `instance` argument (except on a name collision); the whole stack resolves the profile at call time, zero threading through api/ signatures; an unknown profile → a clear refusal with no network. _(15785db)_
- [x] **MI-4 · Admin tools** — `servicenow_list_instances` (no passwords), `servicenow_use_instance` (switch + clearing of the identity caches), `set_credentials` with an optional `profile`; status shows activeProfile + profiles. 51 tools. _(84f283f)_
- [x] **MI-5 · Per-host cache and telemetry** — delivered earlier (per-host semaphore/counters from S2-2, schema cache keys with the instance from О-3). _(13a2810, 103ab7f)_
- [x] **MI-6 · `servicenow_snapshot_instance`** — new `instance` package: tables.md+json, schema/<table>.md for the passed tables, plugins (v*plugin → sys_plugins fallback), apps, automation stats per script type, index.md — all into `SN_DOCS_DIR/<profile>/`; a failing section is a warning, not a failure; traversal guard extended with a .json whitelist for the internal writer. *(7037303)\_
- [x] **MI-7 · `servicenow_compare_instances`** — table presence, column property drift, scripts by SHA-256 (only*in_a/only_in_b/different_source), plugin/app inventory; one dictionary pull and one pull per script type per side (no N+1); `from_snapshot` honours the stored MI-6 JSON with a live fallback + warning; MD report in `_compare/`. *(landed inside 82aad61)\_
- [x] **MI-8 · Per-profile resources** — `servicenow://instances` + `servicenow://{profile}/schema/{table}` on the `instance` package; shared `profilesPayload()` keeps the tool and the resource identical; К-7 resource contract updated. 53 tools, 146 tests. _(fb85be0)_

**Phase 7 is complete** (MI-1…MI-8, 2026-06-12).

**Remaining in Phase 6:** only **Х-8** (HTTP transport) — explicitly optional ("only when remote access is needed"). **Phase 6 is complete.**

## Full review & release readiness (2026-06-13)

Two `/full-review` passes (architect → dev → qa), the `servicenow-mcp-ai` rename and the release process. Each persona fanned out finders and adversarially verified every finding before recording it (refuted false positives kept out). End state: `npm run check` green, 173 tests, coverage 93.1% lines / 80.1% branches / 69.0% functions, `npm audit --omit=dev` 0. Detailed descriptions in WORKLOG.md and the git history; this is the summary.

### Full review pass 1 (architect → dev → qa)

- [x] **ARCH-1 · Plugin availability cache now instance-keyed** (`src/api/plugin.ts`). The namespace-404 availability cache was keyed by API label alone; under concurrent multi-profile use (AsyncLocalStorage) a 404 cached for profile A's instance could fast-fail profile B's for up to the 5-min TTL. Keyed by `${instance}|${apiLabel}`; regression test in `test/plugin.test.js`.
- [x] **DEV-1 · Caret-injection guard in `listTables` filter** (`src/api/meta.ts`) — K-5's `assertNoCaret` class fix had only landed in `scripts.ts`; `meta.ts` was missed. Test in `test/meta.test.js`.
- [x] **DEV-2 · Caret-injection guard in `listAttachments`** (`src/api/attachment.ts`) — `assertNoCaret` on `table`/`sysId`. Test in `test/attachment.test.js`.
- [x] **DEV-1/2 follow-up · guard de-duplicated** — `assertNoCaret` moved from a private copy in `scripts.ts` to `api/shared.ts` and reused in all three modules, so a future query builder cannot silently skip it.
- [x] **DEV-3 · TOCTOU on `index.md` regeneration fixed** (`src/api/docs.ts`) — `regenerateIndex()` serialized through a tail promise (survives a failed rebuild); test (12 concurrent writes all appear) in `test/docs.test.js`. Latent under stdio, real once HTTP/pipelined clients arrive.
- [x] **QA wave · 16 actionable findings fixed (QA-1…QA-16; QA-17 already covered).** Coverage rose to 93.1/80.1/69.0 across 172 tests. Added/cleared tests for per-host `invalidateToken` isolation, Basic-401 no-retry, `Retry-After` invalid-date fallback, the new `--functions 60` gate, `listAttachments`/Import-Set/aggregate/catalog happy-paths, and config-store/batch/snapshot/docs edge cases. 10 suggestions refuted (incl. tightening lines/branches — the headroom is intentional vs cross-Node flakiness).

### Full review pass 2 (the session delta vs origin/main)

- [x] **DEV-4 · Caret-injection guard in `tableLogic()`** (`src/api/scripts.ts`) — two encoded queries (`collection=…`, `nameLIKE…`) fired before the table-validated sub-requests rejected; `assertNoCaret(t, "table")` at the entry. Test in `test/scripts.test.js`. 172 → 173 tests.
- [x] **ARCH-2 · dissolved on verification** — the XDG dir rename (`~/.config/servicenow-mcp` → `…-ai`) was flagged as an undocumented breaking change; investigation showed the package was never published and no old XDG config exists on disk, so no migration fallback or "Breaking Changes" note was needed.
- Architect (rename coherence, plugin-cache lifecycle, docs serialization, release pipeline) and QA (new-test integrity, the `--functions 60` gate, `publish.yml` honesty) otherwise found nothing actionable.

### Evening triple analysis — completed backlog

- [x] **S2-1 · strict zod schemas** (reject unknown args; a `tabel` typo is now a validation error) — `e879321`.
- [x] **S2-2 · per-host semaphore + telemetry** (was global) — `13a2810`.
- [x] **S2-3 · `bin` launcher Node-12 CI test** (node:12-alpine container) — `ac14952`.
- [x] **S2-4 · release process** — `.github/workflows/publish.yml` + `release:dry` + CONTRIBUTING "Releasing": tag-driven publish with `--provenance`, a tag↔version guard and the `npm run check` gate. _Needs an `NPM_TOKEN` repo secret before the first real publish (→ R-2)._
- [x] **A2-1 · `PackageSpec = {name, tools, resources?, prompts?}`** — resources and prompts gating made fully declarative — `5daad20`.
- [x] **Q2-1 · coverage gates** (lines 85 / branches 72) — `b8b9216`.
- [x] **Q2-2 · property-based tests** (fast-check: 500 env round-trips + 200 base64 buffers) — `b8b9216`.
- [x] **Q2-3 · Windows in the CI matrix** — `ac14952`.
- [x] **Q2-4 · perf regression for `okQueryResult`** (10k records < 2 s) — `9ef092b`.
- [x] **Q2-5 · elicitation accept-path test** (decline was already covered) — `9ef092b`.

### Release readiness — completed

- [x] **R-1 · LICENSE** — MIT (file + `"license": "MIT"`) — `fc1f62c`.
- [x] **R-3 · release process / CHANGELOG** cut to `[1.0.0] - 2026-06-12` + annotated tag `v1.0.0` (= S2-4).
- [x] **R-4 · package.json metadata** — `license`/`author`/`prepublishOnly` (`fc1f62c`), `repository`/`bugs`/`homepage` (`ac11df9`).
- [x] **R-5 · WIP formatted & committed** — `e879321`.
- [x] **R-6 · doc drift on the tool count** reconciled — 49 tools / 14 packages everywhere (sourced from the manifest fixture) — `08b71cc`.
- [x] **R-7 · coverage gate in CI** (= Q2-1) — `b8b9216`.
- [x] **R-8 · Windows in CI + the Node-12 launcher test** (= Q2-3, S2-3) — `ac14952`; the Windows job stays `continue-on-error` until the first green run (→ R-2).
- [x] **R-9 · SECURITY.md + CONTRIBUTING.md** added (repo-standard pass). _If the release goes public, revisit the two won't-fix decisions in TODO.md — for third-party users the conservative defaults should win (for personal use they remain OK)._
- [x] **R-10 · npm name resolved → `servicenow-mcp-ai`** (the free unscoped name; `servicenow-mcp` is held by an unrelated maintainer). Renamed coherently across `package.json` name/bin, the launcher, the MCP handshake name, the XDG config dir, `.vscode/mcp.json`, the CI launcher path and the README; the GitHub repo URLs stay `LeassTaTT/servicenow-mcp`.
