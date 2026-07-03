# servicenow-mcp — Done

Completed and verified work, moved out of the reviews and the plan. Active, not-yet-done tasks live in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) and [TODO.md](TODO.md); the work chronology is in [WORKLOG.md](../WORKLOG.md).

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
