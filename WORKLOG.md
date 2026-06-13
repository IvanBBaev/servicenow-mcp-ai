# WORKLOG — servicenow-mcp

> A chronological journal of everything done on the project. Newest first.
> Rule: after every task this file + all affected MD documents (IMPLEMENTATION-PLAN.md, TODO.md, DONE.md, README.md) are updated.

## 2026-06-13 — full-review pass: architect → dev → qa (159 tests)

One `/full-review` pass. Each persona ran as a background workflow that fanned out finders by
dimension and **adversarially verified** every finding (refute-by-default) before it was
recorded — so the false positives never reached the code. All fixes left **uncommitted** for
Ivan's review (his workflow). `npm run check` green after each persona.

- **Architect (ARCH-1, fixed):** the plugin-API availability cache (`api/plugin.ts`) was keyed
  by API label only, unlike every other cache (token/schema/telemetry are host/instance-keyed).
  Under concurrent multi-profile use a namespace-404 on one instance could fast-fail the same
  API on another for up to the 5-min TTL. Keyed by `${instance}|${label}`; `pluginAvailability()`
  filters to the active instance (status-payload contract preserved). +1 regression test.
  5 finder findings refuted (result-truncation "loses total", resource error payload, snapshot
  warnings, snapshot/compare "drift", the hardcoded package list — all false or documented).
- **Dev (DEV-1/2/3, fixed):** two encoded-query `^`-injection holes — `listTables` filter and
  `listAttachments` table/sysId — that K-5 had fixed only in `scripts.ts`. Centralised
  `assertNoCaret` into `api/shared.ts` and applied it in all three (kills the drift that caused
  it). DEV-3: serialized `docs.ts` `regenerateIndex()` through a tail promise so concurrent
  writes cannot drop index entries. +3 regression tests. 1 finding refuted (sys_id uniqueness).
- **QA (17 confirmed / 10 refuted):** all coverage/edge gaps, no bugs. Fixed the high-value
  subset — per-host token invalidation isolation (QA-2), Basic-auth-401-no-retry (QA-3),
  `retryAfterMs` invalid-date fallback (QA-4), a `--functions 60` gate that did not exist (QA-9),
  `listAttachments` happy-path (QA-10), and a whole new `importset.test.js` for the
  previously-untested Import Set API (QA-12). The other 10 (QA-1/5/6/7/8/11/13/14/15/16) are
  tracked in TODO.md for a future wave — not padded. QA-17 was already covered. The refuted set
  included the suggestion to tighten lines/branches — left as-is (intentional headroom, cross-Node
  stability).
- **Totals:** 147 → **159 tests**, coverage 92.0% lines / 78.5% branches / 67.2% functions, audit 0.
  Findings documented in TODO.md under "FULL REVIEW 2026-06-13"; CHANGELOG/PRODUCT-STATE synced.
- **Backlog cleared (same day, second batch):** Ivan said "започвай тоди файла" → implemented the
  10 tracked QA gaps (QA-1/5/6/7/8/11/13/14/15/16): +13 tests across config-store, batch, snapshot,
  attachment, docs, phase3 and a new `aggregate.test.js`. **159 → 172 tests**, coverage up to
  **93.1% lines / 80.1% branches / 69.0% functions**, audit 0. QA-17 confirmed already-covered.
  All findings in TODO.md now closed except the decision/trigger-gated ones (A2-2…A2-5, R-2, R-10,
  S2-4). Still uncommitted for review.
- **R-10 + S2-4 (third batch, "започвай тодо файла" again):** Ivan chose the free unscoped npm name
  **`servicenow-mcp-ai`** (`servicenow-mcp` is taken; `@ivanbbaev/...`, `sn-mcp-server`,
  `servicenow-mcp-ts` were the other free options). Coherent rename across `package.json` name/bin,
  `bin/servicenow-mcp-ai.cjs` (git mv), the MCP server handshake name + log/guard messages, the XDG
  dir `~/.config/servicenow-mcp-ai`, `.vscode/mcp.json`, the CI launcher path and the README; GitHub
  repo URLs stay `servicenow-mcp` (repo unchanged). **S2-4 release process** scaffolded:
  `publish.yml` (tag-driven, `--provenance`, tag↔version guard, runs `npm run check`), an
  `npm run release:dry`, and a CONTRIBUTING "Releasing" section. `npm run release:dry` green →
  `servicenow-mcp-ai-1.0.0.tgz` (57 files, no maps). 172 tests still green, audit 0. Remaining open
  TODO items are all trigger-gated (A2-2…A2-5) or need a browser (R-2, check the first Actions run +
  set the `NPM_TOKEN` secret before publishing). Still uncommitted.

## 2026-06-12 (night) — repo-standard pass (147 tests)

- **Audit (Phase 0):** history clean (one author, the personal email, no AI trailers), `.env` never tracked, no junk in `git ls-files`, the gates are real (coverage gate 85/72 vs a measured 91.4/77.9), `npm audit` 0. Weakest category: release readiness — **the npm name `servicenow-mcp` is taken** (v1.2.0, unrelated maintainer `timschwarz`) → new blocker **R-10** in TODO.md. `gh` is not installed on this machine, so the first-Actions-run check (R-2) needs the browser.
- **Package metadata (`ac11df9`):** `repository`/`homepage`/`bugs` point at the real GitHub repo (closes R-4); description 49 → 53 tools in 15 packages, guarded by a new drift test against the live registry; `build/**/*.map` excluded from the tarball — the maps reference the unshipped `../src` and resolved to nothing (110 → 57 files, 92 → 62 kB packed).
- **Gates (`7843494`):** new `npm run check` = build + lint + format:check + coverage-gated tests + `npm audit --omit=dev --audit-level=high`; `prepublishOnly` runs it now; `c8` pinned as a devDependency (CI used a floating `npx c8`); CI gains a macOS leg (Node 22) and a prod-audit step, with the gate steps kept on ubuntu for cost.
- **Docs (`8bd3c6a`):** CONTRIBUTING.md (setup, gates, the conventions that lived only in this worklog) + SECURITY.md (model summary, reporting, the two accepted risks linked to TODO); README: a table of contents, an honest Develop section (`npm test` does not build first), the docs table without the stale "(Bulgarian)" label; TODO: R-4/R-9 closed, R-2 narrowed, R-10 added; CHANGELOG Unreleased + PRODUCT-STATE refreshed (147 tests, the new gates).
- **Verification:** `npm run check` green — 147/147 tests, coverage 91.38% lines / 77.9% branches, audit 0 vulnerabilities; `npm pack --dry-run` clean (LICENSE + README + bin + build, no maps). Pushed to origin/main — the first real CI run should now appear (check Actions in the browser, incl. whether the Windows job is green → drop its `continue-on-error`, closing R-2).

## 2026-06-12 (night) — Phase 7 completed: MI-6…MI-8 (146 tests)

Done by the release session in parallel with the rebrand/translation session; the two coordinated by staging explicit file lists only.

- **MI-6 · `servicenow_snapshot_instance` (`7037303`):** new `instance` package. Snapshot of tables (md+json), schema of the explicitly passed tables, plugins (v_plugin → sys_plugins fallback), apps, automation stats per script type (one Aggregate call each), index.md — all under `SN_DOCS_DIR/<profile>/` through the existing api/ layers. A failing section becomes a warning instead of failing the snapshot; the docs traversal guard gained an extension whitelist (`docsWriteRaw`, .json allowed internally — the tool surface stays .md-only). 3 tests: full file set, idempotent re-run + unsafe-name skip, plugin fallback + warnings.
- **MI-7 · `servicenow_compare_instances` (landed inside `82aad61`):** each side runs in its profile's ALS context; one `sys_dictionary` pull and one pull per script type per side (no per-table N+1). Diffs: tables only in one, column type/mandatory/reference drift on common tables, scripts by SHA-256 (`only_in_a`/`only_in_b`/`different_source`), plugin/app inventory. `from_snapshot` prefers the MI-6 JSON with live fallback + warning; report in `_compare/<a>-vs-<b>.md`. 3 tests with two mock hosts. Note: the commit also carries the parallel session's translation — it swept the staged files; functionally complete, history slightly mixed.
- **MI-8 · per-profile resources (`fb85be0`):** `servicenow://instances` + `servicenow://{profile}/schema/{table}` registered via the instance package's PackageSpec.resources (A2-1 paying off); new shared `profilesPayload()` in mcp/status.ts so `servicenow_list_instances` and the resource can never drift (the A-5 lesson); К-7 resource contract updated. 3 in-memory MCP client tests (no passwords in the payload, reads go to the named profile's host, unknown profile → JSON error).
- **Totals:** 53 tools in 15 packages, 6 resources, 146/146 tests, build/lint/format clean.

## 2026-06-12 (night) — rebrand: sincronia-mpc → servicenow-mcp (commit `b88e503`)

- **Scope:** package name + bin (`bin/servicenow-mcp.cjs`, git mv) + the Node guard message; MCP server name `servicenow-mcp`; the XDG config path `~/.config/servicenow-mcp/.env`; `.vscode/mcp.json`; the CI launcher path; copilot-instructions; all 8 MD documents; the package-lock name fields. Remaining "sincronia" in the codebase: 0.
- **Migration note:** an existing `~/.config/sincronia-mcp/.env` will not be found under the new name (the project-root .env Ivan uses is unaffected). The local folder stays `sincronia-mpc` — renaming the working directory of a live session is risky; a clone from the new repo brings the name automatically.
- **Verification:** build/lint/format/137 tests green; the launcher under a real Node 12 prints the new name.
- **Next:** Ivan provides the repo URL → git remote + push (closes R-2) + repository/bugs/homepage in package.json.

## 2026-06-12 (night) — Phase 7 started: the multi-instance core (137 tests)

### Context

Ivan: "get everything into the documentation and start the implementation" → docs synced (incl. ARCHITECTURE for PackageSpec/per-host/strict schemas), then Phase 7 began per the plan. MI-1…MI-5 are done; MI-6 (snapshot), MI-7 (compare), MI-8 (per-profile resources) remain.

### MI-1 · Named profiles (commit `07170cf`)

- **Design:** `SN_PROFILE_<NAME>_INSTANCE/_USER/_PASSWORD` define profile `<name>`; the bare SN_INSTANCE/USER/PASSWORD are the `default` profile — full backwards compatibility (not a single existing test was touched). The ConfigStore became a `Map<profile, snapshot>` with the same atomicity (single-assignment swap); `activeProfile()` reads SN_ACTIVE_PROFILE; `useProfile()` validates against `listProfiles()`, persists, and clears the snapshots — the identity caches are cleared by the caller (the admin tool), because core cannot import api/ (the layer rule).
- **Tests:** back-compat, named profiles + ACTIVE_PROFILE, prefixed writes without touching the bare keys, switching + both error kinds. The README env table + .env.example in the same commit.

### MI-2 + MI-4 · Per-profile policy + profile admin tools (commit `84f283f`)

- **MI-2:** the policy getters go through `policyValue(suffix, profile)` — profile override → global fallback. The real scenario is tested in both directions: prod READONLY=true blocks writes with no network even when globally allowed; dev READONLY=false opens writes under a global SN_READONLY=true.
- **MI-4:** `servicenow_list_instances` (name/host/user/readOnly/hasCredentials, **never passwords**), `servicenow_use_instance` (useProfile + invalidateTokens + clearSchemaCache + clearPluginAvailability — nothing cached under the old identity survives), `set_credentials` with an optional `profile` (incl. creating a new profile); buildStatusPayload shows activeProfile + profiles (output schema extended). Manifest/README regenerated → 51 tools; the core contract updated (lesson: the list is sorted — 'upload' < 'use').

### MI-3 · AsyncLocalStorage context (commit `15785db`)

- **The key decision of the phase:** instead of threading a profile through 20+ api functions, `core/request-context.ts` holds an ALS; `activeProfile()` consults the per-request context first. `runSpec` routes when `instance` is given (validated; unknown → a clear fail with no network; the profile joins the log fields), and the registry adds the auto-parameter to every schema — **except** when a tool already uses the name (`set_credentials.instance` = the host; the collision is avoided via `hasAutoInstanceParam`).
- **Test:** through the real MCP layer — `instance:"dev"` hits dev1.service-now.com, no argument hits the default host, an unknown profile → isError without fetch.

### MI-5 · Per-host cache/telemetry — checked off

Delivered earlier: S2-2 (per-host semaphore + perHost telemetry) and О-3 (schema cache keys with the instance). The plan was just checked off with references.

### Note on parallel work

The second session added coordination rules (memory: parallel-sessions-hazard) — from here on: explicit staging, no amend/reset. My two earlier amends got through without collision by luck; the rule is followed going forward.

## 2026-06-12 (late) — the triple-analysis backlog implemented (131 tests)

### What landed (one commit per task; "start it" from Ivan)

- **S2-1 · strict zod schemas (`e879321`):** dug into SDK 1.29 — `normalizeObjectSchema` accepts ready object schemas, not only raw shapes → the registry passes `z.object(spec.input).strict()`. A typo'd argument (`tabel`) is now a validation error, not a silent unfiltered query. Smoke test: 0 fetches.
- **S2-2 · per-host semaphore + telemetry (`13a2810`):** each instance has its own concurrency limit and its own counters; `getTelemetry()` returns the aggregate + `perHost` (in status; output schema extended). Ready for Phase 7.
- **Q2-4+Q2-5 (`9ef092b`):** a perf guard — 10k records through the halving truncation < 2 s; the elicitation **accept** path tested (confirm=true → saved to a temp SN_ENV_FILE). Lesson: the first commit went in before the full suite — a failure from leaked env state (saveCredentials mutates SN_USER); fixed with `baselineEnv()` in finally and the commit amended. The "full suite before commit" discipline is even more mandatory.
- **Q2-1+Q2-2 (`b8b9216`):** a coverage gate in CI from the real report (lines 89.9% → gate 85; branches 78.8% → 72); fast-check property tests — 500 random strings through the formatEnvValue→dotenv round-trip (refusal is a valid outcome) + 200 random buffers through base64 encode→strict decode→byte equality.
- **S2-3+Q2-3 (`ac14952`):** CI job `launcher-node12` (a node:12-alpine container — a human message + a non-zero exit); a `windows-latest` job with continue-on-error until the first green run; the build script is now cross-platform (chmod via node fs, not a unix command).
- **A2-1 · PackageSpec (`5daad20`):** a package = ONE object {name, tools, resources?} in the PACKAGES manifest; ALL_TOOLS is derived; a runtime invariant (the tool tag ≡ the manifest package); registerResources is declarative from the manifest (the manual К-7 if deleted); resources.ts became three standalone registrars and the resources→registry cycle disappeared.
- **Trigger-bound (not done now):** S2-4/R-3 release process (waiting on the publish decision), A2-2 (MI follow-up), A2-3 ("when it hurts"), A2-4 (at Х-8), A2-5 (the MCP protocol).
- **In parallel (the other session):** R-1 MIT license + R-4 npm metadata (`fc1f62c`), R-6 a single tool count 49/14 (`08b71cc`), CI hygiene for the coverage artifacts. R-5/R-7/R-8 were closed by my commits.

## 2026-06-12 — release-readiness analysis (analysis only, no code touched)

### Task

Ivan asked for an assessment of how release-ready the project is by best standards.

### Steps

- [x] Real verification on Node 22: clean build, clean ESLint, **128/128 tests** (127 + 1 from the uncommitted WIP), coverage 89.4% lines / 78.2% branches / 62.5% functions.
- [x] `npm run verify` fails on Prettier — but only because of the **uncommitted WIP** in `src/mcp/registry.ts` (+ a new test in `test/mcp-smoke.test.js`); the HEAD version is formatted correctly.
- [x] `npm pack --dry-run`: 76 kB / 101 files, only build+bin+README — nothing leaks.
- [x] `npm audit --omit=dev`: 0 vulnerabilities (3 runtime dependencies).
- [x] Findings shaped as the **R-1…R-9** checklist in TODO.md (new "Release-readiness 2026-06-12" section); the duplicated won't-fix header removed; the TODO.md compass row in PRODUCT-STATE.md updated.

### Execution (same evening, on "start it")

Ivan's decisions: **MIT**, **no remote for now** (prepared for push), **WORKLOG/.claude stay tracked**. A second session was running in parallel (S2-1, Q2-1/Q2-2, S2-3/Q2-3 — commits `e879321`, `b8b9216`, `ac14952`), hence: staging only specific files, no `git add -A`, verification in a separate worktree from HEAD.

- [x] **Hygiene:** `coverage/` into .gitignore/.prettierignore (`b0fe260`); the 24 committed c8 artifacts removed from history (`a3a388b`) — they had been swept in by a bulk add in `e879321`.
- [x] **R-1+R-4:** LICENSE (MIT) + `license`/`author`/`prepublishOnly` in package.json (`fc1f62c`). `repository`/`bugs`/`homepage` remain for when there is a remote.
- [x] **R-6:** pie 46→49 (+email:2, admin:3), CHANGELOG 46/12→49/14, test count → 131 (`08b71cc` + the release cut).
- [x] **R-3:** CHANGELOG cut to `[1.0.0] - 2026-06-12` (+ entries for strict zod, the license, the property tests, the CI gate); annotated tag `v1.0.0`.
- [x] **Verification:** a worktree from HEAD + `npm ci` + `npm run verify` — build/lint/format clean, **131/131 tests**. R-7/R-8 turned out done by the parallel session — only checked off.

### Result — what was missing for a release (nothing fixed in this pass)

1. **Blocker: no LICENSE file and no `license` field in package.json.**
2. **Blocker: no git remote** — the CI workflow had never actually run.
3. package.json without `repository`/`author`/`bugs`/`homepage`; no `prepublishOnly`.
4. No release process (known — S2-4): version 1.0.0 from day one, CHANGELOG only [Unreleased], zero tags.
5. Minor doc drift: package.json said "49 tools", the PRODUCT-STATE pie + CHANGELOG said 46; TODO.md had a duplicated "won't-fix" header.

## 2026-06-12 — implementing the review tasks

> Ivan's instruction: the worklog must be **detailed** — per task: problem, solution, files, tests, commit.

### П-1 · git init + baseline (commit `2424fcf`)

- **Why:** the project was not a git repository — the "one task = one commit" rule could not apply, and refactoring had no safety point.
- **What:** `git init -b main`, local git identity, a baseline commit of the whole working state (28 tools, 59 tests green at the time). `.gitignore` already covered `.env`, `node_modules/`, `build/`.
- **Files:** no code changes — just the new `.git`.

### S-1 + S-2 · describe_table sees inherited columns (commit `9d8da51`)

- **Problem (critical):** `describeTable` queried `sys_dictionary` with only `name=<table>` — but in ServiceNow inherited fields live on the parent. For `incident` the answer had no `short_description`, `priority`, `state`… (defined on `task`) — the LLM would fail on every create/update of an extended table. Also `listTables` read `super_class` as a display value (the label "Task"), useless for chain walking.
- **Solution:** a new `getTableChain(table)` in api/meta — iteratively walks `sys_db_object.super_class.name` (dot-walk, raw values; guard: depth ≤ 20 + cycle check). `describeTable` queries with `nameIN<chain>^elementISNOTEMPTY`; on a duplicated `element` the entry closest to the child wins (rank by chain position); a new `sourceTable` column shows where a field is defined. `listTables` passes `fields: ["name","label","super_class.name"]` with `displayValue:"false"`.
- **Files:** `api/meta.ts` (rewritten), `test/meta.test.js` (new: chain, child override, unknown table, dot-walk), `test/helpers.js` (new — shared `baselineEnv`/`withEnv`/`withFetch`/`jsonResponse`, the start of Q-2), `test/diagrams.test.js` (the mock now also serves the `sys_db_object` request).
- **Tests:** 63 green (4 new); build + lint clean. Found along the way: `api/diagrams.ts` + its tests had appeared in the repo meanwhile (Phase 5 Mermaid) — their one broken mock was adapted.

### Q-3 · tests for the uncovered harness behaviours (commit `b6469f1`)

- **Problem:** the most complex logic in the codebase had zero tests: the `fetchAll` pagination, the truncation loop in `okQueryResult`, the retry matrix, the `pluginCall` 404 decoration, the settings env parsers.
- **Solution:** 5 new test files, 17 tests, all over mock fetch (zero network): `fetchall.test.js` — multi-page pagination, the empty probe page on exact division, the SN_MAX_RECORDS cap (incl. the last request asking only for the remainder), a starting offset; `result.test.js` — passthrough under the limit, halving truncation with the explanatory note and the limit respected, degradation to 0 records; `http-retry.test.js` — transport error: GET retries / POST does not, a received 502: retry for GET, instant error for POST, Retry-After as an HTTP date; `plugin.test.js` — the 404 hint + 403 passthrough; `settings.test.js` — the positiveInt contract for the four env vars.
- **Expectation correction along the way:** with an offset and exact division fetchAll makes one extra probe request — the test documents that explicitly.
- **Files:** `test/` only. **Tests:** 80 green (from 63).

### Q-1 + Q-4 · in-memory MCP smoke tests (commit `f13f316`)

- **Problem:** the MCP surface (zod schemas, snake_case→camelCase argument mapping, `ok()`/`fail()` envelopes, package gating) had zero tests — swapped arguments in a tool handler would never be caught by the api/ unit tests.
- **Solution:** `test/mcp-smoke.test.js` — a real SDK `Client` + `McpServer` over `InMemoryTransport` (no network, no stdio), mock fetch underneath. 7 tests: (1) **a contract snapshot** — the core profile exposes exactly the enumerated tools (a contract change breaks the test on purpose; overlaps М-6); (2) `all` ⊇ core + the gated packages; (3) a callTool happy path; (4) invalid input → error with **no** network call; (5) an SN 403 → a structured fail() payload; (6) a gated tool is not callable from core; (7) the `servicenow://status` resource — configuration without the password.
- **Found while writing:** SDK 1.29 returns "unknown tool" as an isError result, not a protocol exception — the test accepts both forms.
- **Files:** `test/mcp-smoke.test.js` only. **Tests:** 87 green (from 80). Along the way: the SDK turned out to be 1.29 already (Х-1 done in the meantime) and new docs/diagrams/prompts modules exist — 46 tools by then.

### S-6 · batch policy covers stats/import/cmdb (commit `6ad6821`)

- **Problem:** `tableFromUrl` recognised only `/api/now/table/...` — a denied table stayed readable through batch with a Stats/Import/CMDB URL (an allow/deny bypass).
- **Solution:** the regex covers `/api/now/[vN/](table|stats|import)/{t}` and `/api/now/[vN/]cmdb/instance/{class}`. Test: 5 URL variants against a deny list → 403 before any network.
- **Files:** `api/batch.ts`, `test/batch.test.js`. **Tests:** 88 green.

### S-3 + S-4 · attachment correctness (commit `385fd57`)

- **Problem (S-3):** `Buffer.from(s, "base64")` never throws — the try/catch was dead code and invalid input silently uploaded a corrupted file. **(S-4):** the size guard ran AFTER `arrayBuffer()` — a 1 GB attachment was pulled fully into memory just to be refused.
- **Solution:** `decodeBase64Strict` (regex + length % 4; whitespace tolerated as in MIME); `downloadAttachment` reads the metadata first and refuses on `size_bytes` (×4/3 estimate) before downloading — the post-check stays for a missing/stale size_bytes.
- **Files:** `api/attachment.ts`, new `test/attachment.test.js`. **Tests:** 92 green.

### S-7 · the OAuth cache is cleared on credential changes (commit `946ea2d`)

- **Problem:** the tokenCache key is `host|client|grant|user` — the password is not part of it, so a token obtained with the old password survived its rotation.
- **Solution:** a new `invalidateTokens()` in auth (no config↔auth import cycle), called by `servicenow_set_credentials` after `saveCredentials`. Reusable for К-1 (401 invalidation). Test: cached token → invalidate → a fresh token on the next request.

### S-5 + S-8 · quick fixes (commits `5c31ec7`, `70a961d`)

- **S-5:** `servicenow_aggregate` without count/avg/min/max/sum now returns `fail()` with a clear message and no network call.
- **S-8:** `search_code` logged the search text (potentially personal data, against the logging ground rule) — now `textLength` + `type`.
- **Tests:** 93 green.

### Evening deep research: the best-practices batch (commit `a84b6d5`) + the triple analysis → TODO

- **Ivan's request:** deep research on best-practice improvements + implementation; then a triple analysis of what is missing → into the TODO log.
- **Found and implemented:**
  1. **Invisible Prettier drift in 34 files** — format:check was missing from CI. The whole repo formatted; `format:check` added to CI; README.md and docs/instance/ into `.prettierignore` (generated content — prettier would reflow the generated table and break the sync test).
  2. **`npm run verify`** — one command = CI parity locally (build + lint + format:check + test).
  3. **Crash handlers** in index.ts: `unhandledRejection` is logged (does not kill the stdio server), `uncaughtException` logs and exits 1 — no undefined state.
  4. **A real staleness bug:** the plugin availability cache was keyed by API label (not host) — switching instances on the fly carried up to 5 minutes of a foreign cache; the schema cache also survived. `set_credentials` now clears everything cached under the old identity (tokens + schemas + plugin availability). `_resetPluginAvailability` → `clearPluginAvailability` (now a prod API, not a test hook).
  5. **package.json hygiene:** the description lied ("Table API only") — updated; keywords added.
- **The triple analysis (what is MISSING)** — a new section in TODO.md: S2-1…S2-4, A2-1…A2-5, Q2-1…Q2-5. A prioritized backlog — nothing blocking.
- **Verification:** `npm run verify` green (127/127).

### Phase 6 finale: the М series + the Х series (122 → 127 tests) — "modules in and out"

- **Ivan's request (mid-work):** the project must be well modularised, follow OOP principles, and allow easy plugging of modules in/out. That is exactly М-3/М-4 — delivered.
- **М-1 (`5e6cd04`):** git mv of 14 files into `core/` (level 0, no MCP SDK), `api/` (level 1, core only), `mcp/` (level 2, the SDK), `tools/` (level 3); 56 import paths rewritten by script + a manual registry fix (a partial prefix did not match). Test imports updated in the same commit (no shims — cleaner than the plan). Zero behaviour change.
- **М-2 (`ab6c252`):** the layer rules are machine-enforced — `no-restricted-imports` zones per directory; the criterion verified with a deliberate api→mcp import (it failed). The `test_connection` logic moved to `api/diagnostics.ts` to obey the very tools⇍core/http rule it introduced.
- **М-3+М-4 (`71b6058`) — the heart of the modularity:** a new `mcp/define.ts` with `ToolSpec` (name/docs/package/annotations/zod input/logFields/handler — **one object is the whole tool**) and `runSpec` (uniform logging/errors — tools/util.ts deleted). The 13 tools files became pure data: `export const specs: AnyToolSpec[]`. The registry is simple: `ALL_TOOLS = [...tableSpecs, ...metaSpecs, …]` — **a package plugs in/out with one line**; `ALL_PACKAGES` is derived from the data; readonly packages are a filter on `annotations.readOnlyHint` (the Proxy facade deleted); `describeAllTools()` reads the manifest directly (the capturing stub deleted). **Proof of invariance:** the manifest snapshot and the README sync test passed without regeneration — the surface is byte-identical after a ~1500-line refactor.
- **Х-7 (`5f95db9`) — the modularity in practice:** the whole email package (api + 2 specs) entered with 1 import + 1 spread; the `all` profile and the README/manifest saw it automatically. 49 tools, 14 packages.
- **Х-2+Х-4+Х-5 (`f15bb5d`):** elicitation confirmation for credentials (graceful fallback for clients without the capability — nothing breaks); the MCP logging mirror via `setLogSink` (a low-level attach — one point in `emit()`); `outputSchema`+`structuredContent` optional in the spec, applied only to the two stable diagnostic tools — the deviation from the plan (no query_table etc.) is argued: duplicating structuredContent would double the tokens О-2 fights against.
- **Verification at every step:** build + lint (incl. the boundary rules) + the full suite; 127/127.

### Phase 6 sprint: audit + 17 plan tasks (16 commits, 107 → 122 tests)

- **Ivan's request:** "verify everything in the implementation plan, move what is done into the documents; then continue with whatever is needed".
- **Audit:** every Phase 6 task checked against the code. Actually done beforehand: П-1 (git, mine), Х-1 (SDK 1.29 — found), Х-3 (prompts.ts — found), М-5 (in substance = A-8). Everything else confirmed not done. The plan annotated, DONE extended.
- **П-2 · Node 20+ guard (`2a84eb3`):** the key insight — a guard inside an ESM graph **cannot** catch Node 12, because the whole graph is parsed before anything executes (the SyntaxError in the SDK files comes first). Hence: a CJS launcher `bin/servicenow-mcp.cjs` (Node-12-parseable syntax only; bin points to it) + a second guard in index.ts for direct starts (catches 14–18) + `engines>=20` + `.npmrc engine-strict`. **Verified under a real Node 12.22.12** — a human message, exit 1.
- **К-1+К-2 · OAuth resilience (`b48a4f1`):** a 401 in oauth mode → `invalidateToken(host)` (clears only that host's keys) → a single retry with a fresh token (a flag, not a loop); Authorization is now computed per attempt (with 8 s × N backoff a token could expire between tries). Tests: 401→re-auth→200 with exact request counts; a double 401 → error.
- **К-3 (`61cbd26`):** fetchAll without ORDERBY gets `^ORDERBYsys_id` — offset pagination was unstable under concurrent writes. Explicit ORDERBY and single-page reads untouched.
- **К-4 (`b10a50c`):** batch URLs require the `/api/` prefix — `/oauth_token.do`, `/login.do` were reachable through batch (same host, outside the policy model).
- **К-5 (`ff3e826`):** `^` in the text/name/table filters is rejected with a clear error — it is the encoded-query separator and SN has no escape; a raw `^` silently distorted results.
- **К-6 (`d0e2822`):** set_credentials calls resolveHost before saving — an invalid/SSRF host is refused structurally without touching .env/process.env/store. The won't-fix decision on host switching stands (this is format validation).
- **К-7 (`07006b5`):** resources register by the package policy (tables/schema → `schema`, docs → `docs`, status always); SN_PACKAGES_DENY respected too.
- **К-8 (`5002c2d`):** CI matrix Node 20/22/24, a c8 coverage step (visibility, no gate yet), `npm test` no longer duplicates the build (CI does it separately; locally: `test:full`).
- **М-6 (`ae7d123`):** a snapshot of the full manifest `{name, package, title, annotations}` against a checked-in JSON fixture (`npm run gen:manifest`); describeAllTools carries the full annotations. Every surface change is a visible diff.
- **О-1+О-2 (`05b0341`):** reference link URLs excluded by default (−20–40% tokens; opt-out SN_INCLUDE_REF_LINKS); JSON output compact (pretty ~×2 tokens; opt-in SN_RESULT_PRETTY). The truncation maths measures the real size.
- **О-3 (`103ab7f`):** a new cache module — `cached(key, fn)` with a TTL from SN_SCHEMA_CACHE_TTL_SEC (300 s; 0 disables), applied surgically only to list_tables/describe_table (also saving the inheritance-chain requests) and get_cmdb_meta; the key includes the instance for Phase 7.
- **О-4+О-5 (`84ccbb5`):** a counting semaphore around fetch (SN_MAX_CONCURRENT=4) + telemetry {requests, retries, errors by status, totalMs} in the status surfaces. Tests: max in-flight=2 with 6 parallel calls; the counters after a 429 retry and a 403.
- **Х-6 (`373688b`):** servicenow_test_connection — diagnoses "does it work", not just "what is configured": 1 sys_user record directly through snRequest (a table deny list must not mask diagnostics), result {ok, status, latencyMs, user}; failures structured (ok:false) so the model reacts. Manifest + README regenerated (47 tools); README Requirements → Node 20+.
- **Env discipline:** every new variable (SN_INCLUDE_REF_LINKS, SN_RESULT_PRETTY, SN_SCHEMA_CACHE_TTL_SEC, SN_MAX_CONCURRENT) entered the README table + .env.example in the same commit.
- **Remaining from Phase 6 then:** М-1/М-2 and М-3/М-4 (the big refactor); Х-2/Х-4/Х-5/Х-7/Х-8.

### Architecture documentation: ARCHITECTURE.md + PRODUCT-STATE.md

- **Ivan's request:** "MD files for architecture documentation; the product state — how far, what, how; Mermaid diagrams".
- **Structural decision:** two files with different readers — ARCHITECTURE.md answers "how it is built" (a developer entering the code), PRODUCT-STATE.md answers "what exists and what doesn't" (a status view). Duplication with DONE/the plan kept deliberately minimal: the state file synthesises and points, it does not repeat.
- **ARCHITECTURE.md (11 sections, 5 Mermaid diagrams):** the layered module graph; a sequence diagram of the full request lifecycle (incl. the retry matrix); a flowchart of the two-axis security model (+ what it deliberately does NOT protect — the won't-fix decisions); the auth diagram (cache key without the password → why invalidateTokens exists); the package gating diagram. Plus: the configuration model, errors/results, the test architecture as a per-level table and **condensed ADRs** with the rejected alternatives.
- **PRODUCT-STATE.md (7 sections, 2 Mermaid):** TL;DR; the ServiceNow API coverage table (✅/📋 with exact plan task IDs); how it is built; the tools-per-package pie (sum verified); the history timeline; the roadmap; known limitations; the document compass.
- **README:** a new "Project documentation" compass section.
- **Checks:** the numbers verified against reality; the pie sum checked by hand; the Mermaid syntax reviewed construct by construct. All green after the change.

### A-2 · ConfigStore for credentials (commit `290a346`)

- **Context:** the last HIGH finding of the review. `set_credentials` mutated `process.env` + the file while every module read env per call — the credentials had no owner, and Phase 7 would multiply the scattered reads.
- **Considered options:** (a) a read-through store — rejected: zero change vs. today, just indirection; (b) a full ConfigStore for all SN\_\* settings — rejected for now: the plan deliberately puts that after the М-1/М-2 move, otherwise the refactor happens twice; (c) **a snapshot store for credentials only** — chosen: small, gives structural atomicity, and is exactly the anchor MI-1 extends into profiles.
- **Implementation:** a module-level snapshot; `getCredentials()` snapshots env on first read and then returns a **copy** of the same immutable object; `saveCredentials()` writes the env file + `process.env` (for child processes/back-compat) and swaps the snapshot with a **single assignment**; a new `reloadCredentialsFromEnv()` for startup/tests.
- **Test adaptation:** `baselineEnv()`/`withEnv()` reload the store after staging env. New `test/config-store.test.js`: direct env mutation without reload does NOT leak to readers; the snapshot is a copy; saveCredentials persists/swaps/leaves other keys alone.
- **Verification:** build + lint + 105/105.

### A-8 · the README tools table is generated from the code (commit `5bd5489`)

- **Context:** the README had a 46-row hand-maintained tools table that drifted with every change. The plan deferred this to М-5 after the М-3 manifest.
- **Key decision:** don't wait for the manifest. The registrations ARE the source of truth — `describeAllTools()` replays all registrations against a capturing stub, no server, no network. When М-3 arrived, the function simplified but the interface and generator stayed.
- **Generator:** builds a `Package | Tool | Read-only | Description` table (description = the first sentence, pipe-escaped, capped at 110 chars) and splices it between `GENERATED:TOOLS` markers; `npm run docs:readme`. The hand-written table was replaced — hand-polished descriptions deliberately traded for a drift guarantee.
- **Guard:** `test/readme-sync.test.js` — byte-for-byte comparison (the failure message says exactly what to run); every package contributes tools and every tool has a name/description/readOnly flag.
- **Remainder:** the env table stays manual — noted in the plan.

### Q-6 + the final TODO.md cleanup

- **Q-6 (procedural) — institutionalised:** rule 7 in the plan: every behavioural change ships with a test in the same commit; the guards are automatic — the README sync test, the core contract snapshot and the full suite.
- **The old optional items from 2026-06-11** routed to their places: trust boundary → Х-2; MCP logging capability → Х-4; the PDI integration suite + Export API → the plan's "Optional" section; the roadmap item exhausted; "changelog at publish" — **closed with CHANGELOG.md**.
- **End state:** TODO.md held only the two won't-fix decisions. Everything else: implemented → DONE.md, or planned → IMPLEMENTATION-PLAN.md. **The 2026-06-12 review: 22/22 closed.**

### A-1 · per-package policy (commit `90668d3`)

- **Problem (HIGH):** the policy model was table-centric — `SN_TABLES_DENY=change_request` stops the Table API path, but the Change Management API keeps reading/writing changes. A second control axis for the plugin APIs was missing.
- **Solution:** two new env vars: `SN_PACKAGES_DENY` (drops a whole package regardless of `SN_TOOL_PACKAGES`) and `SN_PACKAGES_READONLY` (registers only tools with `readOnlyHint: true` — write tools simply don't exist for the model). A new `effectivePackages()` — the single source for enabled/denied/readOnly, used by the registry and the status payload. Docs: the README env table + the explicit "table deny ≠ plugin deny" note in the security section; `.env.example` extended.
- **Files:** settings, registry, status, README, .env.example; tests in mcp-smoke (deny removes the whole package; readonly keeps the read tools) and settings.test. **Tests:** 102 green.
- **Technical detail:** `Parameters<McpServer["registerTool"]>` resolves to `never` (a generic overload) — the facade was typed as a loose passthrough without touching the arguments.

### Q-5 (remainder) · SN_LOG_LEVEL tests (commit `be291e6`)

- 4 tests on the log filter: default info (debug dropped), error silences the rest, debug lets everything through, an unknown level → fallback to info; the JSON structure verified (ts/level/message/fields). `console.error` captured — zero code changes.

### Reorganisation: done items → DONE.md (Ivan's instruction)

- Everything implemented from the review (19/22 findings at the time) moved from TODO.md into DONE.md as compact summaries with commit references; TODO.md kept only the then-open A-2, A-8 and Q-6.

### A-4 + A-5 · deduplications (commits `da3f056`, `4028969`)

- **A-4:** the `if (!data || data.result == null) throw` check existed in 7 copies. New `api/shared.ts` with `expectResult`/`expectResultArray` — one place, one message.
- **A-5:** the status payload was built in the admin tool AND in resources.ts — already diverged (the resource lacked `enabledPackages`). A new shared `buildStatusPayload()` — one source for both surfaces.

### A-6 · noUncheckedIndexedAccess (commit `021cfa4`)

- **Why:** the code constantly indexes external SnRecords and arrays — the compiler was silent about `undefined`.
- **What:** enabled in tsconfig; 6 files fixed with real guards (no `!`): regex groups via locals, `lines[i]` → `entries()` iteration, descriptor lookups with `continue`, IP octets with defaults, `PROFILES.core` → a constant. Zero behavioural changes, 93 tests green.

### A-7 · type-checked ESLint + snString (commit `42e1d5f`)

- **What:** `recommendedTypeChecked` over `src/` (projectService), explicit `@typescript-eslint/no-floating-promises: error` (a forgotten await in an async handler swallows errors silently); unsafe-assignment/member-access deliberately off (SN payloads are untyped JSON).
- **A rule's finding:** `no-base-to-string` caught a real trap — `String(unknown)` over an SN field at `display_value=all` (an `{value, display_value}` object) yields `"[object Object]"`. New `snString()` (scalars → text, objects → `""`), applied at 16 sites. Plus `require-await` fixes, unnecessary type assertions removed, the OAuth grant validation without a cast.

### Q-2 · unified test helpers (commit `edcd07b`)

- The 6 older test files duplicated the env block + `withFetch` + `jsonResponse` — migrated to `test/helpers.js` (~150 lines less). The tests are ready for a shared-process runner; env is touched only through `baselineEnv`/`withEnv`.

### A-3 · capability cache for the plugin APIs (commit `3cd86cb`)

- **Design decision:** a 404 from a plugin API means two different things — a missing namespace (the plugin is inactive: "does not represent any resource") or a missing record on a working API ("No Record found"). **Only** the namespace variant is cached (5-minute TTL) — otherwise a valid "record not found" would lock the whole API.
- **What:** with a cached namespace 404, subsequent calls refuse instantly without HTTP; success marks "available"; the status surfaces show `pluginApis: {API: available|unavailable|unknown}`. 5 tests, incl. that fn does not run on a cached refusal and that record 404s keep reaching the instance.

### Auto-approval of the recurring commands (.claude/settings.json)

- At Ivan's request: `npm run build`, `npm run lint`, `node --test test/*`, `npx tsc --noEmit*`, the nvm PATH export, `git add *`, `git commit *` are in the project `permissions.allow` — they stop prompting. Deliberately NOT added: `git push`, `node -e`, broad wildcards (arbitrary code execution).

### WORKLOG.md created + the documentation rule

- A standing rule (also recorded in my memory): after every task, the worklog + all affected MD documents (TODO/DONE/IMPLEMENTATION-PLAN/README) are updated.
- **The deep code review (senior dev / architect / QA) — completed.** Reviewed: all 24 files in `src/`, the 8 test files (50 tests), tsconfig/eslint/CI. Result: **22 findings** in TODO.md — 8 senior (S-1…S-8), 8 architectural (A-1…A-8), 6 QA (Q-1…Q-6), with priorities and a recommended order. Key ones: **S-1 (critical)** `describe_table` misses inherited columns; **S-6** the table policy did not apply to non-Table batch sub-requests; **A-1** the policy model was table-centric and the plugin APIs bypassed allow/deny; **A-2** process.env as a mutable credential store; **Q-1** the tools/ MCP layer had no tests at all; **Q-3** the fetchAll pagination (the most complex loop) — zero tests. No code touched — analysis only.

## 2026-06-11

- **Phase 7 + Phase 8 specifications** added to IMPLEMENTATION-PLAN.md: multi-instance profiles (MI-1…MI-8: an AsyncLocalStorage context, per-profile policy, metadata snapshot, instance comparison) and logical flow testing + code checking (FT-1…FT-7: trace_table_event, Flow Designer reading, ATF, local lint). Overall roadmap for Phases 6–8 ≈ 8–9 days.
- **Phase 6 "Harness 2.0"** — a deep harness analysis, documented in IMPLEMENTATION-PLAN.md as a handoff specification: prerequisites (П-1 git init — the project was not a git repo!, П-2 a Node ≥ 20 guard), correctness (К-1…К-8), modularity (М-1…М-6: core/api/mcp/tools layers + a declarative tool manifest + a generated README), new capabilities (Х-1…Х-8), optimisations (О-1…О-5).
- **Plan ↔ code reconciliation:** Phase 5 script intelligence (4 tools) actually complete — the plan checkboxes updated.
- **An environment trap found:** the default shell Node is v12 → build/test fail cryptically; work with `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`. Recorded in memory; the durable protection is П-2.
