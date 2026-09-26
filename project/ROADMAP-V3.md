# servicenow-mcp-ai — v3.0 Execution Roadmap

Date: 2026-09-02 · Status: **proposed — 46 items done (E-6, E-7 and D-8 partly): H-1 2026-09-03, H-2 2026-09-09, E-9 2026-09-10, H-10, S-1, H-8, H-9, H-5, H-6, E-3, S-2 and S-14 2026-09-23, M-3, S-3, S-8, P-1, S-4, S-13, D-2, P-3, P-4, M-8, S-9, E-5 and P-5 2026-09-24, M-4, S-7, S-5, P-6, S-6 and S-11 2026-09-25, S-10 and P-8 2026-09-26, S-15 (bar `document_kind`, owner decision), M-6, M-9 and P-16 2026-09-26 (batch 10; local tests 1074/1074 green, 88 tools in 26 packages, `pack:check` over the 800 KB ceiling pending the owner; all uncommitted), P-10, P-13, M-1 and D-4 2026-09-26, E-6 partly (batch 11; `servicenow_explain_flow`, server instructions + `get_status` v2, install matrix, test architecture; local tests 1168/1171 green with 3 `todo`, 89 tools in 26 packages; uncommitted), M-5, D-1, S-16, P-11, P-17 and D-8 partly 2026-09-26 (batch 12; dynamic packages + listChanged, `init` wizard + real CLI (`doctor --json`, `support-bundle`), `document_instance` `depth` + discovery files, five plugin skills, `explain_flow` `kind:"action"` + call expansion, decision-table explainer, `servicenow_artifact_dependencies`; uncommitted); the 2.1.0 hardening batch (items 1–5) is complete; next H-3 (BREAKING, waits for O-4) — the other BREAKING items wait for O-4 too. Second pass 2026-09-09 ([GAP-ANALYSIS-2026-09.md](GAP-ANALYSIS-2026-09.md)) added H-10, H-11, S-13, M-9, D-9, E-9, B11–B13 and extended 27 definitions of done. Third pass 2026-09-23 ([INSTANCE-DOCS-ANALYSIS-2026-09.md](INSTANCE-DOCS-ANALYSIS-2026-09.md), instance documentation, 17 findings) added S-14, S-15, S-16 and refined nine definitions of done.** Derived from five read-only audits run
on 2026-09-02 against 2.0.1 (`main` at `5acdcc7`): MCP protocol conformance, ServiceNow coverage,
security and write-safety rails, DX and distribution, and engineering (dependencies, CI, tests,
observability) — plus the 2026-07-06 v2.5 scoping notes (a local handoff; its F-1…F-7 features and
C-1…C-12 corner cases are folded in here under new ids). Companion to [ROADMAP.md](ROADMAP.md)
(the forward view) and [ROADMAP-V2.md](ROADMAP-V2.md) (the v2.0 tracker this file mirrors). This
file is the **execution tracker** for 3.0: the milestone definition, the ground truth it starts
from, the sequenced item list with a definition of done for each, the breaking-change register,
and what is deliberately out. The full findings behind every item — each audit id with its
evidence, severity and the finding → item index — are in
[DEEP-REVIEW-2026-09.md](DEEP-REVIEW-2026-09.md). The second-pass findings (ids `L1-01` … `L9-12`,
nine narrower lenses, 2026-09-09) with their designs, acceptance criteria and tests are in
[GAP-ANALYSIS-2026-09.md](GAP-ANALYSIS-2026-09.md); every `_(gap pass 2026-09-09)_` bullet below
points at them by id. The instance-documentation pass (ids `ID-01` … `ID-17`, 2026-09-23 — the
docs store, the Mermaid generators, the `document_table` prompt, the missing table / app /
instance documents) is in
[INSTANCE-DOCS-ANALYSIS-2026-09.md](INSTANCE-DOCS-ANALYSIS-2026-09.md); every
`_(instance-docs pass 2026-09-23)_` bullet below points at it. Its second pass (ids `ID-18` …
`ID-29`, 2026-09-25 — the dispositions of ID-01…ID-17 after S-14 / S-3 / P-1 / S-4 / P-5 landed,
the registry-driven `document_app`, the `security` kind, the E-7 collectors, per-writer versions,
manifest runs, JSON companions, writer goldens) is in
[INSTANCE-DOCS-ANALYSIS-2026-09-25.md](INSTANCE-DOCS-ANALYSIS-2026-09-25.md); every
`_(instance-docs pass 2 2026-09-25)_` bullet below points at it.

Evidence marker: **verified** = re-checked in code or by running a command during the analysis.
Everything else is an audit claim — confirm it in the first hour of the item before designing.

## Milestone definition

> **v1.x = breadth** (can touch all of ServiceNow). **v2.0 = trust + depth + reach** (safe to let
> it write, understands the instance, reachable by teams/agents). **v3.0 = correctness +
> governance + reach at scale**: the rails hold against an adversarial client and many concurrent
> sessions, every write is reversible and update-set aware, the protocol surface is current
> (instructions, completions, cancellation, structured output, machine-readable errors), and the
> server is one command away for any MCP client.

It is a **major** because it carries client-visible breaks that 2.x cannot: the Node ≥ 22 floor,
a single tool-naming convention, an error contract with machine codes, plan-token-bound destructive
writes, fail-fast settings, per-session HTTP semantics. The rule for the train: **everything that is
not breaking ships on 2.x as soon as it lands** (starting with a 2.1.0 cut from the existing
`[Unreleased]` block plus the hardening pack); the breaking cluster ships together as 3.0.0, previewed
as `3.0.0-beta.n` under the npm `next` tag.

## Ground truth (2026-09-02)

| Fact                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **The gate is red.** `npm run check` ends with `npm audit --omit=dev --audit-level=high`, which exits 1: 6 advisories (2 high — `fast-uri`, `ip-address`; 3 moderate — `hono`, `qs`, …; 1 low), all transitive via `@modelcontextprotocol/sdk` 1.29.0. `npm audit fix` reports a lock-only fix. Build, lint, format and 406/406 tests are green.                              | **verified** (`package.json:44`, audit run 2026-09-02)                                                                  |
| Dependencies lag: SDK 1.29.0 → 1.30.0 (declared `^1.12.0`), zod 3.25.76 (SDK peer `^3.25 \|\| ^4.0`, latest 4.5.4), TypeScript 5.9 → 7.0, ESLint 9 → 10, c8 11 → 12, dotenv 16 → 17, `@types/node` 22 → 26. Node 20 (EOL 2026-04-30) is still the floor and still in the CI matrix.                                                                                           | **verified** (`npm outdated`, `package.json` engines, `.github/workflows/ci.yml:12-23`)                                 |
| Surface: 67 tools / 18 packages / 7 resources / 3 prompts. `tools/list` for `SN_TOOL_PACKAGES=all` is 62,325 chars (~15.6k tokens); the auto-injected `instance` parameter and its description repeat on 67/67 tools (~9.5k chars); `outputSchema` exists on 2/67.                                                                                                            | measured in-memory by the DX audit                                                                                      |
| HTTP transport is single-session: one `StreamableHTTPServerTransport` per process, a second `initialize` gets 400 "Server already initialized", `DELETE` closes it for good. The active profile is process-global (`process.env.SN_ACTIVE_PROFILE`), so one HTTP client switching instances switches them for everyone. No DNS-rebinding/Origin protection, no e2e HTTP test. | **verified** (`src/mcp/transport.ts`, `src/core/config.ts:103-108,190-192`, SDK `webStandardStreamableHttp.js:426-434`) |
| `trace_table_event` / `generate_table_flow` query `collection=<table>` only — business rules inherited from `task` and global rules never appear.                                                                                                                                                                                                                             | **verified** (`src/api/flows.ts:75-78`; `getTableChain` in `src/api/meta.ts:60` is unused there)                        |
| The write journal stores only the fields that were sent — no before-state, so nothing can be reverted.                                                                                                                                                                                                                                                                        | **verified** (`src/core/write-journal.ts` `JournalEntry`, `src/tools/table.ts:169-183`)                                 |
| `set_credentials` accepts `instance` alone; the stored user/password survive the host change and are sent to the new host on the next call. The elicitation guard fails open on clients without elicitation.                                                                                                                                                                  | **verified** (`src/tools/admin.ts:105-126`, `src/core/config.ts:176-198`)                                               |
| `hasCredentials` is `instance && user && password` — API-key/OAuth/mTLS setups read as "not configured" in `get_status` and `doctor`.                                                                                                                                                                                                                                         | **verified** (`src/core/config.ts:164-168`, `src/api/doctor.ts:64-77`)                                                  |
| Version drift: package.json / `server.json` / extension = 2.0.1, `.claude-plugin/plugin.json` = 2.0.0, lock root `version` = 1.0.0. The VS Code extension spawns `npx -y servicenow-mcp-ai` **unpinned**.                                                                                                                                                                     | **verified** (`extension/src/extension.ts:19-22`)                                                                       |
| Adoption is flat: ~147 npm downloads/week, 8 stars, 0 user-filed issues (12 open = Dependabot), stale `io.github.LeassTaTT` registry duplicates, no Open VSX listing, one GitHub Release (v2.0.0), last commit 2026-07-03. Competing servers lead on update-set management, tool search/dynamic packages, hosted/OAuth remotes, Docker/Smithery and Claude Code skills.       | DX audit (external counts unverified beyond npm)                                                                        |
| What is already ahead of the field and must not regress: full auth coverage, profiles + drift gate, plan/apply + journal + redaction + SSRF guard, script intelligence + Mermaid, strict schemas, `readOnlyHint` on every read tool, stderr-only logging.                                                                                                                     | MCP + security audits                                                                                                   |

## Pillars and ids

- **H — Hardening (P0).** Correctness and safety defects in the shipped surface. Non-breaking parts
  ship on 2.x immediately.
- **M — MCP modernization.** Protocol features the SDK already offers and the server does not use.
- **S — ServiceNow depth.** The "knows your instance" thesis, extended.
- **D — DX and distribution.** From first `npx` to a working client in one step; every client.
- **E — Engineering platform.** Runtime floor, toolchain, architecture debt, tests, observability.
- **O — Owner gates.** Decisions and actions only the owner can take.
- **P — SDK parity epic.** Parity with every artefact `@servicenow/sdk` (Fluent) can describe;
  plan in [SDK-PARITY.md](SDK-PARITY.md). Post-3.0 (3.x/4.0).

Effort key (single maintainer): **S** ≤ 1 day · **M** 2–5 days · **L** 1–2 weeks.

## Sequencing (must-haves first)

| #   | Item                                                    | Pillar | Why this order                                                                                                                                                                                                                                                                                                                           | Effort | Status                                                                                                                                                                           |
| --- | ------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- |
| 1   | **H-1** dependency floor + green audit                  | H      | **Done 2026-09-03 (local).** SDK `^1.30.0`, zod `^3.25.0`, lock-only audit fix, no overrides; 406/406, audit 0. CI matrix runs on push. Ships in 2.1.0.                                                                                                                                                                                  | S      | 🟢                                                                                                                                                                               |
| 2   | **H-2** credential host binding                         | H      | **Done 2026-09-09 (local).** Instance change needs `user` + `password` in the same call (`CREDENTIALS_INCOMPLETE`), the confirmation fails closed, `SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE` opt-out; the allow-list bullet is deferred to H-6.                                                                                           | S      | 🟢                                                                                                                                                                               |
| 3   | **S-1** inherited + global business rules               | S      | Verified correctness bug in the hero demo path; ships on 2.1. Done 2026-09-23 (local).                                                                                                                                                                                                                                                   | S      | 🟢                                                                                                                                                                               |
| 4   | **H-8** platform corner-case pins                       | H      | **Done 2026-09-23 (local).** `INSTANCE_HTML_RESPONSE` + wake hint, `fetchAll` past ACL-short pages (`truncatedReason` / `filtered`), `display_value=all` pins, attachment edges, plugin inactive vs missing, drift / where-used caveats; 25 tests.                                                                                       | M      | 🟢                                                                                                                                                                               |
| 5   | **H-9** CI + version hygiene                            | H      | Cheap; must be in place before any 3.0 publish. Done 2026-09-23 (local).                                                                                                                                                                                                                                                                 | S      | 🟢                                                                                                                                                                               |
| —   | _cut **2.1.0** here (non-breaking)_                     |        | `[Unreleased]` + H-1/H-2/S-1/H-8/H-9.                                                                                                                                                                                                                                                                                                    |        |                                                                                                                                                                                  |
| 6   | **E-1** Node ≥ 22 floor                                 | E      | Unlocks c8 12, native TS, `require(esm)`; first breaking change on the 3.0 line.                                                                                                                                                                                                                                                         | S      | 🔴                                                                                                                                                                               |
| 7   | **E-2** toolchain majors (zod 4, SDK, TS 7)             | E      | Needs E-1; touches `define.ts` types once; everything after builds on it.                                                                                                                                                                                                                                                                | M      | 🔴                                                                                                                                                                               |
| 8   | **E-4** validated settings manifest                     | E      | Single source for env docs (D-3) and the HTTP settings H-7 validates; breaking (fail-fast).                                                                                                                                                                                                                                              | M      | 🔴                                                                                                                                                                               |
| 9   | **E-3** runtime container                               | E      | **Done 2026-09-23 (local).** `src/core/runtime.ts`: one runtime (schema cache, tokens, telemetry, queue, breakers, dispatchers, profiles, plugin availability) passed to `registerAllTools`; `dispose()` in place; `_reset*` hooks gone.                                                                                                 | M      | 🟢                                                                                                                                                                               |
| 10  | **H-7** HTTP transport v2                               | H      | Multi-session + per-session profile + rebinding guard + e2e; the biggest verified defect.                                                                                                                                                                                                                                                | L      | 🔴                                                                                                                                                                               |
| 11  | **M-2** error contract v2                               | M      | Public-contract break; ship in the same minor as M-7 so clients migrate once.                                                                                                                                                                                                                                                            | M      | 🔴                                                                                                                                                                               |
| 12  | **M-7** tool naming convention v3                       | M      | Public-contract break; alias map + manifest diff; must precede README/site regeneration.                                                                                                                                                                                                                                                 | L      | 🔴                                                                                                                                                                               |
| 13  | **H-4** policy-axis bypass closure                      | H      | **Partly done 2026-09-26 (local, opt-in default).** Nested batch refused, tables from query/body, attachment parent-table checks, backing tables for plugin APIs, `change_conflicts` plan/apply, sweep test. Open: `SN_BATCH_UNMAPPED` / max defaults (O-4).                                                                             | M      | 🟡                                                                                                                                                                               |
| 14  | **H-5** journal v2 + deep redaction                     | H      | **Done 2026-09-23 (local).** v2 lines (ULID, `result`, `before`, `client`, sha256 `prev` chain + head file), rotation at `SN_JOURNAL_MAX_BYTES`, batch sub-request lines, `local_write`/`config` entries, deep redaction at `ok`/`fail`, CSV formula guard + BOM.                                                                        | M      | 🟢                                                                                                                                                                               |
| 15  | **H-3** plan-token binding + elicitation                | H      | **Partly done 2026-09-26 (local, opt-in).** `SN_DESTRUCTIVE_CONFIRM` `token` / `elicit` (default `off`): single-use `plan_token`, `PLAN_REQUIRED` / `CONFIRM_DECLINED`, journaled. Open: 3.0 default (O-4), `change_conflicts` (H-4), `STALE_RECORD`, email preview cap.                                                                 | M      | 🟡                                                                                                                                                                               |
| 16  | **H-6** outbound hardening                              | H      | **Done 2026-09-23 (local).** Redirects blocked, `SN_MAX_BODY_BYTES`, IPv6-aware host guard (suffix entries never open internal hosts), TLS-off warning, OAuth callback path/`state`, upload caps + MIME allow-list, docs store device-name/`:`/symlink/size guards, `send_email` recipient allow-list (behaviour change → O-4).          | M      | 🟢                                                                                                                                                                               |
| 17  | **S-2** journal-based revert                            | S      | **Done 2026-09-23 (local).** Opt-in `revert` package: `list_writes` + `revert_write` (plan/apply, `STALE_RECORD` drift guard, `NOT_REVERTIBLE` reasons, `reverts:<id>`); H-3 `plan_token` plugs in later.                                                                                                                                | M      | 🟢                                                                                                                                                                               |
| 18  | **S-6** update-set awareness                            | S      | **Done 2026-09-25 (local).** Opt-in `updatesets` package (3 tools) + `update_set` binding on table writes.                                                                                                                                                                                                                               | L      | 🟢                                                                                                                                                                               |
| 19  | **M-1** server instructions + config state              | M      | **Done 2026-09-26 (local, uncommitted).** Generated `instructions` + `title`/`websiteUrl`/`icons` (`src/mcp/server-info.ts`); additive `NOT_CONFIGURED` code + hint; `get_status` v2 groups. Open: per-profile env (H-11), owner (TODO batch 11).                                                                                        | S      | 🟢                                                                                                                                                                               |
| 20  | **M-3** `extra` plumbing                                | M      | **Done 2026-09-24 (local).** SDK `extra` → call context; `signal` aborts fetch / queue wait / backoff (`CANCELLED`); throttled `notifications/progress` from `query_table` fetchAll, snapshot, compare, batch; log lines carry `{profile, requestId, sessionId?, tool}`.                                                                 | M      | 🟢                                                                                                                                                                               |
| 21  | **M-6** outputSchema + token budget                     | M      | **Done 2026-09-26 (local, uncommitted).** 30 tools publish a passthrough `outputSchema` + `structuredContent` (errors never carry it); descriptions ≤ 250, `instance` param ≤ 30; manifest v2; `tools/list` budget ratchet at the measured size (owner to restate).                                                                      | M      | 🟢                                                                                                                                                                               |
| 22  | **M-4** completions + reference resources               | M      | **Done 2026-09-25 (local).** `complete` + `list` (cap 100) on the schema / profile-schema / docs templates from local state only; docs list from the S-14 manifest; `servicenow://reference/tools`; encoded-query reference widened; `src/mcp/boundary.ts` untrusted-content block on prompt arguments and docs resources.               | M      | 🟢                                                                                                                                                                               |
| 23  | **M-5** dynamic packages + listChanged                  | M      | **Done 2026-09-26 (local, uncommitted).** `list/enable/disable_package` toggle registered tools (list_changed, debounced) within DENY/READONLY; prompts follow packages; resources subscribe + list_changed on profile change.                                                                                                           | M      | 🟢                                                                                                                                                                               |
| 24  | **M-8** small protocol fixes                            | M      | **Done 2026-09-24 (local).** `src/mcp/log-bridge.ts`: `logging/setLevel` over HTTP, per-session token bucket (`SN_LOG_NOTIFY_RATE`); all four annotation hints required on every tool; `buildInputSchema` replaces the `.strict()` cast; bounded zod builders + schema-walker test.                                                      | S      | 🟢                                                                                                                                                                               |
| 25  | **D-1** `init` wizard + real CLI                        | D      | **Done 2026-09-26 (local, uncommitted).** `src/cli.ts` (`parseArgs`): `--help`/`--version`, `init` (hidden prompt, piped stdin, doctor at the end), `doctor --json/--ascii/--profile` (env file first line), `support-bundle`; bootstrap in `src/server.ts`.                                                                             | M      | 🟢                                                                                                                                                                               |
| 26  | **D-2** credentials model completeness                  | D      | **Done 2026-09-24 (local).** `credentialStatus` per auth method (Basic, API key, bearer, OAuth grants); `set_credentials` takes `auth` / `oauth_client_id` / `oauth_grant`, secrets via elicitation; `SN_TOKEN_FILE` reload on 401, `AUTH_EXPIRED`, token-expiry and env-file ACL warnings.                                              | S      | 🟢                                                                                                                                                                               |
| 27  | **D-3** generated config docs + counts                  | D      | Depends on E-4; kills the three-way env drift and hand-maintained counts.                                                                                                                                                                                                                                                                | M      | 🔴                                                                                                                                                                               |
| 28  | **D-4** install matrix + deeplinks                      | D      | **Done 2026-09-26 (local, uncommitted).** README + site install matrix for 11 clients; `scripts/install-links.mjs` generates the VS Code / Cursor deeplinks from `package.json`, `test/install-links.test.js` guards them.                                                                                                               | S      | 🟢                                                                                                                                                                               |
| 29  | **D-6** distribution hygiene                            | D+O    | Registry dupes, Open VSX, releases, extension pinned to `^3` **before** 3.0 publishes.                                                                                                                                                                                                                                                   | S      | 🔴                                                                                                                                                                               |
| 30  | **S-3** security-scan extension                         | S      | **Done 2026-09-24 (local).** `src/api/security.ts`: paged ACL scan with `truncated`, role wildcard + inheritance; public REST / UI page, table-no-ACL, admin-overlap, elevated-privilege checks, each `available:false` when unreadable.                                                                                                 | M      | 🟢                                                                                                                                                                               |
| 31  | **S-4** script-intelligence widening                    | S      | **Done 2026-09-24 (local).** Registry `clientFields` / `markupFields` / `baseQuery` + 15 unverified script types; `scope` filter, per-artefact `hits` / `hitCount` and `unreadable` list on search and where-used.                                                                                                                       | M      | 🟢                                                                                                                                                                               |
| 32  | **S-7** snapshot/compare v2                             | S      | **Done 2026-09-25 (local).** `describe_table` column metadata + opt-in `details` (choices, overrides); seven record snapshot sections, fan-out, `sn_partial` + `resume`; compare matches sys_id then name (`renamed`), unified `diff`, opt-in record `sections`. Drift CLI exit codes unchanged.                                         | L      | 🟢                                                                                                                                                                               |
| 33  | **S-8** Table API completeness + paging                 | S      | **Done 2026-09-24 (local).** `view` / `queryCategory` / `noCount` / `queryNoDomain` / `suppressPaginationHeader`, `inputDisplayValue`; keyset `sys_id>last` paging without ORDERBY (C-2); encoded-query reference resource (C-6); `servicenow_upsert_record` (L2-14).                                                                    | M      | 🟢                                                                                                                                                                               |
| 34  | **S-5** trace v2                                        | S      | **Done 2026-09-25 (local).** Opt-in `lanes` on `trace_table_event` / `generate_table_flow`: transform maps, scheduled jobs, client scripts + UI policies, data policies, SLAs, event script actions, each a phase and a Mermaid subgraph; stable order; default output byte-identical. `get_flow` depth moves to P-10.                   | L      | 🟢                                                                                                                                                                               |
| 35  | **S-9** where-used structural references                | S      | **Done 2026-09-24 (local).** `src/api/references.ts`: 9 policy-checked structural sources (dictionary, list/form layouts, catalog variables, flow inputs, reports); additive `structural` section on `where_used` (opt-out `structural:false`).                                                                                          | M      | 🟢                                                                                                                                                                               |
| 36  | **E-5** observability                                   | E      | **Done 2026-09-24 (local).** `src/core/metrics.ts`: per-tool count/errors/p50/p95, cache, retry, queue, breaker and rate-limit stats in `get_status.observability`; `diagnostics_channel` events; `SN_LOG_FORMAT`, rotated `SN_LOG_FILE`; `GET /metrics` behind `SN_METRICS` + `SN_HTTP_TOKEN`.                                          | S      | 🟢                                                                                                                                                                               |
| 37  | **E-6** test architecture                               | E      | **Partly done 2026-09-26:** fetch double v2, fake timers, property tests (retry, policy, encoders + the six L9-02), spawn CLI tests, extension typecheck job. Open: fixture corpus + live smoke (O-2), L9-03 layout, extension lint.                                                                                                     | M      | 🟡                                                                                                                                                                               |
| 38  | **E-7** code health                                     | E      | **Partly done 2026-09-26:** unsafe rules on, collector split. Open: `snRequest` (E-8).                                                                                                                                                                                                                                                   | M      | 🟡                                                                                                                                                                               |
| 39  | **D-5** lighter install + containers                    | D      | Dockerfile (HTTP mode), Smithery, footprint measurement.                                                                                                                                                                                                                                                                                 | M      | 🔴                                                                                                                                                                               |
| 40  | **D-7** extension v2                                    | D      | Settings, SecretStorage sign-in, walkthrough.                                                                                                                                                                                                                                                                                            | M      | 🔴                                                                                                                                                                               |
| 41  | **D-8** plugin skills + hooks                           | D      | **Partly done 2026-09-26 (local, uncommitted).** Five plugin skills under `skills/` (`sn-discover`, `sn-triage`, `sn-impact`, `sn-drift`, `sn-safe-write`) with the L4-02 manifest walker. Open: the `PreToolUse` hook that blocks token-less apply (needs H-3, O-4); slash commands skipped.                                            | M      | 🟡                                                                                                                                                                               |
| 42  | **S-10** ops / data / history tables                    | S      | **Done 2026-09-26 (local).** `ops`, `history`, `properties`, `directory` packages + CMDB relations / IRE.                                                                                                                                                                                                                                | L      | 🟢                                                                                                                                                                               |
| 43  | **S-11** file-based delivery                            | S      | **Done 2026-09-25 (local).** `format:"file"` + `SN_OVERSIZE_TO_FILE`, streamed exports.                                                                                                                                                                                                                                                  | S      | 🟢                                                                                                                                                                               |
| 44  | **S-12** AST-based lint                                 | S      | Replaces regex heuristics; adds a parser dependency — decide deliberately.                                                                                                                                                                                                                                                               | L      | 🔴                                                                                                                                                                               |
| 45  | **E-8** ARCH-14 / ARCH-10 resolution                    | E+O    | GO → shared request engine; NO-GO → delete the dark scaffold in the major.                                                                                                                                                                                                                                                               | M      | 🔴                                                                                                                                                                               |
| 46  | **H-10** HTTP client resilience + identity              | H      | **Done 2026-09-23 (local).** One `getDispatcher(host)` for proxy (`SN_HTTPS_PROXY` → `HTTPS_PROXY`/`HTTP_PROXY` + `NO_PROXY`) and TLS without a client cert, identifying `User-Agent`, `SN_DEADLINE_MS`, bounded queue (`BUSY`), `UPSTREAM_HTML`, OAuth through `rawRequest`, host:port / IPv6 policy, opt-in breaker (GAP L1-01…L1-10). | M      | 🟢                                                                                                                                                                               |
| 47  | **E-9** process lifecycle + bounded state               | E      | **Done 2026-09-10 (local).** Crash handlers exit 1 with one structured line, `dispose()` in `src/core/lifecycle.ts`, LRU schema cache `SN_SCHEMA_CACHE_MAX` (GAP L6-03, L6-04, L2-08); H-10's dispatcher / queue / breaker hooks were wired into `dispose()` on 2026-09-23.                                                              | S      | 🟢                                                                                                                                                                               |
| 48  | **H-11** policy model v2                                | H      | **Done 2026-09-26 (local) bar the BREAKING defaults.** Glob patterns, one evaluator + `explain_policy` + `servicenow://policy`, opt-in protected tables, import-set allowlist, write caps, prod marker. Open: policy file, O-4 defaults.                                                                                                 | M      | 🟡                                                                                                                                                                               |
| 49  | **S-13** capability preflight v2                        | S      | **Done 2026-09-24 (local).** `src/api/capability-matrix.ts`: per-group read-only probes (`groups`, `refresh`), TTL cache (`SN_CAPABILITY_TTL_MS`), plugin negative TTL `SN_PLUGIN_NEGATIVE_TTL_MS`; matrix in doctor and the capabilities resource.                                                                                      | M      | 🟢                                                                                                                                                                               |
| 50  | **D-9** security policy + community files               | D      | Ships with O-1: private vulnerability reporting, supported versions, templates (GAP L9-10, L9-11).                                                                                                                                                                                                                                       | S      | 🔴                                                                                                                                                                               |
| 51  | **M-9** long-running ops as MCP tasks                   | M      | **Done 2026-09-26 (local, uncommitted).** `src/mcp/tasks.ts` behind `SN_EXPERIMENTAL_TASKS=1`: `run_as_task` on six long-running tools, task store (1 h TTL, redacted results), `tasks/cancel` aborts the request. Open: owner questions (TODO batch 10).                                                                                | M      | 🟢                                                                                                                                                                               |
| 52  | **S-14** docs store v2 + generator depth                | S      | **Done 2026-09-23 (local).** `sn_*` frontmatter + source hash, manual blocks, `DOC_GENERATED`, `index.json` manifest, docs tool filters, `src/api/mermaid.ts`, ER `columns`/`depth`, table-flow `operation`; defaults byte-identical.                                                                                                    | M      | 🟢                                                                                                                                                                               |
| 53  | **S-15** document generators                            | S      | **Done 2026-09-26** (part 1 + batch 10). Open: `document_kind` (owner, ID-23). Stretch; after S-14 — `document_table` + the `security` kind and `document_app` (over the P-5 collector) can land on 2.x now; `document_instance` after the E-7 collector split; S-7 only for `choices` (ID-08…ID-11, ID-22…ID-25).                       | L      | 🟡                                                                                                                                                                               |
| 54  | **S-16** native discovery                               | S      | **Done 2026-09-26 (local, uncommitted).** `document_instance({depth})` writes `<profile>/discovery/` (`overview.md`, `apps.md`, `tables-<scope>.md`, `artifacts-<scope>.md` with a collected / not collected and why column); `sn-discover` skill.                                                                                       | S      | 🟢                                                                                                                                                                               |
| 55  | **P-1** artefact registry                               | P      | **Done 2026-09-24 (local).** `src/core/artifacts/registry.ts` (SDK baseline 4.12.2, §5(a) descriptor + validator); `SCRIPT_TYPES` / `ARTEFACT_TABLES` derived, byte-identical; unverified seeds for portal, UIB, flow, workflow, catalog, REST, transform.                                                                               | M      | 🟢                                                                                                                                                                               |
| 56  | **P-2** registry verification probe                     | P      | Needs P-1, S-13 and the PDI (O-5); resolves unverified tables/fields.                                                                                                                                                                                                                                                                    | S      | 🔴                                                                                                                                                                               |
| 57  | **P-3** SDK-managed scope detection                     | P      | **Done 2026-09-24 (local).** `src/core/artifacts/sdk-managed.ts`: `yes                                                                                                                                                                                                                                                                   | no     | unknown`with evidence from`SN_SDK_MANAGED_SCOPES`/`SN_SDK_PROJECT_DIRS` (`now.config.json`); `sdkManaged` block in status and capabilities; instance heuristics empty until O-5. | M   | 🟢  |
| 58  | **P-4** SDK release tracking                            | P      | **Done 2026-09-24 (local).** `scripts/sdk-drift.mjs` (`npm run sdk:drift`) + weekly `sdk-drift.yml` tracking issue; `SDK_NEXT_APIS = ["DatabaseView"]`; not in the gate.                                                                                                                                                                 | S      | 🟢                                                                                                                                                                               |
| 59  | **P-5** `list_artifacts` / `get_artifact`               | P      | **Done 2026-09-24 (local).** Opt-in `artifacts` package: `servicenow_list_artifacts` / `servicenow_get_artifact` over the P-1 registry with children, scope, `sdkManaged`, policy + redaction, `degraded` for unverified types; `servicenow://artifact-types`. 72 tools in 20 packages.                                                  | M      | 🟢                                                                                                                                                                               |
| 60  | **P-6** `explain_artifact` + JSON decoders              | P      | **Done 2026-09-25 (local).** `servicenow_explain_artifact` (opt-in `artifacts` package) over `getArtifactFor`; decoder framework `src/core/artifacts/decoders.ts` (tolerant `json`, `registerDecoder`); size-capped; JSON goldens per §4 group. 73 tools in 20 packages.                                                                 | M      | 🟢                                                                                                                                                                               |
| 61  | **P-7** descriptors: core, server, classic UI           | P      | Needs P-1, P-2, P-6.                                                                                                                                                                                                                                                                                                                     | M      | 🔴                                                                                                                                                                               |
| 62  | **P-8** descriptors: catalog, quality, AI, app          | P      | Needs P-1, P-2, P-6; licensed families per O-9.                                                                                                                                                                                                                                                                                          | M      | 🔴                                                                                                                                                                               |
| 63  | **P-9** descriptors: portal, UIB, flow, workflow        | P      | Needs P-1, P-2; shallow read + script fields before P2.                                                                                                                                                                                                                                                                                  | S      | 🔴                                                                                                                                                                               |
| 64  | **P-10** Flow Designer decoder + `explain_flow`         | P      | **Done 2026-09-26 (local).** `servicenow_explain_flow` in the `flows` package + `flow-values` decoder: step tree, decoded values with pills, draft vs published, opt-in runs; `get_flow` not delegated (O-4).                                                                                                                            | L      | 🟢                                                                                                                                                                               |
| 65  | **P-11** subflows, custom actions, decision tables      | P      | **Done 2026-09-26 (local, uncommitted).** `explain_flow` `kind:"action"` + `depth` call expansion (cap 3, cycle guard, 20 callees); `decision-table` explainer via `explain_artifact`; all (U), O-5.                                                                                                                                     | M      | 🔴                                                                                                                                                                               |
| 66  | **P-12** playbooks                                      | P      | Needs P-10; O-9.                                                                                                                                                                                                                                                                                                                         | M      | 🔴                                                                                                                                                                               |
| 67  | **P-13** legacy workflow graph + migration report       | P      | **Done 2026-09-26 (local).** `explain_flow` `kind:"workflow"`: activity graph, `wf_stage`, opt-in `wf_context` runs, migration report; 24 tests with P-10.                                                                                                                                                                               | M      | 🟢                                                                                                                                                                               |
| 68  | **P-14** UI Builder experience tree                     | P      | Needs P-6, P-9, O-5; new `ui` package.                                                                                                                                                                                                                                                                                                   | L      | 🔴                                                                                                                                                                               |
| 69  | **P-15** workspace, dashboard, list menu, applicability | P      | Needs P-14.                                                                                                                                                                                                                                                                                                                              | S      | 🔴                                                                                                                                                                               |
| 70  | **P-16** Service Portal tree                            | P      | **Done 2026-09-26 (local).** `servicenow_explain_portal` in the new opt-in `ui` package: portal/page tree, decoded widget options, Mermaid layout; 17 tests.                                                                                                                                                                             | M      | 🟢                                                                                                                                                                               |
| 71  | **P-17** `artifact_dependencies`                        | P      | **Done 2026-09-26 (local, uncommitted).** `servicenow_artifact_dependencies` in the opt-in `artifacts` package (`src/api/dependencies.ts`): outbound refFields / decoded JSON / script text, inbound reverse refs + script and flow-step callers + S-9 structural pass; depth 1–3, 150-node cap, JSON or Mermaid; 16 tests.              | M      | 🟢                                                                                                                                                                               |
| 72  | **P-18** registry-driven lint and search                | P      | **Done 2026-09-26 (local).** Portal rules, `lint_script` over opt-in types, `code_health({extended})` registry sweep, `where_used({extended})`. PDI fixture pending (O-5).                                                                                                                                                               | M      | 🟢                                                                                                                                                                               |
| 73  | **P-19** domain analysers (flow, UIB, portal)           | P      | Needs P-10, P-13, P-14, P-16, P-18.                                                                                                                                                                                                                                                                                                      | M      | 🔴                                                                                                                                                                               |
| 74  | **P-20** snapshot/compare over the registry             | P      | **Done 2026-09-26 (local) bar published flow snapshots.** `types` / `scope` on snapshot and compare, normalised records with children, sys_id → natural-key matching, child-aware diffs.                                                                                                                                                 | L      | 🟡                                                                                                                                                                               |
| 75  | **P-21** application documentation generator            | P      | Needs P-17, P-10, P-14, P-16; extends S-15's `document_app` (`DOC_KINDS`), writes through the S-14 store contract.                                                                                                                                                                                                                       | M      | 🔴                                                                                                                                                                               |
| 76  | **P-22** SDK-managed write guard                        | P      | **Done 2026-09-26 (local).** `SN_SDK_MANAGED_WRITES` warn / deny / allow (default warn) on the six Table-style write tools; `SDK_MANAGED_SCOPE`. Open: batch, create without `sys_scope`.                                                                                                                                                | S      | 🟢                                                                                                                                                                               |
| 77  | **P-23** `upsert_artifact` plan/apply                   | P      | Needs H-3, H-5, H-11, S-2, S-8, P-22.                                                                                                                                                                                                                                                                                                    | L      | 🔴                                                                                                                                                                               |
| 78  | **P-24** portal and catalog structural writes           | P      | Needs P-23, P-16, P-8.                                                                                                                                                                                                                                                                                                                   | M      | 🔴                                                                                                                                                                               |
| 79  | **P-25** flow activation toggle                         | P      | Needs P-23, O-5 (behaviour unverified).                                                                                                                                                                                                                                                                                                  | S      | 🔴                                                                                                                                                                               |
| 80  | **P-26** Fluent emitter core (`generate_fluent`)        | P      | P5; needs P-7, P-8, O-7; output under the S-14 store (`<profile>/fluent/<scope>/`, a manifest kind).                                                                                                                                                                                                                                     | L      | 🔴                                                                                                                                                                               |
| 81  | **P-27** flow/subflow/action/playbook emitters          | P      | Needs P-10…P-12, P-26.                                                                                                                                                                                                                                                                                                                   | L      | 🔴                                                                                                                                                                               |
| 82  | **P-28** portal, workspace, catalog emitters            | P      | Needs P-26, P-15, P-16, P-8.                                                                                                                                                                                                                                                                                                             | M      | 🔴                                                                                                                                                                               |
| 83  | **P-29** round-trip verification harness                | P      | Needs P-26, O-7.                                                                                                                                                                                                                                                                                                                         | M      | 🔴                                                                                                                                                                               |

**Recommended cut** for a credible single-maintainer 3.0.0: items 1–19 plus 25–29 (H-1…H-9, E-1…E-4,
M-1/M-2/M-7, S-1/S-2/S-6, D-1…D-4/D-6) with the owner gates O-1…O-4 — roughly 10–13 weeks. Items
20–24 and 30–45 are the stretch set; each ships on 3.x as it lands.

**2026-09-09 update:** H-10 and E-9 (46–47) join the must-have set right after H-2 — small,
non-breaking, and they fix misconfigurations that fail silently today; H-11 (48) joins the 3.0
breaking cluster behind O-4; S-13 (49) precedes M-5; D-9 (50) ships with O-1; M-9 (51) is stretch.
The cut becomes items 1–19, 25–29, 46–50 — roughly 12–15 weeks.

**2026-09-23 update:** S-14 (52) joins the must-have set right after S-2 — non-breaking, about a
week including tests, and S-7's per-table files and `index.json` depend on its frontmatter and
manifest; S-15 (53) is stretch after S-4/S-7 (its `document_table` half can land on 2.x right
after S-14); S-16 (54) ships with D-8. The cut becomes items 1–19, 25–29, 46–50, 52 — roughly
13–16 weeks. Findings and designs:
[INSTANCE-DOCS-ANALYSIS-2026-09.md](INSTANCE-DOCS-ANALYSIS-2026-09.md).

**2026-09-23 update:** rows 55–83 add the SDK parity epic (P-1…P-29, see "SDK parity epic"
below). None of them joins the 3.0 cut; the recommended cut is unchanged.

## Definition of done (per item)

Each item ships green (`npm run check`), with tests in the same change, the manifest and README
tools table regenerated (`npm run gen:manifest`, `npm run docs:readme`), env docs kept in sync, and
a CHANGELOG line. Breaking items add a row to the migration table in the CHANGELOG.

### H-1 — Dependency floor + green audit (S)

- [x] `npm audit --omit=dev --audit-level=high` exits 0 (2026-09-03): `@modelcontextprotocol/sdk`
      `^1.30.0` (installed 1.30.0), then `npm audit fix` moved the transitive `fast-uri` 3.1.7,
      `ip-address` 10.7.0, `hono` 4.13.5, `@hono/node-server` 2.1.1, `qs` 6.16.0, `body-parser`
      2.3.0 — all inside the SDK's own ranges, so no `overrides` were needed. (Gotcha: `npm audit fix --omit=dev` also prunes dev
      dependencies from `node_modules`; run a plain `npm install` afterwards.)
- [x] Floors raised: `zod ^3.25.0` (the SDK peer range); `dotenv ^16.4.5` was already there.
- [x] Verified locally: build, lint, format, 406/406 tests, coverage 95.41/84.94/98.58 unchanged,
      audit 0; the manifest snapshot unchanged. The CI matrix runs on the next push.
- [ ] Two **dev-only** HIGH advisories remain (`brace-expansion`, `js-yaml`, outside the gate's
      `--omit=dev`); fold them into E-2 or the next dependabot pass.
- **Acceptance:** the gate is green with no `overrides` that hide a real fix.

### H-2 — Credential host binding (S)

- [x] `set_credentials` with a changed `instance` **requires** `user` + `password` (or the auth
      material of the profile's method once D-2 lands) in the same call; otherwise it fails with
      `CREDENTIALS_INCOMPLETE` and touches nothing (`src/tools/admin.ts:105-126`).
- [x] The elicitation confirmation fails **closed** for credential changes on clients without
      elicitation unless `SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1` (`src/mcp/registry.ts:203`).
- [x] `SN_ALLOWED_HOSTS` entries still pass through `isBlockedHost` — **settled in H-6 (2026-09-23):** a
      suffix entry never opens an internal/loopback host; an internal host is reachable only when listed
      exactly. Original note: **Open decision
      (2026-09-09):** today `resolveHostWithPolicy` (`src/core/host.ts`) skips `isBlockedHost` for
      allow-listed hosts and `test/jira-host.test.js` pins that as an explicit opt-in ("an allow-listed
      host that is also internal is still reachable"); H-2 left it unchanged. Settle in H-6: keep the
      opt-in, a per-client `HostPolicy` flag (ServiceNow strict, Jira opt-in), or strict for both.
- [x] Tests: instance-only change rejected; full change accepted; stale tokens/caches invalidated —
      `test/admin-credentials.test.js` (8 tests).
- **Acceptance:** no call sequence can make stored secrets travel to a host they were not entered for.
- **Done 2026-09-09 (local, uncommitted):** `src/tools/admin.ts` (`instanceChanged` guard evaluated
  after host validation, before the prompt and before any write; fail-closed
  `confirmCredentialChange`), `src/core/settings.ts` (`allowUnconfirmedCredentialChange()`),
  README env row + `.env.example`, `test/mcp-smoke.test.js` (K-6 opts out so the host guard is
  what rejects). Caveat: only `user` + `password` are re-required — OAuth / API-key / bearer
  material follows with D-2. Tool description extended (first sentence unchanged, so the
  generated README tools table did not move).

### H-3 — Plan-token binding + elicitation on destructive apply (M) — BREAKING

- [ ] `planPreview` returns `plan_token` = base64url HMAC-SHA256 over a canonical
      `{profile, tool, table, sys_id, fieldsHash, exp}` with a per-process secret; TTL
      `SN_PLAN_TOKEN_TTL_SEC` (default 600) (`src/mcp/write-mode.ts`).
- [ ] With `SN_WRITE_MODE=plan` (the default), `apply:true` on `delete_record`, `delete_attachment`,
      `batch` with writes, `send_email`, `order_catalog_item`, `revert_write` (S-2) and
      `change_conflicts(calculate:true)` requires a matching, unexpired `plan_token`; otherwise
      `PLAN_REQUIRED`. `SN_WRITE_MODE=apply` (trusted operator) keeps today's behaviour.
- [ ] When the client advertises elicitation, destructive apply also asks for confirmation; a
      refusal is a `fail` (fails closed) and is journaled as `refused`.
- [ ] Tests: token round-trip, tampering, expiry, wrong profile, apply-mode bypass, elicitation
      refusal.
- [ ] _(gap pass 2026-09-09)_ Optimistic concurrency: the plan captures `sys_mod_count`/`sys_updated_on`, apply refuses `STALE_RECORD` unless `force:true` (journaled) — L2-05; `SN_DESTRUCTIVE_CONFIRM=elicit|token|off` defines the fallback when the client lacks elicitation, prod profiles refuse with `CONFIRM_REQUIRED` — L5-04; email preview = 2 KB `body_preview` + `body_sha256` — L4-06; plan previews list `unknown_fields` from the schema cache — L2-06.
- **Acceptance:** an injected `apply:true` without a preceding plan cannot mutate the instance.
- **Partly done 2026-09-26 (local, uncommitted), non-breaking:** `SN_DESTRUCTIVE_CONFIRM=off|token|elicit`
  (default `off`, so nothing changes until O-4 flips it) and `SN_PLAN_TOKEN_TTL_SEC` (600, 30–86400).
  A spec declares `confirm` (`src/mcp/define.ts`); the gate is `src/mcp/confirm.ts`, called by
  `runSpec` — the only path from the registry (M-9 tasks included) to a handler. Six tools:
  `delete_record`, `delete_attachment`, `batch` (writing only), `send_email`, `order_catalog_item`,
  `revert_write`. **Design change from the first bullet:** the token is an opaque, letters-only
  id (`pt` + 28 letters) whose plan (tool, profile, sha256 of every argument but `apply` /
  `plan_token` / `instance`, expiry) is held in the runtime container (`src/mcp/plan-token.ts`,
  at most 500) instead of a self-describing HMAC — single use needs state anyway (a replayed
  `send_email` would mail twice), and a base64/hex token could be corrupted by the
  `SN_REDACT_PII` digit-run masks that run over every result. A mismatch does not consume the
  token; a match does; `plan_token` is journaled on the applied (or refused) line. `elicit`
  asks only clients that advertise elicitation (others rely on the token); a decline or a
  failed prompt → `CONFIRM_DECLINED` (403), journaled `refused`. `PLAN_REQUIRED` (428) is not
  journaled (nothing was attempted). `test/plan-token.test.js` (16 tests, mutation-checked).
  `change_conflicts(calculate:true)` joined as the seventh tool with H-4 (2026-09-26).
  Also done 2026-09-26: `STALE_RECORD` on update / delete through `apply_with.expected_mod_count`
  (no `force` flag — omitting the count is the override; L2-05), `unknown_fields` from the schema
  cache (L2-06), the email `body_preview` / `body_sha256` (L4-06), prod `CONFIRM_REQUIRED` (with
  H-11), and `expected_*` left out of the token hash. **Open:** the 3.0 default (O-4 / B4); the
  D-8 `PreToolUse` hook.

### H-4 — Policy-axis bypass closure (M) — BREAKING (batch default)

- [ ] `batch`: sub-requests whose path prefix is not in `PACKAGE_BY_PATH` are **denied** unless
      `SN_BATCH_ALLOW_UNMAPPED=1`; nested batch paths denied; table extraction covers path **and**
      body/headers; a manifest-vs-map pin test (closes GA-7) (`src/api/batch.ts:77-103,194-214`).
- [ ] Import-set insert/get already check the staging table (`src/api/importset.ts:23,38` —
      **verified 2026-09-09**, GAP C-1; the `SN_IMPORT_SET_TABLES` allowlist is H-11); attachment
      get/download/delete check `table_name` of the
      attachment record (`src/tools/attachment.ts`); catalog/change/email tools check their
      backing tables; direct `snRequest` reads in atf/diagnostics/capabilities/scripts route through
      the policy check.
- [ ] `change_conflicts(calculate:true)` becomes a plan/apply write and is journaled
      (`src/tools/change.ts:145-169`).
- [ ] Batch previews include request bodies (redacted).
- [ ] _(gap pass 2026-09-09)_ `SN_BATCH_MAX_REQUESTS` (50) enforced before any request is built — L2-03; probe-read semantics (`unknown`, not an error) are defined in H-11 — L3-05.
- **Acceptance:** a property test over every write tool proves no path reaches the instance
  without a policy verdict.
- **Partly done 2026-09-26 (local, uncommitted), non-breaking:** batch — nested batch paths are
  always refused; `SN_BATCH_UNMAPPED=allow|deny` (default `allow` until O-4; the roadmap's
  `SN_BATCH_ALLOW_UNMAPPED=1` becomes `SN_BATCH_UNMAPPED=allow` so one knob covers both sides of
  the flip); tables come from the path, the query (`table_name`, attachment `sysparm_query`) and
  the body (Email API `table_name`, IRE `items[].className` + `cmdb_rel_ci`); an attachment
  addressed by sys_id is resolved to its parent table with one metadata read while a table policy
  is set, and an unscoped attachment list is refused then; `SN_BATCH_MAX_REQUESTS` (1–1000,
  default 1000 — the 50 of L2-03 is an O-4 decision) is checked first; `PACKAGE_BY_PATH` gains
  `sn_cicd` → atf, `sn_codesearch` → scripts, `identifyreconcile` → cmdb; previews list each
  sub-request's body (through the result redaction), tables and package. Attachments get /
  download / delete check the parent `table_name`; an unscoped `list_attachments` drops rows of a
  denied table. Backing tables: change (`change_request`, `conflict` on calculate), catalog
  (`sc_catalog`, `sc_category`, `sc_cat_item`, `sc_request` + `sc_req_item` on order), knowledge
  (`kb_knowledge`), email (`sys_email` + the associated record's table), ATF (`sys_atf_test`,
  `sys_atf_test_suite`); Code Search API hits on a denied table are dropped. `change_conflicts`
  (`calculate:true`) is plan/apply, journaled (`execute` on `conflict`) and an H-3 destructive
  apply. Headers carry no table on any mapped API, so nothing is read from them.
  `test/policy-h4.test.js` (17 tests, mutation-checked): the acceptance sweep calls every tool
  with an `apply` argument under `SN_READONLY` and with its target table denied — no mutating
  request in either; the GA-7 pin test fails when `src/api` calls a REST prefix that
  `PACKAGE_BY_PATH` does not map. **Deliberate exception:** `test_connection` still reads one
  `sys_user` sys_id past the table policy (a diagnostic). **Open:** the unmapped / max-requests
  defaults (O-4); probe-read semantics and `SN_IMPORT_SET_TABLES` (H-11); the Code Search LIKE
  fallback still refuses the whole search when a default script table is denied (the API path
  filters instead).

### H-5 — Journal v2 + deep redaction (M)

- [x] `JournalEntry` gains `before` (captured from the plan or a pre-read on update/delete),
      `id` (ulid), `plan_token`, `update_set` (S-6), `client` (session id in HTTP mode), `result`
      (`applied|failed|refused`); JSONL stays append-only, Markdown rendered from it
      (`src/core/write-journal.ts`).
- [x] Redaction (`SN_REDACT_FIELDS`, `SN_REDACT_PII`) is applied once at the `ok()`/`fail()`
      boundary for every tool result and to journal fields — not only in `query_table`
      (`src/mcp/result.ts`, `src/mcp/redact.ts`).
- [x] `.env` writes are atomic (temp file + rename, `0600`); `docs_write` cannot target
      `write-journal.*`; `resolveDocPath` uses `realpath`; README documents ignoring
      `docs/instance/` in downstream repos.
- [x] Tests: before-state on update/delete; redaction on every write tool's result; concurrent
      `set_credentials` leaves a valid file.
- [x] _(gap pass 2026-09-09)_ `schema_version: 2`, `prev` sha256 chain, `SN_JOURNAL_MAX_BYTES` rotation, reader across files with `integrity` — L2-02; one journal line per non-GET batch sub-request sharing a `batch_id` — L2-03; `local_write` entries for docs/snapshot/compare/`code_health` files and `config` entries (key names only) for admin changes — L2-04; CSV formula-injection guard + BOM in `toCsv` — L2-01.
- [x] _(instance-docs pass 2026-09-23)_ `docs/instance/` added to this repo's own `.gitignore` (pack-check already excluded it from the tarball; git did not) — ID-04, landed with H-5. The other half of ID-04 — the invariant "generated documents contain metadata only, never record data" stated in the `src/api/docs.ts` header and enforced by an allow-list walker over the generators' fetch calls — moved to S-14's tests bullet (INSTANCE-DOCS §9).
- **Acceptance:** every journal line is enough to build the inverse operation (S-2) and contains
  no unredacted secret or PII.
- **Done 2026-09-23** (non-breaking; v1 lines stay readable and seed the chain). `src/core/write-journal.ts`
  writes v2 lines (ULID `id`, `result`, `before` via a best-effort pre-read on table/change/CMDB
  update/delete and attachment delete, `client` from the MCP session id, `prev` chain + `write-journal.head`,
  `SN_JOURNAL_MAX_BYTES` rotation, Markdown re-rendered from the last 200 entries) and
  `readWriteJournal()` verifies `integrity` across rotated files. `journaledWrite()` records
  `applied`/`failed`/`refused` (HTTP 403, including policy refusals) for every write tool; batch
  writes one line per non-GET sub-request plus the envelope; docs/snapshot/compare/code-health files
  log `local_write`, `set_credentials`/`use_instance` log `config` with key names only. Deep redaction
  (`src/core/redaction.ts`) runs at `ok()`/`okStructured()`/`fail()` and on journal `fields`/`before`/`error`.
  `.env` temp names are unique per write and cleaned up on failure; `docs_write` refuses `write-journal.*`
  and symlink escapes (realpath); `toCsv` has the formula guard (`SN_CSV_FORMULA_GUARD`) and BOM
  (`SN_CSV_BOM`), reported in `query_table`'s `_meta.csv`. Tests: `test/journal-v2.test.js`.
  **Deferred:** `plan_token` is reserved, not populated (needs H-3); `update_set` is reserved (needs S-6);
  no `list_writes` tool or revert, only the `readWriteJournal()` reader, so the tool manifest is unchanged (S-2);
  batch sub-requests get no `before` pre-read, and the sub-request cap `SN_BATCH_MAX_REQUESTS` is left to H-4.

### H-6 — Outbound hardening (M)

- [x] `send_email`: recipients must match `SN_EMAIL_ALLOWED_DOMAINS` (default: the instance's own
      user directory, i.e. resolved through `sys_user.email`); anything else fails
      `RECIPIENT_NOT_ALLOWED`.
- [x] Host guard: `SN_ALLOWED_HOSTS` matches are still checked by `isBlockedHost`; the IPv6
      literal branch is reachable and tested (`src/core/host.ts:21-30,96-112`).
- [x] HTTP client: `redirect: "manual"` (a redirect is an error with the target host in the
      message), a `Content-Length`/streamed size cap before buffering (`SN_MAX_BODY_BYTES`),
      optional `SN_HTTPS_PROXY` via undici's `ProxyAgent` (`src/core/http.ts:140-149,247-264`).
- [x] TLS verification off (`src/core/mtls.ts:35-38`) logs a startup warning and shows in
      `get_status`; the OAuth login callback verifies path and `state` before exchanging the code
      (`src/core/oauth-login.ts:135-148`).
- [x] _(gap pass 2026-09-09)_ `SN_MAX_UPLOAD_BYTES` (10 MiB, checked before decoding), filename sanitisation, `SN_UPLOAD_MIME_ALLOW` — L2-09; the docs store rejects Windows reserved names and `:` streams, `SN_DOCS_MAX_FILE_BYTES` on write/read/search — L2-10; recipients through the `email()`/`recipients(50)` builders so `SN_EMAIL_ALLOWED_DOMAINS` has parseable input — L4-06. TLS/proxy/User-Agent items live in H-10.
- **Done 2026-09-23 (local).** `SN_EMAIL_ALLOWED_DOMAINS` (`*` = any) with a fail-closed
  `sys_user` lookup as the default, `RECIPIENT_NOT_ALLOWED`, `email()`/`recipients(50)` builders;
  suffix `SN_ALLOWED_HOSTS` entries never open an internal host (an exact entry is the opt-in),
  full IPv4/IPv6 internal ranges incl. mapped forms; `redirect: "manual"` → `REDIRECT_BLOCKED`
  naming the target host (API, Jira, OAuth); `SN_MAX_BODY_BYTES` (50 MiB, declared + streamed,
  error bodies read as a 64 KiB prefix) → `RESPONSE_TOO_LARGE`; TLS-off warning at startup and
  `get_status.http.warnings`; OAuth callback ignores wrong path (404) and foreign `state` (400)
  and keeps listening; uploads capped before decoding (`PAYLOAD_TOO_LARGE`), leaf-name
  sanitised, `SN_UPLOAD_MIME_ALLOW` (`MIME_NOT_ALLOWED`); docs store rejects reserved names and
  `:`, realpath-checks symlinks (SEC-24), `SN_DOCS_MAX_FILE_BYTES` on write/read (truncated)/
  search (skipped). Tests: `test/outbound-hardening.test.js`. **Deferred:** a DNS-resolution
  check (a public name resolving to an internal address needs a connect-time lookup); the
  `send_email` body preview cap (H-3); per-file bytes in `docs_list`; `docsWriteRaw` stays
  uncapped. The proxy item was delivered by H-10. **Behaviour change:** without
  `SN_EMAIL_ALLOWED_DOMAINS`, mail to addresses outside the instance directory is now refused.
- **Acceptance:** SSRF/exfil tests for each vector; the security audit's SEC-14/16/17/18/19/24 are
  closed.

### H-7 — HTTP transport v2 (L) — BREAKING (session semantics)

- [ ] One `StreamableHTTPServerTransport` **per session**, kept in a `Map<sessionId, transport>`
      created on `initialize` (`onsessioninitialized`) and dropped on `DELETE`
      (`onsessionclosed`) or idle timeout (`SN_HTTP_SESSION_TTL_SEC`); a fresh `McpServer`
      instance per session so notifications and `setLevel` are per client
      (`src/mcp/transport.ts`).
- [ ] `enableDnsRebindingProtection` + `allowedHosts` (default loopback names) and an `Origin`
      allowlist (`SN_HTTP_ALLOWED_ORIGINS`); `/healthz`; `listen` error handler; graceful shutdown
      on SIGTERM; non-loopback bind **refuses to start** without `SN_HTTP_TOKEN`.
- [ ] Active profile lives in the session context (E-3 runtime + ALS), not in `process.env`;
      `use_instance` in HTTP mode is per session; token/schema/plugin caches keyed by profile +
      host (closes C-7).
- [ ] Optional `SN_HTTP_AUTH=oauth` using the SDK's `requireBearerAuth` + a token verifier for
      hosted deployments (design only; the static bearer stays the default).
- [ ] Tests: two concurrent sessions on different profiles with no cross-talk; reconnect after
      `DELETE`; rebinding request rejected; bearer required; e2e over a real port.
- [ ] _(gap pass 2026-09-09)_ `sseKeepAlive` (`SN_HTTP_KEEPALIVE_MS`, 25 s) and `/readyz` (`?probe=1`) — L5-06; `use_instance({persist})` is session-scoped by default, `persist:true` writes the env file and is journaled (B12) — L2-13.
- **Acceptance:** the transport passes the MCP inspector against two simultaneous clients.

### H-8 — Platform corner-case pins (M)

- [x] C-3: a 2xx with `content-type: text/html` throws `INSTANCE_HTML_RESPONSE` ("a PDI may be
      hibernating — wake it at developer.servicenow.com") (`src/core/http.ts:237,256-264`) —
      `parseJsonOrThrowHtml()` (HTML content type or an HTML-looking body); a hibernation-like page
      gets `HIBERNATING_HINT`, any other page `INSTANCE_HTML_HINT`; `detail.raw` is tag-stripped
      text ≤ 512 chars; `shapeErrorBody` classifies a non-2xx hibernation page the same way.
- [x] C-1: `fetchAll` continues past a short page until an empty page or `X-Total-Count`; the
      truncation message names the real cause (`src/api/table.ts:109-116`) — a repeated first
      record ends the read; scan budget `cap × FETCH_ALL_SCAN_FACTOR` (10); `QueryResult` gains
      `truncatedReason` (`cap` | `scan_limit`) and `filtered`; `queryCompleteness()` in
      `src/mcp/result.ts` builds the note for JSON and CSV results.
- [x] C-4: `sysparm_display_value=all` shapes pinned for redaction, CSV and diagram generators —
      PII redaction scans inside `{ value, display_value }` pairs; `snString` unwraps
      `{ value: scalar }`; a CSV pair stays one quoted JSON cell (a two-column split is a 3.0
      decision).
- [x] C-9: attachment edges (UTF-8 filenames, 0-byte files, base64 inflation vs
      `SN_MAX_RESULT_CHARS`); C-10: "plugin inactive" vs "plugin missing" messages; C-11/C-12:
      domain-separation and cross-scope caveats printed in drift/where-used reports — uploads also
      accept a `data:` URL, downloads carry `sizeBytes`; `PLUGIN_CANDIDATES` + a best-effort
      `v_plugin` / `sys_plugins` probe (`setPluginProbe()` test seam); `compareInstances` and
      `whereUsed` return `caveats` (the drift report gains a `## Caveats` section).
- **Acceptance:** one test per corner; the demo path on a fresh PDI gives actionable errors.
- **Done 2026-09-23 (local, uncommitted):** `test/platform-corners.test.js` (25 tests, one or more
  per corner); `fetchall.test.js`, `compare.test.js`, `whereused.test.js`, `plugin.test.js`,
  `meta.test.js` updated. No tool schema or description changed; no BREAKING change (optional
  fields and a new error code on a path that used to return an unusable `{ raw }` body). Gate on
  its branch: 506/506, coverage 96.17 / 86.89 / 98.48, audit 0. Caveats: the hibernation wording
  and the `PLUGIN_CANDIDATES` ids are recorded shapes, not live captures (the probe needs admin-level
  read on many instances, else the old wording stays); snapshot's `warnIfTruncated` still says
  "SN_MAX_RECORDS cap" for a scan-limit stop; base64url uploads are not accepted; `fetchAll` issues
  more requests on ACL-filtered tables (bounded by the scan budget). The where-used "inherited parent rules are not included" caveat now points to
  `servicenow_trace_table_event` and `servicenow_generate_table_flow`, which list inherited and global
  rules since S-1. Ported onto main's H-10 / S-1 / H-9: 519/519.

### H-9 — CI + version hygiene (S)

- [x] Actions pinned to commit SHAs; top-level `permissions: read-all` with per-job elevation;
      `publish-mcp.yml` downloads a checksummed, versioned publisher binary
      (`.github/workflows/*.yml`).
- [x] `test/version-sync.test.js` pins package.json, `package-lock.json` root, `server.json`,
      `extension/package.json`, `.claude-plugin/plugin.json` and `marketplace.json` to one version;
      bumps go through `npm version`.
- [x] CI greps the launcher's Node message from `package.json` engines instead of a literal
      (`ci.yml:83`).
- [x] _(gap pass 2026-09-09)_ `ci.yml`: `permissions: {contents: read}`, `concurrency` with cancel-in-progress, `timeout-minutes`, SHA pins, `actionlint` — L9-06; `pack:check` (tarball allowlist, size cap, no `jira`/`*.map`/`test/`) with the `files` negation `!build/**/jira/**` — L9-04; `.gitignore` `.env.*` + `!.env.example` + `.env.tmp-*` and a tracked-env CI check — L9-07; Prettier idempotency gate + explicit `proseWrap` — L9-08; the version-sync test covers `.claude-plugin/plugin.json` and the docs badge (currently 2.0.0 vs 2.0.1) — L9-12.
- **Acceptance:** a version mismatch fails the gate, not the publish.
- **Done 2026-09-23 (local, uncommitted).** All five workflows pin `actions/checkout` /
  `actions/setup-node` 4.4.0, `codecov/codecov-action` 5.5.5 and `github/codeql-action` 3.38.1 by
  SHA; top-level `permissions: contents: read` everywhere (stricter than the `read-all` written
  above) with `id-token: write` only on the two publish workflows and `security-events: write`
  only on the CodeQL job; `ci.yml` gains `concurrency` + cancel-in-progress, `timeout-minutes`
  on every job, an `actionlint` job (1.7.12), the `pack:check` / "No tracked env files" /
  "Prettier idempotency" steps on the ubuntu/Node 22 leg, and the launcher probe reads
  `engines.node`. `publish-mcp.yml` pins `mcp-publisher` 1.8.1 and verifies it against
  `registry_1.8.1_checksums.txt`. New `scripts/pack-check.mjs` (allow-list `LICENSE`, `README.md`,
  `package.json`, `bin/`, `build/`; no `jira/` / `.map` / `test/` / `docs/instance/`; ≤ 600 KB
  unpacked — 439.7 KB today) with `files: !build/**/jira/**`; `scripts/sync-version.mjs`
  (`npm run version:sync`, `--check`) + the `npm version` hook keep `package-lock.json`,
  `server.json`, `extension/package.json`, `extension/package-lock.json`,
  `.claude-plugin/plugin.json` and `docs/index.html` (badge + `softwareVersion`) at one version,
  pinned by `test/version-sync.test.js` (8 tests, incl. the launcher literal ↔ `engines.node`);
  `.claude-plugin/plugin.json` 2.0.0 → 2.0.1 fixed. `marketplace.json` carries no version of its
  own (a test asserts that). `.gitignore` `.env.*` + `!.env.example` + `.env.tmp-*`;
  `.prettierrc.json` `proseWrap: preserve`; `npm run format` is two passes; CONTRIBUTING has the
  version-bump flow. Gate: 494/494, coverage 96.01 / 86.56 / 98.49, `pack:check` 78 files,
  actionlint 0. Not done (out of this item's scope): `timeout-minutes` on the three publish
  workflows.

### H-10 — HTTP client resilience + identity (M)

- [x] One dispatcher factory (`getDispatcher(host)`): `SN_HTTPS_PROXY` → `HTTPS_PROXY`/`HTTP_PROXY`
      with `NO_PROXY`; TLS options (`SN_TLS_CA[_FILE]`, `SN_TLS_REJECT_UNAUTHORIZED`) applied
      **without** a client certificate; cache key by PEM sha256 + profile, disposed on profile
      switch (GAP L1-01, L1-03, L1-04).
- [x] `User-Agent: servicenow-mcp-ai/<version> (node/<major>; <transport>; <client>)`,
      `SN_USER_AGENT_SUFFIX` (L1-02).
- [x] `SN_DEADLINE_MS` across retries, per-call timeout override, `AbortSignal.any` with the M-3
      signal, `SN_RETRY_AFTER_MAX_MS`; `DEADLINE_EXCEEDED` error code (L1-06).
- [x] `withSlot` bounded: `SN_MAX_QUEUE`, `SN_QUEUE_TIMEOUT_MS`, `BUSY` code; `get_status` and
      `doctor` bypass the queue (L1-09).
- [x] Non-JSON error bodies capped at 512 chars, tag-stripped, classified `UPSTREAM_HTML`; JSON
      detail capped at 2 KB (L1-08; the hibernation case C-1 stays in H-8).
- [x] OAuth token and code-exchange requests go through the shared `rawRequest` primitive
      (dispatcher, UA, retry, deadline, telemetry bucket `auth`) (L1-10).
- [x] Explicit port and bracketed IPv6 accepted only for allow-listed hosts (L1-05).
- [x] Per-host circuit breaker (`SN_BREAKER_THRESHOLD`, `SN_BREAKER_RESET_MS`, `CIRCUIT_OPEN`) —
      landed opt-in, off by default (L1-07).
- [ ] Rate-limit header parsing into telemetry (the second half of L1-07) — slipped to 3.x.
- **Acceptance:** dispatcher option matrix (8 combinations) and proxy/`NO_PROXY` matrix green on the
  E-6 fetch double v2; a token request under mTLS or proxy uses the dispatcher; a 300 KB HTML 502
  yields an error ≤ 1 KB; the 65th queued call fails fast with `BUSY`.
- **Done 2026-09-23 (local, uncommitted):** new `src/core/dispatcher.ts` (proxy + TLS option
  matrix, cache keyed by material sha256 + profile, `disposeDispatchers()` closes the pools on
  `set_credentials` / `use_profile` and inside `dispose()`; `mtls.ts` is a thin alias; `undici`
  stays optional with a clear install hint) and `src/core/identity.ts` (`userAgent()` from
  `package.json`, the transport and the client name of the initialize handshake; suffix printable
  and capped). `rawRequest` in `http-util.ts` is the single primitive (UA, dispatcher, bounded
  `withSlot` with `SlotBusyError` full / timeout / drained, deadline via `anySignal`,
  `retryAfterMs` cap, `shapeErrorBody`, opt-in breaker); `snRequest` gains `signal`, `timeoutMs`,
  `bypassQueue`; the Jira twin rides the same primitive (`clientCert: false`); `requestToken` goes
  through it with `telemetryKey: "auth"` and retries only replayable requests. `ServiceNowError`
  carries `code` + `hint` (surfaced by `fail()`); `get_status` reports `http` (`userAgent`,
  redacted `proxy`, `tls`, `queue`). Tests: `test/http-resilience.test.js` (43 — the
  8-combination dispatcher matrix and the proxy / `NO_PROXY` matrix on a fake `undici`, token
  requests under proxy and mTLS, the 300 KB HTML 502 → ≤ 1 KB, the 65th queued call → `BUSY`,
  deadline, breaker, host:port / IPv6), `test/identity.test.js` (6) and one lifecycle test for
  the `dispose()` hooks. The E-6 fetch double v2 does not exist yet — the matrices run on
  `withFetch` + the fake `undici`.

### H-11 — Policy model v2 (M) — BREAKING (protected tables)

- [ ] Glob patterns (`*`, `?`) in `SN_ALLOW_TABLES`/`SN_DENY_TABLES`; precedence deny > allow,
      exact > pattern; optional `SN_TABLE_POLICY_FILE` (GAP L3-01).
- [ ] Built-in `PROTECTED_TABLES` write-denied by default (`sys_user`, `sys_user_has_role`,
      `sys_user_role`, `sys_user_grmember`, `sys_security_acl`, `sys_properties`, `oauth_entity`,
      `sys_auth_profile_basic`, `sys_script`, `sys_ws_operation`, `sys_public`, `sys_ldap*`,
      `sys_certificate`, `sys_data_source`, `sys_rest_message*`); override by an explicit
      `SN_ALLOW_TABLES` entry or `SN_PROTECTED_TABLES_WRITE=allow` (B11).
- [ ] `SN_IMPORT_SET_TABLES` allowlist for staging tables (default `u_*,imp_*`).
- [ ] Write caps `SN_MAX_WRITES_PER_SESSION`, `SN_MAX_DELETES_PER_SESSION`, `SN_MAX_BATCH_WRITES`;
      `WRITE_CAP` code; counters in `get_status` (L3-02).
- [ ] `SN_PROFILE_<NAME>_ENV=prod|test|dev` / `SN_ENV`; prod ⇒ plan mode unless
      `SN_PROFILE_<NAME>_PROD_WRITES=I_UNDERSTAND`, mandatory elicitation, `_meta.environment`,
      `warn` on switch (L3-03).
- [ ] `servicenow_explain_policy` tool + `servicenow://policy` resource sharing one evaluator with
      `assertTableAllowed` (L3-04).
- [ ] Probe reads classified `probe`; a denied probe yields `unknown`, never an error (L3-05).
- **Acceptance:** with no policy in apply mode, `create_record` on `sys_user_has_role` fails
  `POLICY_DENIED`; `SN_DENY_TABLES=sys_*` blocks `sys_user` and allows `incident`; property test:
  a pattern without wildcards behaves as an exact match.
- **Done 2026-09-26 (local, uncommitted) except the BREAKING default and the policy file.** The
  variables are the existing `SN_TABLES_ALLOW` / `SN_TABLES_DENY` (the bullets above say
  `SN_ALLOW_TABLES` / `SN_DENY_TABLES`, which the code never read). One evaluator
  (`evaluateTable`, `src/core/policy.ts`) behind `assertTableAllowed`, the new
  `assertTableWriteAllowed` (Table API create/update/delete — so upsert, revert and
  `set_property` —, import sets, CMDB create/update/IRE, batch write sub-requests),
  `servicenow_explain_policy` (always-on admin, 94 tools) and `servicenow://policy`
  (`src/mcp/policy-view.ts`). Order: exact deny, exact allow, pattern deny, protected (writes),
  allowlist patterns. `PROTECTED_TABLES` = the list above plus `sys_security_acl_role`;
  `SN_PROTECTED_TABLES_WRITE` defaults to `allow` until O-4 (B11). `SN_IMPORT_SET_TABLES`
  defaults to unrestricted (the `u_*,imp_*` default is O-4 too). Write caps default to no cap
  (the GAP's 500 / 100 / 50 are O-4); a session is the runtime container; a batch counts its
  write sub-requests; `WRITE_CAP` (429) is journaled with `cap_hit`. Environment marker: `SN_ENV`
  for the default profile, `SN_PROFILE_<NAME>_ENV` otherwise; new per-profile
  `SN_PROFILE_<NAME>_WRITE_MODE`; the ack is `SN_PROD_WRITES` / `SN_PROFILE_<NAME>_PROD_WRITES`;
  a prod profile is `elicit` at least and is confirmed in apply mode too (`CONFIRM_REQUIRED` for a
  client without elicitation). L3-05: the probes already degrade (`probeTable` → `policyDenied`,
  the matrix → `unknown`, the plugin probe → undefined) — pinned by a test; `SN_PROBE_TABLES`
  is not added (the policy's read set is the default the GAP proposed). `settings.ts` resolves
  the active profile through the new dependency-free `src/core/profile.ts` (a `settings →
config → runtime` cycle broke module init). `test/policy-h11.test.js` (17 tests,
  mutation-checked). **Open:** `SN_TABLE_POLICY_FILE`; the 3.0 defaults (O-4); attachments are not
  treated as writes to the parent's (protected) table.

### M-1 — Server instructions + configuration state (S)

**Done 2026-09-26 (local, uncommitted).** Open bits: `profiles[]` stays the name list (the rich
list is `profileDetails` until the O-4 window); no per-profile _env_ yet (H-11 / L3-03); no
`init` tool (the hint names `set_credentials` and the env file); the core `tools/list` budget rose
to 32,000; owner questions in TODO.md → batch 11 (M-1).

- [x] `McpServer` gets `instructions` generated from the manifest: active packages, write mode,
      active profile, whether credentials are configured and how to fix that
      (`src/index.ts:92-98`).
- [x] When unconfigured, every tool fails with `NOT_CONFIGURED` and a hint pointing at
      `set_credentials` / `init` — the model can recover without a human reading stderr.
- [x] _(gap pass 2026-09-09)_ Server `title`/`websiteUrl`/`icons` (inline SVG) — L4-01; `get_status` v2 groups: version, uptime, pid, transport, write mode + policy summary, redaction, docs dir, limits, TLS, proxy, cache stats, write counters, queue depth, rate-limit, profile source; `profiles[]` with per-profile auth/env/write mode — L4-04, L8-01.
- **Acceptance:** a first-run transcript in the docs shows the model configuring itself — README
  → "First run: the model configures itself"; `test/server-info.test.js` (18 tests).

### M-2 — Error contract v2 (M) — BREAKING

- [ ] `fail()` emits `{error, code, hint?, source: "servicenow"|"server"|"policy", detail?}`;
      `snDetail` is renamed `detail`; codes are an exported enum (`NOT_CONFIGURED`,
      `POLICY_DENIED`, `PLAN_REQUIRED`, `PLAN_EXPIRED`, `UNREADABLE`, `INSTANCE_HTTP_<status>`,
      `INSTANCE_HTML_RESPONSE`, `RECIPIENT_NOT_ALLOWED`, `CREDENTIALS_INCOMPLETE`, …)
      (`src/mcp/result.ts:38-69`, `src/core/errors.ts`).
- [ ] A neutral base error class (ARCH-11b) with `ServiceNowError`/`JiraError` as subclasses.
- [ ] Resources throw `McpError` (`ResourceNotFound`, `InvalidParams`) instead of returning
      200 JSON (closes A2-5); the docs template's declared and returned `mimeType` agree
      (`src/mcp/resources.ts`).
- [ ] Policy and doctor messages carry the fix (which env var, which role) (`src/core/policy.ts:9`,
      `src/api/doctor.ts:139-145`).
- **Acceptance:** every `fail` path in the suite asserts a `code`; the manifest snapshot documents
  the codes per tool.

### M-3 — `extra` plumbing: cancellation, progress, correlation (M)

- [x] `runSpec` receives the SDK `extra`; `signal` is propagated to `snRequest` so a cancelled
      tool call aborts the in-flight fetch; `progressToken` drives `notifications/progress` from
      `fetchAll`, `snapshot_instance`, `compare_instances`, `batch` (`src/mcp/registry.ts:243`,
      `src/mcp/define.ts`).
- [x] _(instance-docs pass 2026-09-23)_ `progressToken` also drives `document_instance` and `document_app` (S-15): one tick per document, `message` = the path just written — ID-15.
- [x] The ALS context becomes `{profile, requestId, sessionId?, tool}` and every log line carries
      it (`src/core/request-context.ts`, `src/core/logging.ts`).
- **Acceptance:** a cancelled snapshot stops issuing requests within one retry window.
- **Done 2026-09-24 (local, uncommitted).** SDK `extra` → call context; `signal` aborts fetch / queue wait / backoff (`CANCELLED`); throttled `notifications/progress` from `query_table` fetchAll, snapshot, compare, batch; log lines carry `{profile, requestId, sessionId?, tool}`. The S-15 progress bullet waits for S-15 (`trackProgress(n).tick(path)` in `src/core/progress.ts` is the hook).

### M-4 — Completions + reference resources + content boundary (M)

- [x] `complete` callbacks on the three `ResourceTemplate`s (table names from the schema cache,
      profile names, doc paths) and on prompt arguments (`src/mcp/resources.ts:108,152,205`).
- [x] `servicenow://reference/encoded-query` (operators, `ORDERBY`, `javascript:` helpers,
      escaping limits from C-6) — delivered by S-8 (`src/mcp/resources.ts:130-150`).
- [x] New resource `servicenow://reference/tools` (the manifest as Markdown).
- [x] Prompt arguments and instance-sourced text are wrapped in an untrusted-content boundary
      (closes SEC-21) (`src/mcp/docs.ts:86,116`).
- [x] _(gap pass 2026-09-09)_ `completable()` on prompt arguments (tables, profiles); `list` callbacks on the three resource templates, capped at 100 — L5-03.
- [x] _(instance-docs pass 2026-09-23)_ The docs `list` is served from the S-14 manifest (`index.json`): `name` = title, `description` = `<profile> · <kind> · <generated_at>`, `mimeType` `text/markdown` (or `application/json` for companions), generated documents first; the cap of 100 never hides a final `servicenow://docs/index.md` entry; `complete` on `{path}` completes from the manifest by prefix and profile — ID-13.
- [ ] _(instance-docs pass 2 2026-09-25)_ The docs resource serves `.json` companions with `mimeType` `application/json` (by extension — today fixed to `text/markdown`, `src/mcp/resources.ts:280,290`) and passes the profile segment to `docsRead`; the manifest-driven `list` gets the companions from ID-21's manifest entries — ID-21. The prompt's use of the reference resource moves to S-15 (ID-25).
- **Acceptance:** the inspector shows completions for `{table}`; `servicenow://reference/tools`
  lists every registered tool (the prompt's use of the encoded-query resource is S-15's
  acceptance, ID-25).
- **Done 2026-09-25 (local, uncommitted).** `complete` + `list` (cap 100) on the schema / profile-schema / docs templates from local state only; docs list from the S-14 manifest; `servicenow://reference/tools`; encoded-query reference widened (`BETWEEN`, `SAMEAS`, `javascript:` values); `src/mcp/boundary.ts` untrusted-content block on prompt arguments and docs resources. Left out: boundary on tool results and `servicenow_docs_read` (would break read-modify-write). The pass-2 `.json` companion bullet stays open: the mimeType mapping handles `.json`, but companions are not in the manifest and `docsRead` refuses them.

### M-5 — Dynamic packages + listChanged (M)

- [x] Admin tools `list_packages`, `enable_package`, `disable_package` — session-scoped, never
      exceeding the policy axes; registered tools use `enable()`/`disable()` and the server emits
      `notifications/tools/list_changed`.
- [x] `resources/list_changed` on profile changes; `sendResourceUpdated` for
      `servicenow://status` subscribers.
- [x] _(gap pass 2026-09-09)_ Prompts declare `requires: [packages]` and register only when all are on; the overview prompt calls S-13 first and prefixes a prod warning (H-11) — L4-02, L3-03.
- **Acceptance:** a client starting with `core` can pull `codecheck` in without a restart, and
  cannot pull a denied package.
- **Done 2026-09-26 (local, uncommitted).** `src/mcp/packages.ts` `PackageSession`: every
  policy-permitted tool is registered up front and toggled through `RegisteredTool`
  `enable()`/`disable()`; `servicenow_list_packages`, `servicenow_enable_package`,
  `servicenow_disable_package` (admin, always on) never widen `SN_PACKAGES_DENY` (re-checked live)
  or `SN_PACKAGES_READONLY`; list_changed notifications are debounced per tick; the session resets
  to the configured set when the runtime is disposed. Package resources are registered /
  removed with the package; prompts carry `{all, any}` requirements and follow toggles; new
  always-on `servicenow_instance_overview` prompt (capabilities first, production caution until
  H-11). `resources.subscribe` + `listChanged`; `use_instance` / `set_credentials` send
  `resources/list_changed` and `resources/updated` for `servicenow://status` subscribers.
  `test/dynamic-packages.test.js` covers the acceptance (core → `codecheck` without restart;
  denied package refused). 92 tools in 26 packages.

### M-6 — outputSchema + token budget (M)

- [x] `outputSchema` + `structuredContent` for every tool with a stable shape (status, meta,
      capabilities, table reads, scripts, flows, codecheck reports); text stays for humans.
- [x] The auto-injected `instance` description shrinks to ~30 chars; descriptions capped at ~250
      chars; a `tools/list` byte-budget test (`all` ≤ 45,000 chars, `core` ≤ 14,000)
      (`src/mcp/registry.ts:226-240`).
- [x] _(gap pass 2026-09-09)_ Manifest v2 pins `inputSchema` (sorted keys), `outputSchema`, `description_sha256`, `since`; the budget test reads it — L5-01; schema-bounds walker: no string/array leaf without `maxLength`/`maxItems` — L2-07.
- **Acceptance:** budget test green; the manifest snapshot lists the schema per tool.
- **Done 2026-09-26 (local, uncommitted).** 30 tools declare an `output` shape (status, connection,
  instances, capabilities, meta, table reads, aggregate, scripts, flows, codecheck, ATF reads,
  artifacts, update sets); `runSpec` attaches the parsed JSON payload as `structuredContent`, the
  text content stays, and an error result never carries it. Output schemas are passthrough
  (`additionalProperties: true`). Descriptions capped at 250 characters and the `instance` param at
  30 (`test/output-schema.test.js`). Manifest v2 (`scripts/gen-manifest.mjs`,
  `test/fixtures/tools-manifest.json`). The budget targets were not reachable without trimming the
  parameter descriptions: measured `all` 124,050 (86 tools) and `core` 30,560 (20 tools), so the
  test ratchets at 125,000 / 31,000 — owner to restate (M-6 budget). The schema-bounds walker also
  walks the output schemas; the input leaves are unchanged by them. Deferred: parameter description
  trimming toward 45k / 14k, output shapes for the write / ops / cmdb / properties / directory /
  docs tools, a `since` backfill from history.

### M-7 — Tool naming convention v3 (L) — BREAKING

- [ ] One convention: `servicenow_<verb>_<noun>`. Renames: `docs_list → list_docs`,
      `docs_read → read_doc`, `docs_search → search_docs`, `docs_write → write_doc`,
      `table_logic → describe_table_logic`, `knowledge_highlights → get_knowledge_highlights`,
      `code_health → check_code_health`, `change_conflicts → check_change_conflicts`; idiomatic
      names stay (`aggregate`, `batch`, `where_used`).
- [ ] Parameter normalization: `sys_id` for every record id; `table` everywhere (`class_name`
      accepted as a deprecated alias on the CMDB tools); `fields` means the select list only,
      write payloads are `values`; `kind` used for one thing.
- [ ] Overlap review: `get_status`/`test_connection`/`check_capabilities` and
      `list_atf_suites`/`list_atf_tests` are folded or kept with a documented reason in the
      manifest.
- [ ] Legacy names available behind `SN_LEGACY_TOOL_NAMES=1` for one minor cycle (hidden from
      `tools/list` otherwise); a generated old→new table in CHANGELOG and README.
- [ ] _(gap pass 2026-09-09)_ Prompts reference tools by spec name (compile-time) — L4-02; profile resources move to `servicenow://profiles/{profile}/schema/{table}` with the old template aliased for one minor; reserved profile names `docs|schema|status|capabilities|reference|profiles|policy` refused at load (B13) — L4-03; `servicenow://policy` resource from H-11 — L3-04.
- **Acceptance:** manifest snapshot, README table and docs site regenerated; the alias map is
  tested both ways.

### M-8 — Small protocol fixes (S)

- [x] `logging/setLevel` honoured in HTTP mode (`src/index.ts:117-124`, `src/mcp/define.ts:106`).
- [x] `write_doc` gets `destructiveHint: true`; annotations audited across all 67 tools.
- [x] The `.strict()` object cast in `registerTool` is replaced by a typed schema builder
      (`src/mcp/registry.ts:226-240`).
- [x] _(gap pass 2026-09-09)_ Typed builders in `define.ts` — `sysId()`, `tableName()`, `fieldName()`, `encodedQuery(4000)`, `fieldList(200)`, `shortText(255)`, `longText`, `email()`, `recipients(50)`, `tableList(200)`, `sysIdList(500)` — applied to all 83 unbounded strings and 12 arrays — L2-06, L2-07; `openWorldHint:false` explicit on the three docs tools and all four hints mandatory in the helper — L4-07; logging-notification token bucket `SN_LOG_NOTIFY_RATE` — L5-05.
- [x] _(instance-docs pass 2026-09-23)_ The annotation audit covers the three S-15 `document_*` tools (the snapshot's annotation set, `src/tools/instance.ts:23-28`) and the `overwrite:true` path of `docs_write` (described as the one destructive docs operation); the `document_table` prompt registers only with `docs` + `scripts` on — ID-16. _(instance-docs pass 2 2026-09-25)_ Annotation half delivered (all four hints mandatory, `docs_write` `destructiveHint:true`, `src/tools/docs.ts:118-123`); the prompt-gating half is **not** in code — `registerPrompts` is unconditional (`src/index.ts:112`) — and moves to S-15 (ID-25).
- **Done 2026-09-24 (local, uncommitted).** `src/mcp/log-bridge.ts`: `logging/setLevel` over HTTP, per-session token bucket (`SN_LOG_NOTIFY_RATE`); all four annotation hints required on every tool; `buildInputSchema` replaces the `.strict()` cast; bounded zod builders + schema-walker test. Record field values and large payloads stay unbounded (instance- or runtime-capped); `where_used.name` is on the allow-list.

### M-9 — Long-running operations as MCP tasks (M) — experimental

- [x] Behind `SN_EXPERIMENTAL_TASKS=1`: the SDK's experimental task handlers, in-memory store per
      E-3 container (TTL 1 h), results stored redacted (GAP L5-02).
- [x] `run_as_task:true` on `snapshot_instance`, `compare_instances`, `atf_run`, `code_health` and
      the S-11 file export; results carry `_meta["io.modelcontextprotocol/related-task"]`.
- [ ] _(instance-docs pass 2026-09-23)_ `run_as_task:true` also on `document_instance` and `document_app` (S-15) — ID-15.
- [x] Documented as experimental; removable without a major if the SDK drops the API.
- **Acceptance:** task round-trip e2e on the fetch double; cancel; TTL expiry. Prerequisite: M-3.
- **Done 2026-09-26 (local, uncommitted).** `src/mcp/tasks.ts` on SDK 1.30's experimental task API (`TaskStore`, `isTerminal`, `RELATED_TASK_META_KEY`): `SnTaskStore` is an E-3 runtime part (lazy expiry at 1 h from creation, running work aborted on expiry / `tasks/cancel` / dispose, results re-redacted, session-bound); `withTaskSupport` passes it as `taskStore` and declares `tasks: {list, cancel}`, so the SDK serves `tasks/get` / `result` / `list` / `cancel`. `run_as_task` is an argument, not native `params.task` augmentation (the SDK's `registerToolTask` would make every plain call block in a poll loop); `query_table` accepts it with `format:"file"` only. Flag off: schemas and capabilities unchanged. `test/tasks.test.js` (store, round trip, cancel, TTL on an injected clock). The S-15 bullet waits for `document_instance` (add the name to `TASK_TOOLS`).

### S-1 — Inherited + global business rules in trace (S)

- [x] `listBusinessRules` queries `collectionIN<table chain from getTableChain>^ORglobal=true`,
      marks each rule with `inherited_from`/`global`, keeps `ORDERBYorder` (`src/api/flows.ts:75-78`,
      `src/api/meta.ts:60`).
- [x] `generate_table_flow` renders inherited rules in their own lane; flow triggers and
      notifications are filtered by the operation actually traced (`src/api/flows.ts:107-188`).
- **Acceptance:** a test with `incident` sees `task` and global rules in the right order.
- **Done 2026-09-23 (local, uncommitted).** `traceTableEvent` resolves the chain through
  `getTableChain` (now cached with the other schema reads), queries
  `collectionIN<chain>^ORglobal=true^active=true^when=…^action_<op>=true^ORDERBYorder` and tags every
  entry with `table` / `inherited_from` / `global`; a failing chain lookup falls back to the table
  alone with a warning. Flow triggers are kept only when `trigger_type` names the traced operation
  (unknown types are kept), legacy workflows only for insert/update, notifications by
  `action_insert` / `action_update` or when event-driven; `query` lists no record-triggered work.
  `generateTableFlow` renders own rules first, then `inherited from <parent>` lanes in chain order
  and a `global` lane per phase. Five new tests (`test/flows.test.js`, `test/diagrams.test.js`);
  suite 481 → 486, coverage 96.13 / 86.48 / 98.47.

### S-2 — Journal-based revert (M) — flagship

- [x] `servicenow_revert_write(entry_id)` (plan/apply, `revert` package or `table`): update →
      write `before`; create → delete; delete → re-create from `before`; `sys_mod_count` compared
      first and a drift refuses unless `force:true`; the revert is itself journaled with
      `reverts: <entry_id>`.
- [x] `servicenow_list_writes` reads the journal (filters: profile, table, since, result).
- **Done 2026-09-23 (local, uncommitted):** new opt-in `revert` package (`src/api/revert.ts`, `src/tools/revert.ts`; not in the core profile, `SN_PACKAGES_READONLY=revert` keeps only `list_writes`). `servicenow_list_writes` filters by profile, table, since, result, action and limit, newest first, and says per line whether it is revertible and why not. `servicenow_revert_write(entry_id)` previews then applies the inverse — update → `before` written back for exactly the written fields, create → delete, delete → re-create from `before` (sys_id preservation reported) — under the H-4 package rules of the original writer and `table`. Drift: `after_mod_count` (or `before` + 1, else a field comparison, else `unverified`) — anything but clean refuses with `STALE_RECORD` (409) unless `force:true`. `NOT_REVERTIBLE` reasons: not applied, execute/config, batch sub-request, already reverted, no sys_id/`before`, a needed value redacted (whole entry refused), broken hash chain, record state contradicting the inverse, and non-invertible origins (`create_ci`, attachments, email, import sets, catalog orders). Journal lines now record `tool` and, for Table API creates/updates, `after_mod_count`; the revert is journaled with `reverts:<id>` (reverting it redoes the write). Shipped ahead of H-3: the `plan_token` joins the existing preview/apply path when H-3 lands, sharing `STALE_RECORD`. `test/revert.test.js` (15 tests). 69 tools in 19 packages.
- **Acceptance:** create→revert and update→revert round-trips against the mock instance; a journal
  line without `before` reports `NOT_REVERTIBLE` with the reason.

### S-3 — Security-scan extension (M)

- [x] ACL scan paginates beyond the 500 cap and reports `truncated` explicitly
      (`src/api/codecheck.ts:316-340`); roles are joined with `*` wildcard and inheritance resolved.
- [x] New checks: public Scripted REST resources and UI pages, tables with no ACL, admin-overlap
      roles, `elevated privilege` ACLs — each degrades to `available:false` when unreadable.
- **Acceptance:** `check_code_health` on the fixture instance lists the new finding kinds.
- **Done 2026-09-24 (local, uncommitted).** `src/api/security.ts`: paged ACL scan with `truncated`, role wildcard + inheritance; public REST / UI page, table-no-ACL, admin-overlap, elevated-privilege checks, each `available:false` when unreadable.

### S-4 — Script-intelligence widening (M)

- [x] `SCRIPT_TYPES` becomes a data-driven registry (table, fields, scope field, name field,
      active field, kind) covering `sp_widget` (script/client_script/link/css), `sys_ui_page`,
      `sys_ui_script`, `sys_ui_macro`, `sys_processor`, `sys_script_email`, `sys_script_fix`,
      `sys_script_validator`, `sys_ws_definition`/`sys_ws_operation`, `sys_rest_message_fn`,
      `sys_data_source`, `sys_transform_map`/`sys_transform_entry`/`sys_transform_script`,
      `sysevent_script_action`, `catalog_script_client`, `sys_dictionary` calculations/defaults
      (`src/api/scripts.ts:31-95`).
- [x] `search_code` and `where_used` return **all** matches per artefact with line context and take
      a `scope` filter (`src/api/scripts.ts:237-361`, `src/api/whereused.ts`).
- **Acceptance:** `lint_script`, `search_code`, `where_used` and snapshot all consume the registry.
- **SDK parity:** the registry bullet is implemented by P-1 ([SDK-PARITY.md](SDK-PARITY.md) §5(a)); P-18 builds on the search bullet.
- **Done 2026-09-24 (local, uncommitted).** Registry `clientFields` / `markupFields` / `baseQuery` + 15 unverified script types; `scope` filter, per-artefact `hits` / `hitCount` and `unreadable` list on search and where-used. `scope` is not yet on `list_scripts` / `table_logic` / `lint_table`.

### S-5 — Trace v2 (L)

- [x] `trace_table_event` gains a client-side lane (client scripts, UI policies), data policies,
      `sysevent_script_action`, SLA definitions, transform maps, scheduled jobs; each lane opt-in
      via `lanes`.
- [ ] `get_flow` returns actions, steps, subflow calls, inputs/outputs and the trigger condition
      (`src/api/flows.ts:397-554`).
- **Acceptance:** the Mermaid output from `generate_table_flow` shows the new lanes (it is rendered
  from the trace since S-14 — ID-06); snapshot compare of a traced flow is stable.
- **SDK parity:** the `get_flow` bullet is delivered by P-10 ([SDK-PARITY.md](SDK-PARITY.md) §5(b)); the lane work stays here.
- **Done 2026-09-25 (local, uncommitted).** Opt-in `lanes` on `trace_table_event` / `generate_table_flow`: transform maps, scheduled jobs, client scripts + UI policies, data policies, SLAs, event script actions, each a phase and a Mermaid subgraph; stable order; default output byte-identical. `get_flow` depth moves to P-10. Lane table columns are unverified until O-5.

### S-6 — Update-set awareness (L)

- [x] `updatesets` package: `list_update_sets`, `get_update_set` (with `sys_update_xml` contents
      summarised per artefact), `compare_update_set` (against a snapshot or another instance).
- [x] Write session binding: `SN_UPDATE_SET` / a per-call `update_set` sets the current update set
      for the session user before an applied customization write; the journal records it (H-5);
      records without update-set capture (data rows) say so in the plan.
- [x] Preflight (`check_capabilities`) reports whether the user can read/set update sets.
- **Acceptance:** an applied business-rule change lands in the named update set on the fixture
  instance; the plan preview names the target update set.
- **Done 2026-09-25 (local, uncommitted).** Opt-in `updatesets` package (`src/api/updatesets.ts`, `src/tools/updatesets.ts`): `servicenow_list_update_sets`, `servicenow_get_update_set` (`sys_update_xml` summarised per artefact), `servicenow_compare_update_set` (against a snapshot or another profile). `update_set` input on create/update/upsert/delete, default `SN_PROFILE_<P>_UPDATE_SET` → `SN_UPDATE_SET`; the plan names the target set, data-row tables say they are not captured; apply switches the user preference and restores it (per-process lock); the journal records the set. `check_capabilities` reports `canRead` / `canSet`. Errors `UPDATE_SET_NOT_FOUND`, `UPDATE_SET_NOT_IN_PROGRESS`. Tests: `test/updatesets.test.js`, `test/capability-matrix.test.js`. Live-instance acceptance waits for the fixture instance.

### S-7 — Snapshot/compare v2 (L)

- [x] `describe_table` fields gain `default_value`, `choices`, `read_only`, `unique`, `display`,
      `overrides` (`src/api/meta.ts:95-146`).
- [x] Snapshot adds `sys_properties`, `sys_choice`, ACLs, notifications, flows, catalog items,
      roles; compare matches by `sys_id` with name fallback and emits a unified textual diff for
      scripts; domain-separation caveat (C-11) in the report (`src/api/snapshot.ts`,
      `src/api/compare.ts`).
- [x] _(gap pass 2026-09-09)_ Snapshot fan-out `min(SN_MAX_CONCURRENT, 4)`, per-table files + `index.json`, `resume:true`, partial index on cancel — L6-05.
- [x] _(instance-docs pass 2026-09-23)_ The per-table files and `index.json` of L6-05 are the S-14 store: each file carries the frontmatter, `index.json` is the S-14 manifest with `partial:true`, `resume:true` skips files whose `sn_source_hash` is unchanged; the snapshot collectors are split per section (E-7's named collectors, ID-24) so `document_instance` (S-15) reuses them; `sys_choice` feeds the S-15 `choices` kind. Sequence after S-14 — ID-10, ID-15.
- [ ] _(instance-docs pass 2 2026-09-25)_ The compare report moves from the store root `_compare/<a>-vs-<b>.md` (`src/api/compare.ts:403`, filed under profile `a` yet invisible to a profile-scoped `docs_list`) to `<a>/compare/<a>-vs-<b>.md` + `.json` with `sn_compare_with: b`; the legacy root file is taken over on the next run — ID-20. `partial:true` lands in the manifest's `runs` map (`generated_at`, per-generator `{ started_at, finished_at, partial, files }`, `schema_version` stays 1) — ID-19.
- **Acceptance:** `drift` exit codes unchanged; fixture diff readable in the Markdown report.
- **SDK parity:** P-20 widens the snapshot type list to the whole artefact registry ([SDK-PARITY.md](SDK-PARITY.md) §7).
- **Done 2026-09-25 (local, uncommitted).** `describe_table` column metadata + opt-in `details` (choices, overrides); seven record snapshot sections, fan-out, `sn_partial` + `resume`; compare matches sys_id then name (`renamed`), unified `diff`, opt-in record `sections`. Drift CLI exit codes unchanged. Record sections stay out of the `drift` CLI; ACL scripts are stored as a hash.

### S-8 — Table API completeness + cursor paging (M)

- [x] `query_table` exposes `sysparm_view`, `sysparm_query_category`, `sysparm_no_count`,
      `sysparm_input_display_value`, `sysparm_query_no_domain`, `sysparm_suppress_pagination_header`
      where they apply (`src/api/table.ts:49-70`).
- [x] `fetchAll` uses `sys_id>last` cursor paging when the caller supplied no `ORDERBY` (closes
      C-2); encoded-query limits (C-6) documented in the tool description and the reference resource.
- [x] _(gap pass 2026-09-09)_ `servicenow_upsert_record({table, key, fields})` — the action is decided at plan time and re-checked at apply — L2-14.
- **Done 2026-09-24 (local, uncommitted).** `view` / `queryCategory` / `noCount` / `queryNoDomain` / `suppressPaginationHeader`, `inputDisplayValue`; keyset `sys_id>last` paging without ORDERBY (C-2); encoded-query reference resource (C-6); `servicenow_upsert_record` (L2-14).

### S-9 — Where-used structural references (M)

- [x] Reference-field dictionary entries, `sys_ui_list`/`sys_ui_section` field lists, catalog
      variable mappings, flow action inputs and report conditions are searched structurally, not
      only as text (`src/api/whereused.ts:66-99`).
- **SDK parity:** P-17 (`artifact_dependencies`) reuses this reference extractor ([SDK-PARITY.md](SDK-PARITY.md) §7).
- **Done 2026-09-24 (local, uncommitted).** `src/api/references.ts`: 9 policy-checked structural sources (dictionary, list/form layouts, catalog variables, flow inputs, reports); additive `structural` section on `where_used` (opt-out `structural:false`). Catalog, flow-input and report columns are `verified:false` until O-5.

### S-10 — Ops, data and history tables (L)

- [x] `insert_import_set_row` reports `sys_import_set_run` status and the transform map; CMDB gains
      `cmdb_rel_ci` reads and IRE `identifyreconcile`; a `history` reader over
      `sys_audit`/`sys_journal_field` (closes C-5); `sys_properties` get/set (plan/apply);
      users/roles/groups lookups; an `ops` package (`syslog`, `sys_trigger`, `sys_email` queue,
      semaphores) with a "why is it slow" prompt; `data_health` (duplicates, orphans, stale
      references) as `check_code_health`'s twin.
- [x] _(gap pass 2026-09-09)_ `atf_run({wait_seconds})` polls under the M-3 signal with progress; returns `running` + tracker on timeout — L3-07.
- **Acceptance:** each is opt-in by package; each read degrades cleanly when unreadable.
- **SDK parity:** `sys_properties` writes share the P-23 plan/apply path; ATF definitions are read by P-8 ([SDK-PARITY.md](SDK-PARITY.md) §7).
- **Done 2026-09-26 (local, uncommitted).** S-10a: opt-in `history` (`servicenow_get_record_history`, `sys_audit` + journal), `properties` (`servicenow_get_property`, `servicenow_set_property` — plan-and-apply, secret values masked, `PROPERTY_NOT_FOUND`) and `directory` (`servicenow_lookup_user`, roles and groups) packages; CMDB gains `servicenow_list_ci_relations` and `servicenow_identify_reconcile` (IRE, dry-run by default); `insert_import_set_row` reports the `sys_import_set_run` status (`describeImportRun`); `atf_run({wait_seconds})` polls under the M-3 signal. S-10b: opt-in `ops` package (`src/api/ops.ts`) — `servicenow_ops_health` (syslog errors, stuck `sys_trigger` jobs, email queue, semaphores) and `servicenow_data_health` (orphan references, duplicate keys via the Stats API), prompt `servicenow_why_is_it_slow` (gated on `ops`). Tests: `test/s10a.test.js`, `test/ops.test.js`. Table and field names wait for the fixture instance (O-5).

### S-11 — File-based delivery for large results (S)

- [x] `format:"file"` on `query_table`, snapshot and compare writes under `<SN_DOCS_DIR>/exports/`
      and returns the path + a redacted preview; `SN_MAX_RESULT_CHARS` no longer truncates silently.
- [x] _(gap pass 2026-09-09)_ `fetchAll` `onPage` streaming so file exports hold one page in memory; CSV encoder shared with the L2-01 guard — L2-14.
- [x] _(instance-docs pass 2026-09-23)_ The same path covers both generators and the S-15 `document_*` tools: a result over `SN_MAX_RESULT_CHARS` is written to the store (`<profile>/diagrams/<name>.mmd` for diagrams, the document's own path otherwise) and the tool returns `{ path, bytes, preview }` (first 2,000 chars, `truncated:true`); `write:true` results always return `{ path, preview }`, never the full text; `exports/` stays for data — ID-14.
- **Done 2026-09-25 (local, uncommitted).** `format:"file"` on `query_table` (`fileFormat` csv|jsonl, streamed through `fetchAll` `onPage`, one page in memory), snapshot/compare (`tools/instance.ts`) and the docs/diagram generators (`tools/docs.ts`); writes go to a `.part` file then rename, journalled as `local_write`; results are `{ path, bytes, preview }` (2,000 chars, `src/mcp/file-result.ts`). `SN_OVERSIZE_TO_FILE` (default off) diverts an over-limit result to a file instead of truncating; the truncation note names `format:"file"`. CSV encoder shared (`header` option in `src/mcp/csv.ts`). Tests: `test/file-delivery.test.js`. The S-15 `document_*` tools reuse the same path when they land.

### S-12 — AST-based lint (L)

- [ ] Parse scripts with `acorn` (ES5 and ES2021 modes for scoped apps) and rewrite the regex rules
      that have AST equivalents; `check_code_health` keeps a baseline file and reports deltas.
- **Decide first:** it adds a runtime dependency; the alternative is to keep regex and add rules.

### S-13 — Capability preflight v2 (M)

- [x] `describe_capabilities({groups, refresh})` — `writes`, `update_sets`, `attachments`,
      `aggregate`, `import_sets`, `email`, `atf`, `version`, `roles`; one policy-routed probe per
      group; `unknown` when denied (GAP L3-06).
- [x] Positive cache `SN_CAPABILITY_TTL_MS` (10 min), negative `SN_PLUGIN_NEGATIVE_TTL_MS` (60 s);
      transport errors are never cached (L6-06).
- [x] `doctor` prints the same matrix; the M-5 overview prompt calls it first.
- **Acceptance:** per-group probe matrix under allow/deny on the fetch double; a 503-then-200 probe
  recovers after 60 s of fake time.
- **Done 2026-09-24 (local, uncommitted).** `src/api/capability-matrix.ts`: per-group read-only probes (`groups`, `refresh`), TTL cache (`SN_CAPABILITY_TTL_MS`), plugin negative TTL `SN_PLUGIN_NEGATIVE_TTL_MS`; matrix in doctor and the capabilities resource. The M-5 overview prompt is not wired yet (M-5).

### S-14 — Docs store v2 + generator depth (M)

- [x] Frontmatter contract on every generated file (`sn_generated`, `sn_generator`,
      `sn_generator_version`, `sn_profile`, `sn_instance`, `sn_generated_at`, `sn_source_hash`),
      written by `docsWriteRaw` when the caller passes `meta`; `<!-- sn:manual:start/end -->` blocks
      survive regeneration; `docs_write` refuses a generated file and a generator refuses a
      hand-written one without `overwrite:true` (`DOC_GENERATED`); `docs_list` returns `generated`,
      `generator`, `generated_at`, `profile`, `stale` (`SN_DOCS_STALE_DAYS`, default 30) and per-file
      `bytes` (deferred here by H-6) (`src/api/docs.ts:277-320`) — ID-02.
- [x] One manifest `index.json` per store (kind, title, profile, generator, generated_at,
      source_hash, bytes, headings), rebuilt by every writer through the `indexTail` chain;
      `index.md` rendered from it grouped by profile → kind → hand-written; the snapshot's own
      `<profile>/index.md` stops duplicating the list; kinds are open-ended so P-26's
      `fluent/<scope>/` output and P-21's per-scope report list through the same manifest
      (`src/api/docs.ts:140-155,249-275`, `src/api/snapshot.ts:337-356`) — ID-03.
- [x] Optional `profile` on `docs_list/read/search/write` (`"current"` = the active profile, a
      name, or omitted = root, unchanged); `docs_search` gains `profile` / `kind` / `generated`
      filters, returns the nearest heading per hit, capped by `SN_DOCS_SEARCH_MAX` (200); the
      `document_table` prompt reads and writes `<profile>/tables/<table>.md` (legacy root path read
      first) (`src/tools/docs.ts:14-80`, `src/mcp/prompts.ts:102,107`) — ID-01.
- [x] `generate_er_diagram` options with today's output as the default: `columns` (`"all"|"own"|"keys"`), `max_columns` (40, the rest folded into one `+N` line), `depth: 0|1|2`
      (referenced tables added as `keys`, capped by `SN_DIAGRAM_MAX_NODES`), `PK` / `FK` /
      required / inherited markers from `mandatory` + `sourceTable`, an `extends` edge between
      chain members (`src/api/diagrams.ts:30-58`, `src/api/meta.ts:87-98`) — ID-05.
- [x] `generate_table_flow` rendered from `traceTableFlow` instead of its own `listScripts` query:
      one subgraph per lane in execution order (client → display → before → after → async →
      flows/workflows → notifications), the S-1 inherited/global sub-lanes kept, a new optional
      `operation`; every lane S-5 adds to the trace appears in the diagram for free
      (`src/api/diagrams.ts:82-195`, `src/api/flows.ts:449-450`) — ID-06.
- [x] `src/api/mermaid.ts` (new): `ident`, `label` (also escapes `#`, `;`, backticks, `%%`), `node`,
      `edge`, `subgraph`, `erEntity`, `erRelation`, a `MermaidDoc` builder with
      `SN_DIAGRAM_MAX_NODES` (200, one `+N more` node past it) and a test-side `lint()` (balanced
      `subgraph`/`end`, declared endpoints, no raw `"` inside `["…"]`, no `^` in identifiers);
      `diagrams.ts`, `flows.ts:354` and `whereused.ts:78` become callers; C-4
      `{value, display_value}` fixtures pinned; no parser dependency — ID-07 (absorbs the Mermaid
      dedup DEEP-REVIEW H4 listed under E-7). P-10 `explain_flow({format:"mermaid"})` and P-21's
      per-artefact diagrams ([SDK-PARITY.md](SDK-PARITY.md)) are further callers, so this module
      lands before the epic's P2 phase.
- [x] Tests: golden fixtures `test/fixtures/docs/*.{md,mmd}` compared after normalising
      `sn_generated_at` (`UPDATE_GOLDEN=1` regenerates); `lint()` on every Mermaid output; a
      documentation-contract test (frontmatter present, `docs_list` parses it, the manifest lists
      it); the invariant "generated documents contain metadata only, never record data" stated in
      the `src/api/docs.ts` header and enforced by an allow-list walker over the generators' fetch
      calls (moved here from H-5) — ID-04, ID-17.
- **Acceptance:** the default calls of both generators are byte-identical to today's output for
  the existing fixtures; a snapshot re-run reports `unchanged` per file with a stable
  `sn_source_hash`; a manual block survives regeneration byte-for-byte; `docs_write` on a generated
  file without `overwrite` fails with `DOC_GENERATED`. Non-breaking — no register entry.
  Prerequisite: S-1 (done). Sequence before S-7 and before P-10 (both P-10 and P-21 render
  through `src/api/mermaid.ts`; P-20 widens S-7's snapshot, which needs the frontmatter first).
- **Done 2026-09-23 (local, uncommitted):** generated files carry `sn_*` frontmatter (JSON companions at the top level) with a stable `sn_source_hash`; re-runs report `unchanged` in a `changes` map and skip the write, journal line and index rebuild; `<!-- sn:manual -->` blocks survive by id, else by order, orphans appended; `DOC_GENERATED` (409) guards both directions and 2.x outputs are recognised and upgraded; `index.json` (schema_version 1) drives a profile → kind grouped `index.md`, the snapshot's `<profile>/index.md` is a README with a notes block; docs tools gain `profile` / `kind` / `generated` / `overwrite`, `entries` with `stale`, a `heading` per hit and the `SN_DOCS_SEARCH_MAX` cap. Generators share `src/api/mermaid.ts` (`SN_DIAGRAM_MAX_NODES`, `+N more`); ER gains `columns` / `max_columns` / `depth`, table flow gains `operation` (the client-script lane arrives with S-5). Defaults byte-identical (6 unchanged goldens + 4 new), a metadata-only allow-list guard over every generator fetch (extended with the script-bearing config tables where-used scans), C-4 pair fixtures in `test/meta.test.js`. New tests: `test/mermaid.test.js`, `test/docs-goldens.test.js`, `test/docs-store.test.js` (+ `test/mermaid-lint.js`).

### S-15 — Document generators: table, app, instance (L)

- [x] `src/api/document.ts` (new): `documentTable`, `documentApp`, `documentInstance` and a
      `DOC_KINDS` registry (`{ title, collect, requires }` per kind); every document written through
      `docsWriteRaw` with the S-14 frontmatter and a `.json` companion (the structured input, hashed
      for `sn_source_hash`); `unreadable[]` from `tableLogic` and unreadable kind tables become
      Caveats lines, never failures (`src/api/scripts.ts:402-417`). _(instance-docs pass 2 2026-09-25)_ Each kind
      carries its own `version` (`DocMeta.generatorVersion`, default the global
      `DOCS_GENERATOR_VERSION`, `src/api/docs.ts:169`) so one layout change rewrites one writer's
      files (ID-18); the manifest gains `generated_at` + `runs` with `partial` (ID-19); `.json`
      companions are walked, listed (`companion` on the `.md` entry) and readable through
      `docs_read` (ID-21).
- [x] `servicenow_document_table({ table, profile?, write?, diagrams?, columns? })` in the `docs`
      package: header + inheritance chain (`getTableChain`), own columns then one table per parent
      (`sourceTable`), the tables referencing this one (one `sys_dictionary` `reference=<table>`
      query), the ER (`columns:"own", depth:1`) and table-flow diagrams, logic tables (business
      rules, client scripts, UI policies, UI actions, ACLs), Caveats (truncation, unreadable,
      domain separation C-11, "metadata only"), a manual Purpose block; writes
      `<profile>/tables/<table>.md` + `.json`, `write:false` returns the Markdown; the
      `document_table` prompt becomes a thin wrapper that calls the tool by spec name and declares
      `requires:["docs","scripts"]` (`src/mcp/prompts.ts:82-121`, L4-02) — ID-08. Can land on 2.x
      right after S-14. _(instance-docs pass 2 2026-09-25)_ `registerPrompts` takes the enabled package set and
      skips a prompt whose `requires` are off (today it is unconditional, `src/index.ts:112`);
      step 1 drops the legacy root path; the reference-query step points at
      `servicenow://reference/encoded-query` (S-8) — ID-25.
- [x] `servicenow_document_app({ scope, profile?, write? })` → `<profile>/apps/<scope>.md` +
      `.json`: the application record, tables in scope with an ER at `depth:0`, artefacts per
      type through the P-5 collector `listArtifacts({ artifactType, scope })`
      (`src/api/artifacts.ts:117`) over every `ARTIFACT_TYPES` entry in `ARTIFACT_GROUPS` order
      (34 types, 12 groups — REST APIs, outbound REST, flows, portals, UI Builder, catalog items
      included), one table per non-empty type with `active` / `sdkManaged`, unverified types
      under an O-5 note when `degraded`, unreadable types as Caveats, a registry-completeness
      test; roles, cross-scope privileges; `global` refused with a hint to use
      `document_instance` (`src/api/snapshot.ts:243-270`) — ID-09. _(instance-docs pass 2 2026-09-25)_ ID-22
      replaces the "nine `SCRIPT_TYPES` kinds until S-4 lands" caveat — S-4 and P-5 landed. P-21 ([SDK-PARITY.md](SDK-PARITY.md))
      is the registry-wide successor: it reuses `documentApp` / `DOC_KINDS` and adds the dependency
      graph and per-flow / experience / portal diagrams — one writer, not two.
- [x] `servicenow_document_instance({ profile?, tables?, apps?, kinds?, depth?, write? })` →
      `<profile>/README.md` (version/build from `sys_properties` when readable, counts, apps with
      links, plugins, automation, update sets via S-6, the domain-separation caveat, last documented
      by/when) over the E-7 collectors (`collectTables` / `collectPlugins` / `collectApps` /
      `collectAutomation` / `collectSchema` from `src/api/collectors.ts`, ID-24), then
      `documentTable` / `documentApp`
      per named target and one file per requested kind; each document is written as it goes,
      `partial:true` in `index.json` on cancel; `snapshot_instance` unchanged (compare depends on
      its JSON) — ID-10. _(instance-docs pass 2 2026-09-25)_ Also writes `<profile>/artifact-types.md` from
      `artifactTypeCatalog()` with a "collected in this run" column (ID-29); `partial:true` is
      the manifest `runs` field of ID-19. _(batch 10)_ Shipped without `depth` (S-16 adds it);
      `tables` / `apps` capped at 50 each; a named target that fails lands in `failed[]` and the
      run goes on; the README is written first, so its links may point at documents a cancelled
      run never reached (a Caveats line says so).
- [x] 3.0 kinds (`document_kind` open — owner decision): `security` (S-3's `securityScan()` rendered in full — one section per check in
      `SecurityCheckName` order with `bySeverity`, the ACL matrix table × operation from the
      per-finding `table` / `operation` / `roles`, `truncatedReason` / `unavailableReason` as
      Caveats; `code_health` keeps its top-20 summary and links here — ID-23, unblocked now),
      `catalog` (catalogs → categories → items → variables), `integrations` (S-4:
      `sys_ws_definition`, `sys_rest_message`, `sys_transform_map`, `sys_data_source`); 3.x kinds:
      `notifications`, `choices` (S-7's `sys_choice`), `data_model` (ER per scope). Kinds are
      reachable through `document_instance({kinds})` and — owner decision, ID-23 — through a
      generic `servicenow_document_kind({ kind, profile?, write? })` so `security` can ship with
      `document_table` before the E-7 split (tool count 86 today after batch 9; M-6's budget is
      restated by the owner together with the pack ceiling); kinds the SDK-parity epic adds
      (P-21) register in the same `DOC_KINDS` — ID-11.
- [x] The three tools carry the snapshot's annotation set (`src/tools/instance.ts:29-34`) and
      descriptions under 400 chars; manifest + README regenerated; M-3 progress (one tick per
      document) and M-9 `run_as_task` cover `document_instance` / `document_app` — ID-15, ID-16.
      _(instance-docs pass 2 2026-09-25)_ The two remaining Mermaid builders surface `doc.truncated` and
      `whereused.ts` drops its local `MERMAID_EDGES = 40` pre-cap (`src/api/whereused.ts:138,158`;
      `flows.ts:357`) so a document's diagrams carry one truncation signal — ID-26.
      _(batch 10)_ `run_as_task` is M-9's (a sibling batch); `document_app` is one document, so it
      does not tick.
- [x] Tests: golden `incident` table document (own + inherited columns, one rule per phase, one
      ACL, `unreadable` caveat, manual block round-trip, `write:false`); golden app document for a
      fixture scope (two tables, three artefact kinds, the `global` refusal); golden instance
      README + partial run + progress count; one golden per kind and a registry-completeness test;
      the manifest snapshot gains three entries — ID-17. _(instance-docs pass 2 2026-09-25)_ Every S-15 suite
      uses the shared metadata-only guard (`withMetadataFetch` in `test/helpers.js`, ID-27) and
      the writer goldens live under `test/fixtures/docs/writers/` beside the snapshot / compare /
      code-health goldens (ID-28).
- **Acceptance:** two runs against the same fixture produce byte-identical files except
  `sn_generated_at`; a tool-only client gets the same table document the prompt used to describe;
  `document_instance({kinds:["security"]})` on the ACL fixture yields one row per table ×
  operation; cancelling after three documents leaves three valid files and a manifest with
  `partial:true`. Prerequisites: S-14 (done); `document_app` needs nothing else (P-1 / S-4 / P-5
  done); `document_instance` needs E-7's collector split (ID-24); S-7 only for the `choices` kind
  and the richer schema columns; the pack ceiling (794 / 800 KB) is an owner decision before the
  first writer lands _(instance-docs pass 2 2026-09-25)_.
- **Part 1 done 2026-09-26 (local, uncommitted).** `src/api/document.ts` (`generateDocument`, `documentTable`, `documentApp`, `documentSecurity`, `aclMatrix`; `DOC_KINDS` table, app, security); `servicenow_document_table` and `servicenow_document_app` in `docs` (annotations, `format:"file"`, runs recorded in the docs index, JSON companions listed with `companion`, index `generated_at`); prompt gating (`gated()` in `src/mcp/prompts.ts`); `flows.ts` / `whereused.ts` report truncation. Goldens: `test/fixtures/docs/writers/{table-incident,table-incident.written,app-x_acme,security,security-unavailable}.md`, `test/document.test.js`. **Open:** `documentInstance` / `servicenow_document_instance`, the `catalog` and `integrations` kinds, `document_kind`, the instance README golden.
- **Batch 10 done 2026-09-26 (local, uncommitted).** `documentInstance` + `servicenow_document_instance` (`docs`, 87 tools): `<profile>/README.md` from `collectTables` / `collectPlugins` / `collectApps` / `collectAutomation` plus `sys_properties` (`glide.buildname`, `builddate`, `buildtag`, `war`) and `sys_update_set` (in progress), then table / app documents per named target, one document per `kinds` entry, and `<profile>/artifact-types.md` (ID-29, "Collected in this run" from the source tables the run's documents read); one tick per document (`message` = path), each written as it goes, `runs.servicenow_document_instance.partial` on cancel. `DOC_KINDS` gains `catalog`, `integrations`, `instance`, `artifact_types` (`singleton`, `sources`). Goldens `test/fixtures/docs/writers/{instance-README,catalog,integrations}.md`; tests for progress, cancel after N, byte-identical re-run, failed target, registry completeness. **Open:** `servicenow_document_kind` (owner decision, ID-23); `depth` (S-16).

### S-16 — Native discovery + skill delegation (S)

- [x] `document_instance` gains `depth: "overview"|"apps"|"artefacts"` (= the harness `discovery`
      skill's Tier 1/2/3) and writes the skill's file set under `<profile>/discovery/`
      (`overview.md`, `apps.md`, `tables-<scope>.md`, `artifacts-<scope>.md`) as thin renderings
      of the S-15 data — ID-12. _(instance-docs pass 2 2026-09-25)_ `artifacts-<scope>.md` is the per-scope
      rendering of `artifactTypeCatalog()` (already served as `servicenow://artifact-types`,
      `src/mcp/resources.ts:313-324`) joined with `document_app`'s per-type tables, with a
      "collected / not collected and why" column (unverified, unreadable, package off, cap) —
      ID-29.
- [x] D-8's plugin ships an `sn-discover` skill that calls the tool and needs no credentials of its
      own; the harness skill delegates to the server when a configured profile exists and falls
      back to `curl` otherwise (harness change, outside this repo).
- [x] Tests: file set per depth; the plugin skill's tool names exist (the L4-02 manifest walker).
- **Acceptance:** `document_instance({depth:"apps"})` produces the four-file set through the
  policy, redaction, preflight and journal rails; the skill's `docs/ai/discovery/` output and
  `<profile>/discovery/` carry the same sections. Prerequisites: S-15, D-8.
- **Done 2026-09-26 (local, uncommitted).** `depth` is cumulative: `overview` writes
  `discovery/overview.md`; `apps` adds `apps.md` and `tables-<scope>.md`; `artefacts` adds
  `artifacts-<scope>.md` (a Types table with "Collected / not collected and why": collected,
  cap, see tables file, unverified (O-5), no such table, unreadable, package off, no records;
  then per-group artefact tables). Scopes are the named `apps`, else every non-global `sys_app`
  scope (capped at `INSTANCE_TARGETS_MAX`, the rest listed as skipped). `README.md` and
  `artifact-types.md` are written as before; omitting `depth` is unchanged. New `DOC_KINDS`:
  `discovery_overview`, `discovery_apps`, `discovery_tables`, `discovery_artifacts`. Goldens
  `test/fixtures/docs/writers/discovery-*.md`; walker `test/plugin-skills.test.js`. The harness
  `discovery` skill's delegation to the server is outside this repo (open). Owner questions:
  TODO.md → batch 12.

### D-1 — `init` wizard + real CLI (M)

**Done 2026-09-26 (local, uncommitted).**

- [x] `src/cli.ts` with `util.parseArgs`: `--help`, `--version`, `init` (interactive: instance,
      auth method, credentials via hidden prompt, writes the XDG env file, runs `doctor`),
      `doctor` (prints which env file was chosen), `login`, `drift`; the server bootstrap has no
      import-time side effects (`src/index.ts:26-74`).
- [x] _(gap pass 2026-09-09)_ `doctor --json`, `--ascii` (auto on non-TTY / win32 without Windows Terminal), env-file path as the first line, `--profile` — L4-05; `support-bundle` command (doctor json, redacted settings, `npm ls`, manifest, log tail) with a secret-scan test — L7-03.
- **Acceptance:** spawn-based tests for `--help`, `--version`, `doctor` exit codes (E-6).
- **Delivered.** `src/cli.ts` (`parseCli` with per-command option allow-lists, `runCli`, `main`; an unknown command or option exits 2), `src/server.ts` (`startServer`, the bootstrap moved out of `src/index.ts`, which only checks the Node version and calls `main`). `init` asks instance → auth method (`basic` / `oauth` / `apikey` / `token`, OAuth grant) → credentials (secrets via a muted prompt), confirms before overwriting a configured profile, writes through `persistEnv` (+ `reloadCredentialsFromEnv`), prints key names only and exits with the doctor code; piped answers work, EOF / no TTY refuses with exit 2 and writes nothing. `doctor` helpers in `src/api/doctor.ts` (`doctorChecks`, `envFileLine`, `shouldUseAscii`, `toAscii`); `src/api/support-bundle.ts` (masked + scrubbed settings, `npm ls --omit=dev`, manifest summary, 200-line log tail; one `0600` JSON file). Tests: `test/cli.test.js`, `test/support-bundle.test.js`, `test/cli-spawn.test.js` (help/version/unknown, doctor text/ASCII/JSON/profile, piped `init`, refusal, bundle secret scan).

### D-2 — Credentials model completeness (S)

- [x] `hasCredentials` and `doctor` evaluate per auth method (basic, API key, OAuth client/JWT,
      bearer, mTLS, `none`) (`src/core/config.ts:164-168`, `src/api/doctor.ts:64-77`).
- [x] `set_credentials` accepts `auth`, `api_key`, OAuth client id/secret (secret via elicitation
      only, never in a tool argument that gets logged).
- [x] _(gap pass 2026-09-09)_ Persist a rotated OAuth `refresh_token` (in-memory fallback + `warn` when the env file is read-only) — L6-01; bearer-mode 401 → re-read `SN_TOKEN_FILE` once, else `AUTH_EXPIRED`; `SN_TOKEN_EXPIRES_AT` warning — L6-02; `formatEnvValue` single-quote literal path for backslashes, CRLF preservation, win32 ACL warning, extended property alphabet — L2-11; `profiles` reports auth/grant/refresh/env/write mode per profile — L8-01.
- **Done 2026-09-24 (local, uncommitted).** `credentialStatus` per auth method (Basic, API key, bearer, OAuth grants); `set_credentials` takes `auth` / `oauth_client_id` / `oauth_grant`, secrets via elicitation; `SN_TOKEN_FILE` reload on 401, `AUTH_EXPIRED`, token-expiry and env-file ACL warnings. The per-profile `env` field (L8-01) waits for L3-03.

### D-3 — Generated config docs + counts (M)

- [ ] From the E-4 settings manifest: the README env table, `.env.example`, the `server.json`
      env block (+ a `remotes` entry for HTTP mode); the `env-docs-sync` test becomes the guard.
- [ ] `npm run docs:sync` writes tool/package/test/coverage counts into badges, package
      descriptions, `server.json`, plugin/marketplace JSON and the docs site; a guard test; prose
      counts removed from roadmap docs.
- [ ] `docs/llms.txt`, a changelog page and per-version links on the site; the stale
      `sincronia-mcp` path in `.env.example:145` gone.
- [ ] _(gap pass 2026-09-09)_ `.env.example`, the `server.json` env list and the README env table generated from the E-4 settings manifest (`npm run docs:env`, `--check` in the gate); fixes GAP C-3/C-4 — L4-08.

### D-4 — Install matrix + deeplinks (S)

**Done 2026-09-26 (local, uncommitted).**

- [x] One-line install for VS Code (`vscode:mcp/install` deeplink), Claude Desktop, Claude Code
      (`claude mcp add`), Cursor, Windsurf, Cline, Zed, JetBrains, Gemini CLI, Codex CLI — README +
      site. README "Install in your MCP client" (badges + matrix + per-client snippets) and the
      site's `#install` section; VS Code Insiders, the VS Code extension and the Claude Code plugin
      route included. `scripts/install-links.mjs` builds the `vscode:` / `vscode-insiders:` /
      `cursor://` deeplinks, the vscode.dev and cursor.com web redirects and the `code --add-mcp`
      lines from `package.json`; `test/install-links.test.js` asserts both files contain exactly
      those strings (no stale deeplink), that the payloads decode to `npx -y <package>`, and that
      `.claude-plugin/plugin.json` launches the same command. No env block in any link (a client
      env var overrides the env file); secrets stay in the env file / `login` /
      `servicenow_set_credentials`. Unverified client syntaxes: TODO.md → batch 11 owner decisions.

### D-5 — Lighter install + containers (M)

- [ ] Measure the `npx` footprint (93 prod packages ≈ 50 MB via the SDK's express/hono/ajv); trim
      what is ours; document the rest.
- [ ] `Dockerfile` (distroless, HTTP mode, non-root), `.dockerignore`, `smithery.yaml`, Glama
      metadata refresh.
- [ ] _(gap pass 2026-09-09)_ Generic `<KEY>_FILE` secret sources for every secret setting (profiles included); both set = fail-fast — L2-12.

### D-6 — Distribution hygiene (S + owner)

- [ ] Extension spawns `servicenow-mcp-ai@^3` (pinned major) — published **before** 3.0.0 so
      current users are not upgraded silently (`extension/src/extension.ts:19-22`).
- [ ] Stale `io.github.LeassTaTT` registry entries removed; Open VSX publish added to
      `publish-vscode.yml`; a GitHub Release per tag with the CHANGELOG section.
- [ ] _(gap pass 2026-09-09)_ `exports` map (root + `./package.json`), `publishConfig: {access, provenance}`, `sideEffects: false` — L9-05 (deep imports stop resolving; noted under B10).

### D-7 — Extension v2 (M)

- [ ] Settings (`envFile`, `packages`, `transport`), a SecretStorage-backed sign-in command, a
      walkthrough, a status-bar `doctor`; extension typecheck + lint in CI (E-6).

### D-8 — Plugin skills + hooks (M)

- [ ] `.claude-plugin` ships skills (`sn-triage`, `sn-impact`, `sn-drift`, `sn-safe-write`) and
      slash commands; a `PreToolUse` hook that blocks `apply:true` without a `plan_token`.
- [x] _(instance-docs pass 2026-09-23)_ The skill set gains `sn-discover`, which calls `document_instance({depth})` (S-16) instead of the harness `curl` recipe — ID-12.
- **Partly done 2026-09-26 (local, uncommitted).** `skills/sn-discover`, `sn-triage`, `sn-impact`,
  `sn-drift` and `sn-safe-write` (`SKILL.md` each, auto-discovered from the plugin root; not in
  the npm tarball). `test/plugin-skills.test.js` walks every `SKILL.md` (and `commands/*.md` when
  present) and asserts each `servicenow_*` name is in `test/fixtures/tools-manifest.json` (L4-02).
  **Open:** the `PreToolUse` hook that blocks `apply:true` without a `plan_token` waits for H-3
  (BREAKING, O-4) — no `hooks/hooks.json` ships; slash commands are not added (plugin skills are
  already invocable as `/servicenow-mcp-ai:sn-*`).

### D-9 — Security policy + community standard (S)

- [ ] SECURITY.md v2: supported versions, private reporting (GitHub advisory — the owner enables it,
      O-1 checklist), response targets, scope, threat-model pointer (GAP L9-11).
- [ ] `CODEOWNERS`, `CODE_OF_CONDUCT.md`, `SUPPORT.md` (support bundle from D-1), issue and PR
      templates, `.github/release.yml` (L9-10).
- **Acceptance:** GitHub community profile complete; the bug template asks for `doctor --json`.

### E-1 — Node ≥ 22.12 floor (S) — BREAKING

- [ ] `engines.node ">=22.12"`, CI matrix `[22, 24, 26]` (+ macOS/Windows on 22), launcher threshold
      and message, README badge, `@types/node` 24; c8 → 12 and `scripts/coverage-guard.mjs` deleted
      (coverage runs on every matrix leg); `import.meta.dirname` replaces `fileURLToPath`;
      `--experimental-transform-types` dropped from the doc scripts if the source loader allows it.

### E-2 — Toolchain majors (M)

- [ ] zod 4 (`z.objectOutputType` → `z.infer<z.ZodObject<S>>` in `src/mcp/define.ts:39,42`; pin
      `z.record` and `.int()` behaviour with the manifest snapshot + `mcp-smoke`), SDK `^1.30`,
      TypeScript 7 (check typescript-eslint compatibility first; stay on 5.9 if not), ESLint 10,
      `dotenv` replaced by `process.loadEnvFile`/`util.parseEnv` (keep the `formatEnvValue`
      round-trip property test), prettier/fast-check current.
- [ ] _(gap pass 2026-09-09)_ `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; delete `scripts/ts-source-loader.mjs` and the `--experimental-transform-types` flags — L9-09.

### E-3 — Runtime container (M)

- [x] `createRuntime()` built once in bootstrap holds caches, telemetry, the TLS dispatcher, the
      profile store and the session registry; passed to `registerAllTools`; the `_reset*` hooks
      are deleted and tests construct their own runtime (closes A2-3).
- [x] _(gap pass 2026-09-09)_ The container owns the TLS dispatcher, semaphore, caches, breaker and task store and exposes `dispose()` (E-9) — L1-04, L6-04.
- **Done 2026-09-23 (local, uncommitted):** `src/core/runtime.ts` — `createRuntime()`, `installRuntime()`, `runWithRuntime()` (AsyncLocalStorage), `currentRuntime()` and `defineRuntimePart(name, create, dispose?)`; parts: schema cache, tokens, telemetry, queue, breakers, dispatchers, profiles, plugin availability. Built once in bootstrap and passed to `registerAllTools`, which binds every tool call; resources and prompts use the installed runtime. `dispose()` clears in place, is idempotent and concurrent calls share one run; `lifecycle.dispose()` / `registerDisposer()` delegate to it. The `_reset*` hooks are deleted — tests use `freshRuntime()` (`test/helpers.js`); `test/runtime.test.js` covers isolation, dispose and the absence of `_reset*` exports. The session registry and task store arrive as runtime parts with H-7; `_setUndiciLoader`, `_dispatcherCacheSize` and `setPluginProbe` remain as test seams.

### E-4 — Validated settings manifest (M) — BREAKING

- [ ] One zod-validated `Settings` object built at startup from a declarative manifest
      (`key, type, default, description, section, since`); invalid values are startup errors
      (`SN_TIMEOUT_MS=abc` no longer silently defaults); dynamic `process.env` reads in
      `policy.ts`, `host.ts`, `auth.ts`, `config.ts` go through it (closes A2-2; ARCH-12b resolves
      here with namespaced keys if Jira lands).
- [ ] The cwd `.env` fallback is removed (`SN_ENV_FILE` → XDG only); `doctor` prints the chosen
      file.
- [ ] _(gap pass 2026-09-09)_ Manifest fields `secret`, `since`, `group`, `description` feed the D-3 generators and the `_FILE` resolver (D-5) — L2-12, L4-08.

### E-5 — Observability (S)

- [x] `get_status` reports per-tool `{count, errors, p50, p95}`, cache hit/miss and per-host
      retry counters; `diagnostics_channel` publish points in the request loop so OpenTelemetry can
      attach without a hard dependency.
- [x] _(gap pass 2026-09-09)_ `SN_LOG_FORMAT=json|text`, `SN_LOG_FILE` + rotation through the redacting logger — L7-01; counters for queue depth, breaker state, rate-limit headers, cache stats and write caps in `get_status`; optional `GET /metrics` (Prometheus, `SN_METRICS=1`, behind the H-7 token) — L7-02, L1-07.
- **Done 2026-09-24 (local, uncommitted).** `src/core/metrics.ts`: per-tool count/errors/p50/p95, cache, retry, queue, breaker and rate-limit stats in `get_status.observability`; `diagnostics_channel` events; `SN_LOG_FORMAT`, rotated `SN_LOG_FILE`; `GET /metrics` behind `SN_METRICS` + `SN_HTTP_TOKEN`. Write-cap counters wait for H-11.

### E-6 — Test architecture (M + owner)

- [ ] Spawn-based CLI tests; `extension/` typecheck + lint job; `mock.timers` for retry/backoff
      tests and no wall-clock assertions; property tests for the retry matrix, policy resolution
      and the query encoder; a redacted fixture corpus recorded from a PDI; an optional live smoke
      job gated on secrets (GA-9, O-2).
      _(batch 11)_ Spawn-based CLI tests (`test/cli-spawn.test.js`: stdio handshake + core tool list + JSON-only stdout + SIGTERM/SIGINT exit 0 through `bin/` and `build/index.js`, `doctor` exit 2 unconfigured, `drift` usage / error exit 2, both Node guards), an `extension` CI job (`npm ci` + `tsc --noEmit` in `extension/`), `mock.timers` for every retry/backoff test with no wall-clock assertions left, and property tests for the retry matrix, policy resolution and the query encoders — done 2026-09-26 (local, uncommitted). **Open:** extension lint (no ESLint config in `extension/`), the PDI fixture corpus and the live smoke job (O-2).
- [ ] _(gap pass 2026-09-09)_ Fetch double v2 (headers, delay, streaming, routes, fake timers) — L9-01; six new property tests (redaction, CSV, docs path, policy glob, env value, journal chain) — L9-02; `test/**/*.test.js` + `.c8rc.json` + a folder layout mirroring `src/` — L9-03; manifest v2 fixture — L5-01.
      _(batch 11)_ Fetch double v2 (`createFetchDouble` / `withFetchDouble` / `fakeClock` in `test/helpers.js`: routes, headers, delay, streaming bodies, call log with virtual timestamps; `test/fetch-double.test.js`) with `http-resilience`, `http-retry` and `cancel-progress` migrated — L9-01; the six L9-02 properties (redaction, CSV, docs path, host / MIME allow-list globs — the table glob waits for H-11, env value with an extended alphabet, journal chain) in `test/property-{http,policy,data}.test.js`, fixed seed via `fcParams()` (`SN_FC_SEED` / `SN_FC_RUNS`) — done 2026-09-26 (local, uncommitted). Three properties found real defects, kept as `todo` tests (see TODO.md batch 11). **Open:** L9-03 layout (deferred), L5-01.
- [ ] _(instance-docs pass 2 2026-09-25)_ The metadata-only guard (`METADATA_TABLES` / `assertMetadataUrl` / `fetchMeta`, today local to `test/docs-goldens.test.js:46-88`) moves to `test/helpers.js` as `withMetadataFetch`, its allow-list grows with the S-3 / S-15 tables and every `ARTIFACT_TYPES` table (derived at test time), and the `snapshot` / `compare` / `codecheck` / `security-scan` suites switch to it — ID-27. One golden per Markdown writer output (snapshot ×4, compare, code-health; volatile frontmatter fields masked, `UPDATE_GOLDENS=1` to regenerate) lands before the E-7 split so the split is provably byte-neutral — ID-28.

### E-7 — Code health (M)

- [ ] Enable `no-unsafe-assignment` / `no-unsafe-member-access`; split `snapshotInstance` and
      `compareInstances` into per-section collectors; shared `expectJson<T>` and a query-param
      builder; `snRequest` folded through E-8 if the engine is shared.
- [x] _(instance-docs pass 2026-09-23)_ The per-section snapshot collectors are consumed by `document_instance` (S-15); the three Mermaid builders (`src/api/diagrams.ts:14-24`, `src/api/flows.ts:354`, `src/api/whereused.ts:78`) are unified in `src/api/mermaid.ts` under S-14 (ID-07), not here.
- [x] _(instance-docs pass 2 2026-09-25)_ The collector split is named: `src/api/collectors.ts` exports `collectTables`, `collectPlugins`, `collectApps`, `collectAutomation(types = SCRIPT_TYPES)`, `collectSchema(table)` — each `(ctx: { signal?, progress? }) => Promise<{ data, unreadable, truncated? }>`, no file I/O, no Markdown; `snapshotInstance` (`src/api/snapshot.ts:129-130,344`, still monolithic) becomes composition + rendering with byte-identical output pinned by the ID-28 goldens, `compareInstances` reads the same shapes. This bullet precedes `document_instance` (S-15) and S-7's per-table files; the lint-rule bullets can follow — ID-24.
- **Partly done 2026-09-26 (local, uncommitted).** `no-unsafe-assignment` / `no-unsafe-member-access` on (0 violations); `src/api/collectors.ts` (`collectTables`, `collectSchema`, `collectPlugins`, `collectApps`, `collectAutomation`, `collectRecordSection`, ctx-first, `{ data, unreadable, truncated?, capped, errors }`) composed by `snapshot.ts` and `compare.ts`; `snParams()` in `shared.ts` dedups five call sites. Writer goldens pin the snapshot / compare output (`test/writer-goldens.test.js`, `test/collectors.test.js`). `expectJson` skipped on purpose (`expectResult` covers it). **Open:** `snRequest` (with E-8). The `document_instance` consumer (S-15) landed in batch 10 (2026-09-26).

### E-8 — ARCH-14 / ARCH-10 resolution (M + owner)

- [ ] **GO:** extract `runRequestLoop(hooks)` into `http-util.ts` and delete the parity test;
      Jira tools then follow every rail (package axis, plan/apply, journal, redaction).
- [ ] **NO-GO:** delete `src/core/jira/`, `src/api/jira/` and the parity test in the major.
- [ ] _(gap pass 2026-09-09)_ Until the decision, the Jira build output is excluded from the tarball by H-9's `files` negation — L9-04.

### E-9 — Process lifecycle + bounded state (S)

- [x] `unhandledRejection`/`uncaughtException` handlers: one redacted structured `error` line,
      exit 1; SIGTERM behaves like SIGINT in stdio (GAP L6-03) — `installCrashHandlers()` in
      `src/core/lifecycle.ts`: `pid`, `uptime`, `transport`, `errorName`, `error` (2000-char cap,
      never a stack or the raw reason), stderr flushed with a 250 ms bound, then exit 1; only the
      first crash is handled.
- [x] `Container.dispose()` (E-3): close the dispatcher, reject queued waiters with `BUSY`, clear
      caches/tokens/breaker/task timers; called on session close, on signals and in every test's
      `afterEach` (L6-04) — landed as a module-level `dispose()` (idempotent, concurrent calls share
      one run, a failing step is logged and skipped) that clears the schema cache + counters, OAuth
      tokens, the mTLS dispatcher handle and HTTP telemetry plus `registerDisposer()` hooks
      (`api/plugin.ts` registers its availability map); called on SIGINT/SIGTERM before
      `server.close()`, on `onsessionclosed` of the HTTP transport and by the lifecycle / cache
      tests. Wired on 2026-09-23 with H-10: `dispose()` drains the per-host queue (waiters fail
      with `BUSY`, reason `drained`), resets the breakers and closes every cached undici
      dispatcher (`test/lifecycle.test.js`); E-3 folds `dispose()` into the container and adds the
      global `afterEach`.
- [x] Schema cache LRU `SN_SCHEMA_CACHE_MAX` (256) with stats in `get_status` (L2-08) — Map-ordered
      LRU in `src/core/cache.ts` (a hit re-inserts at the recent end, expired entries are swept on
      every insert, the least-recently-used entry is evicted when full); `get_status.schemaCache`
      reports `size`, `max`, `hits`, `misses`, `evictions`, `expired`.
- **Acceptance:** child-process test — an injected rejection produces one JSON error line and exit 1
  within 1 s; the suite exits without `--test-force-exit`; the 257th insert evicts the LRU entry.
- **Done 2026-09-10 (local, uncommitted):** `test/lifecycle.test.js` (8 tests, +1 with H-10 — child-process crash
  probes through `test/fixtures/crash-probe.mjs` assert one JSON error line and exit 1 within 1 s
  for both crash kinds, `dispose()` idempotency / shared run / failing step, listener teardown) and
  `test/cache.test.js` (9 tests — the 257th insert evicts the LRU entry, a hit refreshes recency,
  TTL sweep, counters, `getSchemaCacheMax()` fallback, the `get_status.schemaCache` shape). The
  suite exits on its own. Also in the item: `startHttp` awaits `listen()` so a bind failure
  (EADDRINUSE, privileged port) rejects startup instead of raising a stray `'error'` event, and
  `closeHttpTransport()` stops the listener on shutdown. Not covered: the timer fallback in
  `handleCrash` when stderr never drains.

### O — Owner gates

- [ ] **O-1** ARCH-14 go/no-go (unblocks E-8; needed before M-2's error taxonomy is final).
- [ ] **O-2** PDI + credentials for the fixture corpus and the live smoke (GA-9).
- [ ] **O-3** Distribution: registry cleanup, Open VSX, Marketplace refresh, DX-3 GIF, launch
      posts (GA-8) — the KPI checkpoint set for 2026-08-01 passed without review; set the next one
      at 3.0.0 + 30 days.
- [ ] **O-4** Approve the breaking-change register below before the 3.0 branch opens.
- [ ] **O-5…O-9** SDK parity epic gates (PDI verification of the SDK inventory's unverified items,
      SDK-managed write default, Fluent generation dependency, tool budget, licensed families) —
      defined in [SDK-PARITY.md](SDK-PARITY.md) §7.

## SDK parity epic

Plan, gap matrix (108 artefact rows across core, server, classic UI, Next Experience, UI Builder,
Service Portal, Flow Designer/playbooks, legacy workflow, catalog, quality, AI and app scope),
design decisions and acceptance criteria: [SDK-PARITY.md](SDK-PARITY.md). Baseline `@servicenow/sdk`
4.12.2 (4.13.0 on `next`). Rows 55–83 above track P-1…P-29 in six phases (P0 registry and
detection → P1 read/explain breadth → P2 flows, UIB, portal, workflow → P3 analyse/snapshot/docs →
P4 writes → P5 Fluent generation); weighted effort 64 (S=1, M=2, L=4). Tool delta +9 tools, +2
packages. Placement: nothing in the 3.0 cut; P0–P5 on 3.x; only the P-22 `deny` default is a 4.0
breaking change. Touch points with the S pillar (INSTANCE-DOCS §9): P-10 and P-21 render through
S-14's `src/api/mermaid.ts`, P-21 extends S-15's `document_app`, P-26 writes under the S-14 store
(`fluent/<scope>/` as a manifest kind) and P-20 widens S-7 — S-14 is the only S item the epic needs
before its P2 phase.

## Breaking-change register (→ the CHANGELOG migration table at ship time)

| #   | Change                                                                                                                                                                                  | Item | Migration                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| B1  | Node ≥ 22.12                                                                                                                                                                            | E-1  | Upgrade Node; the launcher prints the requirement.                                    |
| B2  | Tool renames + parameter normalization (`sys_id`, `table`, `fields`/`values`)                                                                                                           | M-7  | Generated old→new table; `SN_LEGACY_TOOL_NAMES=1` for one minor cycle.                |
| B3  | Error contract: `snDetail` → `detail`, new `code`; resources throw `McpError`                                                                                                           | M-2  | Update client parsers; codes documented in the manifest.                              |
| B4  | Destructive `apply:true` needs a `plan_token` in plan mode; elicitation refusals fail                                                                                                   | H-3  | Call the tool without `apply` first; `SN_WRITE_MODE=apply` for automation.            |
| B5  | Fail-fast settings; cwd `.env` autoload removed                                                                                                                                         | E-4  | Fix the reported value; move `.env` to XDG or set `SN_ENV_FILE`.                      |
| B6  | HTTP: per-session profile; non-loopback bind refuses to start without `SN_HTTP_TOKEN`                                                                                                   | H-7  | Set the token; call `use_instance` per session.                                       |
| B7  | `set_credentials`: a new `instance` requires the auth material in the same call                                                                                                         | H-2  | Send `user` + `password` (or API key) with the host.                                  |
| B8  | `batch`: unmapped `/api/*` prefixes denied by default                                                                                                                                   | H-4  | `SN_BATCH_ALLOW_UNMAPPED=1` or add the prefix to the map.                             |
| B9  | Extension pinned to `servicenow-mcp-ai@^3`                                                                                                                                              | D-6  | None for users; publish the pinned extension first.                                   |
| B10 | Dark Jira scaffold removed (only if ARCH-14 = NO-GO)                                                                                                                                    | E-8  | None (no tools were exposed).                                                         |
| B11 | Protected system tables write-denied by default (`sys_user`, `sys_user_has_role`, `sys_security_acl`, `sys_properties`, …)                                                              | H-11 | List the table in `SN_ALLOW_TABLES` or set `SN_PROTECTED_TABLES_WRITE=allow`.         |
| B12 | `use_instance` no longer persists `SN_ACTIVE_PROFILE` to the env file                                                                                                                   | H-7  | Pass `persist:true`; set `SN_ACTIVE_PROFILE` in the env file for a permanent default. |
| B13 | Profile resources move to `servicenow://profiles/{profile}/schema/{table}`; profile names `docs`, `schema`, `status`, `capabilities`, `reference`, `profiles`, `policy` become reserved | M-7  | Old template aliased for one minor; rename a reserved profile.                        |

## Explicitly NOT in 3.0

- **Jira tools** before ARCH-14 lands (E-8 only resolves the scaffold's fate).
- **Background-script execution** (`sys.scripts.do`) — never; it defeats every rail.
- **Module-breadth race** (HR, ITOM, SecOps packages) — not the lane; depth over breadth.
- **Hosted multi-tenant SaaS / A2A** — H-7 makes a single-tenant remote correct; nothing more.
- **XLSX export**, **vitest migration** — unchanged "on request" status.
- **Weakening any rail** for convenience (plan mode default, journal, redaction, host guard).
- **A docs site, zip bundle or SVG rendering** of `docs/instance/` — the profile `README.md` +
  manifest is the deliverable (INSTANCE-DOCS §7).
- **Merging `snapshot_instance` into `document_instance`** — compare depends on the snapshot
  files; revisit in 3.x once both share the E-7 collectors.
- **A full-text search index** (lunr / minisearch) for the docs store — the manifest plus
  heading-aware substring search covers tens of files without a dependency.
- **A `servicenow_security_scan` tool or a `servicenow://reference/artifacts` resource** — the
  `security` document kind + `code_health`, and `servicenow://artifact-types` + the
  `artifact-types.md` document, cover both (INSTANCE-DOCS pass 2 §8).
- **SDK parity epic** (P-1…P-29) — 3.x minors; the P-22 default flip waits for 4.0. P-1 may land
  earlier only as the shape of S-4.

## Exit criteria for 3.0.0

- `npm run check` green, including the production audit, on the Node 22/24/26 matrix.
- A re-run of the five audits reports no open high finding; every H item has its test.
- `tools/list` for `all` ≤ 45,000 chars and `core` ≤ 14,000 (budget test).
- HTTP e2e: two concurrent sessions on different profiles, no cross-talk; rebinding rejected.
- Every write tool: plan → token → apply; every journal line has `before`; revert round-trips.
- The live PDI smoke has passed at least once against the release candidate (O-2).
- One MCP Registry listing, extension pinned to `^3`, all versions pinned by the sync test.
- CHANGELOG 3.0.0 carries the migration table; README, manifest and site regenerated.
- No **high** finding of [GAP-ANALYSIS-2026-09.md](GAP-ANALYSIS-2026-09.md) remains open (L1-03,
  L1-10, L3-01, L5-01, L6-01).

## Guardrails (unchanged)

Always-green gate, one commit per task, new tools added **only** through the declarative
manifest, every behavioural change ships with a test in the same commit, no secrets or PII in
journals, previews or exports.
