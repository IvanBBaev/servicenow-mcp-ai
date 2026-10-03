# servicenow-mcp-ai — Gap Analysis & Implementation Plan (2026-10)

Date: 2026-10-03 · Status: **proposed — docs only, no code.** Baseline: `main` at `8fa2631` plus the
uncommitted batches 13–18 (97 tools in 26 packages, 1648 tests, `tools/list` `all` 150,916 B vs the
151,000 B budget in `test/output-schema.test.js`).

This pass asks a different question from the 2026-09 reviews: v3.0 is close to exhausted (the open
rows of [ROADMAP-V3.md](ROADMAP-V3.md) are owner-gated: O-1, O-2, O-5, the H-11 policy file, the
pack ceiling), so **what does the server still not do that a ServiceNow developer or admin asks
for every week?** Findings carry ids `NX-01` … `NX-12`. The implementation items they produce are
the **N pillar** (`N-0` … `N-10`), tracked as rows 84–94 in [ROADMAP-V3.md](ROADMAP-V3.md). They
are post-3.0 work and ship on 3.x minors, like the P epic.

Evidence marker: **verified** = re-checked in code during this pass (a grep over `src/`).
Table and field names that no code reads yet are **unverified** until O-5 (PDI). Confirm them in
the first hour of the item, before designing.

## 1. Method

1. Map the shipped surface: the tool names in `src/mcp/naming.ts` and `src/tools/*.ts`, the
   packages in `src/mcp/registry.ts`, and the artefact registry (`src/core/artifacts/registry.ts`,
   121 types).
2. Grep `src/` for the platform tables and REST namespaces behind the common admin and developer
   jobs: upgrades, access, scans, CI/CD, approvals, SLAs, integrations, performance, MID,
   translations, reporting. Zero hits means no coverage.
3. Grep for the MCP capabilities the SDK (1.31) offers: elicitation, sampling, resource
   subscriptions, tasks.
4. Filter against the standing non-goals in ROADMAP-V3 "Explicitly NOT in 3.0": no background
   scripts, no module-breadth race (HR / ITOM / SecOps), no weakening of a rail.

## 2. Findings

| Id    | Finding                                                                                                                                                                                                                                                                                                         | Evidence                                                                                                       | Severity | → Item |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| NX-01 | **No upgrade-readiness view.** Skipped records after a family upgrade or patch are a major cost on customised instances. The server already holds every building block (update-set summaries, `unified-diff.ts`, the registry) but never reads the upgrade history.                                             | **verified**: 0 hits for `sys_upgrade_history`, `sys_update_version` in `src/`                                 | High     | N-1    |
| NX-02 | **No access explanation.** "Why can't user X see record or field Y?" is the most common ACL question. `security.ts` reads every ACL and its roles, but only to scan for risky scripts. No tool evaluates the ACL chain for one user, operation and target.                                                      | **verified**: `src/api/security.ts:296-321` reads `sys_security_acl`; no user-scoped evaluation exists         | High     | N-2    |
| NX-03 | **Instance Scan is invisible.** ServiceNow's own health checks (`scan_check`, findings) are not read, so `check_code_health` cannot be compared with the platform's verdict.                                                                                                                                    | **verified**: 0 hits for `sn_instance_scan`, `scan_check`, `scan_finding`                                      | Medium   | N-3    |
| NX-04 | **The CI/CD API is used for ATF only.** Update-set preview / commit, app-repo install / publish and plugin activation (`/api/sn_cicd/...`) are the official promotion path. The server can describe an update set (S-6) but cannot preview it for conflicts.                                                    | **verified**: `sn_cicd` appears only in `src/api/atf.ts` and the batch router (`src/api/batch.ts:104`)         | Medium   | N-4    |
| NX-05 | **No approvals, and SLAs only as definitions.** `sysapproval_approver` is never read. `task_sla` appears only in the Fluent action catalogue, and `contract_sla` only as a registry descriptor. "What is this change waiting for?" and "Is this incident about to breach?" need two hand-written queries today. | **verified**: 0 hits for `sysapproval`; `task_sla` only in `src/api/fluent-sdk-actions.ts`                     | Medium   | N-5    |
| NX-06 | **`ops` stops at the instance boundary.** Its kinds are `syslog`, `jobs`, `email_queue` and `semaphores`. Outbound integration failures, slow transactions and MID-server health are not covered, though the `why-is-it-slow` prompt needs all three.                                                           | **verified**: `OPS_KINDS` in `src/api/ops.ts:21-27`; 0 hits for `syslog_transaction`, `ecc_agent`, `ecc_queue` | Medium   | N-6    |
| NX-07 | **No translation coverage.** Missing translations for an app's labels, choices and messages are a common defect in global rollouts. Nothing reads `sys_translated`, `sys_translated_text` or `sys_ui_message`.                                                                                                  | **verified**: 0 hits for `sys_translated`                                                                      | Low      | N-7    |
| NX-08 | **Reports and Performance Analytics are not artefacts.** `sys_report` appears only in the Fluent action catalogue. Reports, PA indicators and dashboards are missing from `list_artifacts`, `where_used` and `document_app`, though they hold real dependencies such as tables, fields and scripts.             | **verified**: `sys_report` only in `src/api/fluent-sdk-actions.ts`; 0 hits for `pa_indicator`                  | Low      | N-8    |
| NX-09 | **Sampling is unused.** Large results (an `ops` overview, a `compare_instances` diff, an upgrade review) go to the client raw. MCP sampling would let the server ask the client's own model for a bounded summary.                                                                                              | **verified**: 0 hits for `createMessage`; elicitation is used (`src/mcp/confirm.ts:123`, `src/tools/admin.ts`) | Low      | N-9    |
| NX-10 | **Subscriptions cover `servicenow://status` only.** The server declares `resources.subscribe`, but a client cannot watch a record (a change in flight, an import, a running ATF suite).                                                                                                                         | **verified**: `src/mcp/packages.ts:363-400`; `src/mcp/registry.ts:459`                                         | Low      | N-10   |
| NX-11 | **The tool budget is exhausted.** `tools/list` `all` is 150,916 B vs 151,000 B, so any new tool or parameter fails `test/output-schema.test.js`. The budget comment ends with "owner to restate (M-6 budget)".                                                                                                  | **verified**: `test/output-schema.test.js:79-88`                                                               | High     | N-0    |
| NX-12 | **ITOM Event Management** (`em_event`, `em_alert`) and the HR / CSM / SecOps modules have no coverage. Both fall under the standing "module-breadth" non-goal. The generic Table tools reach them already.                                                                                                      | **verified**: 0 hits for `em_event`, `sn_hr`, `sn_customerservice`, `sn_si`                                    | —        | none   |

NX-12 is recorded so it is not re-raised. It stays out unless the owner lifts the non-goal.
MID-server and ECC health are platform plumbing rather than an ITOM module, so they are in N-6.

## 3. Design principles for the N pillar

- **Budget first (N-0).** No N item touches the `core` package. Each one lands in an **opt-in
  package** (M-5 dynamic packages) or as a new `kind` / enum value on an existing tool. Every
  item states its measured `tools/list` delta in its PR.
- **Read before write.** N-1, N-2, N-3 (read half), N-5, N-6, N-7 and N-8 are read-only and
  carry `readOnlyHint`. The only writes are in N-4 (and N-3's optional run). They go through
  plan → token → apply, the journal and the policy evaluator (H-11). Nothing bypasses a rail.
- **Degrade, never lie.** Each section reads its own table and falls back to
  `available:false` with a reason (ACL, policy, plugin, licence), the same as `ops`
  (`src/api/ops.ts` header). An unreadable source never shows as "all clear".
- **No code execution on the instance.** Static evaluation only. Where the platform would run a
  script (a scripted ACL, a script check), the result is `undetermined` with the script shown.
  The background-script non-goal stands.
- **Unverified until O-5.** Every new table and field gets the existing `O-5: verify on a live
instance` comment, and its fixture is queued for the O-2 corpus.

## 4. Implementation plan

Effort key as in ROADMAP-V3: **S** ≤ 1 day · **M** 2–5 days · **L** 1–2 weeks.

### N-0 — Tool-budget headroom (S + owner, O-10)

- **Why:** NX-11. Every later item depends on it.
- **Scope:** (a) Owner restates the `all` budget for the post-3.0 surface, or (b) reclaim
  bytes first. Candidates: shared description fragments for the injected `instance`
  parameter, compacted enum descriptions, and dropping `class_name` deprecated aliases from
  `all` once B13 ships.
- **Done when:** `TOOLS_LIST_BUDGET_ALL` has ≥ 15 KB of headroom with a dated comment, and the
  `core` budget is unchanged.
- **Tests:** `test/output-schema.test.js` (existing).

### N-1 — Upgrade readiness (L) — flagship

- **Why:** NX-01.
- **Surface:** opt-in package `upgrade`, one tool `servicenow_review_upgrade`
  (`readOnlyHint`) with `kind: "history" | "skipped" | "record"`.
  - `history`: upgrades and patches from `sys_upgrade_history` (from / to version, dates,
    state).
  - `skipped`: the skipped and unresolved rows of `sys_upgrade_history_log` for one upgrade
    (disposition, resolution status), grouped by application and artefact type through the
    registry (`src/core/artifacts/registry.ts`), with counts per group.
  - `record`: for one skipped row, the base-system version and the customer version from
    `sys_update_version`, a unified diff (`src/api/unified-diff.ts`), and a classification:
    `only_customer_changes` / `only_base_changes` / `both_changed`.
- **Also:** a `document_instance` kind `upgrade` that writes the `skipped` grouping to the docs
  store (S-14 frontmatter), and an `sn-upgrade` plugin skill (D-8 pattern).
- **Unverified (O-5):** `sys_upgrade_history_log` disposition and resolution values; how the base
  version is identified in `sys_update_version` (source / state fields).
- **Done when:** a skipped row on the PDI produces a correct diff and classification. An
  instance without upgrade-history read access degrades to `available:false`.
- **Tests:** `test/upgrade-review.test.js` with fetch-double fixtures (history, skipped
  grouping, the three classifications, payload XML with CDATA scripts, ACL degrade); a
  docs-store golden for the `upgrade` kind.

### N-2 — Access explainer (L) — flagship, owner gate O-13

- **Why:** NX-02.
- **Surface:** tool `servicenow_explain_access` in the existing opt-in `instance` package
  (`readOnlyHint`). Inputs: `user` (user_name or sys_id), `table`, optional `sys_id`, optional
  `field`, `operation` (`read` / `write` / `create` / `delete`).
- **Algorithm (static, follows the platform order):**
  1. Resolve the user's effective roles from `sys_user_has_role` (inherited rows included).
     Short-circuit on `admin` and note the `security_admin` elevation.
  2. Collect candidate ACLs in evaluation order: `table.field`, `table.*` and `*.field`, then
     `*`, walking the table chain with `getTableChain` (`src/api/meta.ts`). Reuse the ACL reader
     and role join from `src/api/security.ts`.
  3. For each ACL, check the role part statically. Check the condition part by running the
     encoded condition as a query `sys_id=<id>^<condition>` against the record, flagged as
     evaluated **as the connected user**. A script part is `undetermined`, with the script
     shown and S-12 lint hints.
  4. Return `granted` / `denied` / `undetermined`, the deciding ACL, and the full ordered chain.
     Optionally include a Mermaid decision diagram (`src/api/mermaid.ts`).
- **Privacy:** reading another user's roles is an admin action. The tool requires the user to
  be passed explicitly, never enumerates users, and redacts everything except role names
  (H-5 redaction). O-13 decides whether this belongs in the default `instance` package or a
  separate opt-in.
- **Unverified (O-5):** inherited-role rows, high-security plugin defaults, field-ACL fallback to
  table ACLs.
- **Done when:** on the PDI, a role-only ACL, a condition ACL and a scripted ACL return
  `granted`, `denied` and `undetermined` with the correct deciding ACL.
- **Tests:** `test/explain-access.test.js` (ordering, inheritance, admin short-circuit, condition
  query, script → undetermined, unreadable ACL table) plus fast-check properties over the
  ordering function.

### N-3 — Instance Scan (M)

- **Why:** NX-03.
- **Surface:** a `kind: "instance_scan"` on `servicenow_check_code_health`. It returns the latest
  scan results and findings (check, priority, target record) beside the server's own
  findings, with a de-duplicated "both agree" set. An optional `run` through the CI/CD instance
  scan endpoints sits behind the same rails as ATF (non-production only, `sn_cicd` capability
  probe, M-9 task for polling).
- **Unverified (O-5):** finding and result table names, scan endpoints and their payloads.
- **Done when:** findings from a PDI scan show up keyed to registry artefact types. `run` refuses
  on a production-marked profile (H-11 prod marker).
- **Tests:** `test/instance-scan.test.js` (read, merge with code_health, missing plugin,
  production refusal, progress polling via the fake clock).

### N-4 — CI/CD promotion lane (L) — owner gate O-11

- **Why:** NX-04.
- **Surface:** opt-in package `cicd`:
  - `servicenow_preview_update_set` (`/api/sn_cicd/update_set/preview/{id}`): returns preview
    problems joined to registry artefacts. It does not change records, but the platform still
    executes the preview, so this is a write-class action under plan mode.
  - `servicenow_commit_update_set`, `servicenow_install_app`, `servicenow_publish_app`,
    `servicenow_activate_plugin`: destructive, plan → plan_token → apply (H-3), journalled
    with `revertable:false` and a reason, refused on a production-marked profile unless
    the policy allows it explicitly.
  - Progress through one shared `cicdProgress()` (factored from `src/api/atf.ts`) and M-9 tasks.
- **Owner decision O-11:** whether the lane exists at all, which endpoints, and the production
  rule. The lane is not in the non-goals, but it is the first server-side change outside the
  Table API.
- **Done when:** preview → commit round-trips on the PDI. Every apply has a journal line, and
  a policy-denied commit returns the H-11 error code.
- **Tests:** `test/cicd.test.js` (plan / apply / token mismatch / policy deny / prod refusal /
  progress failure / cancellation).

### N-5 — Task context: approvals and SLAs (M)

- **Why:** NX-05.
- **Surface:** tool `servicenow_get_task_context` in the opt-in `history` package
  (`readOnlyHint`), for any `task` descendant: approvals (`sysapproval_approver`: approver, state,
  dates, the approval rule), task SLAs (`task_sla`: definition, stage, elapsed %, planned end
  time, breach flag) and the current assignment. Optionally `pending_for: <user>` lists the
  approvals waiting on one approver (capped, paged).
- **Done when:** a change with two approval groups and an incident with a running and a breached
  SLA render correctly.
- **Tests:** `test/task-context.test.js`.

### N-6 — `ops` v2: integrations, transactions, MID (M)

- **Why:** NX-06. No new tool; three new `OPS_KINDS`.
  - `integrations`: failed and slow outbound calls from `sys_outbound_http_log` (status ≥ 400 or
    above a time threshold), grouped by host and REST message, with redacted URLs (H-6 rules).
  - `transactions`: slow transactions from `syslog_transaction` (response time, URL with the
    query string stripped, user count), grouped by URL.
  - `mid`: `ecc_agent` status, version and last refresh, plus the `ecc_queue` backlog
    (`state=ready`, age) and recent `error` rows, grouped by agent.
- Each kind joins `overview`. The `why-is-it-slow` prompt (`src/mcp/prompts.ts:236`) uses
  `transactions` and `integrations`.
- **Unverified (O-5):** outbound log fields and retention (the log may be off by default),
  `syslog_transaction` field names.
- **Done when:** each kind degrades on its own, and `overview` stays within its time and row caps.
- **Tests:** extend `test/ops.test.js`; budget delta ≤ 1 KB.

### N-7 — Translation coverage (M) — stretch

- **Why:** NX-07.
- **Surface:** `document_app` kind `i18n` with a `language` input. Lists the app's field labels
  (`sys_documentation`), choices (`sys_choice`), UI messages (`sys_ui_message`) and translated
  fields (`sys_translated`, `sys_translated_text`) that have no row for the language, with counts
  per artefact. No new tool.
- **Done when:** a scoped app with a partial `de` translation lists exactly the missing keys.
- **Tests:** `test/document-i18n.test.js` + docs-store golden.

### N-8 — Reports and PA as artefacts (S–M)

- **Why:** NX-08.
- **Surface:** registry descriptors only (the P-1 pattern). `sys_report` (table, filter,
  fields), `pa_indicators` / `pa_cubes` (indicator source table, conditions, scripts)
  and `pa_dashboards`, with `refFields` so `where_used`, `artifact_dependencies`,
  `list_artifacts` and `document_app` cover them without new tools. PA families carry
  `licensed?` and degrade to `available:false` (O-9).
- **Done when:** `where_used` of a field finds the report that filters on it.
- **Tests:** `test/artifact-registry.test.js` (descriptor shape), a where-used fixture.

### N-9 — Sampling summaries (M) — owner gate O-12

- **Why:** NX-09.
- **Surface:** `summarise(result, intent)` in `src/mcp/` calls `server.server.createMessage`
  only when the client declares `sampling` **and** `SN_SAMPLING=1` (settings manifest, E-4).
  Input passes through H-5 redaction and the M-4 untrusted-content boundary first. It has a
  token cap and a timeout, and the deterministic result is always returned too: the summary is
  an addition, never a replacement. First users: `ops` `overview`, `compare_instances`,
  `review_upgrade` `skipped`.
- **Owner decision O-12:** default off, and whether the summary is allowed in the docs store.
- **Done when:** with sampling on, an `ops` overview carries a `summary`. With it off, or on a
  client without sampling, the output is byte-identical to today.
- **Tests:** `test/sampling.test.js` (capability absent, opt-out, timeout, redaction applied
  before send).

### N-10 — Record watch resources (M)

- **Why:** NX-10.
- **Surface:** a subscribable template `servicenow://profiles/{profile}/records/{table}/{sys_id}`.
  A subscription polls `sys_updated_on` / `sys_mod_count` at ≥ 30 s (configurable, with a
  floor) and sends `notifications/resources/updated` on a change. There is a cap per session (H-7
  sessions) and per process (E-9 bounded state). Polling stops on unsubscribe, session close
  and cancellation. Reads go through policy like `get_record`.
- **Done when:** a watched record changed on the instance produces one notification within one
  poll interval, and at the cap the server rejects a new subscription with an error code (M-2).
- **Tests:** `test/record-watch.test.js` with the fake clock (E-6) and HTTP-session isolation.

## 5. Sequencing

| Phase | Items                                   | Why this order                                                                                                    |
| ----- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 0     | N-0 (O-10)                              | Without headroom every other item fails the budget test.                                                          |
| A     | N-6, N-8                                | Lowest risk, near-zero budget, they reuse existing tools; they feed the `why-is-it-slow` prompt and `where_used`. |
| B     | N-1, N-2 (O-13)                         | The two flagships: unique in the market and built on code that already exists (diff, registry, security reader).  |
| C     | N-5, N-3 (read)                         | Daily ITSM questions, then the platform's own scan verdict beside `code_health`.                                  |
| D     | N-4 (O-11), N-9 (O-12), N-10, N-3 (run) | Owner-gated writes and protocol features.                                                                         |
| —     | N-7                                     | Stretch, on demand.                                                                                               |

Rough total for one maintainer: phases 0–C ≈ 5–7 weeks; phase D ≈ 3–4 weeks after the owner
decisions.

## 6. Owner gates (new)

- **O-10** Restate the `tools/list` budget for the post-3.0 surface, or approve the byte
  reclaim of N-0.
- **O-11** CI/CD promotion lane: go / no-go, the endpoint list, the production rule.
- **O-12** Sampling: opt-in default, whether summaries may be written to the docs store.
- **O-13** Access explainer: package placement and the privacy stance on reading another
  user's roles.

All N items also depend on **O-5** (PDI verification) for table and field names, and on **O-2**
for fixtures.

## 7. Explicitly out (re-confirmed)

- ITOM Event Management, HR, CSM and SecOps packages (NX-12): the module-breadth non-goal stands.
- Background scripts, `sn_fd.FlowAPI` scripted REST shims and any server-side code installed by
  this server.
- A hosted, multi-tenant record-watch service. N-10 polls inside the client's own session
  only.
