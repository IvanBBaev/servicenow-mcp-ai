# Role review — October 2026

**Date:** 2026-10-29 · **Subject:** `servicenow-mcp-ai` 3.0.0 GA (2026-10-19) plus the unreleased
3.1/3.2 work on `main` · **Owns:** findings `RR-PO-*`, `RR-AR-*`, `RR-MC-*`, `RR-SN-*`, `RR-SE-*`,
`RR-QA-*`, `RR-DO-*`, `RR-DX-*`, `RR-GV-*` (112 findings); items N-95 … N-162; owner decisions
OD-17 … OD-32 in [TODO.md](TODO.md).

This document has three parts. First, a baseline analysis of what the project is today. Second,
which senior roles should review it, and why. Third, the synthesis of nine independent role
reviews, turned into roadmap items. The full per-role reports are in
[role-review-2026-10/](role-review-2026-10/). Each one has a verdict, what was examined,
strengths, findings with evidence, proposed items, owner decisions and the metrics the role
would track.

## 1. Baseline analysis

### 1.1 What the product is

An MCP server that lets an AI client (Claude Code, Claude Desktop, VS Code, Cursor…) work with a
ServiceNow instance over its REST surface. Its capabilities:

- 100 tools in 28 packages;
- script intelligence (where-used, trace-on-save);
- artefact explainers and document generators;
- multi-instance profiles and dev↔prod drift;
- Mermaid generators;
- a two-axis policy model (tool policy × table policy).

Writes follow **plan → token → apply**. A write tool returns a preview first. A destructive apply
also needs a single-use `plan_token`. Every apply is recorded in a local journal that supports
revert. The default profile `discovery` exposes 20 tools. More come through
`SN_TOOL_PACKAGES`, or at runtime through `servicenow_enable_package` (on the legacy wire only;
see RR-MC-01).

Distribution: npm (`latest` = 3.0.0, plus a 2.0.1 pin), the VS Code Marketplace and Open VSX
extension, a `.mcpb` bundle on every GA release, the MCP registry entry (`server.json`), a
Claude Code plugin with skills and hooks, a container image and a docs site.

### 1.2 Measured state (2026-10-29)

| Dimension    | Value                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Source       | 254 files, ≈ 90.5k lines of TypeScript in `src/` (≈ 11k two months earlier)                                                          |
| Tests        | 238 files, ≈ 91k lines; 2,769 tests; `npm run check` green in ≈ 18 s of test time                                                    |
| Architecture | 0 import cycles; layer direction core ← api ← tools/mcp enforced by ESLint zones                                                     |
| Complexity   | 49 functions over 120 lines; 30 with cyclomatic complexity ≥ 30; `api/` holds 117 flat files                                         |
| Planning     | 178 roadmap rows before this review, 87 % done; gates O-1 … O-25; breaking register B1 … B24                                         |
| Verification | 40 PDI passes, 1,345 table/field names checked; recorded corpus covers 6 of 100 tools                                                |
| Live testing | Weekly live smoke has passed as a no-op for three weeks because its secrets were never set (O-2)                                     |
| Adoption     | ≈ 1,104 npm downloads/month, 10 stars, 553 Marketplace installs, 0 issues opened by a human, 0 sponsors                              |
| Supply chain | SHA-pinned actions, least-privilege jobs, CodeQL, npm provenance; long-lived `NPM_TOKEN` (expires by 2026-11-18); `main` unprotected |

### 1.3 Where the project stands

The engineering is mature, and well above the median community MCP server:

- strict schemas and a single error contract;
- write safety enforced in code;
- a broad offline test suite;
- a reproducible release pipeline.

The weaknesses sit around that core, in five places:

1. **Nobody has measured value with real users or models.** There is no feedback channel. No
   real model has been scored on tool selection. The `tools/list` byte budget limits features
   without evidence of what the bytes buy.
2. **Nothing is proven live.** No test runs against a real instance on a schedule, and every
   write path is tested only against mocks.
3. **The safety model is single-user.** Every control lives in an env file that the restrained
   user can edit. Confirmations are agent-to-agent. The journal is best-effort and
   world-readable.
4. **Operations have deadlines.** The npm token expires, branches are unprotected, the publish
   order is unsafe, and 3.1/3.2 work is unreleased.
5. **Growth outpaces the design record.** ARCHITECTURE.md describes v2.0, there is no size
   ratchet, and the public numbers are stale.

## 2. Which roles should review it, and why

Nine roles were chosen. Together they cover every way the product can fail: no users, a wrong
design, bad agent ergonomics, harm to the instance, a security breach, untested behaviour, a
broken release, docs that mislead, and enterprise rejection. Each role was run as an independent
senior reviewer. Each had the same brief (finding-id scheme, severity and effort scales, report
template) and read the code, docs, CI and live registries directly. No role saw another role's
report.

| #   | Role                                             | Why this project needs it                                                         | Report                                                                                         |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Senior Product Owner / developer-tools GTM       | 3.0 is GA, but demand, positioning and adoption are unmeasured                    | [01-product-owner.md](role-review-2026-10/01-product-owner.md)                                 |
| 2   | Principal Software Architect (TypeScript/Node)   | `src/` grew 8× in two months; the design record is stale                          | [02-software-architect.md](role-review-2026-10/02-software-architect.md)                       |
| 3   | Senior MCP protocol & AI-agent tooling engineer  | The product _is_ a tool surface for models; the modern wire changed the rules     | [03-mcp-agent-tooling.md](role-review-2026-10/03-mcp-agent-tooling.md)                         |
| 4   | ServiceNow Certified Master Architect            | Every call lands on a customer instance; load, roles and update sets matter       | [04-servicenow-platform-architect.md](role-review-2026-10/04-servicenow-platform-architect.md) |
| 5   | Principal AppSec / AI-agent security engineer    | An agent with write access to an ERP-class platform, exposed to prompt injection  | [05-application-security.md](role-review-2026-10/05-application-security.md)                   |
| 6   | Principal QA / Test Architect                    | A green offline suite coexists with 5 wrong tables and 74 wrong fields found live | [06-qa-test-architect.md](role-review-2026-10/06-qa-test-architect.md)                         |
| 7   | Senior DevOps / release & supply-chain engineer  | A solo maintainer publishes to four channels from one token                       | [07-devops-release.md](role-review-2026-10/07-devops-release.md)                               |
| 8   | Senior DX engineer & technical writer            | First-run success decides adoption; docs span README, site, skills and extension  | [08-dx-technical-writer.md](role-review-2026-10/08-dx-technical-writer.md)                     |
| 9   | Enterprise IT governance, risk & compliance lead | Enterprises are the buyers of ServiceNow; they decide whether the tool is allowed | [09-enterprise-governance.md](role-review-2026-10/09-enterprise-governance.md)                 |

Roles considered and not run: a UX designer (the only UI is the VS Code extension, which DX
covers), a legal counsel (licence and trademark are covered by GV as owner decisions), and a
performance engineer (instance load is covered by SN, server cost by AR).

## 3. Method

- **Evidence first.** Every finding is either _verified_ (a file and line, a command output, a
  registry or GitHub API response on 2026-10-29) or marked as _judgement_.
- **Finding ids** are `RR-<ROLE>-NN`. Each finding has a severity (critical / high / medium /
  low), the evidence, the impact and a recommendation.
- **Proposed items** were written with temporary ids (`<ROLE>-I<n>`). Each has a priority
  (P0–P3), an effort (S/M/L), the `tools/list` byte delta, whether it is breaking, and whether
  the owner must decide something.
- **Consolidation.** This document merges the 79 proposed items into 68 roadmap items (N-95 …
  N-162). Overlapping items are merged into one (§5), and every source id stays traceable. The
  owner questions are grouped into 16 decisions, OD-17 … OD-32.
- **No new owner gates and no new breaking rows.** Items reuse O-2 (PDI and secrets), O-4
  (breaking), O-5 (unverified names) and O-10 (`tools/list` budget). The BREAKING items are
  marked, and they enter the B-register only when the owner accepts them under O-4.

## 4. Scorecard

| Role                 | Score | Verdict in one line                                                                  | Top risk                                                                                          |
| -------------------- | ----- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Product Owner        | 5/10  | The engineering is far ahead of the product                                          | No feedback loop: 0 human issues, demand never validated, 178 items with 0 % demand work          |
| Software Architect   | 7/10  | The macro shape is sound and enforced; the problem is the rate of growth             | No size or complexity ratchet; ARCHITECTURE.md describes v2.0                                     |
| MCP / agent tooling  | 7/10  | More careful at the protocol level than almost any peer; agent quality is unmeasured | On the modern wire only 20 of 100 tools can be called (`NO_PACKAGE_SESSION`)                      |
| ServiceNow platform  | 7/10  | Name verification beats most commercial integrations; instance load is the weak spot | Timed-out GETs are retried while the first copy still runs; `check_data_health` has no size guard |
| Application security | 6/10  | Classic hygiene is strong; the AI-agent controls stop short of a human               | The `token` confirmation is agent-to-agent, and `elicit` fails open                               |
| QA / test            | 6/10  | Offline 8–9, live 3                                                                  | The live smoke is a green no-op; writes are proven only against mocks                             |
| DevOps / release     | 7/10  | Workflow design is well above the norm; the guard rails around it are missing        | `NPM_TOKEN` expires by 2026-11-18; `main` and the tags are unprotected                            |
| DX / docs            | 6/10  | The runtime guidance is excellent; the written docs drift                            | Stale numbers, missing site coverage, a password-in-chat path in the README                       |
| Governance           | 5/10  | Above the community median, but the design is single-user                            | Controls are user-editable; the journal is best-effort; exports have no retention                 |

**Mean 6.2/10.** No role found a critical defect in the shipped code. All the P0 items concern
missing controls, measurements or guard rails, not broken behaviour.

## 5. Cross-role synthesis

Several roles reached the same conclusions independently. These are the strongest signals in
the review, so each is merged into one roadmap item:

| Theme                                                                          | Raised by                  | Merged into                |
| ------------------------------------------------------------------------------ | -------------------------- | -------------------------- |
| Release the 3.x work now, fix the dist-tags, order the publish chain           | PO-I4, DO-I2, DO-I6        | N-95                       |
| Replace `NPM_TOKEN` with trusted publishing; protect `main`, tags and releases | DO-I1, SE-I6, RR-GV-13     | N-96                       |
| Public numbers and README claims are stale                                     | PO-I3, DX-I2 (and DX-I1)   | N-99 (N-132)               |
| SDK 2.4 and the blocked Dependabot queue                                       | AR-I6, DO-I3               | N-100                      |
| Model-based evaluation is missing; the byte budget is spent blind              | MC-I2, QA-I9, MC-I3        | N-102, N-111               |
| The journal is not audit-grade and does not scale                              | GV-I2, AR-I3, RR-SE-12     | N-109                      |
| SECURITY.md and the vendor-risk docs drift from the code                       | SE-I3, GV-I8               | N-122                      |
| The password passes through the chat                                           | SE-I5, DX-I3               | N-124                      |
| Nothing is proven against a live instance                                      | QA-I1, QA-I3, QA-I4, SN-I6 | N-107, N-126, N-127, N-140 |
| HTTP deployment is undocumented for operators and enterprises                  | DO-I5, GV-I7               | N-131                      |
| The safety model trusts the person it restrains                                | SE-I1, SE-I2, GV-I1, GV-I3 | N-105, N-106, N-108, N-110 |

Two tensions the owner must resolve:

- **Journal retention.** AR recommends keeping 10 rotated files. GV recommends an unlimited
  journal that the managed policy can lock. Both are in OD-27. The recommendation: unlimited
  by default, with a managed or user retention setting that records each deletion in the chain.
- **Bytes vs. reach.** MC-I1 (+600 B) and GV-I6 (+120 B) spend `tools/list` bytes, while MC-I4
  (−2.5 KB) frees them. The recommendation is to sequence them under budget policy v2 (OD-23):
  land MC-I4 first, then spend the freed bytes on MC-I1.

## 6. Roadmap items N-95 … N-162

The items are appended to [roadmap.yaml](roadmap.yaml) after N-94, in priority order (P0 → P3).
They are rendered into the [ROADMAP-V3.md](ROADMAP-V3.md) sequencing table. The general N rules
apply: no item touches `core`, each states its measured `tools/list` delta, writes go through
plan → token → apply, and any new table or field is unverified until O-5.

### 6.1 Summary

| Item  | Title                                             | Priority | Effort | Sources             | Gates     | Breaking  | Decision |
| ----- | ------------------------------------------------- | -------- | ------ | ------------------- | --------- | --------- | -------- |
| N-95  | release 3.x and an ordered publish chain          | P0       | S      | PO-I4, DO-I2, DO-I6 | —         | no        | OD-17    |
| N-96  | npm trusted publishing and repository guard rails | P0       | S      | DO-I1, SE-I6        | —         | no        | OD-18    |
| N-97  | feedback loop and KPI snapshot                    | P0       | S      | PO-I1               | —         | no        | OD-28    |
| N-98  | single-source positioning                         | P0       | S–M    | PO-I2               | —         | no        | OD-28    |
| N-99  | public-number truth guard and README accuracy     | P0       | S      | PO-I3, DX-I2        | —         | no        | —        |
| N-100 | SDK 2.4, `_wrapHandler` pin, dependency flow      | P0       | M      | AR-I6, DO-I3        | —         | no        | —        |
| N-101 | `call_tool` dispatcher + schema `find_tools`      | P0       | M      | MC-I1               | O-10      | no        | OD-23    |
| N-102 | model-based tool-selection eval and its cadence   | P0       | S–M    | MC-I2, QA-I9        | —         | no        | OD-24    |
| N-103 | no GET retry after timeout; quota alignment       | P0       | S      | SN-I1               | —         | no        | OD-31    |
| N-104 | `check_data_health` size guard, serial run        | P0       | S      | SN-I2               | —         | no        | OD-31    |
| N-105 | human-bound confirmation for destructive writes   | P0       | M      | SE-I1               | O-4       | yes (O-4) | OD-19    |
| N-106 | protected-table expansion and plan-token parity   | P0       | M      | SE-I2               | O-4       | yes (O-4) | OD-20    |
| N-107 | a live smoke that really runs                     | P0       | S      | QA-I1               | O-2       | no        | OD-25    |
| N-108 | managed policy file + host environment map        | P0       | L      | GV-I1               | —         | no        | OD-26    |
| N-109 | audit-grade journal                               | P0       | M      | GV-I2, AR-I3        | —         | no        | OD-27    |
| N-110 | private state dir, file modes, export retention   | P0       | M      | GV-I3               | O-4       | yes (O-4) | OD-27    |
| N-111 | budget policy v2                                  | P1       | S      | MC-I3               | O-10      | no        | OD-23    |
| N-112 | conditional `instance` parameter                  | P1       | S      | MC-I4               | O-10      | no        | OD-23    |
| N-113 | routing clauses and write-flow suffixes           | P1       | S      | MC-I5               | O-10      | no        | —        |
| N-114 | `find_tools` synonym map and jargon eval cases    | P1       | S      | MC-I6               | —         | no        | —        |
| N-115 | cache immutable server parts on the modern wire   | P1       | M      | AR-I1               | —         | no        | OD-30    |
| N-116 | size/complexity ratchet, refactor top five        | P1       | M      | AR-I2, QA-I10       | —         | no        | OD-30    |
| N-117 | read-policy choke point in `snRequest`            | P1       | M      | AR-I4               | —         | no        | —        |
| N-118 | ARCHITECTURE.md 3.x rewrite and technical ADRs    | P1       | M      | AR-I5               | —         | no        | —        |
| N-119 | count once per keyset fetch-all                   | P1       | S      | SN-I3               | —         | no        | —        |
| N-120 | update-set capture verification                   | P1       | M      | SN-I4               | O-5       | no        | —        |
| N-121 | service-account recipe + `doctor` identity        | P1       | M      | SN-I5               | O-5       | no        | OD-31    |
| N-122 | SECURITY.md and vendor-risk documentation truth   | P1       | S      | SE-I3, GV-I8        | —         | no        | OD-29    |
| N-123 | untrusted result boundary + injection eval        | P1       | M      | SE-I4               | —         | no        | —        |
| N-124 | password via elicitation; safe first run          | P1       | S–M    | SE-I5, DX-I3        | O-4       | yes (O-4) | OD-21    |
| N-125 | offline dictionary snapshot in the gate           | P1       | M      | QA-I2               | —         | no        | —        |
| N-126 | recorded corpus per package, strict double        | P1       | L      | QA-I3               | O-2       | no        | OD-25    |
| N-127 | owner-run live write end-to-end                   | P1       | M      | QA-I4               | O-2       | no        | OD-25    |
| N-128 | pinned safety lists + safety-core mutation        | P1       | M      | QA-I5               | —         | no        | OD-24    |
| N-129 | packed-tarball and `.mcpb` install smoke          | P1       | S      | QA-I6               | —         | no        | —        |
| N-130 | container hardening                               | P1       | S      | DO-I4               | —         | no        | —        |
| N-131 | HTTP topology + enterprise deployment guide       | P1       | M      | DO-I5, GV-I7        | —         | no        | —        |
| N-132 | docs-site coverage gate and generated reference   | P1       | M      | DX-I1               | —         | no        | OD-32    |
| N-133 | user-docs jargon lint                             | P1       | S      | DX-I4               | —         | no        | OD-32    |
| N-134 | `regulated` preset and read-access audit          | P1       | M      | GV-I4               | —         | no        | OD-26    |
| N-135 | AI-origin stamp on the record                     | P1       | M      | GV-I5               | —         | no        | —        |
| N-136 | change-request gate for production applies        | P1       | M      | GV-I6               | O-10      | no        | —        |
| N-137 | regenerable demo from recorded mocks              | P1       | M      | PO-I5               | —         | no        | —        |
| N-138 | adoption gate and resequencing                    | P1       | S      | PO-I6               | —         | no        | OD-28    |
| N-139 | competitive landscape refresh                     | P1       | S      | PO-I7               | —         | no        | —        |
| N-140 | per-release-family PDI verification pass          | P2       | M      | SN-I6               | O-5       | no        | OD-25    |
| N-141 | query-shape register for high-volume tables       | P2       | M      | SN-I7               | —         | no        | —        |
| N-142 | Change API writes on the table-write policy axis  | P2       | S      | SN-I8               | —         | no        | —        |
| N-143 | catalog variable validation                       | P2       | M      | SN-I9               | —         | no        | —        |
| N-144 | loopback HTTP token by default and a rate limit   | P2       | M      | SE-I7               | O-4       | yes (O-4) | OD-22    |
| N-145 | fd file reads, SSRF ranges, env scrubbing         | P2       | M      | SE-I8               | —         | no        | —        |
| N-146 | second-client compatibility                       | P2       | M      | QA-I7               | —         | no        | —        |
| N-147 | flake hardening                                   | P2       | M      | QA-I8               | —         | no        | —        |
| N-148 | Scorecard and zizmor                              | P2       | S      | DO-I7               | —         | no        | —        |
| N-149 | release-notes highlights and Open VSX truth       | P2       | S      | DO-I8               | —         | no        | —        |
| N-150 | "Since" stamping                                  | P2       | S      | DX-I5               | —         | no        | —        |
| N-151 | generated troubleshooting page                    | P2       | S–M    | DX-I6               | —         | no        | —        |
| N-152 | "your first safe write" tutorial                  | P2       | M      | DX-I7               | —         | no        | —        |
| N-153 | `all` preset and deprecated `admin` alias         | P2       | S      | DX-I8               | —         | no        | OD-32    |
| N-154 | extension `readOnly` setting                      | P2       | S      | DX-I9               | —         | no        | OD-32    |
| N-155 | trademark-safe display names                      | P2       | S      | GV-I9               | —         | no        | OD-29    |
| N-156 | split `api/` into REST and analysis domains       | P2       | L      | AR-I7               | —         | no        | OD-30    |
| N-157 | planning corpus compaction                        | P2       | S      | AR-I8               | —         | no        | OD-30    |
| N-158 | outcome checks for safe-write / impact skills     | P2       | S      | MC-I8               | —         | no        | —        |
| N-159 | task-intent landing pages                         | P2       | M      | PO-I8               | —         | no        | —        |
| N-160 | history window and import outcome summary         | P3       | S      | SN-I10              | —         | no        | —        |
| N-161 | export audit and pruning                          | P3       | S      | AR-I9               | —         | no        | —        |
| N-162 | `query_table` advanced-flags object               | P3       | S      | MC-I7               | O-4, O-10 | yes (O-4) | OD-23    |

### 6.2 Item detail

Each item names its source items and findings; the definition of done, the tests and the evidence are in the cited report under the same temporary id.

#### N-95 — release 3.x and an ordered publish chain

- Priority P0, effort S; gates: none; breaking: no.
- Sources: PO-I4, DO-I2, DO-I6 — findings RR-PO-06, RR-DO-03, RR-DO-09, RR-DO-10, RR-DO-12 ([01-product-owner.md](role-review-2026-10/01-product-owner.md), [07-devops-release.md](role-review-2026-10/07-devops-release.md)).
- Cut the unreleased 3.1/3.2 work from `main` as a release now (zod security floor, Docker build fix); clean the stale `next` dist-tag; reorder `publish.yml` so the extension publishes only after npm succeeds, serialize release workflows on the tag ref; write a security-patch SLA (7 days) and decide `npm-shrinkwrap.json`.
- Owner decision: OD-17.

#### N-96 — npm trusted publishing and repository guard rails

- Priority P0, effort S; gates: none; breaking: no.
- Sources: DO-I1, SE-I6 — findings RR-DO-01, RR-DO-02, RR-DO-14, RR-SE-06, RR-SE-11, RR-GV-13 ([07-devops-release.md](role-review-2026-10/07-devops-release.md), [05-application-security.md](role-review-2026-10/05-application-security.md)).
- **Deadline: `NPM_TOKEN` expires by 2026-11-18.** OIDC trusted publishing on npmjs.com and delete `NPM_TOKEN`; a `release` environment with the owner as required reviewer; rulesets protecting `main` and `v*` tags; secret scanning and push protection on; a documented backup publisher.
- Owner decision: OD-18.

#### N-97 — feedback loop and KPI snapshot

- Priority P0, effort S; gates: none; breaking: no.
- Sources: PO-I1 — findings RR-PO-01, RR-PO-10, RR-PO-11 ([01-product-owner.md](role-review-2026-10/01-product-owner.md)).
- GitHub Discussions, issue forms that ask for the use case, 3–5 design partners, and a `scripts/kpi.mjs` snapshot (npm downloads, stars, Marketplace installs, issues by humans) recorded per release — no telemetry; a `MAINTENANCE.md` with the sustainability posture and park criteria.
- Owner decision: OD-28.

#### N-98 — single-source positioning

- Priority P0, effort S–M; gates: none; breaking: no.
- Sources: PO-I2 — findings RR-PO-03, RR-PO-04 ([01-product-owner.md](role-review-2026-10/01-product-owner.md)).
- One tagline and one value statement generated into README, `package.json`, `server.json`, the extension manifest, the site and `llms.txt`; drop the tool-count headline (badge and descriptions).
- Owner decision: OD-28.

#### N-99 — public-number truth guard and README accuracy

- Priority P0, effort S; gates: none; breaking: no.
- Sources: PO-I3, DX-I2 — findings RR-PO-05, RR-DX-03, RR-DX-10, RR-DX-13 ([01-product-owner.md](role-review-2026-10/01-product-owner.md), [08-dx-technical-writer.md](role-review-2026-10/08-dx-technical-writer.md)).
- A test that derives every public number (tools, packages, tests, profiles, licence) from code and fails on a stale copy in README, prompts, resources and the site; README examples checked against the live tool schemas.

#### N-100 — SDK 2.4, `_wrapHandler` pin, dependency flow

- Priority P0, effort M; gates: none; breaking: no.
- Sources: AR-I6, DO-I3 — findings RR-AR-07, RR-DO-04, RR-DO-05 ([02-software-architect.md](role-review-2026-10/02-software-architect.md), [07-devops-release.md](role-review-2026-10/07-devops-release.md)).
- Bump `@modelcontextprotocol/server` to 2.4 with a test that pins the private `_wrapHandler` seam; derive SDK version strings so Dependabot PRs stop failing the gate; Dependabot groups and a cadence; merge or close #26–#30.

#### N-101 — `call_tool` dispatcher + schema `find_tools`

- Priority P0, effort M; gates: O-10; breaking: no.
- Sources: MC-I1 — findings RR-MC-01, RR-MC-06, RR-MC-09, RR-MC-10 ([03-mcp-agent-tooling.md](role-review-2026-10/03-mcp-agent-tooling.md)).
- On the 2026-07-28 wire `enable_package` returns `NO_PACKAGE_SESSION`, so only 20 of 100 tools are callable on the default profile. A dispatcher that calls any policy-allowed tool by name, and `find_tools` returning the input schema. ≈ +600 B on every profile.
- Owner decision: OD-23.

#### N-102 — model-based tool-selection eval and its cadence

- Priority P0, effort S–M; gates: none; breaking: no.
- Sources: MC-I2, QA-I9 — findings RR-MC-02, RR-MC-03, RR-QA-08 ([03-mcp-agent-tooling.md](role-review-2026-10/03-mcp-agent-tooling.md), [06-qa-test-architect.md](role-review-2026-10/06-qa-test-architect.md)).
- No real model has ever been scored on tool selection. A `claude -p` (subscription) backend plus a recorded fallback for `evals/`, repeated runs, committed baselines, run once per minor; the gate for MC-I3/MC-I5 byte spending.
- Owner decision: OD-24.

#### N-103 — no GET retry after timeout; quota alignment

- Priority P0, effort S; gates: none; breaking: no.
- Sources: SN-I1 — findings RR-SN-01 ([04-servicenow-platform-architect.md](role-review-2026-10/04-servicenow-platform-architect.md)).
- A timed-out GET is retried while the first transaction still runs on the instance (load amplification). Stop retrying timeouts (keep resets/5xx), document the relation to the instance transaction quota.
- Owner decision: OD-31.

#### N-104 — `check_data_health` size guard, serial run

- Priority P0, effort S; gates: none; breaking: no.
- Sources: SN-I2 — findings RR-SN-02 ([04-servicenow-platform-architect.md](role-review-2026-10/04-servicenow-platform-architect.md)).
- Up to about 40 join counts run in parallel with no size guard on 20M-row tables. Refuse unscoped runs above a row threshold (default 250k, per profile), run the counts serially. ≈ +80 B.
- Owner decision: OD-31.

#### N-105 — human-bound confirmation for destructive writes

- Priority P0, effort M; gates: O-4; breaking: yes (O-4).
- Sources: SE-I1 — findings RR-SE-01 ([05-application-security.md](role-review-2026-10/05-application-security.md)).
- **BREAKING (O-4).** The default `token` confirmation is an agent-to-agent handshake; `elicit` fails open on clients without elicitation. Make `elicit` fail closed, add an `ask` mode to the plugin hook, document `token` honestly as accident protection; `elicit` default on HTTP in the next major.
- Owner decision: OD-19.

#### N-106 — protected-table expansion and plan-token parity

- Priority P0, effort M; gates: O-4; breaking: yes (O-4).
- Sources: SE-I2 — findings RR-SE-02 ([05-application-security.md](role-review-2026-10/05-application-security.md)).
- **BREAKING (O-4).** Add code-executing and credential tables (`sys_script_include`, `sysauto_script`, `ecc_queue`, `sp_widget`, `sys_ui_action`, `oauth_credential`, …) to the protected list and require a `plan_token` for protected writes through the generic table tools, matching the dedicated tools. Names unverified until O-5.
- Owner decision: OD-20.

#### N-107 — a live smoke that really runs

- Priority P0, effort S; gates: O-2; breaking: no.
- Sources: QA-I1 — findings RR-QA-01 ([06-qa-test-architect.md](role-review-2026-10/06-qa-test-architect.md)).
- The weekly live smoke has been a green no-op for three weeks because its secrets were never set. Set the `SN_*` secrets (O-2) and make the job fail, not skip, when it is unconfigured.
- Owner decision: OD-25.

#### N-108 — managed policy file + host environment map

- Priority P0, effort L; gates: none; breaking: no.
- Sources: GV-I1 — findings RR-GV-01, RR-GV-12 ([09-enterprise-governance.md](role-review-2026-10/09-enterprise-governance.md)).
- Every control comes from an env file the restrained user can edit. An admin-managed policy file at an OS path (plus an instance-side property as kill switch) that sets floors the user cannot lower, and a host → environment map so `prod` is not a self-declared flag. Opt-in, not breaking.
- Owner decision: OD-26.

#### N-109 — audit-grade journal

- Priority P0, effort M; gates: none; breaking: no.
- Sources: GV-I2, AR-I3 — findings RR-GV-02, RR-GV-03, RR-AR-02, RR-SE-12 ([09-enterprise-governance.md](role-review-2026-10/09-enterprise-governance.md), [02-software-architect.md](role-review-2026-10/02-software-architect.md)).
- Fail closed when the journal cannot be written, a keyed (HMAC) hash chain, file mode 0600, audit events (policy changes, credential changes, denied applies), the human identity on stdio; a write lock, a lazy Markdown mirror, streaming reads and a retention setting.
- Owner decision: OD-27.

#### N-110 — private state dir, file modes, export retention

- Priority P0, effort M; gates: O-4; breaking: yes (O-4).
- Sources: GV-I3 — findings RR-GV-04 ([09-enterprise-governance.md](role-review-2026-10/09-enterprise-governance.md)).
- **BREAKING (O-4)** (`SN_DOCS_DIR` default). Exports full of instance data pile up in `./docs/instance`, world-readable, with no retention. Move to a per-user state dir (compatibility read for one minor), 0600/0700 modes, a 7-day default retention for exports.
- Owner decision: OD-27.

#### N-111 — budget policy v2

- Priority P1, effort S; gates: O-10; breaking: no.
- Sources: MC-I3 — findings RR-MC-03 ([03-mcp-agent-tooling.md](role-review-2026-10/03-mcp-agent-tooling.md)).
- Answers OD-15. Freeze `discovery`, move other profiles to token ceilings, allow growth only when the MC-I2 eval shows a gain, funded by N-112. Policy and `test/output-schema.test.js` change only.
- Owner decision: OD-23.

#### N-112 — conditional `instance` parameter

- Priority P1, effort S; gates: O-10; breaking: no.
- Sources: MC-I4 — findings RR-MC-04 ([03-mcp-agent-tooling.md](role-review-2026-10/03-mcp-agent-tooling.md)).
- Publish `instance` only when more than one profile is configured and drop it from local tools; accept-and-ignore keeps it non-breaking. ≈ −2.5 KB on `all`, −0.5 KB on `discovery`.
- Owner decision: OD-23.

#### N-113 — routing clauses and write-flow suffixes

- Priority P1, effort S; gates: O-10; breaking: no.
- Sources: MC-I5 — findings RR-MC-05, RR-MC-08 ([03-mcp-agent-tooling.md](role-review-2026-10/03-mcp-agent-tooling.md)).
- Disambiguating "use X, not Y" clauses for the overlap clusters and a plan → apply suffix on write tools; ≈ +1.8 KB on `all`, only if the N-102 eval shows a gain.

#### N-114 — `find_tools` synonym map and jargon eval cases

- Priority P1, effort S; gates: none; breaking: no.
- Sources: MC-I6 — findings RR-MC-06 ([03-mcp-agent-tooling.md](role-review-2026-10/03-mcp-agent-tooling.md)).
- Map user words ("ticket", "workflow", "script") to tool vocabulary; eval cases with ServiceNow jargon. ≈ +40 B.

#### N-115 — cache immutable server parts on the modern wire

- Priority P1, effort M; gates: none; breaking: no.
- Sources: AR-I1 — findings RR-AR-03, RR-AR-11 ([02-software-architect.md](role-review-2026-10/02-software-architect.md)).
- Each modern-wire request builds the whole server. Cache the immutable template (tool definitions, schemas, prompts) and bind runtime and auth per request.
- Owner decision: OD-30.

#### N-116 — size/complexity ratchet, refactor top five

- Priority P1, effort M; gates: none; breaking: no.
- Sources: AR-I2, QA-I10 — findings RR-AR-01, RR-QA-13 ([02-software-architect.md](role-review-2026-10/02-software-architect.md), [06-qa-test-architect.md](role-review-2026-10/06-qa-test-architect.md)).
- Extends N-88. `src/` grew 8× in two months; 49 functions over 120 lines, 30 with cyclomatic complexity ≥ 30. A ratchet (CC 25 / 120 lines), refactor the five worst; rename tracker-id test files by behaviour.
- Owner decision: OD-30.

#### N-117 — read-policy choke point in `snRequest`

- Priority P1, effort M; gates: none; breaking: no.
- Sources: AR-I4 — findings RR-AR-04 ([02-software-architect.md](role-review-2026-10/02-software-architect.md)).
- Read policy is checked per tool; move the check into `snRequest` and sweep the read tools so a new reader cannot bypass it.

#### N-118 — ARCHITECTURE.md 3.x rewrite and technical ADRs

- Priority P1, effort M; gates: none; breaking: no.
- Sources: AR-I5 — findings RR-AR-05, RR-AR-06 ([02-software-architect.md](role-review-2026-10/02-software-architect.md)).
- ARCHITECTURE.md still describes v2.0. Rewrite it for 3.x with a drift check; record the implicit technical decisions as ADRs 0013+ (runtime parts, modern wire, journal, policy evaluator…).

#### N-119 — count once per keyset fetch-all

- Priority P1, effort S; gates: none; breaking: no.
- Sources: SN-I3 — findings RR-SN-03 ([04-servicenow-platform-architect.md](role-review-2026-10/04-servicenow-platform-architect.md)).
- Every keyset page pays for a `COUNT(*)`; count once per fetch-all. Optional read-replica request category.

#### N-120 — update-set capture verification

- Priority P1, effort M; gates: O-5; breaking: no.
- Sources: SN-I4 — findings RR-SN-04 ([04-servicenow-platform-architect.md](role-review-2026-10/04-servicenow-platform-architect.md)).
- Verify after apply that the change was captured in the intended update set and warn when the service account is shared with humans. ≈ +40 B (output field).

#### N-121 — service-account recipe + `doctor` identity

- Priority P1, effort M; gates: O-5; breaking: no.
- Sources: SN-I5 — findings RR-SN-05 ([04-servicenow-platform-architect.md](role-review-2026-10/04-servicenow-platform-architect.md)).
- A minimal-role matrix per profile (`snc_read_only` for read-only), unverified roles marked; `doctor` checks the account's roles and flags admin on a read profile.
- Owner decision: OD-31.

#### N-122 — SECURITY.md and vendor-risk documentation truth

- Priority P1, effort S; gates: none; breaking: no.
- Sources: SE-I3, GV-I8 — findings RR-SE-03, RR-SE-12, RR-GV-08, RR-GV-09 ([05-application-security.md](role-review-2026-10/05-application-security.md), [09-enterprise-governance.md](role-review-2026-10/09-enterprise-governance.md)).
- Fix the stale SECURITY.md statements, add a drift check against the code; dependency drift, signed tags and a DCO for the vendor-risk view.
- Owner decision: OD-29.

#### N-123 — untrusted result boundary + injection eval

- Priority P1, effort M; gates: none; breaking: no.
- Sources: SE-I4 — findings RR-SE-04 ([05-application-security.md](role-review-2026-10/05-application-security.md)).
- Mark instance data in tool results as untrusted with a structural boundary; an eval of prompt-injection records (descriptions, work notes, script bodies). Output bytes only.

#### N-124 — password via elicitation; safe first run

- Priority P1, effort S–M; gates: O-4; breaking: yes (O-4).
- Sources: SE-I5, DX-I3 — findings RR-SE-05, RR-DX-02 ([05-application-security.md](role-review-2026-10/05-application-security.md), [08-dx-technical-writer.md](role-review-2026-10/08-dx-technical-writer.md)).
- Docs first (stop presenting the chat path for passwords). Then **BREAKING (O-4)**: `set_credentials` takes the password only through elicitation, the argument deprecated then removed. ≈ −40 B.
- Owner decision: OD-21.

#### N-125 — offline dictionary snapshot in the gate

- Priority P1, effort M; gates: none; breaking: no.
- Sources: QA-I2 — findings RR-QA-03, RR-QA-10 ([06-qa-test-architect.md](role-review-2026-10/06-qa-test-architect.md)).
- A committed `sys_dictionary` snapshot from the PDI so every table and field name read by code is checked offline in `npm run check`.

#### N-126 — recorded corpus per package, strict double

- Priority P1, effort L; gates: O-2; breaking: no.
- Sources: QA-I3 — findings RR-QA-02, RR-QA-10 ([06-qa-test-architect.md](role-review-2026-10/06-qa-test-architect.md)).
- The recorded corpus covers 6 of 100 tools. Record metadata reads per package (redacted, leak refusal) and make the strict double (unknown request = failure) the default.
- Owner decision: OD-25.

#### N-127 — owner-run live write end-to-end

- Priority P1, effort M; gates: O-2; breaking: no.
- Sources: QA-I4 — findings RR-QA-04 ([06-qa-test-architect.md](role-review-2026-10/06-qa-test-architect.md)).
- Every write path is proven only against hand-written mocks. A scripted plan → token → apply → revert run on the PDI in a scratch scope, owner-run before releases that touch write code.
- Owner decision: OD-25.

#### N-128 — pinned safety lists + safety-core mutation

- Priority P1, effort M; gates: none; breaking: no.
- Sources: QA-I5 — findings RR-QA-05 ([06-qa-test-architect.md](role-review-2026-10/06-qa-test-architect.md)).
- Snapshot tests for protected tables, destructive tools and token rules; a case-insensitivity property; StrykerJS on the safety core, manual-only.
- Owner decision: OD-24.

#### N-129 — packed-tarball and `.mcpb` install smoke

- Priority P1, effort S; gates: none; breaking: no.
- Sources: QA-I6 — findings RR-QA-07 ([06-qa-test-architect.md](role-review-2026-10/06-qa-test-architect.md)).
- Install the packed tarball and the `.mcpb` in CI and run `initialize` + `tools/list`; a post-publish `npx` check.

#### N-130 — container hardening

- Priority P1, effort S; gates: none; breaking: no.
- Sources: DO-I4 — findings RR-DO-06 ([07-devops-release.md](role-review-2026-10/07-devops-release.md)).
- Folds into N-86: base images pinned by digest, Dependabot for docker, a `/healthz` HEALTHCHECK.

#### N-131 — HTTP topology + enterprise deployment guide

- Priority P1, effort M; gates: none; breaking: no.
- Sources: DO-I5, GV-I7 — findings RR-DO-07, RR-GV-07, RR-GV-11, RR-GV-14 ([07-devops-release.md](role-review-2026-10/07-devops-release.md), [09-enterprise-governance.md](role-review-2026-10/09-enterprise-governance.md)).
- Supported topologies for HTTP mode (reverse proxy, TLS, auth, one instance per user); an enterprise guide with a data-flow diagram, a hardening baseline, role setup and an incident-response section.

#### N-132 — docs-site coverage gate and generated reference

- Priority P1, effort M; gates: none; breaking: no.
- Sources: DX-I1 — findings RR-DX-01, RR-DX-11 ([08-dx-technical-writer.md](role-review-2026-10/08-dx-technical-writer.md)).
- The site misses tools and CLI commands; generate the tool and CLI sections and fail the gate when one is missing. Coordinate with N-92.
- Owner decision: OD-32.

#### N-133 — user-docs jargon lint

- Priority P1, effort S; gates: none; breaking: no.
- Sources: DX-I4 — findings RR-DX-04 ([08-dx-technical-writer.md](role-review-2026-10/08-dx-technical-writer.md)).
- No roadmap ids (`N-`, `O-`, `F5-`…) in user docs; allowed in CHANGELOG, CONTRIBUTING, AGENTS and `project/`.
- Owner decision: OD-32.

#### N-134 — `regulated` preset and read-access audit

- Priority P1, effort M; gates: none; breaking: no.
- Sources: GV-I4 — findings RR-GV-05 ([09-enterprise-governance.md](role-review-2026-10/09-enterprise-governance.md)).
- A preset for regulated instances (no exports, no free-form reads of HR/PII tables, read events in the journal).
- Owner decision: OD-26.

#### N-135 — AI-origin stamp on the record

- Priority P1, effort M; gates: none; breaking: no.
- Sources: GV-I5 — findings RR-GV-02 ([09-enterprise-governance.md](role-review-2026-10/09-enterprise-governance.md)).
- Opt-in `SN_WRITE_ATTRIBUTION` that stamps a work note or field so the instance itself shows an AI-made change.

#### N-136 — change-request gate for production applies

- Priority P1, effort M; gates: O-10; breaking: no.
- Sources: GV-I6 — findings RR-GV-06 ([09-enterprise-governance.md](role-review-2026-10/09-enterprise-governance.md)).
- An optional `change_request` argument required on `prod` for applies and update-set commits, checked to be in an implement state. ≈ +120 B.

#### N-137 — regenerable demo from recorded mocks

- Priority P1, effort M; gates: none; breaking: no.
- Sources: PO-I5 — findings RR-PO-07 ([01-product-owner.md](role-review-2026-10/01-product-owner.md)).
- A scripted demo (GIF / asciinema) rebuilt from recorded mocks each release, so README and the Marketplace show current behaviour.

#### N-138 — adoption gate and resequencing

- Priority P1, effort S; gates: none; breaking: no.
- Sources: PO-I6 — findings RR-PO-02, RR-PO-08, RR-PO-09 ([01-product-owner.md](role-review-2026-10/01-product-owner.md)).
- A WIP limit on new surface; N-71, N-72 and N-67 wait for a demand signal until the 2026-11-19 checkpoint; distribution and adoption items move forward.
- Owner decision: OD-28.

#### N-139 — competitive landscape refresh

- Priority P1, effort S; gates: none; breaking: no.
- Sources: PO-I7 — findings RR-PO-10 ([01-product-owner.md](role-review-2026-10/01-product-owner.md)).
- Scope add to N-77: compare against NowAIKit and the other OSS / vendor servers on outcomes, not tool counts.

#### N-140 — per-release-family PDI verification pass

- Priority P2, effort M; gates: O-5; breaking: no.
- Sources: SN-I6 — findings RR-SN-06, RR-SN-11 ([04-servicenow-platform-architect.md](role-review-2026-10/04-servicenow-platform-architect.md)).
- Re-run the name verification per release family (Brazil first) and bundle the O-4 key-field fixes (OD-1) into the same minor.
- Owner decision: OD-25.

#### N-141 — query-shape register for high-volume tables

- Priority P2, effort M; gates: none; breaking: no.
- Sources: SN-I7 — findings RR-SN-07 ([04-servicenow-platform-architect.md](role-review-2026-10/04-servicenow-platform-architect.md)).
- A register of the queries each tool sends to `task`, `sys_audit`, `syslog`, `cmdb_ci` with the indexed fields they rely on; a test that new shapes are registered.

#### N-142 — Change API writes on the table-write policy axis

- Priority P2, effort S; gates: none; breaking: no.
- Sources: SN-I8 — findings RR-SN-08 ([04-servicenow-platform-architect.md](role-review-2026-10/04-servicenow-platform-architect.md)).
- Before N-71: Change API writes go through the same table policy evaluator as table writes.

#### N-143 — catalog variable validation

- Priority P2, effort M; gates: none; breaking: no.
- Sources: SN-I9 — findings RR-SN-09 ([04-servicenow-platform-architect.md](role-review-2026-10/04-servicenow-platform-architect.md)).
- Validate catalog variables (mandatory, type, choices) in the preview, `requested_for` support, a default limit. ≈ +60 B.

#### N-144 — loopback HTTP token by default and a rate limit

- Priority P2, effort M; gates: O-4; breaking: yes (O-4).
- Sources: SE-I7 — findings RR-SE-07 ([05-application-security.md](role-review-2026-10/05-application-security.md)).
- **BREAKING (O-4).** An auto-generated bearer token even on loopback (DNS-rebinding and local-process defence) and a per-session rate limit.
- Owner decision: OD-22.

#### N-145 — fd file reads, SSRF ranges, env scrubbing

- Priority P2, effort M; gates: none; breaking: no.
- Sources: SE-I8 — findings RR-SE-08, RR-SE-09, RR-SE-10 ([05-application-security.md](role-review-2026-10/05-application-security.md)).
- Open-then-check file reads (TOCTOU), the missing SSRF ranges, and secrets scrubbed from child-process environments.

#### N-146 — second-client compatibility

- Priority P2, effort M; gates: none; breaking: no.
- Sources: QA-I7 — findings RR-QA-06 ([06-qa-test-architect.md](role-review-2026-10/06-qa-test-architect.md)).
- Run the official MCP conformance suite and a Python-SDK client smoke in CI.

#### N-147 — flake hardening

- Priority P2, effort M; gates: none; breaking: no.
- Sources: QA-I8 — findings RR-QA-09, RR-QA-11, RR-QA-12 ([06-qa-test-architect.md](role-review-2026-10/06-qa-test-architect.md)).
- Event-based waits instead of timers, a weekly repeat run with a random seed, quiet logs in tests.

#### N-148 — Scorecard and zizmor

- Priority P2, effort S; gates: none; breaking: no.
- Sources: DO-I7 — findings RR-DO-11 ([07-devops-release.md](role-review-2026-10/07-devops-release.md)).
- OpenSSF Scorecard and zizmor workflow linting in CI.

#### N-149 — release-notes highlights and Open VSX truth

- Priority P2, effort S; gates: none; breaking: no.
- Sources: DO-I8 — findings RR-DO-08, RR-DO-13 ([07-devops-release.md](role-review-2026-10/07-devops-release.md)).
- Overlaps N-92 (highlights). The corpus says Open VSX is out, but the extension is live there; fix D-6 / OD-16 and the docs.

#### N-150 — "Since" stamping

- Priority P2, effort S; gates: none; breaking: no.
- Sources: DX-I5 — findings RR-DX-05 ([08-dx-technical-writer.md](role-review-2026-10/08-dx-technical-writer.md)).
- Stamp tools, env vars and CLI commands with the version that introduced them, generated from CHANGELOG.

#### N-151 — generated troubleshooting page

- Priority P2, effort S–M; gates: none; breaking: no.
- Sources: DX-I6 — findings RR-DX-06 ([08-dx-technical-writer.md](role-review-2026-10/08-dx-technical-writer.md)).
- A troubleshooting page generated from the error-code catalogue and its hints.

#### N-152 — "your first safe write" tutorial

- Priority P2, effort M; gates: none; breaking: no.
- Sources: DX-I7 — findings RR-DX-07, RR-DX-12 ([08-dx-technical-writer.md](role-review-2026-10/08-dx-technical-writer.md)).
- Extends N-94: a guided plan → apply → revert on a PDI.

#### N-153 — `all` preset and deprecated `admin` alias

- Priority P2, effort S; gates: none; breaking: no.
- Sources: DX-I8 — findings RR-DX-08 ([08-dx-technical-writer.md](role-review-2026-10/08-dx-technical-writer.md)).
- `all` becomes the canonical preset name; `admin` and the `reader` duplicate are deprecated (removal later is BREAKING).
- Owner decision: OD-32.

#### N-154 — extension `readOnly` setting

- Priority P2, effort S; gates: none; breaking: no.
- Sources: DX-I9 — findings RR-DX-09 ([08-dx-technical-writer.md](role-review-2026-10/08-dx-technical-writer.md)).
- A VS Code setting that starts the server in read-only mode; decide whether a new Sign In defaults to it.
- Owner decision: OD-32.

#### N-155 — trademark-safe display names

- Priority P2, effort S; gates: none; breaking: no.
- Sources: GV-I9 — findings RR-GV-10 ([09-enterprise-governance.md](role-review-2026-10/09-enterprise-governance.md)).
- Display names that do not read as an official ServiceNow product; the npm name stays.
- Owner decision: OD-29.

#### N-156 — split `api/` into REST and analysis domains

- Priority P2, effort L; gates: none; breaking: no.
- Sources: AR-I7 — findings RR-AR-08 ([02-software-architect.md](role-review-2026-10/02-software-architect.md)).
- The flat 117-file `api/` is mostly analysis code. A one-shot move with shims and ESLint zones, after N-116, with no feature work in parallel.
- Owner decision: OD-30.

#### N-157 — planning corpus compaction

- Priority P2, effort S; gates: none; breaking: no.
- Sources: AR-I8 — findings RR-AR-09 ([02-software-architect.md](role-review-2026-10/02-software-architect.md)).
- Archive done rows and closed analyses each release; a 400 KB live budget for `project/`.
- Owner decision: OD-30.

#### N-158 — outcome checks for safe-write / impact skills

- Priority P2, effort S; gates: none; breaking: no.
- Sources: MC-I8 — findings RR-MC-11 ([03-mcp-agent-tooling.md](role-review-2026-10/03-mcp-agent-tooling.md)).
- Evals that check the outcome of `sn-safe-write` and `sn-impact` (preview shown, apply only after consent).

#### N-159 — task-intent landing pages

- Priority P2, effort M; gates: none; breaking: no.
- Sources: PO-I8 — findings RR-PO-12 ([01-product-owner.md](role-review-2026-10/01-product-owner.md)).
- Site pages per job ("find where a script include is used", "diff dev vs prod") instead of per package.

#### N-160 — history window and import outcome summary

- Priority P3, effort S; gates: none; breaking: no.
- Sources: SN-I10 — findings RR-SN-10, RR-SN-12 ([04-servicenow-platform-architect.md](role-review-2026-10/04-servicenow-platform-architect.md)).
- A default time window and the history-set source for history reads; an outcome summary for imports. ≈ +40 B.

#### N-161 — export audit and pruning

- Priority P3, effort S; gates: none; breaking: no.
- Sources: AR-I9 — findings RR-AR-10 ([02-software-architect.md](role-review-2026-10/02-software-architect.md)).
- knip over `src/` and removal of unused exports.

#### N-162 — `query_table` advanced-flags object

- Priority P3, effort S; gates: O-4, O-10; breaking: yes (O-4).
- Sources: MC-I7 — findings RR-MC-07 ([03-mcp-agent-tooling.md](role-review-2026-10/03-mcp-agent-tooling.md)).
- **BREAKING (O-4).** Nest the rarely used flags in one `advanced` object in the next major. ≈ −400 B.
- Owner decision: OD-23.

## 7. Sequencing

The waves are ordered by deadline first, then by how much each item unblocks.

1. **Wave 0: dated, owner-heavy, minutes to hours (before 2026-11-18).**
   - N-96 trusted publishing and the rulesets (the `NPM_TOKEN` deadline).
   - N-95 release 3.x and fix the publish order.
   - N-107 set the O-2 secrets.
   - N-97 Discussions and design partners.
   - OD-16's Smithery removal (dated 2026-10-31).
2. **Wave 1: P0 code that unblocks measurement or removes risk.**
   - N-100 SDK 2.4.
   - N-103 and N-104, the instance-load fixes (small, non-breaking).
   - N-102 the model eval, which gates every later byte decision.
   - N-112 then N-101: free bytes first, then spend them on the dispatcher.
   - N-99 the truth guard and N-98 positioning, before any relaunch post.
3. **Wave 2: P0 safety and governance, owner-decided and partly BREAKING.**
   - N-105 and N-106, the confirmation and protected tables (OD-19, OD-20).
   - N-109 the audit-grade journal.
   - N-108 the managed policy file.
   - N-110 the private state directory.

   Bundle the BREAKING parts into one minor with N-124 (password) and OD-1's key-field renames,
   so users absorb the break once.

4. **Wave 3: P1 by role cluster, parallelisable.**
   - Agent surface: N-111, N-113, N-114.
   - Architecture: N-115 … N-118.
   - Platform: N-119 … N-121.
   - Security and docs truth: N-122, N-123.
   - Test tiers: N-125 … N-129.
   - Operations: N-130, N-131.
   - Docs: N-132, N-133.
   - Governance: N-134 … N-136.
   - Product: N-137 … N-139.

   N-138, the adoption gate, holds N-71, N-72 and N-67 until the 2026-11-19 checkpoint.

5. **Wave 4: P2 and P3 as capacity allows.** N-156 (the `api/` split) runs alone, after N-116.

This order interacts with the 2026-10-04 owner rule that N-45 … N-56 are P0 and run before every
other N item. All of N-45 … N-56 that remain open stay first. The role-review P0 items come
next, ahead of the open 3.5 items N-66 … N-94, except where an owner decision (OD-28, the
adoption gate) says otherwise.

## 8. Owner decisions

The 44 owner questions from the nine reports are grouped into 16 decisions, OD-17 … OD-32, in
[TODO.md](TODO.md). Each decision has its options, a recommendation and links to the evidence.

| Decision | Topic                                                                                                    | Items                      |
| -------- | -------------------------------------------------------------------------------------------------------- | -------------------------- |
| OD-17    | Release 3.x now, dist-tags, shrinkwrap, patch SLA                                                        | N-95                       |
| OD-18    | Trusted publishing, rulesets, release environment, backup publisher                                      | N-96                       |
| OD-19    | Human-bound confirmation (BREAKING)                                                                      | N-105                      |
| OD-20    | Protected-table reach and plan-token parity (BREAKING)                                                   | N-106                      |
| OD-21    | Password via elicitation only (BREAKING)                                                                 | N-124                      |
| OD-22    | Loopback HTTP token (BREAKING)                                                                           | N-144                      |
| OD-23    | Budget policy v2: dispatcher on `discovery`, conditional `instance`, `query_table` flags (answers OD-15) | N-101, N-111, N-112, N-162 |
| OD-24    | Model-eval route and spend; mutation testing                                                             | N-102, N-128               |
| OD-25    | Live testing: O-2 secrets, live write e2e, recording scope, Brazil PDI                                   | N-107, N-126, N-127, N-140 |
| OD-26    | Managed policy layer and the `regulated` preset                                                          | N-108, N-134               |
| OD-27    | Data location, export and journal retention (BREAKING part)                                              | N-109, N-110               |
| OD-28    | Product: tagline, Discussions and design partners, tool-count headline, adoption gate, sustainability    | N-97, N-98, N-138          |
| OD-29    | Licence posture, DCO, trademark display name                                                             | N-122, N-155               |
| OD-30    | Architecture: modern-wire reuse, complexity thresholds, `api/` split, corpus archive                     | N-115, N-116, N-156, N-157 |
| OD-31    | ServiceNow defaults: timeout vs quota, role matrix, data-health threshold                                | N-103, N-104, N-121        |
| OD-32    | Docs: canonical home, jargon policy, preset naming, extension read-only default                          | N-132, N-133, N-153, N-154 |

## 9. Metrics to track after this review

Each report ends with the metrics its role would track. The shortlist that covers all nine:

- **Adoption:** npm downloads, stars, Marketplace installs and issues opened by humans, recorded
  per release (N-97). Target: the first human issue and 3 design partners by 2026-11-19.
- **Agent quality:** tool-selection accuracy per profile from the model eval (N-102); bytes per
  correct selection.
- **Live truth:** live-smoke pass rate on real runs (N-107); recorded-corpus coverage of tools
  (6/100 today, N-126); unverified names (O-5).
- **Safety:** destructive applies completed without a human in the loop (target 0 under `elicit`,
  N-105); protected-table coverage of code-executing tables (N-106).
- **Supply chain:** long-lived publish secrets (target 0, N-96); days from a security advisory to
  a release (SLA 7, N-95).
- **Code health:** functions over the ratchet thresholds (N-116); ARCHITECTURE.md drift (N-118).
- **Docs truth:** stale public numbers found by the guard (target 0, N-99); site coverage of
  tools and CLI commands (N-132).

## 10. Reports

1. [Product Owner](role-review-2026-10/01-product-owner.md) — RR-PO-01 … RR-PO-12
2. [Software Architect](role-review-2026-10/02-software-architect.md) — RR-AR-01 … RR-AR-11
3. [MCP / agent tooling](role-review-2026-10/03-mcp-agent-tooling.md) — RR-MC-01 … RR-MC-11
4. [ServiceNow platform](role-review-2026-10/04-servicenow-platform-architect.md) — RR-SN-01 … RR-SN-12
5. [Application security](role-review-2026-10/05-application-security.md) — RR-SE-01 … RR-SE-12
6. [QA / test architecture](role-review-2026-10/06-qa-test-architect.md) — RR-QA-01 … RR-QA-13
7. [DevOps / release](role-review-2026-10/07-devops-release.md) — RR-DO-01 … RR-DO-14
8. [DX / technical writing](role-review-2026-10/08-dx-technical-writer.md) — RR-DX-01 … RR-DX-13
9. [Enterprise governance](role-review-2026-10/09-enterprise-governance.md) — RR-GV-01 … RR-GV-14
