# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).
The full development chronology lives in [WORKLOG.md](WORKLOG.md); the git history is one commit per task.

## [Unreleased]

## [1.0.0] - 2026-06-12

### Added

- **Multi-instance profiles (Phase 7 core):** named connection profiles in .env (`SN_PROFILE_<NAME>_*`), per-profile policy (prod read-only / dev full rights), an optional `instance` argument on every tool (AsyncLocalStorage routing per call), `servicenow_list_instances` / `servicenow_use_instance`; the status payload lists the profiles.
- MIT license; npm metadata (`license`/`author`) and `prepublishOnly: npm run verify` — publishing without a green verify is impossible.
- Property-based tests (fast-check) for the env codecs; CI: coverage gate (lines 85 / branches 72), a Windows job, a Node 12 launcher test.
- Full ServiceNow API coverage beyond the Table API: Aggregate (Stats), Attachment, Import Set, Batch, Service Catalog, Change Management, Knowledge, CMDB Instance/Meta (IRE) — 49 tools in 14 packages behind `SN_TOOL_PACKAGES` (profiles `core`/`all`).
- Script intelligence (read-only): list/read/search scripts, `servicenow_table_logic`; Mermaid generators (ER diagram, table flow); local self-documentation (`docs` package) + MCP resources and prompts.
- Per-package policy: `SN_PACKAGES_DENY` and `SN_PACKAGES_READONLY` — control over the plugin APIs that the table policy cannot see.
- Capability cache for plugin APIs: a namespace 404 is cached for 5 minutes (fail-fast); availability is visible as `pluginApis` in the status payload.
- ConfigStore: credentials are an atomic in-memory snapshot (the environment is only the initial source).
- The README tools table is generated from the live registrations (`npm run docs:readme`) and kept in sync by a test.
- In-memory MCP smoke tests (SDK Client + InMemoryTransport) with a contract snapshot of the `core` profile and a manifest fixture.
- `servicenow_test_connection` — diagnoses whether the configuration actually works ({ok, status, latencyMs}); failures are structured.
- OAuth: a 401 with a cached token recovers with a single re-authentication; stable fetchAll pagination (automatic ORDERBY); schema cache with TTL; concurrency semaphore; telemetry in status; Node 20+ guard (launcher + engines).
- Token diets by default: compact JSON output and no reference `link` URLs (opt-in to include them).

### Fixed

- `servicenow_describe_table` only saw the table's own columns — it now walks the inheritance chain (for `incident` the fields defined on `task` are returned too); `superClass` is a real table name, not a label.
- Batch policy also covers `stats`/`import`/`cmdb` sub-requests; invalid base64 on upload is rejected before the network; download no longer pulls the bytes before the size check; the OAuth cache is cleared on credential changes.
- `String()` over a ServiceNow field at `display_value=all` no longer produces `"[object Object]"` (`snString`).

### Changed

- Tool input zod schemas are strict — an unknown argument in `tools/call` returns a validation error instead of being silently dropped.
- Quality batch from the backlog: strict input schemas (an argument typo is an error), per-host semaphore and telemetry, coverage gates + property-based tests + a perf guard, Windows and Node-12-launcher CI probes, the PackageSpec manifest (a package = tools + resources in one object).
- Layered architecture `core/` → `api/` → `mcp/` → `tools/` with ESLint-enforced boundaries; tools are a declarative manifest (ToolSpec) — a package is added/removed with one line; email package (send/get); elicitation confirmation for credentials; MCP logging capability; outputSchema for the diagnostic tools.
- TypeScript: `noUncheckedIndexedAccess`; ESLint: type-checked rules + `no-floating-promises`.
- Errors are structured (`{ status, message, snDetail }`); retry with exponential backoff + `Retry-After`; SSRF guard; result size guard.
