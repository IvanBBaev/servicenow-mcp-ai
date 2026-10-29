# Role review — ServiceNow Certified Master Architect / senior platform developer (2026-10-29)

Reviewer role: I review the server as the platform owner of a large production instance would.
My question is whether I would let this client hold an integration account on my
instance. I look at the load it puts on the nodes and the database (COUNT(\*), dot-walk joins,
retries against transaction quotas, semaphores), whether its writes are correct
(update-set capture, IRE, import sets, the Change and Catalog APIs), whether its table and field
names are right for the release family, and whether its security posture matches how I would
provision a service account (least privilege, a Machine identity, OAuth, read-only roles).
Code style, MCP ergonomics and packaging are out of scope.

Baseline: main @ dc29e9c · servicenow-mcp-ai 3.0.0 · scope: `src/api/*` (table, batch,
importset, change, catalog, cmdb, history, ops, updatesets), `src/core/http-util.ts`,
`src/core/policy.ts`, `project/PDI-VERIFY-2026-10.md`, `project/V3.5-ANALYSIS-2026-10.md` §2.1,
README service-account examples.

## 1. Verdict

**Score: 7/10.** The table and field names are checked more carefully than most commercial
integrations I have audited (40 PDI passes, 1,345 names). The write-safety model (plan, token,
journal, protected tables, batch package mapping) is sound. What keeps the score down is load on
the instance. Several read paths are built for correctness, not for a 20M-row `task` table. A
slow GET is retried while the first copy is still running on the instance, every keyset page
pays for a COUNT(\*), and `check_data_health` runs up to about 40 join counts with no size
guard. The server also never tells or checks how the service account should be provisioned on
the instance side.

- **Top 3 risks:**
  1. GET timeout retries stack up to 3 concurrent copies of a slow transaction (RR-SN-01).
  2. Unbounded dot-walk join counts in `check_data_health` (RR-SN-02).
  3. Update-set binding can race a human on the same account, and nothing checks the capture (RR-SN-04).
- **Top 3 strengths:** PDI name verification; plan → token → journal write safety; transport
  discipline (429/Retry-After, per-host semaphore, circuit breaker).

## 2. What I examined

- Code: `src/api/table.ts` (paging, upsert, writes), `src/core/http-util.ts` and
  `http-retry.ts` (timeouts, retries), `src/api/ops.ts` (health and data-health), `src/api/updatesets.ts`
  (`applyInUpdateSet`), `src/api/change.ts`, `src/api/catalog.ts`, `src/api/cmdb.ts` (IRE),
  `src/api/importset.ts`, `src/api/batch.ts`, `src/api/history.ts`, `src/api/capabilities.ts`,
  `src/core/policy.ts` (`PROTECTED_TABLES`, `evaluateTable`, `assertTableWriteAllowed`).
- Docs and trackers: `project/PDI-VERIFY-2026-10.md`, `project/V3.5-ANALYSIS-2026-10.md` §2.1
  (F5-01…F5-14), `project/roadmap.yaml`, `project/TODO.md`, README (service-account examples).
- Grep sweeps across `project/roadmap.yaml` / `project/TODO.md` / `V3.5-ANALYSIS`, as hit counts:
  `quota` 0/0/0, `sysparm_no_count` 0/0/0, `query_category` 0, `snc_read_only` 0, `Brazil` 0,
  `sys_history_line` 0, `requested_for` 0, `sys_update_xml` 1/0/2.
- Grep in `src/`: `snc_read_only|web_service_access_only|identity_type|internal_integration`
  returns 0 hits. `sysparm_query_category` returns 0 hits.
- Web, read today:
  - Default quota rules:
    <https://www.servicenow.com/docs/r/platform-administration/platform-performance/c_DefaultQuotaRules.html>
  - Brazil release notes:
    <https://www.servicenow.com/docs/r/brazil/release-notes/available-versions.html>
  - Brazil key dates: <https://nowben.com/servicenow-brazil-release-key-dates-and-preview-information/>
  - Creating a user (identity type):
    <https://www.servicenow.com/docs/r/platform-administration/user-administration/t_CreateAUser.html>
  - Web-service-access-only identity:
    <https://dev.classmethod.jp/en/articles/servicenow-identity-type-web-service-access-only/>
- No instance tools were called. Nothing was built or installed.

## 3. Strengths (keep doing)

1. **The table and field names are verified against a real instance.** `project/PDI-VERIFY-2026-10.md`
   has 40 passes, 276 tables and 1,345 names. Open items are listed explicitly (4 absent tables,
   3 BREAKING key fields, 7 scope-field tables). I rarely see this level of rigour, and it is
   what prevents silent empty results on production.
2. **Keyset paging instead of deep offsets.** `src/api/table.ts:193-214` and `:394` page with
   `sys_id>cursor^ORDERBYsys_id`. That avoids the O(n²) cost of `sysparm_offset` on big tables.
   It also accounts for rows the ACL filters out (`:316-324`).
3. **Batch API boundaries.** `src/api/batch.ts` maps every sub-request path to a package
   (`PACKAGE_BY_PATH`). It refuses nested batches and unmapped namespaces (`sn_cicd/app_repo`,
   plugin activation), so the Batch API cannot be used to get around the policy.
4. **Transport discipline.** It honours 429 with Retry-After (capped at 60 s). 502/503/504 are
   retried only for GET. It uses a per-host semaphore (`SN_MAX_CONCURRENT=4`), a bounded queue
   and a circuit breaker. These are the right primitives against API_INT semaphore exhaustion.
5. **Upsert is safe.** `resolveUpsert` reads with limit 2 plus `X-Total-Count`, and an ambiguous
   key raises `AMBIGUOUS_KEY`. `keyQuery` rejects `^` and newlines, so a caller cannot inject
   extra conditions into the key query.
6. **Write governance.** Protected tables (`src/core/policy.ts:72-…`, which include the ACL,
   role, property and OAuth tables) under `confirm` by default, plan tokens for destructive
   applies, a local journal, and an `SN_IMPORT_SET_TABLES` guard (`policy.ts:388`). The IRE
   write checks every item class against the write policy (`src/api/cmdb.ts`
   `assertIreAllowed(payload, true)`).
7. **Ops reads are well shaped.** The time-windowed `syslog_transaction` / `sys_semaphore` /
   outbound-log reads use `gs.minutesAgoStart` and `noCount` (`src/api/ops.ts:242-777`).
8. **The update-set preference switch is restored in `finally`, even after a cancel.**
   (`src/api/updatesets.ts:854-911`.) The switch covers `updateSetForScope<app>` and global.

## 4. Findings

### RR-SN-01 — A GET that times out is retried while the instance transaction keeps running (severity: high · verified)

- **Evidence:**
  - `src/core/http-util.ts:441-458`: after an abort (timeout),
    `if (idempotent && attempt < maxRetries)` retries the GET.
  - The defaults are `SN_TIMEOUT_MS=30000` and `SN_MAX_RETRIES=2`.
  - The default "REST Table API request timeout" quota rule cancels the transaction at 60 s
    (default quota rules doc, reported).
  - Aborting the HTTP socket does not cancel the transaction on the node.
- **Why it matters (to this role):** a slow query (an unindexed LIKE, a big COUNT) runs for up to
  60 s per copy, and the client starts a fresh copy at about 30 s and again at about 60 s. One
  agent call becomes up to 3 overlapping expensive transactions. Each holds an API_INT
  semaphore slot and a DB connection. With `SN_MAX_CONCURRENT=4`, one agent can take 12
  integration threads. This is the pattern I see behind "the instance got slow when the bot
  ran".
- **Recommendation:**
  - Do not retry a GET after a _timeout_ by default. Keep the retry for connection resets and
    refusals, where the request never reached a node.
  - Or make the client timeout default exceed the 60 s quota (for example 65 s), so the
    instance's own cancel decides.
  - Document the interaction with quota rules in the settings reference.
- **Existing roadmap link:** none — new. N-90 (ECONNRESET retries) moves in the opposite
  direction. It should take this distinction on board.

### RR-SN-02 — `check_data_health` runs unbounded dot-walk join counts on any table (severity: high · verified)

- **Evidence:**
  - `src/api/ops.ts:1040-1042` computes `rowsInScope`, but the value is only reported
    (`:1097`). It never gates anything.
  - `:1083-1089` then runs a duplicate group-by alongside up to 10 default / 20 named reference
    checks via `Promise.all`.
  - Each check runs `${field}ISNOTEMPTY^${field}.sys_created_onISEMPTY` (`:972`), which is an
    outer join to the target table.
  - Stale checking is on by default (`args.stale !== false`). Each stale check adds a second
    join count, `${field}.active=false` (`:991`).
- **Why it matters (to this role):** on `task`, `cmdb_ci` or `sys_audit`-sized tables, these are
  20–40 full join scans fired concurrently, bounded only by the semaphore. Only caveat text
  stands in the way. A CMA would not approve this tool for production without a guard.
- **Recommendation:**
  - Refuse to run, or require an explicit `scope` query, when `rowsInScope` exceeds a threshold
    (for example 250k, configurable).
  - Run the reference checks sequentially (or 2 at a time), not through `Promise.all`.
  - Make the stale check opt-in.
  - Report the per-check elapsed time.
- **Existing roadmap link:** none — new.

### RR-SN-03 — fetch-all pays for a COUNT(\*) on every keyset page (severity: medium · verified)

- **Evidence:**
  - `src/api/table.ts:137` sets `sysparm_no_count` only when `opts.noCount`.
  - The keyset loop (`:262-326`) never sets it. It reads `page.total` once (`:272`), then on
    every page for the exhaustion check (`:316-324`).
  - There are 23 internal `fetchAll: true` call sites (meta, compare, doc-\*, access, security,
    upgrade, artifact-snapshot, i18n-coverage…).
  - No internal reader passes `noCount`. Only `src/api/ops.ts` and the `query_table` tool
    option do.
- **Why it matters (to this role):** 10,000 rows at page size 1,000 means 10 COUNT(\*) queries
  with the same filter. On big tables the count often costs more than the page itself. The
  natural end of a keyset scan (a short page) makes the count unnecessary after page 1.
- **Recommendation:**
  - Count once on the first page, then send `sysparm_no_count=true`, and detect the end by
    `rows < want`.
  - Consider `sysparm_query_category` (a read-replica category) for the long bulk readers
    (documentation, snapshot, compare) as an opt-in setting.
- **Existing roadmap link:** none — new (0 hits for `sysparm_no_count` / `query_category` in
  the trackers).

### RR-SN-04 — Update-set binding races a human on the same account and never checks the capture (severity: medium · verified)

- **Evidence:**
  - `src/api/updatesets.ts:890` locks on ``withLock(`${instance}|${user}`)``, an in-process
    `Map`.
  - It switches the `sys_update_set` and `updateSetForScope<app>` preferences (`:899-904`) and
    restores them in `finally` (`:911`).
  - Nothing reads `sys_update_xml` afterwards to confirm the change was captured.
    `sys_update_xml` is read only at `:339` (the summary), in uib-completeness and in upgrade.
- **Why it matters (to this role):**
  - Preferences are per user, not per session. If a developer is logged in interactively with
    the same account (common on sub-production), or a second MCP process runs, either side's
    changes land in the other side's update set.
  - Some writes are never captured at all: data tables, a non-`update_synch` table, or a
    record in a scope other than the set's application. Today these produce a journal entry
    that names an update set which does not hold the change. That is a silent promotion gap.
- **Recommendation:**
  - After the write, query `sys_update_xml` by `update_set` and the `name` prefix
    `<table>_<sys_id>`. Report `captured: true/false`. Warn when false.
  - Refuse update-set binding when the integration account has an active interactive session
    (`sys_user_session` read, if readable), or document that this needs a dedicated account.
- **Existing roadmap link:** related to N-73 (update set create/complete/move). N-73 covers
  lifecycle, not capture verification.

### RR-SN-05 — No instance-side service-account recipe or check (severity: medium · verified)

- **Evidence:**
  - README examples configure `user: "admin"` (README:598, 712, 1758).
  - The presets section (~README:1262) gives no instance-side role recipe.
  - `src/api/capabilities.ts:230` suggests "a dedicated read role, or admin".
  - Grep for `snc_read_only|web_service_access_only|identity_type|internal_integration` in
    `src/` returns 0 hits.
  - N-23 (the least-privilege advisor, `src/api/privilege.ts`) compares packages with read
    access only.
- **Why it matters (to this role):** a production approval needs a named, non-interactive
  integration user: Identity type = Machine (which sets web-service-access-only, reported from
  the ServiceNow user doc), OAuth rather than basic auth, and a role set per package. Reader
  profiles should use `snc_read_only`, so the _instance_ enforces read-only even if the client
  policy is misconfigured. Today the defence is client-side only.
- **Recommendation:**
  - Ship a role matrix (package → minimal roles: `itil`, `catalog_admin`, `import_admin`,
    `personalize_dictionary`…; mark those still unverified until O-5).
  - Add `doctor` checks: the account is not `admin`; `identity_type`/`web_service_access_only`
    is set; `snc_read_only` is present when the profile is read-only; and OAuth vs basic.
  - Replace `admin` in the README examples.
- **Existing roadmap link:** N-23 (done) — missing: instance-enforced read-only, identity-type
  check, write-role matrix.

### RR-SN-06 — No Brazil-family readiness track (severity: medium · reported)

- **Evidence:**
  - Brazil reached early availability on 2026-09-24, and GA is expected in November 2026
    (nowben key dates, reported).
  - The repo has 0 mentions of `Brazil`. The PDI verification is on the Zurich family. N-78
    covers Australia only.
- **Why it matters (to this role):** customers upgrade on the ServiceNow cadence. The PDI pass
  is a strong point now, but it decays with every family. The next GA will arrive before
  anyone re-runs it.
- **Recommendation:** add a per-family verification item. Re-run the `PDI-VERIFY` sweep on a
  Brazil PDI when one is available, record the family in the doc header, and add a
  `release_family` line to `doctor` output (read `glide.buildtag`).
- **Existing roadmap link:** N-78 (Australia REST) — missing: a repeatable per-family pass.

### RR-SN-07 — A PDI pass checks that names exist, not that queries are selective (severity: medium · judgement)

- **Evidence:**
  - `project/PDI-VERIFY-2026-10.md` states that the verifier checks names, not query values.
  - `sys_index` is unreadable over REST on the PDI (403).
  - Code search falls back to `LIKE` on CLOB script fields (`src/api/scripts.ts`), and
    `dependencies-inbound.ts` runs `LIKE` scans.
- **Why it matters (to this role):** a correct field can still be an unindexed predicate. On
  `sys_script_include` / `sys_script` volumes this is tolerable, but `LIKE` scans on
  `sys_metadata`-wide or customer tables are not.
- **Recommendation:**
  - Keep an explicit list of query shapes used against high-volume tables (task, cmdb_ci,
    sys_audit, syslog\*, sys_journal_field) with the index each relies on.
  - Refuse an unscoped `LIKE` on those tables.
  - Prefer the Code Search API, and surface when the fallback was used.
- **Existing roadmap link:** none — new.

### RR-SN-08 — The Change API write path skips the table-write policy axis (severity: low · verified)

- **Evidence:** `src/api/change.ts:72-73` and `:103-104` call `assertTableAllowed` plus
  `assertWriteAllowed`. They do not call `assertTableWriteAllowed` (`src/core/policy.ts:369`),
  which every Table API write and the IRE use. `change_request` is not in `PROTECTED_TABLES`,
  so the practical effect is nil today.
- **Why it matters (to this role):** this is one write path with a different policy contract.
  If an operator adds `change_request` to the protected set, the Change API write bypasses it.
  N-71 adds more Change writes on the same pattern.
- **Recommendation:** use `assertTableWriteAllowed(CHANGE_TABLE)` in `createChange` /
  `updateChange` (and in the N-71 writes), plus a test.
- **Existing roadmap link:** N-71 (F5-04) — missing: the policy-axis fix.

### RR-SN-09 — Catalog ordering bypasses catalog client logic, with no requested_for and no default limit (severity: low · verified)

- **Evidence:**
  - `src/api/catalog.ts` has `order_now` only.
  - It has no `sysparm_requested_for` (0 hits in src and trackers).
  - `listCatalogItems` has no default limit (`:43-54`).
  - N-72 (producers and guides) does not mention variable validation.
- **Why it matters (to this role):** over REST, catalog client scripts and catalog UI policies
  do not run. Mandatory variables, value checks and visibility rules enforced only on the
  client are skipped. That produces RITMs that fulfilment cannot work. Ordering on behalf of
  a user is the common integration case.
- **Recommendation:**
  - Before ordering, read the item's variables (`item_option_new`) and enforce
    `mandatory` / choice values in the preview.
  - Add `requested_for` (`sysparm_requested_for` is on the cart API, unverified until O-5).
  - Default the item list to a limit of 20.
- **Existing roadmap link:** N-72 — missing: variable validation and `requested_for`.

### RR-SN-10 — Record history ignores the History Set and has no default window (severity: low · verified)

- **Evidence:**
  - `src/api/history.ts` reads `sys_audit` (`tablename`, `documentkey`, ORDERBYDESC
    `sys_created_on`, up to 1,000 rows) and `sys_journal_field`.
  - `since` is optional.
  - `sys_history_line` has 0 hits.
- **Why it matters (to this role):** the queries hit indexed keys, so load is fine. But
  `sys_audit` is the most expensive table on most instances, and it is often rotated or
  archived. The history set (`sys_history_set` / `sys_history_line`) is the platform's own
  per-record view: it includes journal entries and a resolved display, and is cheaper to read.
- **Recommendation:** default `since` to 90 days, and add a `sys_history_line` source as an
  option (unverified until O-5).
- **Existing roadmap link:** none — new.

### RR-SN-11 — Open name defects are tracked but not prioritised for a production pilot (severity: low · verified)

- **Evidence:** `project/PDI-VERIFY-2026-10.md` lists:
  - 3 BREAKING key fields (`sys_declarative_action_definition.action_name`,
    `…payload_definition.key`, `sys_ux_event.name`), held on O-4.
  - 7 tables with no `sys_scope` (kb_knowledge_base, sys_app, sys_flow_context, sys_pd_context,
    sys_repo_config, sys_user_preference, wf_context).
  - 37 `verified:false` types that the instance confirms, waiting on OD-4.
  - Blocked items: `sys_store_app` 403 (N-1b) and the `sys_hub_flow` PATCH 403 (P-25b).
- **Why it matters (to this role):** wrong key fields mean wrong upsert identity. That is a
  write-correctness defect, not a cosmetic one.
- **Recommendation:** resolve the three key fields before the next minor version (owner
  decision O-4). Flip the 37 confirmed types in one change (OD-4).
- **Existing roadmap link:** O-4, O-5, OD-4, N-1b, P-25b — already tracked; missing: a
  deadline.

### RR-SN-12 — Import-set loads report no transform outcome per row by default (severity: low · judgement)

- **Evidence:** `src/api/importset.ts:40-90` posts to `/api/now/import/{staging}` and
  `/insertMultiple`, and returns the raw `result`. `describeImportRun` exists but is a
  separate call. `insertMultiple` is still unverified (`PDI-VERIFY`).
- **Why it matters (to this role):** a successful 201 on the staging table says nothing about
  whether the transform map inserted, updated, skipped or errored. Data-load sign-off needs
  `sys_import_set_row.sys_import_state` counts.
- **Recommendation:** after a multi-row load, summarise `sys_import_set_row` by
  `sys_import_state` for the import set. Verify `insertMultiple` on the PDI (O-5).
- **Existing roadmap link:** N-68 (done) — missing: the transform-outcome summary.

## 5. Proposed roadmap items

| Temp id | Title                                                                 | Findings           | Priority | Effort | tools/list            | Breaking       | Owner decision        |
| ------- | --------------------------------------------------------------------- | ------------------ | -------- | ------ | --------------------- | -------------- | --------------------- |
| SN-I1   | No GET retry after timeout; timeout vs quota alignment                | RR-SN-01           | P0       | S      | 0 B                   | No (behaviour) | Yes — default timeout |
| SN-I2   | Size guard and serial execution for `check_data_health`               | RR-SN-02           | P0       | S      | +~80 B (desc)         | No             | No                    |
| SN-I3   | Count once in keyset fetch-all; optional read-replica category        | RR-SN-03           | P1       | S      | 0 B                   | No             | No                    |
| SN-I4   | Update-set capture verification and shared-account guard              | RR-SN-04           | P1       | M      | +~40 B (output field) | No             | No                    |
| SN-I5   | Service-account recipe and `doctor` identity checks                   | RR-SN-05           | P1       | M      | 0 B                   | No             | Yes — role matrix     |
| SN-I6   | Per-release-family verification pass (Brazil first)                   | RR-SN-06, RR-SN-11 | P2       | M      | 0 B                   | No             | Yes — PDI access      |
| SN-I7   | Query-shape register for high-volume tables                           | RR-SN-07           | P2       | M      | 0 B                   | No             | No                    |
| SN-I8   | Change API writes on the table-write policy axis                      | RR-SN-08           | P2       | S      | 0 B                   | No             | No                    |
| SN-I9   | Catalog variable validation, `requested_for`, default limit           | RR-SN-09           | P2       | M      | +~60 B                | No             | No                    |
| SN-I10  | History default window and history-set source; import outcome summary | RR-SN-10, RR-SN-12 | P3       | S      | +~40 B                | No             | No                    |

### SN-I1 — No GET retry after timeout; timeout vs quota alignment

- **Scope:** `src/core/http-util.ts` retry branch; settings docs.
- **Acceptance criteria:**
  - A GET that aborts on `SN_TIMEOUT_MS` is not retried unless `SN_RETRY_ON_TIMEOUT=true`.
  - ECONNRESET / ECONNREFUSED on a GET are still retried (test with the fetch double).
  - The settings reference explains the 60 s "REST Table API request timeout" quota and the
    recommended relation of the timeout to it.
  - Unit test: a hanging GET produces exactly 1 request when the flag is off and 3 when it is
    on.
- **Dependencies/gates:** coordinate with N-90. The owner decides the default timeout (30 s
  vs 65 s).

### SN-I2 — Size guard and serial execution for `check_data_health`

- **Scope:** `src/api/ops.ts` `dataHealth`.
- **Acceptance criteria:**
  - When `rowsInScope` exceeds `SN_DATA_HEALTH_MAX_ROWS` (default 250,000) and the call has no
    `scope`, it returns a refusal with a hint before any reference check.
  - Reference checks run with concurrency ≤ 2 (test: max in-flight count observed in the fetch
    double).
  - `stale` defaults to `false`. Each check reports `elapsed_ms`.
- **Dependencies/gates:** none.

### SN-I3 — Count once in keyset fetch-all; optional read-replica category

- **Scope:** `src/api/table.ts` `queryTable`.
- **Acceptance criteria:**
  - In a fetch-all of N pages, only the first request lacks `sysparm_no_count=true` (test
    inspects the params).
  - The end is detected by a short page. The truncation and ACL accounting tests still pass.
  - `SN_BULK_QUERY_CATEGORY` (unset by default) adds `sysparm_query_category` to internal
    fetch-all reads only.
- **Dependencies/gates:** O-5 for `sysparm_query_category` behaviour on the PDI.

### SN-I4 — Update-set capture verification and shared-account guard

- **Scope:** `src/api/updatesets.ts` `applyInUpdateSet`; journal entry.
- **Acceptance criteria:**
  - After an apply, the result carries `captured: boolean`, found from `sys_update_xml` by
    `update_set` and the `name` `<table>_<sys_id>`.
  - `captured:false` adds a warning and is written to the journal.
  - Docs state that update-set binding requires a dedicated, non-interactive account. A
    `doctor` warning appears when the account is interactive.
- **Dependencies/gates:** O-5 for the `sys_update_xml.name` format. Related to N-73.

### SN-I5 — Service-account recipe and `doctor` identity checks

- **Scope:** README / docs/instance, `src/api/privilege.ts` / doctor.
- **Acceptance criteria:**
  - A package → minimal-role matrix is published. Each role is marked verified or unverified.
  - `doctor` reports the following:
    - a warning when the account has `admin`;
    - `identity_type` / `web_service_access_only` state;
    - `snc_read_only` presence when the profile is read-only;
    - the auth type (OAuth vs basic).
  - The README examples no longer use `user: "admin"`.
- **Dependencies/gates:** the owner approves the role matrix. O-5 for the `identity_type`
  field.

### SN-I6 — Per-release-family verification pass (Brazil first)

- **Scope:** `project/PDI-VERIFY-*`, the verifier script, the doctor output.
- **Acceptance criteria:**
  - The `PDI-VERIFY` header records the family and build tag.
  - The verifier runs green on a Brazil PDI, with differences recorded.
  - `doctor` prints `glide.buildtag` or an equivalent release family.
  - The 3 key-field defects are resolved or explicitly scheduled.
- **Dependencies/gates:** O-4, O-5, OD-4; Brazil PDI availability.

### SN-I7 — Query-shape register for high-volume tables

- **Scope:** a doc plus a guard in `table.ts` / scripts fallback.
- **Acceptance criteria:**
  - The register lists every internal query on task, cmdb_ci, sys_audit, syslog\*,
    sys_journal_field with the index it relies on.
  - An unscoped `LIKE` against these tables is refused with a hint.
  - Code-search results state `source: code_search | like_fallback`.
- **Dependencies/gates:** none.

### SN-I8 — Change API writes on the table-write policy axis

- **Scope:** `src/api/change.ts`.
- **Acceptance criteria:**
  - `createChange` / `updateChange` call `assertTableWriteAllowed(CHANGE_TABLE)`.
  - Test: with `change_request` protected and `deny`, the apply is refused before any network
    call.
- **Dependencies/gates:** land before N-71.

### SN-I9 — Catalog variable validation, `requested_for`, default limit

- **Scope:** `src/api/catalog.ts`, catalog tool schema.
- **Acceptance criteria:**
  - The order preview lists missing mandatory variables and invalid choice values, from
    `item_option_new`.
  - The apply is refused when one is missing, unless `force: true`.
  - A `requested_for` parameter is passed to the order call.
  - `listCatalogItems` defaults to limit 20.
- **Dependencies/gates:** O-5 for the variable field names and the order-on-behalf parameter.
  Related to N-72.

### SN-I10 — History default window and history-set source; import outcome summary

- **Scope:** `src/api/history.ts`, `src/api/importset.ts`.
- **Acceptance criteria:**
  - `since` defaults to 90 days.
  - `source: "history_set"` reads `sys_history_line`.
  - A multi-row import result includes counts by `sys_import_state`.
- **Dependencies/gates:** O-5 for `sys_history_line` and `insertMultiple`.

## 6. Owner decisions needed

1. **Default client timeout vs the instance quota (SN-I1).**
   - Options: (a) keep 30 s and stop retrying timeouts; (b) raise it to 65 s and keep the
     retries; (c) both.
   - Recommendation: **(a)**. It is the smallest change, and it removes the load
     amplification without making interactive calls slower.
2. **Service-account role matrix (SN-I5).** Publish an opinionated minimal-role matrix (with
   the risk that some roles are wrong until O-5), or a doctor-only check?
   - Recommendation: publish it, mark unverified roles explicitly, and make `snc_read_only` the
     documented default for read-only profiles.
3. **Brazil PDI (SN-I6).** Request a Brazil PDI as soon as the developer program offers one, and
   schedule the O-4 key-field fixes for the same minor version?
   - Recommendation: yes. Bundle them, so the BREAKING change happens once.
4. **`check_data_health` default threshold (SN-I2).** 250k rows unscoped? Recommendation: 250k,
   configurable per profile.

## 7. Metrics this role would track

| KPI                                                              | Current value                            | Target                                |
| ---------------------------------------------------------------- | ---------------------------------------- | ------------------------------------- |
| Max concurrent instance transactions per agent call (worst case) | 3 per GET × 4 slots = 12 (code analysis) | ≤ 4                                   |
| COUNT(\*) queries per 10k-row fetch-all                          | 10 (page size 1,000)                     | 1                                     |
| Table and field names verified on the current release family     | 1,345 names on Zurich; 0 on Brazil       | 100% on each GA family within 30 days |
| Open BREAKING key-field defects                                  | 3 (O-4)                                  | 0                                     |
| Update-set applies with verified capture                         | not measured (no check)                  | 100% reported                         |
| Docs examples that use an `admin` account                        | 3 (README:598, 712, 1758)                | 0                                     |
