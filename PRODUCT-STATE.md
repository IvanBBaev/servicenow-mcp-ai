# servicenow-mcp — Product State

Date: 2026-07-02 · clean build · clean ESLint (type-checked + layer boundaries) · **380/380 tests** (coverage 95.29% lines / 84.36% branches / 98.56% functions) · CI: Node 20/22/24 + macOS matrix (lint + format also on Windows), coverage (lines 94 / branches 82 / functions 97) + prod-audit gates, CodeQL SAST + weekly dependabot · git history one-commit-per-task.
**Phase 6 is complete** (the optional X-8 HTTP transport shipped in v2.0 as DF-6): layered core/api/mcp/tools directories, a declarative tool manifest (a package is a plug-in), elicitation, MCP logging, outputSchema, the email package. **Phase 7 (multi-instance) is complete** (MI-1…MI-8: profiles, per-profile policy, per-call routing, snapshot, comparison, per-profile resources). **Phase 8 (flow testing + code checking) is complete** (FT-1…FT-7: the `flows`, `codecheck` and `atf` packages — deterministic table-event tracing, Flow Designer reading + run history, a local lint rule set + code-health report, ATF runs via the CI/CD API). **Phase 9 / v2.0 is complete** (DF-0…DF-6 trust + depth + reach; v2.0.0 published 2026-06-22 — npm `servicenow-mcp-ai` now at 2.0.1, MCP Registry, Claude Code plugin, VS Code extension 2.0.1). An uncommitted **Jira Cloud client WIP** (`src/core/jira/`, `src/api/jira/` — no tools yet) was reviewed 2026-07-01 and awaits the ARCH-14 go/no-go decision (see [BUSINESS-REVIEW-2026-07.md](BUSINESS-REVIEW-2026-07.md) §5 and §8).
Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) (how it is built), [DONE.md](DONE.md) (everything completed), [ROADMAP.md](ROADMAP.md) (forward plan), [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) (detailed specs), [WORKLOG.md](WORKLOG.md) (chronology), [CHANGELOG.md](CHANGELOG.md).

## 1. TL;DR — what works today

A full ServiceNow MCP server: **67 tools in 18 packages**, 7 MCP resources (package-gated), 3 prompts. Covers all core ServiceNow REST APIs (Table, Aggregate, Attachment, Import Set, Batch, CMDB/IRE) and the plugin APIs (Catalog, Change, Knowledge, Email) with capability detection. **v2.0 — trust + depth + reach:** plan-and-apply write safety (`SN_WRITE_MODE`, default plan) plus a local audit journal across all 13 write tools; a capability preflight (`check_capabilities` + degrade); an ACL security scan folded into `code_health`; a where-used / impact graph; client-side field redaction (PII); a token-guarded Streamable HTTP transport (`SN_TRANSPORT=http`); CSV export; and a `drift` CI gate. Reads and analyses the instance's script automation (business rules, script includes, client scripts…), traces what a table operation would run, lints scripts against a local rule set and runs ATF tests via the CI/CD API, generates Mermaid diagrams and maintains a local Markdown self-documentation store. Two-axis policy model (tables + packages), named connection profiles with per-call routing, **every ServiceNow auth method** (Basic, OAuth 2.1 Authorization Code + PKCE, client_credentials, refresh_token, JWT bearer, API key, bearer token, mutual TLS), retry/backoff, SSRF guard, structured errors.

```mermaid
pie title 67 tools by package
    "table (CRUD)" : 5
    "attachment" : 5
    "catalog" : 5
    "change" : 5
    "cmdb" : 5
    "admin" : 6
    "atf" : 5
    "scripts" : 5
    "flows" : 4
    "docs + diagrams" : 6
    "knowledge" : 3
    "codecheck" : 3
    "schema" : 2
    "importset" : 2
    "email" : 2
    "instance" : 2
    "aggregate" : 1
    "batch" : 1
```

## 2. ServiceNow API surface coverage

| ServiceNow API                      | Status | How                                                                                                                                       |
| ----------------------------------- | :----: | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Table API (CRUD + queries)          |   ✅   | `table` package; fetchAll pagination, X-Total-Count, display values                                                                       |
| Aggregate / Stats                   |   ✅   | `servicenow_aggregate`: count/avg/min/max/sum + group_by/having                                                                           |
| Attachment                          |   ✅   | list/meta/download/upload/delete; base64, size guard before download                                                                      |
| Import Set                          |   ✅   | staging insert + transform outcome                                                                                                        |
| Batch (`/api/now/v1/batch`)         |   ✅   | several REST calls in one request; policy per sub-request                                                                                 |
| CMDB Instance / Meta / IRE          |   ✅   | class-aware CRUD through Identification & Reconciliation                                                                                  |
| Service Catalog (`sn_sc`)           |   ✅   | browsing + variables + **order now**; plugin-aware                                                                                        |
| Change Management (`sn_chg_rest`)   |   ✅   | typed create (normal/standard/emergency), conflicts, update                                                                               |
| Knowledge (`sn_km_api`)             |   ✅   | relevance search, article, featured/most-viewed                                                                                           |
| Schema (`sys_db_object/dictionary`) |   ✅   | list/describe **with super_class inheritance chain**                                                                                      |
| Scripts (via the Table API)         |   ✅   | 9 artefact types: list/source/code search/`table_logic`                                                                                   |
| Diagrams / documentation            |   ✅   | Mermaid ER + table flow; local MD store + resources                                                                                       |
| Email API                           |   ✅   | `email` package: send (pluginCall + write policy) / get                                                                                   |
| Multi-instance work                 |   ✅   | profiles + per-profile policy + per-call routing (MI-1…MI-5); `snapshot_instance`, `compare_instances`, per-profile resources (MI-6…MI-8) |
| CI/CD + ATF                         |   ✅   | `atf` package: list/run tests + suites, poll results via the CI/CD API (FT-4; opt-in, non-default)                                        |
| Code Search (`sn_codesearch`)       |   ✅   | `search_code` uses it with `SN_CODESEARCH=true` (FT-7), LIKE fallback otherwise                                                           |
| Flow intelligence + code checking   |   ✅   | `flows` (trace/list/get/runs) + `codecheck` (lint + code-health) — Phase 8 FT-1/2/3/5/6                                                   |

## 3. How it is built (quality and infrastructure)

- **Language/runtime:** TypeScript strict + `noUncheckedIndexedAccess`, ESM, Node ≥ 20 (note: the default shell Node here is v12 — use nvm 22), MCP SDK 1.29.
- **Lint:** typescript-eslint type-checked + `no-floating-promises` + layer-boundary rules; Prettier (checked in CI).
- **Tests: 380 on 4 levels** (unit → api over mock fetch → in-memory MCP client → documentation guards, incl. property-based, perf and a manifest-integrity smoke that drives every tool), ~1 second, zero network. A contract snapshot protects the `core` tool list; sync tests protect the README tools table, the package description counts and the env reference (every `SN_*` var read in `src/` must appear in `README.md` **and** `.env.example` — `test/env-docs-sync.test.js`).
- **CI:** GitHub Actions (lint + format + build + test on Node 20/22/24 Linux + Node 22 macOS; lint + format also on the Windows leg; coverage gate `--lines 94 --branches 82 --functions 97`; prod-dependency audit; Node 12 launcher probe), plus CodeQL SAST and weekly dependabot (npm root + `extension/` + github-actions). Locally the same chain is one command: `npm run check`.
- **Documentation as code:** the README tools table is generated (`npm run docs:readme`); the env reference + `.env.example` are enforced by the sync test above; WORKLOG/DONE/TODO discipline after every task.

## 4. History — how we got here

```mermaid
timeline
    title servicenow-mcp — major milestones
    section 2026-06-11
        Start : 7 tools over the Table API only
        Reviews : code review + architecture review : won't-fix decisions (.env mode, instance change)
        Phases 1-5 : harness (retry, policy, OAuth, packages) : full API coverage : script intelligence : docs + diagrams + prompts
        Plan : Phase 6 (harness 2.0) : Phase 7 (multi-instance) : Phase 8 (flow testing + code analysis)
    section 2026-06-12
        Deep review : 22 findings (senior / architect / QA) : 22 of 22 closed
        Phase 6 : layered dirs : declarative manifest : elicitation, logging, outputSchema, email
        Quality : 59 to 137 tests : type-checked lint : generated README : v1.0.0 cut
        Phase 7 core : named profiles : per-profile policy : per-call instance routing : rebrand to servicenow-mcp
    section 2026-06-16 … 22
        Reviews : full-review passes (06-16→17, 06-18 ×3) : hardened defaults (.env 0600, host allow-list)
        Phase 8 : flows + codecheck + atf packages (FT-1…FT-7)
        v2.0 : DF-0…DF-6 trust + depth + reach : published to npm + MCP Registry : VS Code extension + Claude Code plugin
    section 2026-07-01 … 02
        Jira WIP review : full review of the uncommitted Jira client (16 findings, 12 fixed, 4 deferred)
        Gap sweep : GA-1…GA-6 (dependabot, CodeQL, Windows lint, unit tests, env-docs sync) : 380-test gate
        Analyses : BUSINESS-REVIEW-2026-07 (+ §8 merciless addendum) : UX-REVIEW-2026-07
```

The most important review fixes (full list in [DONE.md](DONE.md)): `describe_table` now sees inherited columns (critical for any extended table such as `incident`); batch can no longer bypass the table policy via stats/import/cmdb URLs; plugin APIs have a capability cache; credentials live in an atomic ConfigStore; a per-package policy axis covers the plugin APIs.

## 5. What is NOT done (roadmap)

Detailed specifications live in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) — written as a handoff spec:

| Phase                                | What                                                                       | Effort     | Key tasks                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| ~~8 · Flow testing + code analysis~~ | **done (2026-06-19)** — `flows` + `codecheck` + `atf` packages (FT-1…FT-7) | —          | shipped                                                                                |
| ~~9 · v2.0 differentiators~~         | **done (2026-06-22)** — DF-0…DF-6 (see [ROADMAP-V2.md](ROADMAP-V2.md))     | —          | shipped as v2.0.0 / 2.0.1                                                              |
| Undecided                            | the uncommitted Jira Cloud surface — go/no-go, safety rails, packaging     | owner call | ARCH-14 in TODO.md; [BUSINESS-REVIEW-2026-07.md](BUSINESS-REVIEW-2026-07.md) §5 + §8.2 |
| Owner actions                        | GA-8 distribution execution, DX-3 demo GIF, GA-9 PDI e2e nightly           | owner call | TODO.md owner actions; [BUSINESS-REVIEW-2026-07.md](BUSINESS-REVIEW-2026-07.md) §8.4   |
| Optional                             | PDI e2e suite, XLSX export (needs a binary-writer dep), vitest migration   | on request | the "Optional" section in the plan                                                     |

## 6. Known limitations and deliberate decisions

- **Hardened defaults (2026-06-17):** `.env` is written owner-only (`0600`); a request host must be `*.service-now.com` unless `SN_ALLOWED_HOSTS` is set (the SSRF guard + X-2 elicitation still apply on top). These were the two former "won't-fix" single-user risks, flipped for the public release.
- **Table policy ≠ plugin policy:** denying a table does not stop the plugin APIs — that is what the package axis (`SN_PACKAGES_DENY`/`SN_PACKAGES_READONLY`) is for; documented in the README security section.
- **No code execution on the instance** (incl. background scripts) — ATF through the official CI/CD API is the shipped alternative (Phase 8, opt-in).
- **The whole test suite is mock-fetch** — nothing yet proves the server against a live instance; the PDI e2e nightly is tracked as GA-9 (owner, needs a PDI + credentials).
- **The Jira Cloud client WIP is uncommitted and dark** — `src/core/jira/` + `src/api/jira/shared.ts` exist and are reviewed/tested, but expose no tools and no registry entry until the ARCH-14 decision (safety rails: package axis, plan/apply, journal, redaction).

## 7. Document compass

| File                                                     | Contents                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [README.md](README.md)                                   | setup, env reference, generated tools table, examples, security                                |
| [ARCHITECTURE.md](ARCHITECTURE.md)                       | layers, diagrams, policy/auth/config models, ADR decisions                                     |
| [PRODUCT-STATE.md](PRODUCT-STATE.md)                     | this file — what/how far/how                                                                   |
| [ROADMAP.md](ROADMAP.md)                                 | forward plan: ship 1.0.0, Phase 8, Phase 9 differentiators, optional                           |
| [COMPETITIVE-ANALYSIS.md](COMPETITIVE-ANALYSIS.md)       | positioning vs the official MCP Server Console; Phase 9 boost plan; risks                      |
| [BUSINESS-ANALYSIS-V2.md](BUSINESS-ANALYSIS-V2.md)       | market, business model, monetization; what "v2.0" means as a milestone                         |
| [ROADMAP-V2.md](ROADMAP-V2.md)                           | the v2.0 execution tracker (DF-0…DF-6, DX-1/DX-3) with definition of done                      |
| [BUSINESS-REVIEW-2026-07.md](BUSINESS-REVIEW-2026-07.md) | post-2.0 business review: delivery scorecard, adoption reality, the Jira decision, 30-day plan |
| [UX-REVIEW-2026-07.md](UX-REVIEW-2026-07.md)             | post-2.0 UX/DX review: onboarding funnel, tool surface, errors, docs site, prioritized backlog |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)         | Phase 6–8 specifications + optional items                                                      |
| [DONE.md](DONE.md)                                       | everything completed, with commit references                                                   |
| [TODO.md](TODO.md)                                       | backlog (triple analysis S2/A2/Q2), release checklist R-1…R-9, won't-fix                       |
| [WORKLOG.md](WORKLOG.md)                                 | detailed chronology: problem/solution/alternatives/verification                                |
| [CHANGELOG.md](CHANGELOG.md)                             | user-facing change overview (Keep a Changelog)                                                 |
