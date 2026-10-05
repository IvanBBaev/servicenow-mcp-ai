# servicenow-mcp — Done

Completed and verified work, moved out of the reviews and the plan. Active, not-yet-done tasks live in [IMPLEMENTATION-PLAN.md](archive/IMPLEMENTATION-PLAN.md) and [TODO.md](TODO.md); the work chronology is in [WORKLOG.md](../WORKLOG.md).

State (2026-07-06): this file is the **historical completion log** — chronological, with commit refs; the current product state lives in [PRODUCT-STATE.md](archive/PRODUCT-STATE.md). Snapshot: clean build · clean ESLint (type-checked) · 406/406 tests (coverage 95.41/84.94/98.58) · `npm audit --omit=dev` 0 · **v2.0.1 published** on npm + MCP Registry + VS Code Marketplace. **2026-09-03 → 23:** v3.0 execution started — H-1, H-2, E-9, H-10, S-1, H-8 and H-9 done (last sections; local gate green at 519/519, uncommitted); the SDK parity epic (P-1…P-29) is planned in [SDK-PARITY.md](SDK-PARITY.md); the tracker is [ROADMAP-V3.md](ROADMAP-V3.md). Per-section numbers below (test counts, coverage) are point-in-time values from when each section was written.

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

- [x] **S-1 (critical) + S-2** · `describe_table` walks the inheritance chain (`sys_db_object.super_class`, dot-walk, cycle guard) — `incident` now shows the fields from `task` too; child overrides win; new `sourceTable` column; `listTables` returns the parent's real name. _(commit d60ea51)_
- [x] **S-3** · strict base64 validation on upload — `Buffer.from` never throws; invalid input is now an error with no HTTP call. _(7c39681)_
- [x] **S-4** · download checks `size_bytes` from the metadata before pulling the bytes (no 1 GB in memory "just to check"). _(7c39681)_
- [x] **S-5** · `servicenow_aggregate` requires at least one aggregation — fails fast offline. _(7b1e46e)_
- [x] **S-6** · batch table policy also covers `/stats`, `/import`, `/cmdb/instance` sub-requests. _(4a894d1)_
- [x] **S-7** · `invalidateTokens()` — the OAuth cache is cleared on credential changes (the key contains no password). _(ed7198e)_
- [x] **S-8** · `search_code` logs the text length, not the text itself. _(f9cc73e)_

### Architect (A)

- [x] **A-1** · per-package policy: `SN_PACKAGES_DENY` (drops a whole package, incl. plugin APIs the table policy cannot see) + `SN_PACKAGES_READONLY` (registers only read tools); `effectivePackages()` — one source for registry and status; README warns that table deny ≠ plugin deny. _(f9df1df)_
- [x] **A-2** · ConfigStore: credentials are an atomic in-memory snapshot in `config.ts` — env is only the initial source; `saveCredentials` swaps the snapshot in one assignment (a torn read is structurally impossible); `reloadCredentialsFromEnv()` for startup/tests. The anchor for the MI-1 profiles. _(7c97cc3)_
- [x] **A-3** · capability cache in `pluginCall`: a namespace 404 ("does not represent any resource") is cached for 5 minutes with instant refusal; record 404s are not cached; availability is `pluginApis` in status. _(8a3ab0d)_
- [x] **A-4** · `api/shared.ts: expectResult/expectResultArray` — the 7 copies of the result check became one. _(efd0893)_
- [x] **A-5** · one `buildStatusPayload()` for the tool and the resource — drift is impossible. _(39c2f52)_
- [x] **A-6** · `noUncheckedIndexedAccess` in tsconfig; 6 files fixed with real guards. _(8b3155e)_
- [x] **A-7** · type-checked ESLint + `no-floating-promises`; `no-base-to-string` caught a real trap → new `snString()` (an object at `display_value=all` no longer becomes `"[object Object]"`). _(94aa6cf)_
- [x] **A-8** · the README tools table is generated: `describeAllTools()` → `scripts/readme-tools.mjs` (`npm run docs:readme`) → a section between GENERATED markers; `test/readme-sync.test.js` fails on drift. Only the env table remains manual. _(044cc31)_

### QA (Q)

- [x] **Q-1 + Q-4** · in-memory MCP smoke tests: a real SDK `Client`+`McpServer` over `InMemoryTransport` — a contract snapshot of the core profile, zod → mapping → ok()/fail() envelopes, package gating, the status resource. _(d66fe60)_
- [x] **Q-2** · shared `test/helpers.js` (baselineEnv/withEnv/withFetch/jsonResponse); the 6 older files migrated, ~150 duplicated lines removed. _(fab1a08)_
- [x] **Q-3** · 17 tests for the uncovered: fetchAll pagination + the SN*MAX_RECORDS cap, okQueryResult truncation, the retry matrix (GET/POST, Retry-After as a date), pluginCall, settings parsers. *(bc0be0b)\_
- [x] **Q-5** · env override tests (settings) + SN*LOG_LEVEL filter tests. *(bc0be0b, e473089)\_
- [x] **Q-6** · test discipline institutionalised: rule 7 in the plan + three automatic guards — the README sync test, the core contract snapshot and the full suite. An undisciplined change breaks at least one of them.

### Alongside the review

- [x] **P-1** · `git init` + baseline; one task = one commit. _(035a77f)_
- [x] Auto-approval of the recurring dev commands in `.claude/settings.json` (build/lint/test/commit; no push, no broad wildcards).
- [x] **CHANGELOG.md** created (Keep a Changelog) — closes the old optional "changelog at publish time" item.
- [x] The old optional items from the 2026-06-11 architecture review moved into the plan: trust boundary → X-2 (elicitation), MCP logging capability → X-4, PDI integration suite + Export API → the "Optional" section; the roadmap item is exhausted (Batch/Catalog/Knowledge/CMDB/IRE covered, Email was X-7).

## Phase 6 (Harness 2.0) — completed tasks

### Prerequisites and audit

- [x] **P-1 · git init** + baseline; one-commit-per-task history. _(035a77f)_
- [x] **P-2 · Node 20+ guard on three levels**: a CJS launcher (`bin/servicenow-mcp.cjs`) with a guard before the ESM graph is parsed, a second guard in index.ts, `engines >=20` + `.npmrc engine-strict`. Verified under a real Node 12. _(a31ee78)_
- [x] **X-1 · SDK upgrade 1.12 → 1.29** — found already done during the 2026-06-12 audit; InMemoryTransport is used by the smoke tests.
- [x] **X-3 · Prompts module** — `prompts.ts` with the three templates (triage / change impact / document table), delivered with Phases 4/5.

### Correctness (the K series, complete)

- [x] **K-1 · OAuth 401 → invalidation + a single retry** with a fresh token; a second 401 is a real error. _(369f5cf)_
- [x] **K-2 · Authorization per attempt** — a token cannot expire between backoff tries. _(369f5cf)_
- [x] **K-3 · Stable fetchAll pagination** — automatic `ORDERBYsys_id` when the query has no ordering. _(739c20f)_
- [x] **K-4 · Batch restricted to `/api/` paths** — `/oauth_token.do`, `/login.do` etc. unreachable. _(9c7f02b)_
- [x] **K-5 · `^` rejected in search/list filters** (the encoded-query separator has no escape). _(1585efb)_
- [x] **K-6 · `set_credentials` validates the host (resolveHost) before saving** — nothing is persisted for an invalid one. _(d2a354d)_
- [x] **K-7 · Resources follow the package policy** (schema/docs packages; status always). _(849ff92)_
- [x] **K-8 · CI Node matrix 20/22/24 + c8 coverage**; `npm test` without a duplicated build (`test:full` locally). _(7d57b66)_

### Modularity and new capabilities

- [x] **M-5 · Generated README tools table** — `describeAllTools()` + `scripts/readme-tools.mjs` + a sync test (see A-8); remainder: the env table.
- [x] **M-6 · Manifest snapshot** — `{name, package, title, annotations}` for all tools against a checked-in fixture (`npm run gen:manifest`). _(1d8e141)_
- [x] **X-6 · `servicenow_test_connection`** — reads 1 sys*user record, returns `{ok, status, latencyMs, user}`; 401/403/timeout come back structured, not as exceptions. *(3ed5351)\_

### Optimisations (the O series, complete)

- [x] **O-1 · `sysparm_exclude_reference_link=true` by default** (opt-out `SN_INCLUDE_REF_LINKS`) — −20–40% tokens on reference-heavy responses. _(e57fa9c)_
- [x] **O-2 · Compact JSON output** (opt-in `SN_RESULT_PRETTY`) — pretty roughly doubled the tokens. _(e57fa9c)_
- [x] **O-3 · Schema cache with TTL** (`SN_SCHEMA_CACHE_TTL_SEC`, default 300 s; instance in the key) for list*tables/describe_table/get_cmdb_meta. *(29b37ec)\_
- [x] **O-4 · Semaphore `SN_MAX_CONCURRENT`** (default 4) around fetch. _(12d2e97)_
- [x] **O-5 · Telemetry** `{requests, retries, errors, totalMs}` in get*status and servicenow://status. *(12d2e97)\_

### Modularity (the M series, complete) — the afternoon sprint

- [x] **M-1 · Directories `core/` / `api/` / `mcp/` / `tools/`** — a layered structure with one-way dependencies; a clean git mv + 56 rewritten import paths; zero behaviour change. _(08d16ce)_
- [x] **M-2 · ESLint layer boundaries** (no-restricted-imports zones: core⇍api/mcp/tools; api⇍mcp/tools; tools⇍core/http) + `api/diagnostics.ts` (test*connection logic moved out of tools). A deliberate bad import fails lint — verified. *(a53e2cc)\_
- [x] **M-3+M-4 · Declarative tool manifest** — `mcp/define.ts` (ToolSpec + defineTool + runSpec, absorbing tools/util), the 13 tools files rewritten as `specs: AnyToolSpec[]`, `ALL_TOOLS` in the registry (a package = one spread), readonly packages = a filter on annotations (the Proxy facade deleted), describeAllTools reads the manifest directly. The contract stayed byte-identical (the snapshot tests passed without regeneration). _(cc1b83e)_

### New capabilities (the X series) — the afternoon sprint

- [x] **X-7 · Email package** — api/email.ts + tools/email.ts (send/get, pluginCall, write policy); plugging in = 1 import + 1 spread. _(45ea8bb)_
- [x] **X-2 · Elicitation for set_credentials** — a client with the elicitation capability confirms the change (decline → nothing saved); without the capability → the old behaviour. _(8dda598)_
- [x] **X-4 · MCP logging capability** — `setLogSink` in core/logging + a `sendLoggingMessage` mirror after connect; a throwing sink is swallowed. _(8dda598)_
- [x] **X-5 · outputSchema + structuredContent** — `ToolSpec.output` / `okStructured()`; applied to get*status and test_connection. Deviation from the plan: query_table/get_record/aggregate deliberately excluded — duplicating structuredContent contradicts O-2. *(8dda598)\_

## Phase 7 (Multi-instance) — core done

- [x] **MI-1 · Named profiles** — `SN_PROFILE_<NAME>_INSTANCE/_USER/_PASSWORD`; the bare keys = `default` (full backwards compatibility); store = Map<profile, snapshot> with the same atomicity; `useProfile()` switches + persists SN*ACTIVE_PROFILE. *(bf6712d)\_
- [x] **MI-2 · Per-profile policy** — `SN_PROFILE_<NAME>_READONLY/_TABLES_ALLOW/_TABLES_DENY` with a global fallback: "prod read-only, dev full rights" in one server. _(4a129de)_
- [x] **MI-3 · AsyncLocalStorage context** — every tool has an optional `instance` argument (except on a name collision); the whole stack resolves the profile at call time, zero threading through api/ signatures; an unknown profile → a clear refusal with no network. _(3bf1e12)_
- [x] **MI-4 · Admin tools** — `servicenow_list_instances` (no passwords), `servicenow_use_instance` (switch + clearing of the identity caches), `set_credentials` with an optional `profile`; status shows activeProfile + profiles. 51 tools. _(4a129de)_
- [x] **MI-5 · Per-host cache and telemetry** — delivered earlier (per-host semaphore/counters from S2-2, schema cache keys with the instance from O-3). _(aaab456, 29b37ec)_
- [x] **MI-6 · `servicenow_snapshot_instance`** — new `instance` package: tables.md+json, schema/<table>.md for the passed tables, plugins (v*plugin → sys_plugins fallback), apps, automation stats per script type, index.md — all into `SN_DOCS_DIR/<profile>/`; a failing section is a warning, not a failure; traversal guard extended with a .json whitelist for the internal writer. *(17f0fc6)\_
- [x] **MI-7 · `servicenow_compare_instances`** — table presence, column property drift, scripts by SHA-256 (only*in_a/only_in_b/different_source), plugin/app inventory; one dictionary pull and one pull per script type per side (no N+1); `from_snapshot` honours the stored MI-6 JSON with a live fallback + warning; MD report in `_compare/`. *(landed inside e265588)\_
- [x] **MI-8 · Per-profile resources** — `servicenow://instances` + `servicenow://{profile}/schema/{table}` on the `instance` package; shared `profilesPayload()` keeps the tool and the resource identical; K-7 resource contract updated. 53 tools, 146 tests. _(fb85be0)_

**Phase 7 is complete** (MI-1…MI-8, 2026-06-12).

**Remaining in Phase 6:** only **X-8** (HTTP transport) — explicitly optional ("only when remote access is needed"). **Phase 6 is complete.**

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

- [x] **S2-1 · strict zod schemas** (reject unknown args; a `tabel` typo is now a validation error) — `0b0111d`.
- [x] **S2-2 · per-host semaphore + telemetry** (was global) — `aaab456`.
- [x] **S2-3 · `bin` launcher Node-12 CI test** (node:12-alpine container) — `478e444`.
- [x] **S2-4 · release process** — `.github/workflows/publish.yml` + `release:dry` + CONTRIBUTING "Releasing": tag-driven publish with `--provenance`, a tag↔version guard and the `npm run check` gate. _Needs an `NPM_TOKEN` repo secret before the first real publish (→ R-2)._
- [x] **A2-1 · `PackageSpec = {name, tools, resources?, prompts?}`** — resources and prompts gating made fully declarative — `6df0e57`.
- [x] **Q2-1 · coverage gates** (lines 85 / branches 72) — `03e1120`.
- [x] **Q2-2 · property-based tests** (fast-check: 500 env round-trips + 200 base64 buffers) — `03e1120`.
- [x] **Q2-3 · Windows in the CI matrix** — `478e444`.
- [x] **Q2-4 · perf regression for `okQueryResult`** (10k records < 2 s) — `1ace964`.
- [x] **Q2-5 · elicitation accept-path test** (decline was already covered) — `1ace964`.

### Release readiness — completed

- [x] **R-1 · LICENSE** — MIT (file + `"license": "MIT"`) — `3868a9c`.
- [x] **R-3 · release process / CHANGELOG** cut to `[1.0.0] - 2026-06-12` + annotated tag `v1.0.0` (= S2-4).
- [x] **R-4 · package.json metadata** — `license`/`author`/`prepublishOnly` (`3868a9c`), `repository`/`bugs`/`homepage` (`ac11df9`).
- [x] **R-5 · WIP formatted & committed** — `0b0111d`.
- [x] **R-6 · doc drift on the tool count** reconciled — 49 tools / 14 packages everywhere (sourced from the manifest fixture) — `c120469`.
- [x] **R-7 · coverage gate in CI** (= Q2-1) — `03e1120`.
- [x] **R-8 · Windows in CI + the Node-12 launcher test** (= Q2-3, S2-3) — `478e444`; the Windows job stays `continue-on-error` until the first green run (→ R-2).
- [x] **R-9 · SECURITY.md + CONTRIBUTING.md** added (repo-standard pass). _If the release goes public, revisit the two won't-fix decisions in TODO.md — for third-party users the conservative defaults should win (for personal use they remain OK)._
- [x] **R-10 · npm name resolved → `servicenow-mcp-ai`** (the free unscoped name; `servicenow-mcp` is held by an unrelated maintainer). Renamed coherently across `package.json` name/bin, the launcher, the MCP handshake name, the XDG config dir, `.vscode/mcp.json`, the CI launcher path and the README; the GitHub repo URLs stay `IvanBBaev/servicenow-mcp`.

## Full review (2026-06-16) — 1 cycle (architect → dev → qa)

Third `/full-review` pass over the whole tree on top of 1.0.0. One real correctness/honesty bug fixed, one comment-drift fixed, the fix locked with three tests. `npm run check` green: 176 tests, coverage 92.9% lines / 80.5% branches / 69.1% functions, `npm audit --omit=dev` 0. Two contract/policy items deliberately deferred to Ivan (ARCH-4 envelope-unwrap convention, ARCH-5 batch package-axis enforcement) — see TODO.md.

- [x] **ARCH-3 · `fetchAll` truncation made visible (snapshot/compare no longer over-claim completeness).** `queryTable({fetchAll})` silently stopped at the `SN_MAX_RECORDS` cap (default 10 000); `compareInstances` pulls the entire `sys_dictionary` (tens of thousands of rows on a real instance), so its column diff was computed over a truncated slice and reported as the full comparison. `QueryResult` now carries a `truncated` flag — set when the cap is hit while `X-Total-Count` shows more rows (a count exactly equal to the cap is NOT a truncation) — `queryTable` logs a `warn`, and `compareInstances`/`snapshotInstance` push a user-facing warning per capped section (dictionary, scripts, plugins, apps). Files: `src/api/table.ts`, `src/api/compare.ts`, `src/api/snapshot.ts`.
- [x] **DEV-5 · stale comment fixed in `servicenow_set_credentials`** (`src/tools/admin.ts`). The cache-clearing comment said plugin availability is "keyed by label, not host" — outdated since the prior review's ARCH-1 made it instance-keyed. Rewritten to state the real reason all three caches are cleared. No behaviour change.
- [x] **QA-18 · `truncated` contract pinned** — three unit tests in `test/fetchall.test.js` (capped read flags truncated; complete read does not; row count == cap is complete).
- [x] **QA-19 · consumer-side warning pinned** — `compareInstances` test in `test/compare.test.js` pages `sys_dictionary` over the cap and asserts the partial-diff warning reaches both the result and the Markdown report. 173 → 176 tests; branch coverage 80.16% → 80.47%.

### Follow-up (2026-06-17) — "fix everything": every remaining finding closed

The two architect-deferred items and the two former won't-fix security decisions, all implemented with tests. `npm run check` green: 176 → **182 tests**, coverage 93.0% lines / 81.0% branches / 69.4% functions, audit 0. No deferred review items remain.

- [x] **ARCH-4 · unified the `result`-envelope unwrap.** `aggregate`, `cmdb`, `catalog`, `change` and `knowledge` returned `data.result` raw while `table`/`attachment`/`meta`/`email` used the shared `expectResult`; a malformed body surfaced as `undefined` data in some tools and a clear error in others. All now route through `expectResult`/`expectResultArray` (`src/api/{aggregate,cmdb,catalog,change,knowledge}.ts`), so a missing `result` is a uniform `ServiceNowError` everywhere. Test in `test/aggregate.test.js`.
- [x] **ARCH-5 · the Batch API now enforces the package axis.** `runBatch` checked only the table + read-only axes, so with `SN_PACKAGES_DENY`/`SN_PACKAGES_READONLY` set a batch could still reach a denied plugin API (e.g. `POST /api/sn_chg_rest/change/normal`) or write to a read-only package. Added `assertPackageAllowed`/`assertPackageWriteAllowed` in `core/policy.ts` (reads `SN_PACKAGES_DENY`/`_READONLY`, keeps the api→core layering) and a path→package map in `src/api/batch.ts`; every sub-request is now classified and checked. Tests in `test/batch.test.js` (denied package blocked; read-only package blocks writes, allows reads).
- [x] **ARCH-5 hardening (adversarial review) · path-traversal bypass of the batch guards closed.** A 5-agent adversarial pass over the diff demonstrated (against the compiled build) that non-canonical sub-request paths — `/api/now//table/x`, `/api/now/x/../table/x`, `/api/now/./table/x` and the percent-encoded `/api/now/%2e%2e/table/x` — evaded the anchored `tableFromUrl`/`packageForUrl` matchers, so they bypassed **both** the new package axis and the pre-existing `SN_TABLES_*` guard (only the method-based `SN_READONLY` survived); ServiceNow's batch dispatcher normalizes and routes them to the real surface. Fixed: `runBatch` now rejects any sub-request whose path (raw **or** percent-decoded) contains a `//`, `/./` or `/../` segment, before policy matching — so the path policed is the path executed. Package matchers also tightened to `(?:\/|$)` boundaries. Tests in `test/batch.test.js` cover all literal + encoded bypass vectors (fetch never fires) and confirm a trailing slash stays canonical.
- [x] **SEC-7 · `.env` written owner-only (`0600`).** `config.ts` `updateEnvFile` wrote with the default `0644`; the file holds a plaintext password. Now writes the temp file with `mode: 0o600` and re-`chmod`s after the atomic rename (best-effort; a no-op on Windows). Test in `test/config-store.test.js` (skipped on Windows). Former won't-fix decision, flipped for the public release.
- [x] **SEC-8 · host must be `*.service-now.com` unless `SN_ALLOWED_HOSTS`.** `resolveHost` (`core/host.ts`) previously allowed any non-internal host with no allowlist; a redirected/mistyped host could silently receive Basic credentials. Now, with no `SN_ALLOWED_HOSTS`, only `*.service-now.com` hosts pass (bare names still get the suffix appended; the SSRF guard + X-2 elicitation still apply). Custom/sovereign-cloud domains opt in via `SN_ALLOWED_HOSTS`. Tests in `test/servicenow.test.js` (external + look-alike hosts rejected; allow-listed custom domain reachable). Former won't-fix decision, flipped for the public release. Docs synced: SECURITY.md, ARCHITECTURE.md, README.md, PRODUCT-STATE.md, .env.example.

## Full review (2026-06-18) — architect → dev → qa (3 cycles)

Fresh `/full-review 3` pass over the whole tree on top of the 2026-06-17 state. Gate run on Node 22 (`.nvmrc`) — note that on Node 25 the pinned `c8@11`/`yargs@17` crash the coverage step (`require is not defined in ES module scope`), see QA below. Findings recorded with the cycle that produced them.

### Cycle 1 — Architect (ARCH-6, ARCH-7)

- [x] **ARCH-6 · Markdown table rendering deduplicated; the snapshot/compare drift that corrupted reports is closed.** `api/snapshot.ts` rendered tables through a local `mdTable`/`mdEscape` that escaped the `|` column separator, while `api/compare.ts` built its column-diff and script-diff tables by hand **without** escaping — so a ServiceNow identifier containing `|` (e.g. a business-rule name `"Foo | Bar"`) broke or injected columns in the comparison report. Extracted `mdEscape`/`mdTable` into `src/api/shared.ts` (header + cells escaped) and routed both modules through it, so the two reports can no longer diverge. `npm run check` green (Node 22): 186 tests, coverage 93.06% lines / 81.49% branches / 69.69% functions, audit 0.
- [x] **ARCH-7 · per-profile auth honoured (the MI-1 convention was documented-as-done but unimplemented).** IMPLEMENTATION-PLAN MI-1 lists `SN_PROFILE_<NAME>_AUTH` / `_OAUTH_CLIENT_ID` / `_OAUTH_CLIENT_SECRET` / `_OAUTH_GRANT` / `_OAUTH_REFRESH_TOKEN` as part of the profile convention, but `core/auth.ts` read auth mode and the whole OAuth client config from the **global** `SN_*` keys only — so "prod is OAuth, dev is Basic" (or per-profile OAuth clients) silently fell back to the global config, contradicting the per-profile credentials (MI-1) and per-profile policy (MI-2). Added an `authEnv(suffix)` helper mirroring `core/policy.ts` `policyValue` (active profile's `SN_PROFILE_<NAME>_<SUFFIX>` first, then global `SN_<SUFFIX>`; empty override falls through) and routed `getAuthMode()`/`readOAuthConfig()` through it. Fully backwards-compatible (no per-profile key set → identical behaviour). Regression test in `test/auth.test.js` (a non-default profile uses its own OAuth client id + host).

### Cycle 1 — Dev (DEV-6, DEV-7)

- [x] **DEV-6 · caret-injection guard added to `describeTable()`** (`src/api/meta.ts`). `describeTable` embeds the table name raw into two encoded queries — `name=<t>` (in `getTableChain`) and `nameIN<chain>` (in `describeTableUncached`) — but had no `assertNoCaret`, unlike `listTables`, the script tools and `tableLogic`. A `^` in the table name (reachable via the `servicenow_describe_table` tool, the `servicenow://schema/{table}` resource and `generateErDiagram`) would inject extra encoded-query clauses and silently distort the dictionary lookup. Guarded at the public entry (one chokepoint covers all callers; `snapshot` was already safe via its `SAFE_NAME` check). Same caret-injection class as K-5 / DEV-1 / DEV-2 / DEV-4, in paths the earlier passes missed. Regression test in `test/meta.test.js` (caret name rejected, 0 fetch).
- [x] **DEV-7 · caret-injection guard added to `generateTableFlow()`** (`src/api/diagrams.ts`). It built `collection=<t>^active=true^…` from the raw table name and passed it to `listScripts` as a raw `query` (which intentionally is not caret-guarded), so a `^` injected clauses before the read. Guard with `assertNoCaret(t, "table")` at the entry, mirroring `tableLogic`. Regression test in `test/diagrams.test.js` (caret name rejected, 0 fetch).

### Cycle 1 — QA (QA-20, QA-21, QA-22)

> QA-20 was first recorded as deferred, then closed in the same session's "fix everything" follow-up (see its entry below).

- [x] **QA-21 · `change.ts` read/update paths pinned.** `phase3.test.js` covered `createChange`/`changeConflicts` but `listChanges`, `getChange` and `updateChange` had no test (change.ts was 67% lines / 40% functions). Added tests: `listChanges` sysparm passthrough (query/limit/offset/fields), `getChange` GET-by-id, `updateChange` PATCH to `/change/<id>` with the fields, and `updateChange` blocked under `SN_READONLY` (403, 0 fetch).
- [x] **QA-22 · `cmdb.ts` list/update/meta-cache paths pinned.** `listCmdbInstances`, `updateCmdbInstance` and `getCmdbMeta` were untested (cmdb.ts was 58% lines / 40% functions). Added tests: `listCmdbInstances` sysparm passthrough, `updateCmdbInstance` PATCH through IRE (attributes + source), the write blocked under `SN_READONLY`, and `getCmdbMeta` serving the second read from the TTL cache (one fetch for two calls). Coverage after: see the cycle gate below.
- [x] **QA-20 · the coverage gate now fails clearly on Node ≥ 25 instead of crashing cryptically.** `c8@11` (its latest release) → `yargs@17` throws `ReferenceError: require is not defined in ES module scope` under Node 25 (yargs ships an extensionless CJS entry under a `"type":"module"` package, which Node 25 loads as ESM). There is no Node-25-compatible `c8`, and forcing `yargs@18` would break the **Node 20** CI leg (it is ESM-only and Node 20 cannot `require()` it), so a dependency bump was rejected. Instead, `test:coverage` runs a preflight (`scripts/coverage-guard.mjs`) that, on Node ≥ 25, prints an actionable message — use the pinned runtime (`nvm use`, `.nvmrc` = 22) or the coverage-free `npm run verify` — and exits non-zero, rather than the cryptic yargs stack trace. Verified: Node 22 → full `npm run check` green (197 tests, coverage 94.2/81.6/71.7, audit 0); Node 25 → `npm run check` stops at the guard with the message, `npm run verify` passes (build + lint + format + 197 tests). The supported dev/CI runtimes (Node 20–24) are untouched.

### Cycle 2 — Architect (ARCH-8)

- [x] **ARCH-8 · the `fetchAll` completeness signal now reaches the primary query path.** ARCH-3 added `QueryResult.truncated` (a fetchAll that stopped at `SN_MAX_RECORDS`) and `snapshot`/`compare` surface it — but `servicenow_query_table`, the tool that actually does `fetchAll`, called `okQueryResult(records, total)` and **dropped** the flag, so a capped read came back with `count`/`total` but no explicit partial-result marker; a model could report the capped count as the whole table. `okQueryResult` now takes a `capped` argument and, when set, marks the result `truncated: true` with a "stopped at the SN_MAX_RECORDS cap … raise it or narrow the query" note even when the payload fits the char limit; `tools/table.ts` threads the flag through. Regression test in `test/result.test.js`. (Cycle 2 dev and QA re-reviews found nothing further actionable — the remaining tool wrappers map their schemas to the API options cleanly.)

## Phase 8 — Logical flow testing + code checking (2026-06-19)

The "run logical tests on flows and check the code" requirement, in three new packages (none in the default `core` profile). `npm run check` green: **219 tests** (+22), coverage 93.2% lines / 77.3% branches / 69.6% functions, audit 0. 65 tools / 18 packages (manifest fixture + README regenerated; package.json description drift-checked).

- [x] **FT-2 · `servicenow_trace_table_event(table, operation)`** (`api/flows.ts`, package `flows`). Deterministic, execution-ordered chain of what an operation runs — display → before → (database) → after → async business rules, then Flow Designer flows (`sys_hub_trigger_instance`), legacy workflows and notifications (`sysevent_email_action`) — each with its condition, plus a Mermaid flowchart. A failing section is a warning, not a failed trace. Caret-guarded. Tests in `test/flows.test.js`.
- [x] **FT-1 · `servicenow_list_flows` / `servicenow_get_flow`** (`flows`). Structured view of Flow Designer (`sys_hub_flow` + trigger + action instances) and legacy workflows (`wf_workflow`/`wf_activity`, `kind:"workflow"`): trigger (table/condition/when) + ordered steps.
- [x] **FT-3 · `servicenow_get_flow_runs`** (`flows`). Execution evidence from `sys_flow_context` by flow or by record (document_id) — closes the FT-2 loop.
- [x] **FT-5 · `servicenow_lint_script` / `servicenow_lint_table`** (`api/codecheck.ts`, package `codecheck`). A deterministic, pure-TS rule set (no new dependency): `hardcoded-sys-id`, `hardcoded-instance-url`, `eval-usage`, `gs-sleep`, `gs-log-deprecated`, `set-workflow-false`, `current-update-in-br` (server), `gr-on-client` / `sync-get-reference` (client), `query-in-loop` (brace-tracked) and `gr-unbounded-query` (look-back), plus a `new Function` syntax probe. `lintSource` is a pure function (6 unit tests). `lint_table` lints a table's active BR/CS/UI-policy scripts via `tableLogic`.
- [x] **FT-6 · `servicenow_code_health(scope?)`** (`codecheck`). Script counts by type (Aggregate) and, for a table scope, lint findings by severity + top offenders; writes `SN_DOCS_DIR/<profile>/code-health.md`.
- [x] **FT-4 · ATF runs via the CI/CD API** (`api/atf.ts`, package `atf`). `list_atf_tests`/`_suites` (Table API), `run_atf_test`/`_suite` (`/api/sn_cicd/testsuite/run` via `pluginCall`, write-gated, `readOnlyHint:false`), `get_atf_result` (`/api/sn_cicd/progress/{id}`). The run tools execute on the instance, so `atf` is never in the default profile. Tests assert the request shape, the read-only block and the plugin-inactive message.
- [x] **FT-7 · Code Search opt-in** (`api/scripts.ts`). With `SN_CODESEARCH=true`, `search_code` queries `sn_codesearch` (probe via `pluginCall`, defensive parsing) and **falls back to the proven LIKE iteration** on any failure — so the default path is unchanged. Tests cover both the API path and the fallback.

## Authentication — full ServiceNow coverage (2026-06-19)

Every inbound REST auth method ServiceNow supports is now implemented. The `AuthProvider` was refactored from a single `authorize() → Authorization string` to `headers(host) → header map` so non-`Authorization` schemes (API key) and header-less schemes (mutual TLS) fit cleanly; `core/http.ts` merges the returned headers and attaches an optional client-cert dispatcher. No new runtime dependency.

A **manifest-integrity smoke test** (`test/all-tools-smoke.test.js`) then drove every tool through `runSpec` with args synthesised from each tool's own zod shape, lifting **function coverage to 98.9%** (was ~71%) and **branch coverage to 81.8%** (was ~76%); the coverage gate was ratcheted up to **lines 93 / branches 80 / functions 96** (from 85/72/60). `npm run check` green: **236 tests**, coverage 95.3% lines / 81.8% branches / 98.9% functions, audit 0.

- [x] **OAuth 2.1 — Authorization Code + PKCE** (the recommended path). `core/pkce.ts` (S256), `core/oauth-login.ts` (RFC 8252 native-app flow: loopback listener + browser open), `core/auth.ts` `buildAuthorizeUrl`/`exchangeAuthorizationCode`. A one-time `servicenow-mcp-ai login` subcommand (wired in `index.ts`) captures the redirect, exchanges the code+verifier and stores the refresh token (then runs as the refresh_token grant — no password stored). Tests in `test/oauth.test.js` (PKCE, authorize URL, code exchange, redirect parse, full login flow via a loopback + the post-login refresh path).
- [x] **OAuth — JWT bearer grant** (`SN_OAUTH_GRANT=jwt_bearer`). `core/jwt.ts` signs an RS256 assertion with `node:crypto` (key from `SN_OAUTH_JWT_KEY`/`_FILE`; claims `iss`/`sub`/`aud`/`iat`/`exp`, optional `kid`); `getToken` posts `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`. The service-account path with no password. Tested incl. signature verification with the public key.
- [x] **API Key** (`SN_AUTH=apikey`, `SN_API_KEY`) → the `x-sn-apikey` header. **Static Bearer** (`SN_AUTH=token`, `SN_BEARER_TOKEN`) → `Authorization: Bearer …` verbatim. **`none`** (cert-only) → no auth header. `getAuthMode()` auto-detects from the present keys (api key → bearer → OAuth → Basic).
- [x] **Mutual TLS** (`SN_TLS_CLIENT_CERT`/`_KEY`/`_CA`, PEM or `_FILE`). `core/mtls.ts` builds an undici `Agent` dispatcher (client cert on the handshake; ServiceNow maps it to a user). undici is loaded by a **dynamic import** so it stays an OPTIONAL dependency — a clear "install undici" error if absent; the supported runtimes are otherwise untouched. Tests cover the not-configured and undici-absent branches.
- [x] **Password grant (ROPC) marked deprecated** (OAuth 2.1 forbids it); kept for back-compat. Docs synced: README (env table + a "Supported authentication methods" matrix), `.env.example`, the docs site auth section.

## Full review (2026-07-01) — the uncommitted Jira integration (cycle 1)

Scope: the work-in-progress Jira Cloud integration (`src/core/jira/`, `src/api/jira/`,
`src/core/http-util.ts` and the touched `core/http.ts`/`core/host.ts`), reviewed before it grows a
tool layer.

### Cycle 1 — Architect (ARCH-9, ARCH-11, ARCH-12, ARCH-13)

- [x] **ARCH-9 · host-resolution/SSRF policy deduplicated.** `resolveHost` (ServiceNow) and
      `resolveJiraHost` implemented the same normalise → validate → allowlist/blocklist algorithm
      line-for-line; a hardening fix to one would silently miss the other. Extracted
      `resolveHostWithPolicy(raw, policy)` + `HostPolicy` in `core/host.ts`; both resolvers are now
      thin policy wrappers (canonical suffix, env var, error wording, error class) with verbatim
      error messages, so the existing message-pinning tests pass unchanged.
- [x] **ARCH-11 · Jira failures now throw `JiraError`.** Every throw in `core/jira/*` and
      `api/jira/shared.ts` used `ServiceNowError` (so `err.name` lied and code could never branch
      per system). Added `JiraError extends ServiceNowError` in `core/errors.ts` and threw it from
      all Jira modules — the subclass keeps every existing `instanceof ServiceNowError` boundary
      (`mcp/result.ts`) and test green. The fuller taxonomy rename (neutral base class, `snDetail` →
      generic key) is a public-contract change — deferred to the owner (see TODO).
- [x] **ARCH-12 · shared `SN_*` transport knobs documented.** The Jira client rides
      `SN_TIMEOUT_MS`/`SN_MAX_RETRIES`/`SN_MAX_CONCURRENT`; the `settings.ts` docstrings now state
      the knobs govern every REST client (the `SN_` prefix is historical). Per-system `JIRA_*`
      overrides remain a config-surface decision — deferred to the owner (see TODO).
- [x] **ARCH-13 · `parseTotalCount` moved back into `http.ts`.** `X-Total-Count` is a ServiceNow
      Table API concept with a single consumer; keeping it in `http-util.ts` polluted the shared
      transport module with system-specific policy. `http-util.ts` is system-agnostic again.

Gate after the architect step: `npm run check` green — build + ESLint + Prettier, **358 tests**,
coverage 95.22% lines / 84.07% branches / 98.56% functions, audit 0.

### Cycle 1 — Dev (DEV-8, DEV-9, DEV-10)

- [x] **DEV-8 · `snRequest` created the timeout signal before acquiring the semaphore slot**
      (`src/core/http.ts`). `AbortSignal.timeout(SN_TIMEOUT_MS)` started ticking when the request
      `init` was built, _before_ `withSlot` granted a per-host slot — so with a saturated semaphore
      (`SN_MAX_CONCURRENT` in-flight requests, e.g. a `fetchAll` chain plus `tableLogic`'s parallel
      salvo) a queued request could burn its whole timeout budget waiting and abort without ever
      touching the network. The Jira twin already did this right (signal built inside the thunk);
      `snRequest` now builds `init` inside the `withSlot` thunk, so the timeout covers only the
      actual network attempt.
- [x] **DEV-9 · `snRequest` lacked the `?`-join guard** (`src/core/http.ts`). A caller passing a
      `path` that already carries a query string plus `params` would produce a malformed
      double-`?` URL (`…?a=1?b=2`); the Jira client already joined with the right separator. No
      current caller does this — fixed as latent-parity hardening so the twin clients cannot
      diverge on URL building.
- [x] **DEV-10 · `jiraRequest` let `extraHeaders` clobber managed headers**
      (`src/core/jira/http.ts`). The `...extraHeaders` spread came last, so an entry for
      `Authorization`, `Accept` or `Content-Type` silently replaced the client-managed value — and
      under a different casing (`authorization`) both keys survived in the record and fetch merges
      them into one broken comma-joined header. The client now rejects reserved-header entries with
      a clear `JiraError` (same style as the body+form mutual-exclusion guard); legitimate extras
      like `X-Atlassian-Token: no-check` pass through unchanged.

Reviewed and confirmed correct (no action): the retry-matrix tightening that ships with this change
(503 moved from retry-any-method to GET-only — a 503 write may already have landed, so replaying it
could duplicate a create/transition; pinned by the new `http-retry` test) and the new 60s
`Retry-After` cap in `http-util.ts`.

Gate after the dev step: `npm run check` green — build + ESLint + Prettier, **358 tests**, coverage
95.19% lines / 84.01% branches / 98.56% functions, audit 0.

### Cycle 1 — QA (QA-23 … QA-27)

- [x] **QA-23 · The `JiraError` contract was not pinned by any test.** `jira-http.test.js` and
      `jira-adf.test.js` asserted only `instanceof ServiceNowError`, so a regression that threw the
      base class again (losing the per-system distinction ARCH-11 introduced) — or broke the
      subclass name/inheritance — would pass the suite. The error-mapping, transport and 503
      assertions now check `instanceof JiraError`, `toAdf` rejections assert `JiraError`, and a
      dedicated contract test pins `name === "JiraError"`, `status`/`detail` passthrough and
      `instanceof ServiceNowError` (the check `mcp/result.ts` narrows on).
- [x] **QA-24 · The `snRequest` `?`-join guard (DEV-9) was untested.** Only the Jira twin had a
      URL-join test; the SN side could silently regress to the double-`?` bug. Added a direct
      `snRequest` test in `coverage-extra.test.js` asserting the `&` join when the path already
      carries a query string.
- [x] **QA-25 · The reserved-`extraHeaders` guard (DEV-10) was untested** — per-file coverage showed
      `src/core/jira/http.ts:111-114` (the throw) uncovered. Added a negative test using the
      different-casing attack (`AUTHORIZATION`) that asserts the `JiraError`, the header name in the
      message, and that fetch is never called.
- [x] **QA-26 · The Jira per-host telemetry claim was untested.** `http-util.ts` documents that the
      shared per-host telemetry gives a "multi-system breakdown for free", but no test exercised it
      through `jiraRequest`. Added a test pinning that a Jira request is counted under
      `perHost["mycompany.atlassian.net"]` and in the aggregate.
- [x] **QA-27 · The `message` fallback in `extractJiraErrorDetail` was uncovered**
      (`src/core/jira/http.ts:63-64`): Jira bodies that carry only a top-level `message` (typical
      for 5xx) fell through untested. Added an error-mapping test for a `{ message: … }`-only body.

No product code was touched in the QA step — all five findings were test gaps, not bugs.

Gate after the QA step: `npm run check` green — build + ESLint + Prettier, **363 tests** (+5),
coverage 95.23% lines / 84.17% branches / 98.56% functions, audit 0. The previously uncovered
`jira/http.ts` guard lines (111–114) and `message` fallback (63–64) are now exercised.

## Gap analysis (2026-07-01 → 02) — ruthless sweep, GA-1 … GA-6 executed

Two parallel code sweeps plus a manual verification pass on top of the 2026-07-01 gate. The
heavy code claims were **verified false** (probeTable's per-item error isolation, the flows
caret guard, the OAuth-login timeout and the per-instance schema-cache keying are all fine) —
the codebase was sound; the actionable gaps were CI/supply-chain and test hygiene. GA-7 stays
deferred (trigger-gated) and GA-8/GA-9 stay owner actions — tracked in TODO.md.

- [x] **GA-1 · No dependency-update automation.** Added `.github/dependabot.yml`: npm (root),
      npm (`extension/`) and github-actions, weekly, minor+patch grouped so majors (the class
      that bit before — the c8 Node-25 breakage) get individual review.
- [x] **GA-2 · No SAST in CI.** Added `.github/workflows/codeql.yml`: javascript-typescript,
      `security-and-quality` queries, on push/PR plus a weekly cron so advisories in unchanged
      code still surface. Least-privilege permissions (contents:read + security-events:write).
- [x] **GA-3 · Extension version skew.** The extension shipped 2.0.0 while npm was at 2.0.1.
      Bumped `extension/package.json` (+ lock) to 2.0.1 and added a version-sync gate to
      `publish-vscode.yml` that fails the publish when the extension and root versions differ.
- [x] **GA-4 · The Windows CI leg skipped lint + format.** `npm run lint` and
      `npm run format:check` now run on windows-latest too (the coverage ratchet stays
      ubuntu-only by design). Also fixed the stale coverage comment in `ci.yml` (93/80/96 →
      the real 94/82/97 ratchet under the ~95/~84/~99 report).
- [x] **GA-5 · Security-critical core modules lacked isolated unit tests.** New
      `test/policy.test.js` (10 tests: list parsing/normalisation, deny-wins-over-allow,
      `isReadOnly` truthiness variants, the per-profile override chain including the
      scoped-empty-string-beats-global contract, and the package-axis guards the Batch API
      rides) and `test/write-journal.test.js` (entry shape with real ISO ts + profile, jsonl
      round-trip, append-only accumulation, md rows keys-only/em-dash — values never leak into
      Markdown — and per-profile directory routing). `oauth-login.ts` was already covered by
      `oauth.test.js` (full PKCE loopback flow + precondition errors); added the two missing
      `parseRedirect` edges there (error_description preferred over the error code; a
      malformed request-URL returns an error instead of throwing).
- [x] **GA-6 · The README env table was manual (the M-5 remainder).** New
      `test/env-docs-sync.test.js`: scans `src/**/*.ts` for literal `SN_*`/`JIRA_*` tokens
      **plus** `authEnv("SUFFIX")` call sites (suffix-built names like `SN_OAUTH_JWT_KID`
      never appear literally) and asserts every var is documented in both `README.md` and
      `.env.example`. Sentinel + floor assertions pin the extraction itself so a refactor
      cannot silently pass an empty inventory. The dark Jira surface (ARCH-14) rides an
      explicit `PENDING_DARK_SURFACE` exception with a self-destruct test — the moment
      `JIRA_*` enters the README, the exception must be deleted and the sync becomes binding.
      The scan found three real doc gaps: `.env.example` gained `SN_OAUTH_JWT_KID`,
      `SN_OAUTH_JWT_EXP_SEC` and `SN_CODESEARCH`.

Gate: `npm run check` green — build + ESLint + Prettier, **380 tests** (+17), coverage
95.29% lines / 84.36% branches / 98.56% functions, `npm audit --omit=dev` 0 vulnerabilities.

## v3.0 execution — H-1 (2026-09-03)

The five-lens review of 2026-09-02 ([DEEP-REVIEW-2026-09.md](archive/DEEP-REVIEW-2026-09.md)) found the gate **red** on its last step; the v3.0 tracker ([ROADMAP-V3.md](ROADMAP-V3.md)) sequences H-1 first because nothing else can be verified until the gate is green.

- [x] **H-1 · Dependency floor + green audit.** `@modelcontextprotocol/sdk` `^1.12.0` → `^1.30.0` (installed 1.30.0) and `zod` `^3.23.8` → `^3.25.0` (the SDK's peer range; zod 4 stays with E-2 because it is breaking). A lock-only `npm audit fix --omit=dev` — no `overrides` — moved the transitive `fast-uri` 3.1.2 → 3.1.7, `ip-address` 10.2.0 → 10.7.0, `hono` 4.12.25 → 4.13.5, `@hono/node-server` 1.19.14 → 2.1.1, `qs` 6.15.2 → 6.16.0 and `body-parser` 2.2.2 → 2.3.0. No generated file (tool manifest, README tools table) changed. CHANGELOG `[Unreleased]` → Security. The procedure — including the `--omit=dev` dev-tree pruning gotcha — is now in [CONTRIBUTING.md](../CONTRIBUTING.md#dependencies-and-the-audit-gate). Two dev-only HIGH advisories (`brace-expansion`, `js-yaml`) sit outside the production gate and are folded into E-2 / Dependabot. Still open inside the item: cutting 2.1.0 (owner: version bump + tag) and the CI matrix run on the next push.

Gate: `npm run check` green — build + ESLint + Prettier, **406 tests** (unchanged), coverage 95.41% lines / 84.94% branches / 98.58% functions, `npm audit --omit=dev --audit-level=high` 0 vulnerabilities. Uncommitted.

## v3.0 execution — H-2 (2026-09-09)

The second finding the v3.0 tracker ([ROADMAP-V3.md](ROADMAP-V3.md) §H-2) sequences: a verified credential-redirect defect in `servicenow_set_credentials` — an `instance`-only update moved a configured profile to a new host while the stored user/password rode along, and the X-2 confirmation silently fell open on clients without elicitation.

- [x] **H-2 · Credential host binding.** `servicenow_set_credentials` now refuses to move a configured profile to a different host unless `user` and `password` arrive in the same call — `CREDENTIALS_INCOMPLETE` at the start of the error message (`fail()` carries no code field), evaluated after host validation, before the confirmation prompt and before any write, so nothing is persisted and no cache is touched. A first-time set and same-host re-spellings (`DEV00000` vs `dev00000.service-now.com`) stay allowed; a stored instance that no longer resolves counts as a change. The elicitation confirmation fails **closed**: no live server, a client without the `elicitation` capability, or a protocol error all refuse the change unless the operator sets `SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1` (new settings getter, README env row, `.env.example`); an explicit decline / cancel / accept-without-confirm is refused regardless. An accepted change still invalidates OAuth tokens, the schema cache and plugin availability. Tests: `test/admin-credentials.test.js` (8 tests over an in-memory MCP server/client pair and a scratch env file); the K-6 smoke test opts out so the SSRF guard is what rejects. Left open inside the item: the `SN_ALLOWED_HOSTS`-bypasses-`isBlockedHost` bullet (a documented opt-in pinned by `test/jira-host.test.js`) is deferred to H-6 as an open decision; re-requiring OAuth / API-key / bearer material on a host change follows with D-2.

Gate (after H-2, before H-10/E-9): build + ESLint + Prettier clean, **414 tests** (+8), coverage 95.46% lines / 85.28% branches / 98.58% functions. Uncommitted.

## v3.0 execution — E-9 (2026-09-10)

Third item off the v3.0 tracker ([ROADMAP-V3.md](ROADMAP-V3.md) §E-9), run in parallel with H-10 because the two only meet at `settings.ts` / `status.ts`: the process had no controlled way to fail (an unhandled rejection was logged and the server ran on with possibly corrupt state), no single teardown for its module singletons, and an unbounded schema cache (GAP L6-03, L6-04, L2-08).

- [x] **E-9 · Process lifecycle + bounded state.** New `src/core/lifecycle.ts`. `installCrashHandlers()` replaces the inline handlers in `index.ts`: an `unhandledRejection` or `uncaughtException` logs exactly one structured, secret-free `error` line (`pid`, `uptime`, `transport`, `errorName`, `error` capped at 2000 chars — never a stack or the raw reason object) and exits 1 after flushing stderr (bounded by 250 ms; only the first crash is handled). `dispose()` — idempotent, concurrent calls share one run, a failing step is logged and skipped — clears the schema cache and its counters, cached OAuth tokens, the mTLS dispatcher handle and HTTP telemetry, plus whatever upper layers register through `registerDisposer()` (`api/plugin.ts` registers its availability map); it runs on SIGINT/SIGTERM before `server.close()` and on `onsessionclosed` of the HTTP transport so nothing leaks across sessions. `closeHttpTransport()` stops the listener on shutdown, and `startHttp` now awaits `listen()` so a bind failure (EADDRINUSE, privileged port) rejects startup instead of raising a stray `'error'` event. `src/core/cache.ts` is a Map-ordered LRU bounded by `SN_SCHEMA_CACHE_MAX` (default 256; new settings getter, README env row, `.env.example`): a hit re-inserts at the recent end, expired entries are swept on every insert, the least-recently-used entry is evicted when full; `get_status` gains `schemaCache` (`size`, `max`, `hits`, `misses`, `evictions`, `expired`). Tests: `test/lifecycle.test.js` (8 — child-process crash probes through `test/fixtures/crash-probe.mjs`, dispose semantics, listener teardown) and `test/cache.test.js` (9 — the 257th insert evicts, recency refresh, TTL sweep, counters, status shape). Deferred inside the item: closing the undici Agent, rejecting queued waiters with `BUSY` and the breaker reset wire into `dispose()` when H-10 exposes the hooks; E-3 folds `dispose()` into the runtime container.

Gate (after the E-9 port into the main tree, H-10 still in flight): build clean, **431 tests** (+17); the full gate (ESLint, Prettier, coverage, audit) ran green together with H-10 on 2026-09-23 (next section). Uncommitted.

## v3.0 execution — H-10 (2026-09-23)

Fourth item off the v3.0 tracker ([ROADMAP-V3.md](ROADMAP-V3.md) §H-10, GAP L1-01…L1-10): the HTTP edge failed silently in several ways — `SN_TLS_*` was ignored without a client certificate, a proxy could not be configured at all, OAuth token requests bypassed the mTLS dispatcher, retries had no total budget, the per-host queue was unbounded, an HTML error page came back as a multi-hundred-KB "detail", and the instance saw an anonymous `node` client.

- [x] **H-10 · HTTP client resilience + identity.** New `src/core/dispatcher.ts`: one `getDispatcher(host)` builds the `undici` agent from the proxy (`SN_HTTPS_PROXY`, else `HTTPS_PROXY` / `HTTP_PROXY` with `NO_PROXY` matching) and the TLS options (`SN_TLS_CA[_FILE]`, `SN_TLS_REJECT_UNAUTHORIZED`, optional client cert/key pair — a lone half is a configuration error), applied **without** a client certificate too; agents are cached by the sha256 of their material + the active profile and closed (not just dropped) by `disposeDispatchers()` on `set_credentials` / `use_profile` and inside `dispose()`; `undici` stays optional with a clear install hint, `SN_TLS_REJECT_UNAUTHORIZED=false` logs one warning; `mtls.ts` is now a thin alias. New `src/core/identity.ts`: `User-Agent: servicenow-mcp-ai/<version> (node/<major>; <transport>; <client>)` — the client name comes from the MCP initialize handshake (`setClientInfoProvider`, registered in `mcp/context.ts`), `SN_USER_AGENT_SUFFIX` appends a printable, capped token. `src/core/http-util.ts` now exposes one `rawRequest` primitive: UA header, dispatcher, the bounded per-host queue (`SN_MAX_QUEUE` 64, `SN_QUEUE_TIMEOUT_MS` = timeout; `SlotBusyError` full / timeout / drained → code `BUSY`; `get_status` and `doctor` bypass it), a total deadline (`SN_DEADLINE_MS`, default max(120 s, 2 × timeout) → `DEADLINE_EXCEEDED`, composed with the caller's `AbortSignal` and a per-call `timeoutMs`), `SN_RETRY_AFTER_MAX_MS` (60 s), body shaping (JSON detail ≤ 2 KB; HTML → `UPSTREAM_HTML` + hint, tag-stripped, ≤ 512 chars) and the opt-in per-host circuit breaker (`SN_BREAKER_THRESHOLD` 0 = off, `SN_BREAKER_RESET_MS` 30 s → `CIRCUIT_OPEN`, half-open after the window, diagnostics spared). `snRequest` gains `signal`, `timeoutMs`, `bypassQueue` and re-authenticates once on 401 through the same path; the Jira twin (`jira/http.ts`) rides the same primitive with `clientCert: false` (parity test extended). `auth.ts` `requestToken` goes through `rawRequest` (`telemetryKey: "auth"`, retry only for replayable requests). `host.ts` `parseHostPort`: an explicit non-443 port or a bracketed IPv6 literal is accepted only when an `SN_ALLOWED_HOSTS` entry names it. `ServiceNowError` / `JiraError` carry `code` + `hint` (surfaced by `fail()` in `mcp/result.ts`); `get_status` reports `http` (`userAgent`, redacted `proxy` source + host, `tls` ca / clientCert / verify, `queue` per host). Eight new settings (`SN_HTTPS_PROXY`, `SN_USER_AGENT_SUFFIX`, `SN_DEADLINE_MS`, `SN_RETRY_AFTER_MAX_MS`, `SN_MAX_QUEUE`, `SN_QUEUE_TIMEOUT_MS`, `SN_BREAKER_THRESHOLD`, `SN_BREAKER_RESET_MS`) with README rows and `.env.example` entries; `dispose()` (E-9) now drains the queue, resets the breakers and closes the dispatchers. Tests: `test/http-resilience.test.js` (43 — the 8-combination dispatcher matrix and the proxy / `NO_PROXY` matrix on a fake `undici`, token requests under proxy and mTLS, a 300 KB HTML 502 → an error ≤ 1 KB, the 65th queued call → `BUSY`, queue timeout, drain, deadline / `Retry-After` cap / per-call timeout / caller abort, host:port + IPv6 policy, breaker open / half-open / off), `test/identity.test.js` (6) and one `dispose()` hook test in `test/lifecycle.test.js`. Not in the item: rate-limit header parsing into telemetry (second half of L1-07, 3.x); the acceptance matrices run on `withFetch` + the fake `undici` because the E-6 fetch double v2 does not exist yet.

Gate (whole dirty tree — H-1 + H-2 + E-9 + H-10): build + ESLint + Prettier clean, **481 tests** (+50: 43 + 6 + 1), coverage 96.04% lines / 86.44% branches / 98.44% functions, `npm audit --omit=dev --audit-level=high` 0. Uncommitted.

## v3.0 execution — S-1 (2026-09-23)

Tracker: [ROADMAP-V3.md](ROADMAP-V3.md) §S-1 (DEEP-REVIEW C-2 / FT-2). Local, uncommitted.

- [x] **Inherited + global business rules in the trace.** `traceTableEvent` resolves the table's
      inheritance chain through `getTableChain` (child first) before querying `sys_script`, and the
      query becomes `collectionIN<chain>^ORglobal=true^active=true^when=<phase>^action_<op>=true^ORDERBYorder`
      (`^OR` binds to the clause right before it, so this is "(chain OR global) AND the rest"). Each
      `ChainEntry` says where the rule lives: `table`, `inherited_from` (a parent table) or
      `global`. A failing chain lookup traces the table alone and says so in `warnings`.
- [x] **Operation-aware filters.** Flow triggers are dropped only when `trigger_type` names a
      different record operation (`record_create` is not in an `update` trace; unknown types are
      kept); legacy workflows are listed for insert/update only; notifications by `action_insert` /
      `action_update` or when driven by an event; `query` lists no record-triggered work at all.
- [x] **Table-flow diagram lanes.** `generateTableFlow` walks the same chain, renders the table's
      own rules as direct nodes and then one `inherited from <parent>` lane per parent (chain order)
      plus a `global` lane per phase; empty lanes are skipped; the result gains `tables`.
- [x] **`getTableChain` cached** with the other schema reads (`cacheKey(["tableChain", table])`);
      the `business_rule` script descriptor exposes `global`; both tool descriptions extended.
- [x] **Gate:** build clean · ESLint 0 · Prettier clean · **486/486** (five new tests: incident
      sees task + global rules in order; flow triggers / notifications filtered by operation; chain
      lookup failure → warning; diagram lanes) · coverage 96.13 / 86.48 / 98.47 · `npm audit --omit=dev` 0.

## v3.0 execution — H-9 (2026-09-23)

Tracker: [ROADMAP-V3.md](ROADMAP-V3.md) §H-9 (DEEP-REVIEW CI/version hygiene; GAP L9-04, L9-06, L9-07, L9-08, L9-12). Local, uncommitted.

- [x] **Workflows hardened.** Every action in the five workflows is pinned to a commit SHA with
      the version in a trailing comment (`actions/checkout` / `actions/setup-node` 4.4.0,
      `codecov/codecov-action` 5.5.5, `github/codeql-action` 3.38.1); top-level
      `permissions: contents: read` everywhere, `id-token: write` only where a publish needs OIDC,
      `security-events: write` only on the CodeQL job; `ci.yml` has `concurrency` with
      cancel-in-progress, `timeout-minutes` on every job and an `actionlint` job (1.7.12).
- [x] **New CI steps** on the ubuntu/Node 22 leg: `npm run pack:check`, "No tracked env files"
      (only `.env.example` may be tracked) and "Prettier idempotency"; the Node 12 launcher probe
      derives the expected major from `engines.node`.
- [x] **Checksummed publisher.** `publish-mcp.yml` downloads `mcp-publisher` 1.8.1 by version and
      verifies it with `sha256sum --check` against the release's `registry_<v>_checksums.txt`.
- [x] **Tarball guard.** `scripts/pack-check.mjs` (`npm run pack:check`, in `npm run check`) fails
      on any entry outside `LICENSE` / `README.md` / `package.json` / `bin/` / `build/`, on
      `jira/`, `.map`, `test/`, `docs/instance/`, or above 600 KB unpacked; `files` gains
      `!build/**/jira/**` so the dark Jira client never ships (78 files, 439.7 KB today).
- [x] **One version.** `scripts/sync-version.mjs` (`npm run version:sync`, `--check`) plus the
      `npm version` lifecycle hook keep `package-lock.json`, `server.json`,
      `extension/package.json`, `extension/package-lock.json`, `.claude-plugin/plugin.json` and
      `docs/index.html` at the `package.json` version; `test/version-sync.test.js` (8 tests) fails
      the gate on skew and pins the launcher's Node literal to `engines.node`. Fixed
      `.claude-plugin/plugin.json` 2.0.0 → 2.0.1.
- [x] **Hygiene.** `.gitignore` `.env.*` + `!.env.example` + `.env.tmp-*`; `.prettierrc.json`
      `proseWrap: preserve`; `npm run format` is two passes; CONTRIBUTING documents the
      version-bump flow, the tarball guard and the Markdown formatting gotchas.
- [x] **Gate:** build clean · ESLint 0 · Prettier clean · **494/494** · coverage
      96.01 / 86.56 / 98.49 · `pack:check` OK · `sync-version --check` OK · actionlint 1.7.12 0 ·
      `npm audit --omit=dev` 0.

## v3.0 execution — H-8 (2026-09-23)

Tracker: [ROADMAP-V3.md](ROADMAP-V3.md) §H-8 (DEEP-REVIEW C-1, C-3, C-4, C-9…C-12). Built on its own branch, then 3-way merged onto the H-10 / S-1 / H-9 tree (one conflict, in `src/api/diagrams.ts`: kept main's `${indent}` lane layout and H-8's `snString` rule name). Local, uncommitted.

- [x] **Platform corner-case pins.** A 2xx HTML page (PDI hibernation, login/SSO) now raises `INSTANCE_HTML_RESPONSE` with a wake-up hint; `fetchAll` reads past ACL-shortened pages to `X-Total-Count` or an empty page under a `cap × 10` scan budget and reports `truncatedReason`/`filtered` with a cause-specific note; redaction, CSV and the diagram generators are pinned for `display_value=all` pairs; attachment UTF-8 names, 0-byte files, data URLs and the base64 limit boundary are pinned; namespace 404s distinguish plugin inactive / missing / active; drift and where-used reports carry domain-separation and cross-scope caveats. 25 new tests in `test/platform-corners.test.js` (506 on its branch). Plugin ids and the hibernation wording are unverified against a live instance; snapshot's `warnIfTruncated` still names the `SN_MAX_RECORDS` cap for a scan-limit stop. The where-used "inherited parent rules are not included" caveat now points to `servicenow_trace_table_event` and `servicenow_generate_table_flow`, which list inherited and global rules since S-1.
- [x] **SDK parity plan.** [SDK-PARITY.md](SDK-PARITY.md) adds the post-3.0 SDK parity epic (P-1…P-29, owner gates O-5…O-9) to the tracker as rows 55–83; none of it joins the 3.0 cut. Docs only.
- [x] **Gate (merged tree):** `npm run check` exit 0 — build + ESLint + Prettier + format idempotency, **519/519** · coverage 96.15% statements / lines, 87.06% branches, 98.52% functions · `pack:check` 78 files, 456.2 KB · `npm audit --omit=dev` 0. With it the 2.1.0 hardening batch (tracker items 1–5) is complete.

## 2026-09-23 — H-5 journal v2 + deep redaction, H-6 outbound hardening

Tracker: [ROADMAP-V3.md](ROADMAP-V3.md) §H-5, §H-6. Built in parallel on separate copies of the tree, then 3-way merged (conflicts in `src/api/docs.ts`, `src/core/settings.ts`, `src/tools/attachment.ts`, README, CHANGELOG, SECURITY — both sides kept; the docs store keeps one synchronous symlink check inside `resolveDocPath`). Local, uncommitted.

- [x] **H-5 · Write journal v2.** `schema_version: 2`, ULID `id`, `result` (applied / failed / refused), best-effort `before` on update/delete, `client`, sha256 `prev` chain with a head file, rotation at `SN_JOURNAL_MAX_BYTES` (20 MiB), per-sub-request batch lines with `batch_id`, `local_write` and `config` (key names only) entries; `readWriteJournal` reports chain integrity. Deep redaction (`src/core/redaction.ts`) at the `ok()`/`fail()` boundary; CSV exports get a formula guard and BOM (`SN_CSV_FORMULA_GUARD`, `SN_CSV_BOM`). Tests: `test/journal-v2.test.js`.
- [x] **H-6 · Outbound hardening.** Manual redirects (`REDIRECT_BLOCKED`), `SN_MAX_BODY_BYTES` (`RESPONSE_TOO_LARGE`), IPv6-aware host guard, TLS-off warning in logs and `get_status`, OAuth callback path/`state` check, `SN_MAX_UPLOAD_BYTES` / `SN_UPLOAD_MIME_ALLOW` / file-name sanitising, docs store device-name, `:` , symlink and `SN_DOCS_MAX_FILE_BYTES` guards, `send_email` recipient allow-list (`SN_EMAIL_ALLOWED_DOMAINS`, fail-closed default — O-4 candidate). Tests: `test/outbound-hardening.test.js`.
- [x] **Gate (merged tree):** `npm run check` exit 0 — **568/568** · coverage 96.61% statements / lines, 88.52% branches, 98.68% functions · `pack:check` 79 files, 500.4 KB · `npm audit --omit=dev` 0.

## 2026-09-23 — E-3 runtime container, S-2 journal-based revert, S-14 docs store v2

Tracker: [ROADMAP-V3.md](ROADMAP-V3.md) §E-3, §S-2, §S-14. Built in parallel on separate copies of the tree, then 3-way merged (one conflict, in `src/core/errors.ts`: both sets of new error codes kept). Local, uncommitted.

- [x] **E-3 · Runtime container.** `src/core/runtime.ts` — `createRuntime()`, `installRuntime()`, `runWithRuntime()` (AsyncLocalStorage), `currentRuntime()`, `defineRuntimePart()`; the schema cache, OAuth tokens, telemetry, per-host queue and breakers, dispatchers, profile store and plugin availability are runtime parts. Built once in bootstrap, passed to `registerAllTools`, which binds every tool call. `dispose()` clears in place, idempotent, concurrent calls share one run; `lifecycle.dispose()` delegates. The `_reset*` test hooks are deleted — tests use `freshRuntime()`; `test/runtime.test.js`.
- [x] **S-2 · Journal-based revert.** Opt-in `revert` package (`src/api/revert.ts`, `src/tools/revert.ts`): `servicenow_list_writes` (profile / table / since / result / action / limit, revertible + reason per line) and `servicenow_revert_write` (plan/apply; update → `before` back, create → delete, delete → re-create; `STALE_RECORD` on `sys_mod_count` or field drift unless `force:true`; `NOT_REVERTIBLE` with the reason; journaled with `reverts:<id>`). Journal lines gain `tool` and `after_mod_count`; new error codes `NOT_REVERTIBLE`, `STALE_RECORD`. `test/revert.test.js` (15). 69 tools in 19 packages.
- [x] **S-14 · Docs store v2 + generator depth.** `sn_*` frontmatter with a stable `sn_source_hash`, `unchanged` re-runs, `<!-- sn:manual -->` blocks, `DOC_GENERATED` (409) in both directions with 2.x upgrade, `index.json` manifest + grouped `index.md`, docs tools `profile` / `kind` / `generated` / `overwrite` / `stale` / search cap; `src/api/mermaid.ts` (node cap), ER `columns` / `max_columns` / `depth`, table-flow `operation`; C-4 pair fixtures. Defaults byte-identical (goldens), metadata-only fetch allow-list. New tests: `mermaid`, `docs-goldens`, `docs-store` (+ `mermaid-lint.js`).
- [x] **Gate (merged tree):** `npm run check` exit 0 — **621/621** · coverage 96.95% statements / lines, 89.28% branches, 98.84% functions · `pack:check` 83 files, 566.8 KB · `npm audit --omit=dev` 0.

## 2026-09-24 — M-3 cancellation + progress, S-3 security scan, S-8 Table API + upsert, P-1 artefact registry

Tracker: [ROADMAP-V3.md](ROADMAP-V3.md) §M-3, §S-3, §S-8 and [SDK-PARITY.md](SDK-PARITY.md) §P-1. Built in parallel on separate copies of the tree, then 3-way merged (conflicts in CHANGELOG and `src/api/table.ts` — M-3's `signal` / `onProgress` and S-8's query parameters both kept; the `fetchAll` loop reports progress before S-8's filtered-page accounting). Local, uncommitted.

- [x] **M-3 · Cancellation + progress.** `src/core/progress.ts` (`throwIfCancelled`, `reportProgress`, `trackProgress`, `fetchAllProgress`) and `src/mcp/progress.ts` (250 ms throttled sink); the call's `AbortSignal` rides the request context into `snRequest`, the per-host slot wait and the retry loop (no retry after abort); new error code `CANCELLED`; log lines carry the call id. `query_table`, snapshot, compare and batch report progress. Tests: `test/cancel-progress.test.js` (18).
- [x] **S-3 · Security scan.** `src/api/security.ts`, folded into `servicenow_code_health`: rules `acl-open`, `acl-public-role`, `acl-roles-only`, `acl-elevated-privilege`, `admin-overlap-role`, `public-rest-resource`, `table-no-acl` (custom `u_` / `x_` tables); roles resolved through `sys_user_role_contains`; 50 000-row ACL ceiling with an explicit early-stop note; each extra table degrades to `available:false` instead of failing the scan. Tests: `test/security-scan.test.js` (13).
- [x] **S-8 · Table API completeness + upsert.** `view`, `sysparm_query_category`, `no_count`, `query_no_domain`, `suppress_pagination_header`, `input_display_value`; keyset paging for `ORDERBY` queries without `^NQ`; new `servicenow_upsert_record` (natural-key upsert, `AMBIGUOUS_KEY` on >1 match, revertible) in the core profile; `servicenow://reference/encoded-query` resource. Tests: `test/table-s8.test.js` (16). 70 tools in 19 packages.
- [x] **P-1 · Artefact registry.** `src/core/artifacts/registry.ts` (SDK baseline 4.12.2, APIs, decoder ids, artefact types); `SCRIPT_TYPES` and the capabilities artefact tables derive from it. Tests: `test/artifact-registry.test.js` (9).
- [x] **Tarball ceiling** raised from 600 KB to 800 KB in `scripts/pack-check.mjs` (the 3.0 tree packs at ~638 KB) — owner to confirm.
- [x] **Gate (merged tree):** `npm run check` exit 0 — **677/677** · coverage 97.33% statements / lines, 90.28% branches, 98.78% functions · `pack:check` 87 files, 637.6 KB · `npm audit --omit=dev` 0.

## 2026-09-24 — S-4 script-intelligence widening, S-13 capability matrix, D-2 credentials model, P-3/P-4 SDK tracking

Tracker: [ROADMAP-V3.md](ROADMAP-V3.md) §S-4, §S-13, §D-2 and [SDK-PARITY.md](SDK-PARITY.md) §P-3, §P-4. Built in parallel on separate copies of the tree, then 3-way merged (conflicts in CHANGELOG, `src/api/capabilities.ts`, `src/core/settings.ts`, `src/core/artifacts/registry.ts`, `src/tools/admin.ts` and `test/artifact-registry.test.js` — both sides kept everywhere). Local, uncommitted.

- [x] **S-4 · Script-intelligence widening.** Registry fields `clientFields`, `markupFields`, `baseQuery` and 15 unverified script types; `scope` filter on script search / list and where-used; per-artefact `hits` (max 20) with `hitCount`; unverified types that fail to read land in `unreadable` instead of failing the sweep.
- [x] **S-13 · Capability matrix.** `src/api/capability-matrix.ts`: one read-only, policy-routed probe per group, `groups` / `refresh` inputs on `servicenow_check_capabilities`, TTL cache (`SN_CAPABILITY_TTL_MS`, default 10 min) and plugin negative TTL (`SN_PLUGIN_NEGATIVE_TTL_MS`, default 60 s); matrix block in doctor. Tests: `test/capability-matrix.test.js`.
- [x] **D-2 · Credentials model.** `credentialStatus` per auth method; `set_credentials` gains `auth`, `oauth_client_id`, `oauth_grant`, `request_secrets` (secrets only via elicitation); `SN_TOKEN_FILE` re-read on 401, new code `AUTH_EXPIRED`, token-expiry and env-file ACL warnings; per-profile auth in status and doctor. Tests: `test/credentials-model.test.js`.
- [x] **P-3 · SDK-managed scope detection.** `src/core/artifacts/sdk-managed.ts` (`SN_SDK_MANAGED_SCOPES`, `SN_SDK_PROJECT_DIRS` scanning `now.config.json`, bounded); `sdkManaged` block in `get_status` and `check_capabilities`. Tests: `test/sdk-managed.test.js`.
- [x] **P-4 · SDK release tracking.** `scripts/sdk-drift.mjs` (`npm run sdk:drift`) and the weekly `.github/workflows/sdk-drift.yml`; `SDK_NEXT_APIS = ["DatabaseView"]`. Tests: `test/sdk-drift.test.js` (fixture `test/fixtures/sdk-llms.txt`).
- [x] **Gate (merged tree):** `npm run check` exit 0 — **752/752** · coverage 97.65% statements / lines, 91.08% branches, 98.76% functions · `pack:check` 89 files, 711.8 KB (limit 800 KB) · `npm audit --omit=dev` 0. 70 tools in 19 packages (no new tools).

## 2026-09-24 — M-8 protocol fixes, S-9 structural where-used, E-5 observability, P-5 generic artifact reads

Tracker: [ROADMAP-V3.md](ROADMAP-V3.md) §M-8, §S-9, §E-5 and [SDK-PARITY.md](SDK-PARITY.md) §P-5. Built in parallel on separate copies of the tree, then 3-way merged (conflicts in CHANGELOG, `.env.example`, README and `docs/index.html` env tables — both sides kept; P-5's tools then adapted to M-8's required annotation hints and bounded inputs). Local, uncommitted.

- [x] **M-8 · Protocol fixes.** `src/mcp/log-bridge.ts` (`logging/setLevel` over HTTP, per-session rate limit `SN_LOG_NOTIFY_RATE`, suppressed-line summary); required annotation hints on every tool; `buildInputSchema`; bounded input builders in `src/mcp/define.ts`. Tests: `test/log-bridge.test.js`, `test/schema-bounds.test.js`.
- [x] **S-9 · Structural where-used.** `src/api/references.ts` with 9 structural sources; `structural` section and input on `servicenow_where_used`. Tests: `test/references.test.js`.
- [x] **E-5 · Observability.** `src/core/metrics.ts`, `src/core/log-file.ts`, `src/mcp/observability.ts`; `observability` block in `get_status`; `diagnostics_channel` events; `SN_LOG_FORMAT`, `SN_LOG_FILE`, `SN_LOG_FILE_MAX_BYTES`, `SN_METRICS`. Tests: `test/observability.test.js`.
- [x] **P-5 · Generic artifact reads.** `src/api/artifacts.ts`, `src/tools/artifacts.ts` (opt-in `artifacts` package), `servicenow://artifact-types`. Tests: `test/artifacts.test.js`.
- [x] **Gate (merged tree):** `npm run check` exit 0 — **817/817** · coverage 97.84% statements / lines, 91.08% branches, 98.78% functions · `pack:check` 96 files, 794.0 KB (limit 800 KB) · `npm audit --omit=dev` 0. 72 tools in 20 packages.

## 2026-09-25 — M-4 completions, S-7 snapshot/compare v2, S-5 trace v2, P-6 explain_artifact

Tracker: [ROADMAP-V3.md](ROADMAP-V3.md) §M-4, §S-7, §S-5 and [SDK-PARITY.md](SDK-PARITY.md) §P-6. Built in parallel on separate copies of the tree, then 3-way merged (CHANGELOG conflicts only — both sides kept). Local, uncommitted.

- [x] **M-4 · Completions + reference resources + content boundary.** `src/mcp/boundary.ts`; `complete` / `list` callbacks in `src/mcp/resources.ts`; completable prompt arguments; `servicenow://reference/tools`. Tests: `test/completions.test.js`.
- [x] **S-7 · Snapshot/compare v2.** `src/api/snapshot.ts` (sections, fan-out, resume), `src/api/compare.ts` (sys_id matching, `renamed`, record diffs), `src/api/unified-diff.ts`, `describe_table` details. Tests: `test/unified-diff.test.js`, `test/snapshot.test.js`, `test/compare.test.js`, `test/meta.test.js`.
- [x] **S-5 · Trace v2.** Opt-in `lanes` in `src/api/flows.ts` / `src/api/diagrams.ts`. Tests: `test/trace-lanes.test.js`, new table-flow golden.
- [x] **P-6 · explain_artifact.** `src/api/explain-artifact.ts`, `src/core/artifacts/decoders.ts`, `servicenow_explain_artifact`. Tests: `test/explain-artifact.test.js`, `test/fixtures/explain/`.
- [ ] **Gate (merged tree):** tests **870/870** pass · coverage 97.95% statements / lines, 90.94% branches, 98.9% functions · build, lint, format pass · `npm audit --omit=dev` 0 · **`pack:check` fails: 868.7 KB unpacked, over the 800 KB ceiling (owner decision)**. 73 tools in 20 packages.

## 2026-09-25 — P-7 core/server/classic-UI descriptors, P-9 portal/UIB/flow/workflow descriptors, S-6 update sets, S-11 file delivery

- [x] **P-7 · Descriptors + explainers.** 31 CORE/SRV/CUI rows in `src/core/artifacts/registry.ts`, `available` probe in `src/api/artifacts.ts`, `src/api/explainers.ts` (state model, choice table, field effects). Tests: `test/explain-enrichers.test.js`.
- [x] **P-9 · Shallow NX/UIB/SP/FLW/WF descriptors.** `scriptToolsOptIn`, `search_code({extended})`. Tests: `test/artifact-registry.test.js`, `test/scripts.test.js`.
- [x] **S-6 · Update-set awareness.** Opt-in `updatesets` package (`src/api/updatesets.ts`, `src/tools/updatesets.ts`), `update_set` binding on table writes, `check_capabilities` access. Tests: `test/updatesets.test.js`.
- [x] **S-11 · File-based delivery.** `format:"file"`, `src/mcp/file-result.ts`, `openDocStream`, `SN_OVERSIZE_TO_FILE`. Tests: `test/file-delivery.test.js`.
- [ ] **Gate (merged tree):** tests **936/936** pass · coverage 98.13% statements / lines, 91.26% branches, 98.98% functions · build, lint, format pass · `npm audit --omit=dev` 0 · **`pack:check` fails: 984.5 KB unpacked, over the 800 KB ceiling** (owner decision). 76 tools in 21 packages.

## 2026-10-02 / 03 — batch 18: M-2 (error contract v2, BREAKING B3), M-7 (naming v3, BREAKING B2 + B13)

O-4 approved 2026-10-01; B3 ships with B2 + B13.

- [x] **M-2 · Error contract v2 (BREAKING B3).** Flat failure payload `{error, code, source, status?, hint?, detail?}` (`snDetail` → `detail`, no `error.code` nesting, no message prefixes); `ERROR_CODES` in `src/core/errors.ts` (54 fixed codes + the `INSTANCE_HTTP_<status>` family, each with a fixed `source`: `servicenow` / `policy` / `server`); derivation order own code → `INSTANCE_HTTP_<status>` → status family → `ZodError` → `INTERNAL_ERROR`; neutral `IntegrationError` base with `ServiceNowError` / `JiraError` siblings (ARCH-11b); policy, credential, profile and doctor failures carry the fix as `hint`; resources throw `McpError` (`InvalidParams` for caller codes, `InternalError` otherwise, `data:{code, source, hint?}`), docs template mime matches its content; manifest v3 publishes one global `errorCodes` table (deviation from per-tool lists, see TODO). Tests: `test/error-contract.test.js` (13, incl. a fast-check property and an every-tool `UNKNOWN_PROFILE` sweep) + code asserts across the existing suites.
- [x] **M-7 · Tool naming convention v3 (BREAKING B2 + B13).** `servicenow_<verb>_<noun>` everywhere: 11 renames from one alias map (`TOOL_RENAMES` in `src/mcp/naming.ts` — the 8 planned + `get_artifact_dependencies`, `check_data_health`, `read_ops`), `TOOLS` name constants used by the prompts; `sys_id` / `table` / `values` parameter normalization with `legacyParams` (flag-only) and `deprecatedParams` (`class_name` on the CMDB tools, always) handled in `defineTool`; `SN_LEGACY_TOOL_NAMES=1` alias tools for one minor; overlap reasons (`TOOL_OVERLAPS`) and `toolRenames` in manifest v4; generated old→new table in README + CHANGELOG (`npm run docs:readme`); `servicenow://profiles/{profile}/schema/{table}` with the old template aliased (warn-once); reserved profile names refused (`RESERVED_PROFILE_NAME`); `servicenow://policy` checked secret-free; the D-8 hook maps the legacy `change_conflicts` name. Tests: `test/naming-m7.test.js` (17) + renamed names / parameters across the suites.
- [ ] **Gate (main):** tests **1628/1629** pass, 1 `todo`, 0 fail (extension lint clean) · coverage 97.81% statements / lines, 88.29% branches, 97.88% functions · build, lint, format, `docs:env --check`, `docs:sync --check`, `fluent:actions --check` pass · `npm audit --omit=dev` 0 · **`pack:check` fails: 2033.3 KB unpacked over the 800 KB ceiling** (owner decision). 97 tools in 26 packages. Uncommitted.
- [ ] **Gate (after M-7, 2026-10-03):** tests **1647/1648** pass, 1 `todo`, 0 fail · extension lint clean, extension tests 14/14 · coverage 97.72% statements / lines, 88.32% branches, 97.71% functions · build, lint, format, `docs:env --check`, `docs:sync --check`, `fluent:actions --check` pass · `npm audit --omit=dev` 0 · **`pack:check` fails: 2056.9 KB unpacked over the 800 KB ceiling** (owner decision). 97 tools in 26 packages (+11 legacy aliases under `SN_LEGACY_TOOL_NAMES=1`). Uncommitted.

## 2026-10-01 — batch 17: E-1, E-2, H-3, H-4, H-11 (bar the policy file), D-8, S-12, P-29 (part); P-26…P-28 SDK-verified

Owner decisions 2026-10-01: O-4 approved (B1–B13 except B10), O-7 approved (`@servicenow/sdk` 4.12.2 exact as a dev dependency), O-1 / ARCH-14 deferred, S-12 `acorn` approved.

- [x] **E-1 · Node ≥ 22.12 floor (BREAKING B1).** Launcher + `src/index.ts` guard, CI 22 / 24 / 26 + macOS / Windows + a 22.12.0 floor job, `import.meta.dirname`, coverage guard removed.
- [x] **E-2 · Toolchain majors.** zod 4, MCP SDK 1.31, ESLint 10, fast-check 4.10, dotenv replaced by `process.loadEnvFile`; TypeScript stays 5.9 (typescript-eslint); schema drift listed in CHANGELOG.
- [x] **H-3 · Plan-token binding (BREAKING B4).** `SN_DESTRUCTIVE_CONFIRM` defaults to `token`; single-use `plan_token`, `PLAN_REQUIRED` / `CONFIRM_DECLINED`, journaled.
- [x] **H-4 · Policy-axis bypass closure (BREAKING B8).** `SN_BATCH_UNMAPPED=deny`, `SN_BATCH_MAX_REQUESTS=50`, nested batch refused, attachment parent-table checks.
- [ ] **H-11 · Policy model v2 (BREAKING B11)** bar `SN_TABLE_POLICY_FILE`: glob patterns, one evaluator, `explain_policy`, protected tables write-denied, write caps.
- [x] **D-8 · Plugin hook.** `hooks/hooks.json` + `hooks/require-plan-token.mjs`. Tests: `test/plugin-hook.test.js`.
- [x] **S-12 · AST lint.** `src/api/script-ast.ts` (`acorn`), regex fallback, `code_health` baseline (`src/api/code-health-baseline.ts`). Tests: `test/s12-ast-lint.test.js`.
- [ ] **P-29 · Fluent round-trip oracle (part).** `scripts/fluent-verify.mjs` (`npm run fluent:verify`): strict `tsc` against the SDK 4.12.2 types plus an offline `now-sdk build` of all 27 goldens in conflict-free projects; every declared key must build under its sys*id (own file or nested in the parent) and no `DELETE` may be emitted — 0 type errors, 93 keyed records among 100 built. `scripts/gen-fluent-actions.mjs` → `src/api/fluent-sdk-actions.ts` (`fluent:actions -- --check` in `npm run check`). Tests: `test/fluent-sdk-oracle.test.js`. Emitter fixes: typed `action.core` inputs, steps by name, `endFlow` in blocks, `*`-prefixed unused params, `wfa.action`keys on`sys_hub_action_instance_v2`, only referenced keys declared, `SPPage` sys_id note. Open: per-field comparison with instance records (O-2 / O-5).
- [ ] **Gate (main):** tests **1614/1615** pass, 1 `todo`, 0 fail (extension 14/14, extension lint clean) · coverage 97.83% statements / lines, 88.21% branches, 97.95% functions · build, lint, format, `docs:env --check`, `docs:sync --check`, `fluent:actions --check` pass · `npm audit --omit=dev` 0 · **`pack:check` fails: 2012.7 KB unpacked over the 800 KB ceiling** (owner decision). Uncommitted.

## 2026-09-30 — batch 16: P-27, P-28 (bar the O-7 oracle)

- [ ] **P-27 · Flow / subflow / action / playbook Fluent emitters.** `servicenow_generate_fluent` emits `Flow` / `Subflow` / `Action` / `PlaybookDefinition` from the `explain_flow` tree (`src/api/fluent-flow.ts`, result `emitter:"flow"`); a degraded, unavailable or mismatched tree falls back to the P-26 `Record()` form. Open: O-7 oracle, `wfa.dataPill` type argument, step-output pills kept as text, subflow call TODO, PDI verification (O-5 / O-9). Tests: `test/fluent-flow.test.js`, `test/fixtures/fluent/*_emitter.golden.txt`.
- [ ] **P-28 · Portal / workspace / catalog Fluent emitters.** 20 dedicated emitters in `src/api/fluent-ui.ts` (portal tree incl. `SPPage` containers / rows / columns / instances and `SPWidget` sidecars; `Workspace`, `Dashboard`, `UxListMenuConfig`, `Applicability`; `CatalogItem` / `RecordProducer` with variables, sets, client scripts, UI policies); leftover rows and uncovered fields go to `Record()` + `unsupported[]`; UIB and `sp_ng_template` stay `Record()`; `verified:false` warning. Open: property names (O-7 / O-5), standalone `io_set_item` rows. Tests: `test/fluent-ui.test.js`, `test/fixtures/fluent/ui_*.golden.txt`, `uib_fallback.golden.txt`.
- [ ] **Gate (merged tree):** tests **1581/1584** pass, 3 `todo`, 0 fail (extension 14/14, extension lint clean) · coverage 98.10% statements / lines, 88.72% branches, 98.49% functions · build, lint, format, `docs:env --check`, `docs:sync --check` pass · `npm audit --omit=dev` 0 · **`pack:check` fails** (1902.3 KB vs the 800 KB ceiling, owner decision). 97 tools in 26 packages.

## 2026-09-30 — batch 15: P-20 (remainder), E-6 (part), P-26 (bar the O-7 oracle)

- [x] **P-20 · Snapshot/compare remainder.** `compare_instances({types, mermaid:true})` returns `mermaidDiffs[]` (unified diffs of the Mermaid sources for flows, subflows, actions, workflows, playbooks, portals, pages and workspaces; 10 records × 120 lines, never counted as drift) — `src/api/artifact-mermaid.ts`; flows read their children from the published `master_snapshot` when it has rows (`source:"published"`, unverified until O-5), draft otherwise. Tests: `test/p20-mermaid-published.test.js`.
- [ ] **E-6 · Test architecture (part).** `withMetadataFetch` now fails on a swallowed violation, allow-list gains the S-9 tables, the snapshot / compare / codecheck / security-scan / collectors / P-18…P-20 suites switched (ID-27); code-health writer golden (ID-28); `extension/eslint.config.mjs` + `lint` script + CI step; L5-01 recorded as done under M-6. Open: O-2 fixture corpus + live smoke, L9-03 layout.
- [ ] **P-26 · Fluent emitter core.** `servicenow_generate_fluent` (opt-in `artifacts` package, read-only) — `src/api/fluent.ts`, `src/api/fluent-render.ts`: `.now.ts` + `keys.ts` + `Now.include` sidecars + `Now.ref` for 11 scalar types, `Record()` + `unsupported[]` for the rest, secrets as placeholders, header names SDK 4.12.2 as an O-7 assumption; `format:"file"` under `<SN_DOCS_DIR>/<profile>/fluent/<scope>/` (kind `fluent`, `docsReadRaw`). Open: the type-check oracle (O-7). Tests: `test/fluent.test.js`, `test/fixtures/fluent/`.
- [ ] **Gate (merged tree):** tests **1539/1542** pass, 3 `todo`, 0 fail (extension 14/14, extension lint clean) · coverage 98.14% statements / lines, 89.07% branches, 98.46% functions · build, lint, format, `docs:env --check`, `docs:sync --check` pass · `npm audit --omit=dev` 0 · **`pack:check` fails** (1817.1 KB vs the 800 KB ceiling, owner decision). 97 tools in 26 packages.

## 2026-09-30 — batch 14: E-4, D-3, H-7, D-6 (part), P-12, P-14, P-15, P-19 (UIB), P-21 (UIB), P-24, P-25 (part)

- [x] **E-4 · Validated settings manifest.** `src/core/settings-manifest.ts` (118 zod specs: sections, aliases, profile scoping, `_FILE` sources); readers used across `settings`, `config`, `policy`, `profile`, `logging`, `host`, `auth`; invalid values warn once and fall back, fail-fast behind opt-in `SN_STRICT_SETTINGS`. Tests: `test/settings-manifest.test.js`.
- [x] **D-3 · Generated config docs + counts.** `scripts/env-docs.mjs` (`npm run docs:env`: README env table, `.env.example`, `server.json` env block), `scripts/docs-sync.mjs` (`npm run docs:sync`: tool / package counts in 8 files), both `--check` in `npm run check`; `docs/llms.txt`. Tests: `test/env-docs-generated.test.js`, `test/docs-sync.test.js`.
- [x] **H-7 · HTTP transport v2.** `src/mcp/http-sessions.ts` (`HttpSessionManager`: per-session server + runtime, idle TTL, session cap, SSE keep-alive), Host / Origin guard, `SN_HTTP_REQUIRE_TOKEN`, `buildMcpServer(runtime)`, per-session `use_instance`. Six new `SN_HTTP_*` settings. Tests: `test/http-transport-v2.test.js`.
- [ ] **D-6 · Distribution hygiene (part).** Open VSX job (`OVSX_PAT`-gated), GitHub release job + `scripts/release-notes.mjs`, extension pinned to `servicenow-mcp-ai@3.x`, `publishConfig`. Owner: publish, registry clean-up, `exports` (B10). Tests: `test/distribution.test.js`.
- [x] **P-12 · Playbooks.** `explain_flow` `kind:"playbook"` in `src/api/explain-flow.ts`. Tests: `test/explain-playbook.test.js`.
- [x] **P-14 + P-15 · UI Builder experience tree.** `servicenow_explain_ui_experience` (`src/api/ui-experience.ts`, `src/core/artifacts/uib-composition.ts`), workspaces / dashboards / list menus / applicability. Tests: `test/explain-ui-experience.test.js`.
- [x] **P-19 UIB + P-21 UIB.** Three UIB rules in `src/api/domain-analysers.ts`; workspace page maps in `document_app({detail})`.
- [x] **P-24 · Portal and catalog structural writes.** `children[].parent`, registry `unique` rules and pre-flight, `SCOPE_PREFIX` warning. Tests: `test/upsert-artifact.test.js`.
- [ ] **P-25 · Flow activation toggle (part).** `{active}`-only flow upsert (`FLOW_ACTIVE_ONLY`); instance behaviour waits for O-5.
- [ ] **Gate (merged tree):** tests **1500/1503** pass, 3 `todo`, 0 fail (extension 14/14) · coverage 98.18% statements / lines, 89.22% branches, 98.62% functions · build, lint, format, `docs:env --check`, `docs:sync --check` pass · `npm audit --omit=dev` 0 (lock-only fix for `fast-uri` / `ip-address`) · **`pack:check` fails** (1770.3 KB vs the 800 KB ceiling, owner decision). 96 tools in 26 packages.

## 2026-09-28 — batch 13: D-5, D-7, D-9, P-19, P-22 (remainder), P-23

- [x] **D-5 · Lighter install + containers.** `src/core/secret-files.ts` (`<KEY>_FILE` secret sources, profiles included, KEY + KEY_FILE fail-fast), `Dockerfile` (distroless, non-root, HTTP), `.dockerignore`, `smithery.yaml`, non-loopback HTTP warning, `project/FOOTPRINT.md`. Tests: `test/secret-files.test.js`, `test/container.test.js`. The image was not built locally (Docker daemon I/O failure).
- [x] **D-7 · Extension v2.** Settings `envFile` / `packages` / `transport`, SecretStorage sign-in / sign-out, walkthrough, status-bar doctor (`extension/src/{config,doctor,http-process}.ts`); root lint covers `extension/src`; the CI extension job runs its 14 unit tests. Tests: `extension/src/test/`, `test/extension-manifest.test.js`.
- [ ] **D-9 · Security policy + community files.** SECURITY.md v2, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `.github/CODEOWNERS`, issue forms, PR template, `release.yml`. Tests: `test/community-files.test.js`. Open (owner): private vulnerability reporting, release-note labels.
- [ ] **P-19 · Domain analysers bar UIB.** `src/api/domain-analysers.ts`, 11 rules behind `servicenow_code_health({domains:true})`. Tests: `test/p19-domain-analysers.test.js`.
- [x] **P-22 remainder · SDK guard on batch writes and scope-less creates.** `servicenow_batch` sub-requests, `apps.current_app` scope for creates. Tests: `test/sdk-guard.test.js`.
- [x] **P-23 · `servicenow_upsert_artifact`.** `src/api/upsert-artifact.ts` in the opt-in `artifacts` package; `writeFields` in the registry, `artifact_write` journal link, six error codes. Tests: `test/upsert-artifact.test.js`.
- [ ] **Gate (merged tree):** tests **1409/1412** pass, 3 `todo`, 0 fail (extension 14/14) · coverage 98.16% statements / lines, 89.37% branches, 98.54% functions · build, lint, format pass · `npm audit --omit=dev` 0 · **`pack:check` fails: 1596.2 KB unpacked, over the 800 KB ceiling** (owner decision). 95 tools in 26 packages; `tools/list` `all` ratchet 144,000 (measured 143,644), core 36,000.

## 2026-09-26 — batch 12: M-5, D-1, S-16, P-11, P-17, D-8 (part)

- [x] **M-5 · Dynamic packages + listChanged.** `src/mcp/packages.ts`; every policy-permitted tool is registered at startup and toggled with the SDK `enable()` / `disable()`; new always-on admin tools `servicenow_list_packages`, `servicenow_enable_package`, `servicenow_disable_package` (deny list re-checked, read-only packages stay read-only, session-scoped); package resources / prompts follow toggles; `resources.subscribe` + debounced `listChanged`; new `servicenow_instance_overview` prompt. Tests: `test/dynamic-packages.test.js`.
- [x] **D-1 · `init` wizard + real CLI.** `src/cli.ts` (`parseArgs`; `init`, `doctor`, `login`, `drift`, `support-bundle`; unknown command / option exits 2), `src/server.ts` (`startServer`, no side effects at import), `src/api/support-bundle.ts`, `doctor --json` / `--profile`. Tests: `test/cli.test.js`, `test/support-bundle.test.js`, `test/cli-spawn.test.js`.
- [x] **S-16 · Native discovery.** `servicenow_document_instance({depth: "overview" | "apps" | "artefacts"})` (cumulative) writes `<profile>/discovery/`. Tests: `test/document.test.js` + discovery goldens in `test/fixtures/docs/writers/`.
- [x] **P-11 · Subflows, custom actions, decision tables.** `explain_flow` `kind:"action"`, call expansion (`depth` default 1, max 3, 20 callees, cycle guard), decision-table explainer, `decision_table` R + X in the registry. Tests: `test/explain-decision.test.js`, `test/explain-flow.test.js` + `test/fixtures/explain/action.mmd`.
- [x] **P-17 · Artifact dependency graph.** `src/api/dependencies.ts`, `servicenow_artifact_dependencies` in the opt-in `artifacts` package (outbound + inbound edges, depth 1–3, 150-node cap, `unavailable` per failed source, Mermaid). Tests: `test/dependencies.test.js` + `test/fixtures/explain/dependencies.mmd`.
- [ ] **D-8 part · Plugin skills.** `skills/{sn-discover,sn-triage,sn-impact,sn-drift,sn-safe-write}/SKILL.md`; the `PreToolUse` hook waits for H-3 (O-4). Tests: `test/plugin-skills.test.js`.
- [ ] **Gate (merged tree):** tests **1269/1272** pass, 3 `todo`, 0 fail · coverage 98.43% statements / lines, 89.55% branches, 99.03% functions · build, lint, format pass · `npm audit --omit=dev` 0 · **`pack:check` fails: 1416.6 KB unpacked, over the 800 KB ceiling** (owner decision). 93 tools in 26 packages; `tools/list` measured 137,276 (all) / 34,426 (core), ratchets 138,000 / 35,000.

## 2026-09-26 — batch 11: P-10, P-13, M-1, D-4, E-6 (part)

- [x] **P-10 / P-13 · Flow and workflow explain.** `src/core/artifacts/flow-values.ts` (`detectFlowValues`), `src/api/explain-flow.ts`, `servicenow_explain_flow` in the `flows` package — Flow Designer step tree with decoded values, legacy workflow activity graph, opt-in runs and migration report. Tests: `test/explain-flow.test.js` + `test/fixtures/explain/{flow,workflow}.mmd`.
- [x] **M-1 · Server instructions + configuration state.** `src/mcp/server-info.ts` (`instructions` ≤2 KB, `title` / `icon` / `websiteUrl`), `NOT_CONFIGURED` error code, `get_status` v2 (`server`, `policy`, `writes`, `profileDetails`). Tests: `test/server-info.test.js`.
- [x] **D-4 · Install matrix + one-click links.** `scripts/install-links.mjs`, README "Install in your MCP client" and the docs-site install section. Tests: `test/install-links.test.js`.
- [x] **E-6 part · Test architecture.** Fetch double v2 and fake clock in `test/helpers.js`, property suites (`property-http`, `property-policy`, `property-data`), `test/cli-spawn.test.js`, the cancel-progress flake removed, CI `extension` typecheck job. Three findings (F1–F3) kept as `todo` tests pending the owner. O-2 fixture corpus open.
- [ ] **Gate (merged tree):** tests **1168/1171** pass, 3 `todo`, 0 fail · coverage 98.28% statements / lines, 89.43% branches, 98.94% functions · build, lint, format pass · `npm audit --omit=dev` 0 · **`pack:check` fails: 1298.7 KB unpacked, over the 800 KB ceiling** (owner decision). 89 tools in 26 packages.

## 2026-09-26 — batch 10: S-15 (remainder), M-6, M-9, P-16

- [x] **S-15 remainder · Instance document.** `documentInstance`, `servicenow_document_instance` (`docs`); kinds `catalog`, `integrations`, internal `instance`, `artifact_types`; `<profile>/README.md` + `artifact-types.md`, progress per document, partial on cancel. Tests: `test/document.test.js` + goldens `test/fixtures/docs/writers/{instance-README,catalog,integrations}.md`. `document_kind` open (owner).
- [x] **M-6 · outputSchema + token budget.** 30 tools declare a passthrough `outputSchema` with `structuredContent` (never on errors); manifest v2 (`outputSchema`, `description_sha256`, `since`); descriptions ≤250 chars; `tools/list` byte budget ratchet. Tests: `test/output-schema.test.js`.
- [x] **M-9 · Long-running ops as MCP tasks.** `src/mcp/tasks.ts` behind `SN_EXPERIMENTAL_TASKS=1`; `run_as_task` on snapshot / compare / ATF / code_health / query_table (file); a task-capable tool's output schema has every field optional so the handle validates (M-6 interplay). Tests: `test/tasks.test.js`.
- [x] **P-16 · Service Portal tree.** `src/api/portal.ts`, `servicenow_explain_portal` in the new opt-in `ui` package. Tests: `test/explain-portal.test.js` + `test/fixtures/explain/portal.mmd`.
- [ ] **Gate (merged tree):** tests **1074/1074** pass · coverage 98.29% statements / lines, 90.01% branches, 98.8% functions · build, lint, format pass · `npm audit --omit=dev` 0 · **`pack:check` fails: 1222.8 KB unpacked, over the 800 KB ceiling** (owner decision). 88 tools in 26 packages.

## 2026-09-26 — batch 9: S-10a, S-10b, P-8, S-15 (part 1), E-7 (collector split)

- [x] **S-10a · History, properties, directory, CMDB relations / IRE.** Opt-in `history`, `properties`, `directory` packages; `servicenow_list_ci_relations`, `servicenow_identify_reconcile`; `describeImportRun`; `atf_run({wait_seconds})`. Tests: `test/s10a.test.js`.
- [x] **S-10b · Ops package.** `src/api/ops.ts`, `src/tools/ops.ts` — `servicenow_ops_health`, `servicenow_data_health`, prompt `servicenow_why_is_it_slow`. Tests: `test/ops.test.js`.
- [x] **P-8 · Catalog / quality / AI / application descriptors.** Registry 121 types, `licensed?`, catalog explainers. Tests: `test/explain-catalog.test.js`.
- [x] **S-15 part 1 · Document generators.** `src/api/document.ts`, `servicenow_document_table`, `servicenow_document_app`, prompt gating. Tests: `test/document.test.js` + goldens. `document_instance` open.
- [x] **E-7 part · Collector split.** `src/api/collectors.ts`, unsafe lint rules, `snParams()`. Tests: `test/collectors.test.js`, `test/writer-goldens.test.js`.
- [ ] **Gate (merged tree):** tests **1018/1018** pass · coverage 98.28% statements / lines, 90.96% branches, 98.78% functions · build, lint, format pass · `npm audit --omit=dev` 0 · **`pack:check` fails: 1136.2 KB unpacked, over the 800 KB ceiling** (owner decision). 86 tools in 25 packages.
