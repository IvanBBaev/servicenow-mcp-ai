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

The business-analysis cut line for a tight single-maintainer 2.0 was **DF-0, DF-2,
DF-1, DX-1, DX-3**; in the event **DF-3/DF-4/DF-5/DF-6 also landed in 2.0** (drift
gate, where-used, redaction, HTTP transport). **2.0.0 is published** — npm
`servicenow-mcp-ai@2.0.0` (provenance) and the MCP Registry listing; only the DX-3
**screen-capture GIF** remains.

| #   | Item       | Pillar      | Why this order                                                       | Status                        |
| --- | ---------- | ----------- | -------------------------------------------------------------------- | ----------------------------- |
| 1   | **DF-0**   | Depth       | Precondition for DF-1/DF-4; closes the permission paradox (R1/R2/B4) | 🟢 preflight shipped          |
| 2   | **DF-2**   | Trust       | The root enabler — makes raw-REST writes safe (dry-run + audit)      | 🟢 all 13 writes shipped      |
| 3   | **DF-1**   | Depth       | Headline "knows your instance"; extends Phase 8 codecheck            | 🟢 ACL scan shipped           |
| 4   | **DX-1**   | Discovery   | MCP Registry + Claude Code plugin — biggest adoption lever           | 🟢 published + registry       |
| 5   | **DX-3**   | Discovery   | One sharp "find-usages / what-runs / dev-vs-prod" demo               | 🟡 demo written · GIF pending |
| —   | DF-3/4/5/6 | Depth/Reach | drift gate · where-used graph · redaction · HTTP transport           | 🟢 shipped in 2.0             |

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
- [x] `code_health` degrades the ACL read to `available:false` when `sys_security_acl` is
      unreadable (DF-1 security scan landed).

### DF-2 — Plan-and-apply + local audit journal (all writes shipped)

- [x] `SN_WRITE_MODE=plan|apply` (default **plan**) + per-tool `apply:true`; plan returns
      a non-mutating before/after preview. Shipped for **Table CRUD** (create/update/
      delete) — `core/settings.ts`, `mcp/write-mode.ts`, `tools/table.ts`.
- [x] Append-only audit journal (`core/write-journal.ts`) →
      `<SN_DOCS_DIR>/<profile>/write-journal.{jsonl,md}` on every applied write.
- [x] Tests (plan previews, no mutation, apply executes + journals); env docs
      (README, .env.example, site) + `npm run check` green (250 tests).
- [x] Extended to record-style writes: change (create/update), cmdb (create/update CI),
      importset (insert) — `tools/change.ts`, `tools/cmdb.ts`, `tools/importset.ts`.
- [x] Special writes: email send, catalog order, attachment upload/delete —
      `tools/email.ts`, `tools/catalog.ts`, `tools/attachment.ts` (base64/body never
      echoed in the preview or journal).
- [x] batch (write batches) and the ATF run tools — **all 13 instance-mutating write
      tools** now plan-and-apply.

### DF-1 — Instance linter + security scan (ACL scan shipped)

- [x] `securityScan()` folded into `code_health`: ACL evaluation scripts flagged for
      `eval`/side-effects/`gs.getUser`, plus roles-only ACLs (no condition + no script).
      The `sys_security_acl` read is gated behind DF-0 — a 401/403 degrades to
      `available:false` with the role needed, never a silently empty "all clear".
- [ ] _2.1 ok:_ extend to public Scripted REST/pages, tables with no ACL, admin-overlap roles.

### DF-3 / DF-4 / DF-5 / DF-6 — extras that also landed in 2.0 (shipped)

Originally triaged as "2.1 if capacity demands", these four shipped inside 2.0 — each
green at the 303/303-test gate, with tests in the same change and the README/env reference kept in sync.

- [x] **DF-3 — cross-instance drift gate.** `servicenow-mcp-ai drift <profileA> <profileB>`
      (`src/index.ts` dispatch → `api/compare.ts` `compareInstances`/`driftCount`) prints the
      Markdown drift report on stdout and exits `1` on drift / `0` clean / `2` on error, so a CI
      pipeline can block a deploy on configuration drift. Promotes `servicenow_compare_instances`
      to a release artifact.
- [x] **DF-4 — where-used / impact graph.** `servicenow_where_used` (`tools/scripts.ts` →
      `api/whereused.ts`): textual references across every script source, plus — for a table — its
      business rules, client scripts, UI policies/actions and ACLs. Read-only, with an optional
      Mermaid reference graph; the IDE-grade "find usages" the platform lacks.
- [x] **DF-5 — client-side field redaction.** `SN_REDACT_FIELDS` masks named fields and
      `SN_REDACT_PII` masks email/phone/national-id patterns in `mcp/redact.ts`, applied **before**
      records are serialised in `mcp/result.ts`; off by default, the redaction count is reported.
      Reused by the CSV export.
- [x] **DF-6 — HTTP transport.** `SN_TRANSPORT=http` (`mcp/transport.ts`,
      `StreamableHTTPServerTransport`, `SN_PORT`) serves the server over Streamable HTTP for remote
      and ServiceNow-MCP-Client consumption; loopback-bound by default (`SN_HTTP_HOST`) with an
      optional constant-time `SN_HTTP_TOKEN` bearer guard. Triggered the A2-4 `mcp/transport.ts`
      extraction.

### DX-1 / DX-3 — Discovery (DX-1 shipped; DX-3 demo GIF pending)

- [x] Claude Code plugin / skills bundle (`.claude-plugin/`) **and** a VS Code extension
      (`extension/`) that auto-registers the server with Copilot Chat. **Published:** npm
      `servicenow-mcp-ai@2.0.0` (`--provenance`) and the **MCP Registry** listing
      (`io.github.LeassTaTT/servicenow-mcp-ai → 2.0.0`) — DX-1's discovery half.
- [x] DX-3 hero demo **written** — a "Quick demo" section in both the README
      ([README.md](README.md#quick-demo)) and the docs site (`docs/index.html` →
      `#quick-demo`): find-usages (`servicenow_where_used`), what-runs-on-save
      (`servicenow_trace_table_event`) and dev-vs-prod (`servicenow-mcp-ai drift`).
- [ ] Record the matching **screen-capture GIF** (a manual capture) and drop it into the
      hero — the only remaining DX-3 piece.

## Guardrails (unchanged)

Always-green gate, one commit per task, new tools added **only** through the declarative
manifest, every behavioural change ships with a test in the same commit.
