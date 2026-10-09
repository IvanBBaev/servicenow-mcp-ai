# servicenow-mcp-ai — Gap Analysis & Implementation Plan (2026-10)

Date: 2026-10-03 · Status: **proposed — docs only, no code.** Baseline: `main` at `78fa65c` (batches 13–18
committed; npm `latest` still 2.0.1) (97 tools in 26 packages, 1648 tests, `tools/list` `all` 150,916 B vs the
151,000 B budget in `test/output-schema.test.js`).

This pass asks a different question from the 2026-09 reviews: v3.0 is close to exhausted (the open
rows of [ROADMAP-V3.md](ROADMAP-V3.md) are owner-gated: O-1, O-2, O-5, the H-11 policy file, the
pack ceiling), so **what does the server still not do that a ServiceNow developer or admin asks
for every week?** Findings carry ids `NX-01` … `NX-35`. The implementation items they produce are
the **N pillar** (`N-0` … `N-65`), tracked as rows 84–149 in [ROADMAP-V3.md](ROADMAP-V3.md). They
are post-3.0 work and ship on 3.x minors, like the P epic.

Evidence marker: **verified** = re-checked in code during this pass (a grep over `src/`).
Table and field names that no code reads yet are **unverified** until O-5 (PDI). Confirm them in
the first hour of the item, before designing.

The pass ran in four rounds the same day. Round 1 (NX-01 … NX-12) covers ServiceNow coverage and
MCP capabilities. Round 2 (NX-13 … NX-24, §2.2) adds release and verification, platform models
(domains, hardening, cross-scope, indexes), server identity over HTTP and tool-surface quality. Round 3 (NX-25 … NX-29, §2.3) covers
elevated-privilege roles (`security_admin`). Round 4 (NX-30 … NX-35, §2.4) covers user access:
role grants, privileged accounts, least privilege and field masking. Round 5 (UI Builder, findings
`UX-01` … `UX-24`, items N-25 … N-34, owner gate O-18) has its own document, [UIB-ANALYSIS-2026-10.md](UIB-ANALYSIS-2026-10.md). Round 6 (token economy, AI-facing documentation and MCP 2026-07-28, findings `TK-01` … `TK-20`, items N-35 … N-44, owner gates O-19 … O-21) and round 7 (agent harness and distribution, `TK-21` … `TK-29`, items N-45 … N-53, **P0**, owner gate O-22) and round 8 (code mode, telemetry, surface security, `TK-30` … `TK-33`, items N-54 … N-56, **P0**) are in [TOKEN-DOCS-ANALYSIS-2026-10.md](TOKEN-DOCS-ANALYSIS-2026-10.md). Round 9 (measured token-optimization plan, `TK-34` … `TK-51`, work packages N-57 … N-65, sub-questions on O-4, O-10, O-19 and O-21) is in [TOKEN-OPTIMIZATION-PLAN-2026-10.md](TOKEN-OPTIMIZATION-PLAN-2026-10.md).

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

### 2.2 Round 2 — release, platform models, identity, surface quality

| Id    | Finding                                                                                                                                                                                                                                                                                                             | Evidence                                                                                                                                        | Severity | → Item             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------ |
| NX-13 | **v3 is unreleased.** Eighteen roadmap batches, including the approved breaking register (B1–B13 bar B10), sit on `main`, but npm `latest` and `package.json` are both 2.0.1. The roadmap's `3.0.0-beta.n` on the `next` tag has never been cut, so no user has run any of it.                                      | **verified**: `npm view servicenow-mcp-ai` → `latest: 2.0.1`; `package.json` `version` 2.0.1; `git log` → `78fa65c`                             | High     | N-11               |
| NX-14 | **A prerelease tag would publish as `latest`.** `publish.yml` runs `npm publish --provenance --access public` for every `v*` tag with no `--tag`, so `v3.0.0-beta.1` would replace 2.0.1 for every `npx` user.                                                                                                      | **verified**: `.github/workflows/publish.yml:10,33`                                                                                             | High     | N-11               |
| NX-15 | **No live verification.** All 1648 tests run against the fetch double. The live smoke and fixture corpus (E-6 rest, O-2) are open, and dozens of table and field names carry `O-5: verify on a live instance`. This is the largest quality risk in the repo, larger than any missing feature.                       | **verified**: `grep -rc "O-5" src`; ROADMAP-V3 row 37                                                                                           | High     | E-6 / O-2 (raised) |
| NX-16 | **No domain separation awareness.** On a domain-separated (MSP) instance, reads are scoped by the session domain, and business rules, ACLs and data policies can be domain-specific. Trace, documentation and the planned `explain_access` (N-2) would describe the wrong domain without saying so.                 | **verified**: `sys_domain` appears only in the Fluent ignore list (`src/api/fluent.ts:119`)                                                     | Medium   | N-12               |
| NX-17 | **No hardening compliance.** `security.ts` scans ACL scripts and roles but none of the instance security properties (CSRF, escaping, session timeout, script sandbox, attachment rules). ServiceNow's hardening guide and Security Center check exactly these.                                                      | **verified**: no `glide.security.*` / `glide.ui.escape*` reads in `src/`                                                                        | Medium   | N-13               |
| NX-18 | **Cross-scope access is not reported.** Cross-scope privileges are a registry descriptor and a where-used edge, and restricted caller access is not read at all. "What does this app call outside its scope, and is it allowed?" is a standard scoped-app review question.                                          | **verified**: `sys_scope_privilege` only in `src/core/artifacts/registry.ts`, `src/api/whereused.ts`; 0 hits for `sys_restricted_caller_access` | Medium   | N-14               |
| NX-19 | **No index or table-size view.** The server checks encoded-query syntax, but not whether a query's fields are indexed or how large the table is. That is the second half of "why is it slow" after N-6 transactions.                                                                                                | **verified**: 0 hits for `sys_index`, `sys_table_rotation`                                                                                      | Low      | N-15               |
| NX-20 | **ATF results only per execution.** `get_atf_result` polls one execution id. Nothing reports the last result per test or suite, pass-rate history, or flaky tests.                                                                                                                                                  | **verified**: 0 hits for `sys_atf_test_result`                                                                                                  | Low      | N-16               |
| NX-21 | **Store-app updates are not visible.** Which installed store apps have a newer version, and which customised artefacts they would touch, belongs with upgrade readiness.                                                                                                                                            | **verified**: no `sn_appclient` reads                                                                                                           | Low      | N-1 (scope)        |
| NX-22 | **HTTP identity is one static bearer token.** Every client of an HTTP server shares one ServiceNow credential: there is no MCP authorization (OAuth 2.1 protected-resource metadata) and no per-user identity on the instance. This blocks team use and remote connectors, and the journal cannot tell users apart. | **verified**: `src/mcp/transport.ts:38-46,239-312`                                                                                              | Medium   | N-17               |
| NX-23 | **Tool selection is untested.** With 97 tools, nothing checks that a model picks the right tool from the descriptions. M-7 renamed 11 tools and the N-0 reclaim will shorten descriptions, both without a regression check.                                                                                         | **verified**: no eval suite under `test/` or `scripts/`                                                                                         | Medium   | N-18               |
| NX-24 | **Five prompts for 26 packages.** Prompts cover table, change, docs and scripts, the instance overview and `why-is-it-slow`. The N flagships (upgrade, access, hardening) need guided entry points.                                                                                                                 | **verified**: 5 `registerPrompt` calls in `src/mcp/prompts.ts`                                                                                  | Low      | N-19               |

NX-15 does not get a new item: it raises E-6 rest and O-2 to the first slot of the sequencing
(§5, phase R).
MID-server and ECC health are platform plumbing rather than an ITOM module, so they are in N-6.

### 2.3 Round 3 — elevated-privilege roles

ServiceNow marks some roles `elevated_privilege` (`sys_user_role`); `security_admin` is the base
one. A user who holds such a role must elevate it explicitly, and the elevation lasts only for
that session: it ends at logout or session timeout. ServiceNow documents no REST endpoint for
elevation. Whether a non-interactive (basic or OAuth) session can elevate at all is **unverified**
and is the first step of N-20.

| Id    | Finding                                                                                                                                                                                                                                                                                                                                               | Evidence                                                                                                        | Severity | → Item            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- | ----------------- |
| NX-25 | **No elevation support.** The server can neither elevate a role nor tell the user that an operation needs one. Blocked today: ACL script bodies in the security scan, `document_* security` and `compare_instances`; `upsert_artifact` type `acl` and its `revert`; probably an update-set commit that carries ACLs (unverified); later N-2 and N-13. | **verified**: 0 hits for `elevat` / `impersonat` in `src/`; ACL descriptor `src/core/artifacts/registry.ts:763` | High     | N-20              |
| NX-26 | **Every request is a new session.** The dispatcher keeps no cookies (`JSESSIONID`, `glide_user_route`) and sends no `X-UserToken`, so an elevation would be lost on the next request. This is the structural blocker.                                                                                                                                 | **verified**: no cookie handling in `src/core/dispatcher.ts` / `src/core/http-util.ts`                          | High     | N-20 (EL-3)       |
| NX-27 | **No detection.** `check_capabilities` only says in prose that ACL scripts need `security_admin`. Nothing reports whether the user holds an elevatable role or whether one is active.                                                                                                                                                                 | **verified**: `src/api/capabilities.ts:213`                                                                     | Medium   | N-20 (EL-1)       |
| NX-28 | **No error code.** A denial caused by a missing elevation surfaces as a generic 403, without `ELEVATION_REQUIRED` and a hint.                                                                                                                                                                                                                         | **verified**: `ERROR_CODES` in `src/core/errors.ts`                                                             | Medium   | N-20 (EL-2)       |
| NX-29 | **Plan and journal are elevation-blind.** The plan token does not record that an apply needs elevation, and the journal does not record when an elevation started and ended.                                                                                                                                                                          | **verified**: `src/mcp/write-mode.ts`, `src/core/write-journal.ts`                                              | Medium   | N-20 (EL-4, EL-5) |

The H-11 policy is a separate layer and stays one: `sys_security_acl` is in `PROTECTED_TABLES`
(`src/core/policy.ts:64`), so an elevated write is still refused unless `SN_TABLES_ALLOW` lists
the table exactly. Impersonation and granting roles (`sys_user_has_role` writes, already
possible behind the protected-table policy) are out of scope.

### 2.4 Round 4 — user access and field masking

| Id    | Finding                                                                                                                                                                                                                                                                                                                                | Evidence                                                                                            | Severity | → Item |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------- | ------ |
| NX-30 | **Role and group grants have no first-class operation.** A grant or revoke is a generic table write to `sys_user_has_role` / `sys_user_grmember`, which needs the table listed in `SN_TABLES_ALLOW`. Nothing shows the user's effective roles before and after, including roles inherited through groups and `sys_user_role_contains`. | **verified**: both tables in `PROTECTED_TABLES` (`src/core/policy.ts:64`); no grant / revoke tool   | Medium   | N-24   |
| NX-31 | **No privileged-account inventory.** `lookup_directory` resolves one user, group or role. The security scan reports roles, not users. Nothing answers "who holds `admin`, `security_admin` or an elevated role, directly or inherited", and `last_login` is never read, so dormant privileged accounts are invisible.                  | **verified**: `src/api/directory.ts:7-19`; 0 hits for `last_login`                                  | Medium   | N-22   |
| NX-32 | **No least-privilege advice for the server's own account.** `doctor` and `check_capabilities` report what is missing, never what is excess. The capability matrix already knows which tables each package reads.                                                                                                                       | **verified**: `src/api/doctor.ts`, `src/api/capability-matrix.ts`                                   | Medium   | N-23   |
| NX-33 | **Role-change audit is per record.** `get_record_history` reads one record's `sys_audit`, but a grant or revoke is an insert or delete on `sys_user_has_role`. There is no per-user role-change history.                                                                                                                               | **verified**: `src/api/history.ts:7`; the audit source for role inserts / deletes is **unverified** | Low      | N-22   |
| NX-34 | **Field masking is name-based only.** Results are masked by `SN_REDACT_FIELDS` and the PII patterns. Only `properties.ts` masks by type. `query_table` returns `password2` and `glide_encrypted` field values as the instance sends them, although the cached schema already holds `internal_type`.                                    | **verified**: `src/core/redaction.ts:1-17`, `src/api/properties.ts:37`, `src/api/meta.ts:220,253`   | High     | N-21   |
| NX-35 | **Impersonation.** It would let the server verify access as another user.                                                                                                                                                                                                                                                              | Out of scope; N-2 answers the question statically                                                   | —        | none   |

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
- **Store apps (NX-21):** `kind: "store_updates"` lists installed store apps with a newer
  version available, and for each one the customised artefacts in its scope (registry +
  `sys_update_xml`) that the update would touch.
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

> **Dropped 2026-10-10** ([ADR 0009](adr/0009-drop-sampling-summaries.md)); the plan below is kept
> for the record.
>
> **2026-10-04:** MCP 2026-07-28 deprecates Sampling. N-9 waits for O-19 and is re-scoped or
> dropped there; see N-35 in [TOKEN-DOCS-ANALYSIS-2026-10.md](TOKEN-DOCS-ANALYSIS-2026-10.md).

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

### N-11 — 3.0.0-beta on `next` (S + owner, O-14)

- **Why:** NX-13, NX-14.
- **Scope:**
  - `publish.yml` derives the dist-tag from the version: a prerelease (`-beta.n`, `-rc.n`)
    publishes with `--tag next`, a release with `--tag latest`. The GitHub Release is
    `--prerelease` for the former. The same rule goes into the extension and MCP-registry
    jobs, so a beta never reaches Marketplace stable or the registry `latest`.
  - `npm version 3.0.0-beta.1` through the existing `sync-version` hook; the CHANGELOG
    `[Unreleased]` block becomes `3.0.0-beta.1` with the B1–B13 migration table.
  - A release checklist in CONTRIBUTING (gate green, `pack:check` decision, smoke run when O-2
    is available).
- **Done when:** a dry run (`npm publish --dry-run --tag next`) and a workflow test on a
  `-beta` tag show `next`. `latest` stays 2.0.1 until 3.0.0.
- **Tests:** `test/version-sync.test.js` gains a case for the dist-tag derivation (the logic
  moves to `scripts/dist-tag.mjs` so it is unit-testable).

### N-12 — Domain separation awareness (M)

- **Why:** NX-16.
- **Surface:** no new tool.
  - `get_status` and `check_capabilities` report whether domain separation is active and
    the connected user's domain.
  - Every artefact read keeps `sys_domain` / `sys_overrides`. `trace_table_event`,
    `explain_artifact`, `document_*` and N-2 group or flag per domain, and print one caveat
    line when the view is limited to the session domain.
  - Query tools accept an optional `domain` scope where the platform supports it
    (`sysparm_query_no_domain` for admins; unverified).
- **Unverified (O-5):** the plugin probe, `sysparm_query_no_domain` behaviour, override
  semantics. A domain-separated PDI may need a separate O-2 fixture.
- **Done when:** on a non-domain instance, the output is byte-identical to today. On a
  domain-separated fixture, a domain-specific business rule is attributed to its domain.
- **Tests:** `test/domain-separation.test.js`.

### N-13 — Hardening compliance (M)

- **Why:** NX-17.
- **Surface:** `document_instance` kind `security` and `check_code_health` gain a
  `hardening` section. It holds a versioned rule table (`src/api/hardening-rules.ts`: property,
  expected value or range, severity, rationale, docs link), read via `servicenow_get_properties`
  plumbing. The result per rule is `pass` / `fail` / `not_set` (platform default applies) /
  `unreadable`.
- **Unverified (O-5):** property names and defaults per family. The rule table carries
  `since` / `until` family markers.
- **Done when:** a PDI baseline produces no false `fail` on platform defaults, and every rule
  cites its source.
- **Tests:** `test/hardening.test.js` (rule evaluation, missing property = default, unreadable
  `sys_properties`) plus a golden for the document section.

### N-14 — Cross-scope access report (M)

- **Why:** NX-18.
- **Surface:** `document_app` kind `security` adds a cross-scope section with the app's outbound
  calls into other scopes (S-4 script intelligence: script includes, `GlideRecord` on foreign
  tables), each joined to its `sys_scope_privilege` row (allowed / requested / denied) and to
  restricted caller access records. It also lists the inverse: who calls into this app.
- **Done when:** a scoped app calling a foreign script include without a privilege row shows
  as `missing`.
- **Tests:** `test/cross-scope.test.js`.

### N-15 — Index and table-size advisor (S–M)

- **Why:** NX-19.
- **Surface:** `describe_table` gains `indexes` (fields per index, unique) and an estimated row
  count via the Aggregate API, capped and cached. `query_table` with `explain:true` returns,
  for its encoded query, which conditions hit an index and which do not, and an
  `ORDERBY` / `LIKE` / `STARTSWITH` cost note. N-6 `transactions` links slow URLs to this
  advisor.
- **Unverified (O-5):** index metadata table and fields; table-rotation flags.
- **Tests:** extend `test/meta.test.js`; an encoded-query → index-hit property test.

### N-16 — ATF result history (S)

- **Why:** NX-20.
- **Surface:** `servicenow_list_atf_tests` / `list_atf_suites` gain `with_results:true`: last
  result, last run, pass rate over the last _n_ runs, and a `flaky` flag for mixed outcomes on
  an unchanged test (`sys_mod_count` stable). No new tool.
- **Tests:** extend `test/atf.test.js`.

### N-17 — HTTP identity: MCP authorization (L) — owner gate O-15

- **Why:** NX-22.
- **Scope:**
  - The HTTP transport serves OAuth 2.1 protected-resource metadata and validates access tokens
    issued by an external authorization server (the MCP authorization spec). The static bearer
    token stays as the simple mode.
  - **Per-user instance identity:** each authenticated MCP user maps to their own ServiceNow
    OAuth token (authorization-code flow against the instance, stored per user in the
    credential store), so ACLs, audit and the journal show the real user. A shared service
    account stays opt-in.
  - The journal and metrics record the MCP subject.
- **Owner decision O-15:** whether this is in scope. It sits next to the "hosted multi-tenant
  SaaS" non-goal: the design stays single-tenant (one instance profile set, many users), but
  it is the first time the server holds more than one person's credentials (BUSINESS-ANALYSIS
  B5).
- **Done when:** two users on one HTTP server see their own ACL-filtered data, and each journal
  line names its user.
- **Tests:** `test/http-auth.test.js` (metadata, token validation, audience, expiry, per-user
  credential isolation, fallback bearer mode).

### N-18 — Tool-selection eval (M)

- **Why:** NX-23.
- **Surface:** `evals/tool-selection/` holds ~150 cases (`prompt`, enabled packages,
  `expected_tool`, optional key arguments). `npm run eval:tools` sends `tools/list` plus each
  prompt to a model and scores top-1 accuracy per package. It is **not** in `npm run check`
  (it needs a key and costs money): it runs on demand and in a manual CI job, and its report
  is committed per release.
- **Done when:** a baseline report exists, and a change to descriptions (N-0 reclaim, M-7 style
  renames) must not drop accuracy by more than 2 points.
- **Tests:** a unit test for the scorer and case schema (offline).

### N-19 — Prompts for the N flagships (S)

- **Why:** NX-24.
- **Surface:** prompts `review-upgrade` (N-1), `why-no-access` (N-2) and `security-posture`
  (N-13 + S-3 + N-14), each gated on its package like `why-is-it-slow`, with argument
  completions (M-4). They ship with their items, not before.
- **Tests:** extend the prompt tests.

### N-20 — Elevated-privilege roles (M–L) — owner gate O-16

- **Why:** NX-25 … NX-29.
- **EL-0 — PDI spike (go / no-go).** On a PDI, test whether an elevation persists across REST
  requests: (a) basic auth with a cookie jar and the UI's elevation mechanism; (b) an OAuth
  session; (c) any instance property that grants elevated roles to web-service sessions. The
  findings go into this section. Without a working path, only EL-1 and EL-2 ship.
- **EL-1 — Detection (read-only, ships regardless).** `get_status`, `check_capabilities` and
  `doctor` report the elevatable roles the user holds (`sys_user_has_role` joined to
  `sys_user_role.elevated_privilege`) and whether one is active, probed by reading one ACL
  script body.
- **EL-2 — Error contract.** A new `ELEVATION_REQUIRED` code in `ERROR_CODES` with a hint that
  names the role, used when a 403 matches a known elevation-gated table or field.
- **EL-3 — Session persistence.** A per-profile cookie jar plus `X-UserToken` in the
  dispatcher, used only on elevated runs. The normal path stays stateless and is unchanged.
- **EL-4 — Elevation scoped to one operation.**
  - The plan records `requiresElevation: ["security_admin"]`, and the plan token binds the role.
  - Apply elevates, writes, then ends the session in `finally`.
  - Reads take `elevate: true` (for example the ACL scan) under the same scoping.
  - There is no free-standing "elevate" tool and no elevation that outlives the operation.
- **EL-5 — Consent and guards.**
  - `SN_ALLOW_ELEVATION=0` is the default, and `SN_ELEVATION_ROLES` defaults to `security_admin`.
  - Every elevation needs elicitation consent, the same pattern as a credential change
    (`src/tools/admin.ts:55`). It fails closed when the client cannot elicit.
  - Elevation is disabled over HTTP until per-user identity exists (N-17).
  - If the instance requires MFA or re-authentication to elevate, the operation is refused with
    a hint.
  - The journal records the start and the end of each elevation.
- **Unverified (O-5):** the elevation mechanism itself, whether non-interactive sessions can
  elevate, and the session-timeout behaviour. EL-0 settles all three.
- **Done when:** with elevation off, every elevation-gated operation fails with
  `ELEVATION_REQUIRED` and a hint. With elevation on and consent given, an ACL upsert applies
  and the session holds no elevated role afterwards.
- **Tests:** `test/elevation.test.js` covers:
  - the detection matrix;
  - 403 → `ELEVATION_REQUIRED` mapping;
  - the cookie jar is used only on elevated runs;
  - the session is ended on success, on failure and on cancellation;
  - consent refused, or no elicitation support → refusal;
  - HTTP mode → refusal;
  - journal start and end lines.

### N-21 — Type-based field masking (S)

- **Why:** NX-34.
- **Surface:** the result boundary (`src/mcp/redact.ts`) and the write journal mask every field
  whose cached `internal_type` is `password`, `password2` or `glide_encrypted`, for every tool
  that returns records, whatever `SN_REDACT_FIELDS` says. A schema miss falls back to the
  name-based rules and never blocks the read. Masking cannot be turned off: a caller who needs
  the value reads it on the instance.
- **Done when:** a `query_table` / `get_record` / `compare_instances` result never carries a
  `password2` value. The journal never stores one.
- **Tests:** `test/type-masking.test.js` (per type, nested `display_value` objects, schema miss,
  journal).

### N-22 — Access review (M)

- **Why:** NX-31, NX-33.
- **Surface:** `document_instance` kind `access_review` lists the privileged accounts: users
  holding `admin`, `security_admin`, any `elevated_privilege` role, or a role that contains one
  of those. For each user it shows:
  - the grant path (direct, group, contained role);
  - `active` and `last_login`, with dormant accounts flagged;
  - who granted the role and when, where the audit source is readable.

  `lookup_directory` kind `user` gains `role_history`.

- **Unverified (O-5):** the audit source for `sys_user_has_role` inserts and deletes.
- **Tests:** `test/access-review.test.js` (inheritance paths, dormant threshold, unreadable
  audit → `available:false`).

### N-23 — Least-privilege advisor (S–M)

- **Why:** NX-32.
- **Surface:** `servicenow_doctor` gains a `privilege` section. From the capability matrix it
  derives the read and write roles that the enabled packages need. It compares them with the
  account's effective roles and reports `missing` and `excess`. For example: the account has
  `admin`, but `itil` plus the read roles for the code tables are enough.
- **Done when:** on the README's recommended read-role profile, the advisor reports nothing
  missing for the `core` package set.
- **Tests:** extend `test/doctor.test.js`.

### N-24 — Grant and revoke access (M) — owner gate O-17

- **Why:** NX-30.
- **Surface:** `servicenow_change_access` in a new opt-in `access` package. Its actions are
  `grant_role`, `revoke_role`, `add_to_group` and `remove_from_group`, and it runs through
  plan → token → apply.
  - The plan shows the user's effective roles before and after.
  - It warns when the change adds `admin`, an elevated role, or a role that contains one.
  - It refuses an inherited role, because revoking a group-granted role is a group change.
  - The H-11 protected-table rule still applies: the tool needs the tables in `SN_TABLES_ALLOW`.
  - Revoking `admin` from the server's own account needs an explicit confirmation.
- **Owner decision O-17:**
  - whether the server may change access at all;
  - whether admin and elevated grants are allowed or always refused.
- **Tests:** `test/change-access.test.js`.

## 5. Sequencing

| Phase | Items                                                                                       | Why this order                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| R     | N-11 (O-14), E-6 rest + O-2 smoke                                                           | Ship what exists and verify it live before adding surface (NX-13 … NX-15).                                         |
| 0     | N-18, then N-0 (O-10)                                                                       | The eval baseline first, so the budget reclaim cannot silently hurt tool selection.                                |
| A     | N-21, N-6, N-8, N-15, N-16, N-20 (EL-0 … EL-2)                                              | Lowest risk, near-zero budget, they extend existing tools; they feed the `why-is-it-slow` prompt and `where_used`. |
| B     | N-12, N-1, N-2 (O-13), N-19                                                                 | Domain awareness first, so the flagships are correct on MSP instances; the prompts ship with them.                 |
| C     | N-13, N-14, N-22, N-23, N-5, N-3 (read)                                                     | Security posture (hardening, cross-scope), daily ITSM questions, then the platform's own scan verdict.             |
| D     | N-4 (O-11), N-17 (O-15), N-20 (EL-3 … EL-5, O-16), N-24 (O-17), N-9 (O-12), N-10, N-3 (run) | Owner-gated writes, identity and protocol features.                                                                |
| —     | N-7                                                                                         | Stretch, on demand.                                                                                                |

Rough total for one maintainer: phase R ≈ 2–3 days plus the owner's PDI time; phases 0–C ≈ 8–10
weeks; phase D ≈ 5–6 weeks after the owner decisions.

## 6. Owner gates (new)

- **O-10** Restate the `tools/list` budget for the post-3.0 surface, or approve the byte
  reclaim of N-0.
- **O-11** CI/CD promotion lane: go / no-go, the endpoint list, the production rule.
- **O-12** Sampling: opt-in default, whether summaries may be written to the docs store.
- **O-13** Access explainer: package placement and the privacy stance on reading another
  user's roles.
- **O-14** Cut `3.0.0-beta.1` on `next` (N-11), and decide the `pack:check` ceiling before it.
- **O-15** HTTP identity (N-17): in or out of scope; if in, the authorization server and the
  per-user credential custody model.
- **O-16** Elevated-privilege roles (N-20): go / no-go after the EL-0 spike, the allowed
  roles, and whether stdio-only is enough.
- **O-17** Access changes (N-24): whether the server may grant or revoke roles and groups, and
  whether admin and elevated grants are allowed or always refused.
- **O-18** UIB writes (N-33): whether they ship, whether they need an open update set, and
  whether `/api/now/uxf/*` and custom-component deployment stay out. See [UIB-ANALYSIS-2026-10.md](UIB-ANALYSIS-2026-10.md).
- **O-19** Protocol 2026-07-28 (N-35): SDK v2 migration window, whether it is BREAKING, and the
  fate of N-9. **O-20** public `AGENTS.md` (N-43). **O-21** response defaults (N-39, N-40). **O-22** external distribution (N-51, N-53). See [TOKEN-DOCS-ANALYSIS-2026-10.md](TOKEN-DOCS-ANALYSIS-2026-10.md); round 9 sub-questions on O-10, O-19 and O-21 are in [TOKEN-OPTIMIZATION-PLAN-2026-10.md](TOKEN-OPTIMIZATION-PLAN-2026-10.md) §7.

All N items also depend on **O-5** (PDI verification) for table and field names, and on **O-2**
for fixtures.

## 7. Explicitly out (re-confirmed)

- ITOM Event Management, HR, CSM and SecOps packages (NX-12): the module-breadth non-goal stands.
- Background scripts, `sn_fd.FlowAPI` scripted REST shims and any server-side code installed by
  this server.
- A hosted, multi-tenant record-watch service. N-10 polls inside the client's own session
  only.
