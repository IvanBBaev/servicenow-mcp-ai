# servicenow-mcp-ai — v2.0 Execution Roadmap

Date: 2026-06-21 · The operational plan for the next major version. Derived from
[BUSINESS-ANALYSIS-V2.md](BUSINESS-ANALYSIS-V2.md) (the "why" and the sequencing) and
[ROADMAP.md](ROADMAP.md) (the full DF-/DX- task specs). This file is the **execution
tracker**: what ships in v2.0, in what order, and the definition of done for each.

## Milestone definition

> **v1.x = breadth** (can touch all of ServiceNow). **v2.0 = trust + depth + reach**
> (safe to let it write, understands the instance, reachable by teams/agents).

The API surface is complete; v2.0 is the release that makes the breadth **safe** and
**discoverable**. Business framing and market rationale: BUSINESS-ANALYSIS-V2 §2, §11.

## Sequencing (must-haves first)

The business analysis cut line for a tight single-maintainer 2.0 is **DF-0, DF-2, DF-1,
DX-1, DX-3**; DF-4/DF-5/DF-6 follow in 2.1 if capacity demands triage.

| #   | Item     | Pillar      | Why this order                                                       | Status                |
| --- | -------- | ----------- | -------------------------------------------------------------------- | --------------------- |
| 1   | **DF-0** | Depth       | Precondition for DF-1/DF-4; closes the permission paradox (R1/R2/B4) | 🟢 preflight shipped  |
| 2   | **DF-2** | Trust       | The root enabler — makes raw-REST writes safe (dry-run + audit)      | 🟡 Table CRUD shipped |
| 3   | **DF-1** | Depth       | Headline "knows your instance"; extends Phase 8 codecheck            | ⬜                    |
| 4   | **DX-1** | Discovery   | MCP Registry + Claude Code plugin — biggest adoption lever           | ⬜                    |
| 5   | **DX-3** | Discovery   | One sharp "find-usages / what-runs / dev-vs-prod" demo               | ⬜                    |
| —   | DF-4/5/6 | Depth/Reach | where-used graph · redaction · HTTP transport — 2.1 triage           | ⬜ deferred           |

## Definition of done (per item)

Each item ships green (`npm run check`), with tests in the same change, docs/manifest
regenerated, and the README/env reference kept in sync (the project's standing guardrail).

### DF-0 — Capability preflight + recommended read-role profile (preflight shipped)

- [x] `api/capabilities.ts` — probe which admin-restricted `sys_*` artefact tables the
      connected user can actually read; map to achievable higher-level capabilities
      (schema reads, script intelligence, ACL audit).
- [x] `servicenow_check_capabilities` admin tool (always-on, read-only).
- [x] `servicenow://capabilities` MCP resource.
- [x] Tests (probe readable / 403 / transport) + regenerated manifest + README;
      `npm run check` green (241 tests, coverage 95/82/99).
- [x] `table_logic` degrades a 401/403 per artefact type to an `unreadable` flag
      instead of a hard failure or a silently empty overview.
- [ ] _2.1 / DF-1:_ extend the same degrade to `code_health` when the security scan lands.

### DF-2 — Plan-and-apply + local audit journal (Table CRUD shipped)

- [x] `SN_WRITE_MODE=plan|apply` (default **plan**) + per-tool `apply:true`; plan returns
      a non-mutating before/after preview. Shipped for **Table CRUD** (create/update/
      delete) — `core/settings.ts`, `mcp/write-mode.ts`, `tools/table.ts`.
- [x] Append-only audit journal (`core/write-journal.ts`) →
      `<SN_DOCS_DIR>/<profile>/write-journal.{jsonl,md}` on every applied write.
- [x] Tests (plan previews, no mutation, apply executes + journals); env docs
      (README, .env.example, site) + `npm run check` green (246 tests).
- [ ] _Remaining:_ extend plan-and-apply to the other write tools (batch, catalog
      order, change, attachment upload/delete, importset, email, cmdb).

### DF-1 — Instance linter + security scan

- [ ] Fold a security dimension into `code_health`: world-/role-open ACLs, tables with no
      ACL, public Scripted REST/pages, admin-overlap roles, `eval`/`gs.getUser()` in ACL
      scripts. Gate the readable scope behind DF-0.

### DX-1 / DX-3 — Discovery

- [ ] MCP Registry listing (`server.json` is ready) + a Claude Code plugin/skills bundle.
- [ ] A README/site hero demo + GIF: find-usages, what-runs-on-save, dev-vs-prod diff.

## Guardrails (unchanged)

Always-green gate, one commit per task, new tools added **only** through the declarative
manifest, every behavioural change ships with a test in the same commit.
