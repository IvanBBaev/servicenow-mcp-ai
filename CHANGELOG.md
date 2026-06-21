# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).
The full development chronology lives in [WORKLOG.md](WORKLOG.md); the git history is one commit per task.

## [Unreleased]

## [2.0.0] - 2026-06-21

v2.0 makes the breadth of v1 **safe and self-aware**: writes preview before they run, the server reports which capabilities it can actually achieve on your instance, and `code_health` audits the access-control layer. (v1 = breadth; v2 = trust + depth.)

### Breaking changes

- **Writes are plan-by-default.** `SN_WRITE_MODE=plan` is the new default. The write tools — record CRUD (`create`/`update`/`delete_record`), change (`create`/`update_change`), CMDB CI (`create`/`update_ci`), import-set insert, **email send**, **catalog order**, **attachment upload/delete**, **batch** (when it contains writes), and the **ATF run** tools — now return a non-mutating **before/after preview** instead of executing.
  - **Migration:** to apply a change, pass `apply: true` on the call, or set **`SN_WRITE_MODE=apply`** to restore the v1.x "execute immediately" behaviour globally. Automations that relied on a write running on the first call must do one of these.

### Added

- **DF-0 — capability preflight.** New always-on `servicenow_check_capabilities` tool and `servicenow://capabilities` resource: probe which admin-restricted `sys_*` tables the connected user can actually read, and report which capabilities (schema reads, script intelligence, ACL audit) are achievable — so the script/codecheck tools never promise a read they cannot make. `servicenow_table_logic` now degrades a 401/403 on one artefact type to an `unreadable` flag instead of failing the whole overview. (67 tools / 18 packages.)
- **DF-2 — plan-and-apply + local audit journal.** `SN_WRITE_MODE` (plan|apply) and a per-call `apply` argument gate every record-style write tool; each applied mutation is appended to a per-profile, append-only journal at `<SN_DOCS_DIR>/<profile>/write-journal.{jsonl,md}` — a client-side audit trail where there is no AI Control Tower.
- **DF-1 — ACL security scan.** `servicenow_code_health` now folds in a security dimension over the active ACLs (`sys_security_acl`): `eval`/side-effects/`gs.getUser` in ACL evaluation scripts, and roles-only ACLs (no condition and no script). The `sys_security_acl` read is gated behind DF-0 — when it is unreadable the scan reports the role needed rather than a silently empty all-clear.
- **DF-4 — where-used / impact graph.** New `servicenow_where_used` tool: find where a table, field or script is referenced across the instance's code — textual references in every script source, plus (for a table) the business rules, client scripts, UI policies/actions and ACLs attached to it. Read-only; optional Mermaid reference graph. The IDE-grade "find usages" the platform lacks.
- **DF-5 — client-side field redaction.** `SN_REDACT_FIELDS` masks named field values before query results are serialised for the model; `SN_REDACT_PII` also masks email/phone/national-id patterns inside any string value. Opt-in (off by default); the redaction count is reported in the result.
- **DF-6 — HTTP transport.** `SN_TRANSPORT=http` (port `SN_PORT`, default 3000) serves the MCP server over **Streamable HTTP** so the official ServiceNow MCP Client app and remote clients can consume it; the default stays `stdio`. The endpoint binds to **loopback (`127.0.0.1`) by default** (`SN_HTTP_HOST` to widen) and supports an optional **`SN_HTTP_TOKEN`** bearer guard (constant-time check); broader TLS/network hardening remains the operator's responsibility.
- **CSV export.** `servicenow_query_table` accepts `format: "csv"` for a spreadsheet-friendly export — a dependency-free RFC-4180 formatter that reuses the DF-5 redaction.
- **Claude Code plugin (DX-1).** A `.claude-plugin/` bundle (plugin + marketplace manifest) makes the server installable with `/plugin marketplace add LeassTaTT/servicenow-mcp-ai` then `/plugin install servicenow-mcp-ai` — zero-config, the server wired up.
- **DF-3 — CI drift gate.** `servicenow-mcp-ai drift <profileA> <profileB>` promotes `compare_instances` to a release artifact: it prints the Markdown drift report and exits non-zero when the instances differ, so a pipeline can block a deploy on configuration drift.

### Changed

- The out-of-the-box posture for writes is now **safe-by-default** (preview first) — see Breaking changes.

## [1.1.2] - 2026-06-19

### Fixed

- MCP Registry namespace casing: `mcpName` and `server.json` `name` now use the exact GitHub login `io.github.LeassTaTT/servicenow-mcp-ai` (the registry namespace is case-sensitive), and the registry `description` is within the 100-character limit.

## [1.1.1] - 2026-06-19

### Added

- Listed on the official **MCP Registry**: a `server.json` manifest and the `mcpName` field in `package.json`, plus an automated registry publish (GitHub OIDC) wired into the release workflow so a `v*` tag publishes to npm and registers the server in one run.

### Fixed

- `package.json` `repository`/`homepage`/`bugs` URLs now point at the renamed `servicenow-mcp-ai` repository — npm provenance verification requires `repository.url` to match the GitHub repository the publish workflow runs in.

## [1.1.0] - 2026-06-19

### Added

- **Full ServiceNow authentication coverage.** Added OAuth 2.1 **Authorization Code + PKCE** via a one-time `servicenow-mcp-ai login` (loopback + browser, stores a refresh token), the OAuth **JWT bearer** grant (`SN_OAUTH_GRANT=jwt_bearer`, RS256, no password), **API Key** auth (`SN_API_KEY` → `x-sn-apikey`), a **static Bearer token** (`SN_BEARER_TOKEN`), **`none`** (certificate-only), and **mutual TLS** (`SN_TLS_CLIENT_CERT`/`_KEY`/`_CA`, via the optional `undici` package). `SN_AUTH` now accepts `basic`/`oauth`/`apikey`/`token`/`none` and is auto-detected from the keys present. The `AuthProvider` returns a header map (so non-`Authorization` schemes fit), with no new runtime dependency.
- **Phase 8 — flow testing + code checking** (3 new packages, none in the default `core` profile; 65 tools / 18 packages total):
  - `flows`: `servicenow_trace_table_event` (deterministic, ordered simulation of what a table operation runs — business rules by phase, flows, workflows, notifications — with a Mermaid flowchart), `servicenow_list_flows` / `servicenow_get_flow` (Flow Designer + legacy workflows), `servicenow_get_flow_runs` (execution evidence from `sys_flow_context`).
  - `codecheck`: `servicenow_lint_script` / `servicenow_lint_table` (a local deterministic rule set — hard-coded sys_ids/URLs, unbounded/in-loop GlideRecord queries, `eval`, `gs.sleep`, `setWorkflow(false)`, client-side GlideRecord, sync `getReference`, …) and `servicenow_code_health` (script inventory + lint summary → `code-health.md`).
  - `atf`: `servicenow_list_atf_tests` / `_suites`, `servicenow_run_atf_test` / `_suite`, `servicenow_get_atf_result` via the CI/CD API. The run tools execute on the instance — `atf` is opt-in and never in the default profile.
  - `SN_CODESEARCH=true` makes `servicenow_search_code` use the Code Search API (`sn_codesearch`) when available, with a fallback to the LIKE iteration (FT-7).
- `servicenow_compare_instances` and `servicenow_snapshot_instance` now warn (per section) when a read hit the `SN_MAX_RECORDS` cap, so a partial `sys_dictionary`/script/plugin/app read can no longer be presented as a complete diff or snapshot. Backed by a new `QueryResult.truncated` flag set when the cap is reached while `X-Total-Count` shows more rows.

### Changed

- Every ServiceNow API module now unwraps the `result` envelope through the shared `expectResult`/`expectResultArray`, so a malformed response is a uniform error instead of `undefined` data (`aggregate`, `cmdb`, `catalog`, `change`, `knowledge` joined `table`/`attachment`/`meta`/`email`).
- The Batch API now enforces the package policy axis: a sub-request to a denied package (`SN_PACKAGES_DENY`) is refused, and a write to a read-only package (`SN_PACKAGES_READONLY`) is blocked — a batch can no longer bypass the package policy that filters the normal tool list.

### Fixed

- `fetchAll` reads that stopped at the `SN_MAX_RECORDS` cap were silently treated as complete by the instance comparison/snapshot tools (under-reporting drift on large instances).

### Security

- The `.env` file is now written owner-only (`0600`) instead of the default `0644` — it holds a plaintext password.
- Without `SN_ALLOWED_HOSTS`, only `*.service-now.com` instances are contacted; a redirected or mistyped host can no longer silently receive Basic credentials. Set `SN_ALLOWED_HOSTS` to opt in a custom or sovereign-cloud domain.
- The Batch API rejects non-canonical sub-request paths (`//`, `/./`, `/../`, and their percent-encoded forms), closing a path-traversal bypass that let a batch reach a denied table or package surface that ServiceNow's dispatcher would normalize and route.

## [1.0.0] - 2026-06-15

First public release of `servicenow-mcp-ai` — a ServiceNow MCP server with full
API coverage, multi-instance profiles, a layered architecture and an enforced
quality gate. (Nothing was published before this; the earlier internal `1.0.0`
cut and the subsequent work are consolidated here.)

### Added

- Full ServiceNow API coverage beyond the Table API: Aggregate (Stats), Attachment, Import Set, Batch, Service Catalog, Change Management, Knowledge, CMDB Instance/Meta (IRE) — behind `SN_TOOL_PACKAGES` (profiles `core`/`all`).
- Script intelligence (read-only): list/read/search scripts, `servicenow_table_logic`; Mermaid generators (ER diagram, table flow); local self-documentation (`docs` package) + MCP resources and prompts.
- **Multi-instance profiles (Phase 7 core):** named connection profiles in .env (`SN_PROFILE_<NAME>_*`), per-profile policy (prod read-only / dev full rights), an optional `instance` argument on every tool (AsyncLocalStorage routing per call), `servicenow_list_instances` / `servicenow_use_instance`; the status payload lists the profiles.
- **Instance snapshot & comparison (`instance` package):** `servicenow_snapshot_instance` writes the instance's structural picture (tables, schema of selected tables, plugins, apps, script-automation stats) into `SN_DOCS_DIR/<profile>/` as Markdown + JSON; `servicenow_compare_instances` diffs two profiles — tables only in one, column property drift, scripts by SHA-256, plugin/app inventory — into a `_compare/<a>-vs-<b>.md` report with a structured summary. **53 tools in 15 packages.**
- **Per-profile MCP resources:** `servicenow://instances` (profile inventory, no passwords) and `servicenow://{profile}/schema/{table}`; the old URIs stay bound to the active profile.
- Per-package policy: `SN_PACKAGES_DENY` and `SN_PACKAGES_READONLY` — control over the plugin APIs that the table policy cannot see.
- Capability cache for plugin APIs: a namespace 404 is cached (fail-fast), keyed per instance; availability is visible as `pluginApis` in the status payload.
- ConfigStore: credentials are an atomic in-memory snapshot (the environment is only the initial source).
- The README tools table is generated from the live registrations (`npm run docs:readme`) and kept in sync by a test; a drift test ties the `package.json` description to the live tool/package counts.
- In-memory MCP smoke tests (SDK Client + InMemoryTransport) with a contract snapshot of the `core` profile and a manifest fixture; property-based tests (fast-check) for the env codecs.
- `servicenow_test_connection` — diagnoses whether the configuration actually works (`{ok, status, latencyMs}`); failures are structured.
- **`npm run check` — a single full gate:** build, lint, format check, coverage-gated tests (lines 85 / branches 72 / functions 60), `npm audit --omit=dev --audit-level=high`; `prepublishOnly` runs it, so a publish cannot bypass the gates.
- **CONTRIBUTING.md and SECURITY.md:** dev setup + gates + conventions; the security model, reporting channel and the accepted-risk decisions. README gains a table of contents and links to both.
- **Release process (S2-4):** `.github/workflows/publish.yml` publishes from CI on a `v*` tag with `--provenance`, a tag↔version guard and the full `npm run check` gate; an `npm run release:dry` script and a "Releasing" section in CONTRIBUTING. Needs an `NPM_TOKEN` repo secret.
- CI: a Node matrix with a macOS leg, a Windows job and a Node-12 launcher probe, plus a production-dependency audit step.
- OAuth: a 401 with a cached token recovers with a single re-authentication; stable fetchAll pagination (automatic ORDERBY); schema cache with TTL; concurrency semaphore; telemetry in status; Node 20+ guard (launcher + engines).
- Token diets by default: compact JSON output and no reference `link` URLs (opt-in to include them).
- MIT license; npm metadata (`license` / `author`).

### Fixed

- **Encoded-query injection in `servicenow_list_tables` and `servicenow_list_attachments`** (full-review DEV-1/DEV-2): the `filter`/`table`/`sysId` arguments were embedded in the encoded query without the `^`-separator guard that K-5 added to the script tools, so a `^` could inject extra clauses. The guard (`assertNoCaret`) is now shared in `api/shared.ts` and applied by every query builder.
- **`servicenow_table_logic` rejects a `^` in the table** (full-review pass 2, DEV-4): `tableLogic` embedded the table name raw into two of its sub-queries, so a `^` fired injected clauses before the validated sub-requests rejected. Guarded at the entry, the same way as the other query builders.
- **Plugin-API availability cache is now keyed per instance** (full-review ARCH-1): a namespace-404 cached for one profile's instance could fast-fail a concurrent call to the same API on a different instance for up to 5 minutes. Keyed like the schema cache; the status payload scopes to the active instance.
- **`index.md` regeneration is serialized** (full-review DEV-3): concurrent doc writes could interleave a directory walk with another write and drop entries from the rebuilt index.
- `servicenow_describe_table` only saw the table's own columns — it now walks the inheritance chain (for `incident` the fields defined on `task` are returned too); `superClass` is a real table name, not a label.
- Batch policy also covers `stats`/`import`/`cmdb` sub-requests; invalid base64 on upload is rejected before the network; download no longer pulls the bytes before the size check; the OAuth cache is cleared on credential changes.
- `String()` over a ServiceNow field at `display_value=all` no longer produces `"[object Object]"` (`snString`).

### Changed

- **The npm package is named `servicenow-mcp-ai`** (R-10: the unscoped `servicenow-mcp` is held by an unrelated maintainer). The name is coherent across `name`/`bin`, the bin launcher, the MCP server handshake name, the XDG config dir (`~/.config/servicenow-mcp-ai`), `.vscode/mcp.json`, CI and the README. The GitHub repository stays `LeassTaTT/servicenow-mcp`.
- `package.json` metadata: `repository`/`homepage`/`bugs` point at the GitHub repo; the description states 53 tools in 15 packages.
- The published tarball ships build + bin + README + LICENSE only — no `build/**/*.map` (the maps referenced the unshipped `../src`): 110 → 57 files, 92 → 62 kB packed.
- Tool input zod schemas are strict — an unknown argument in `tools/call` returns a validation error instead of being silently dropped.
- Layered architecture `core/` → `api/` → `mcp/` → `tools/` with ESLint-enforced boundaries; tools are a declarative manifest (ToolSpec) — a package is added/removed with one line; per-host semaphore and telemetry; an email package; elicitation confirmation for credential changes; MCP logging capability; `outputSchema` for the diagnostic tools.
- TypeScript: `noUncheckedIndexedAccess`; ESLint: type-checked rules + `no-floating-promises`.
- Errors are structured (`{ status, message, snDetail }`); retry with exponential backoff + `Retry-After`; SSRF guard; result size guard.

[Unreleased]: https://github.com/LeassTaTT/servicenow-mcp-ai/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/LeassTaTT/servicenow-mcp-ai/compare/v1.1.2...v2.0.0
[1.1.2]: https://github.com/LeassTaTT/servicenow-mcp-ai/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/LeassTaTT/servicenow-mcp-ai/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/LeassTaTT/servicenow-mcp-ai/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/LeassTaTT/servicenow-mcp-ai/releases/tag/v1.0.0
