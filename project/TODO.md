# TODO — status as of 2026-09-23

> **2026-09 update.** On 2026-09-02 `npm run check` was **red** on its last step
> (`npm audit --omit=dev --audit-level=high` — two HIGH transitive advisories via
> `@modelcontextprotocol/sdk@1.29.0`); the five-lens [DEEP-REVIEW-2026-09.md](archive/DEEP-REVIEW-2026-09.md)
> and the proposed v3.0 tracker [ROADMAP-V3.md](ROADMAP-V3.md) were written that day. On
> 2026-09-03 **H-1** fixed the gate (green locally, uncommitted). On 2026-09-09 a second-pass
> gap analysis ([GAP-ANALYSIS-2026-09.md](archive/GAP-ANALYSIS-2026-09.md) — 67 findings) extended the tracker with
> **H-10, H-11, S-13, M-9, D-9, E-9** and B11–B13; see "Active (2026-09-02)" below. H-2
> (2026-09-09), E-9 (2026-09-10), H-10, S-1, H-8 and H-9 (2026-09-23) are done since (local gate
> green at 519 tests, uncommitted). On 2026-09-23 the SDK parity epic (P-1…P-29, owner gates
> O-5…O-9) was added in [SDK-PARITY.md](SDK-PARITY.md) — post-3.0, none of it in the 3.0 cut.
> Everything after that section reflects the 2026-07-06 state.
>
> **As of 2026-07-06, no active/actionable dev work remained.** Everything completed is in [DONE.md](DONE.md) — the
> morning review (22/22), Phases 6–8, five full-review passes, **Phase 9 / v2.0** (DF-0…DF-6
> trust + depth + reach; published 2026-06-22 — npm `servicenow-mcp-ai` now at 2.0.1, MCP
> Registry, Claude Code plugin, VS Code extension 2.0.1), **full ServiceNow authentication
> coverage** (OAuth 2.1 Authorization Code + PKCE login, JWT bearer, API key, bearer token, `none`,
> mutual TLS), the 2026-07-01 → 02 gap sweep (GA-1…GA-6) and the 2026-07-03 landing of the
> **dark Jira scaffold** (`ad2799c`, with the http-twin parity drift guard). Gate green at
> **406 tests** (coverage 95.41/84.94/98.58, audit 0). What is left below is **not pending dev
> work**: deferred design decisions on the dark Jira surface (ARCH-10/11b/12b/14), a
> trigger-gated backlog and owner actions (GA-8 distribution, DX-3 GIF, GA-9 PDI e2e).
>
> Marker key — ⏳ **deferred** (activates only when its trigger fires) · 👤 **owner action**
> (needs Ivan, not a dev task).
>
> Next moves are owner decisions, not dev tasks — see
> [BUSINESS-REVIEW-2026-07.md](archive/BUSINESS-REVIEW-2026-07.md) §7 + §8.4 (the two-week plan) and
> [UX-REVIEW-2026-07.md](archive/UX-REVIEW-2026-07.md) §11 (the UX backlog); "Optional" items (Export
> API, PDI e2e, vitest) on request. The work chronology is in [WORKLOG.md](../WORKLOG.md).

## Active (2026-09-02)

- [x] **P-4 / P-7 · SDK 4.13 re-pin** — done 2026-10-09 (owner approved): `@servicenow/sdk` and
      `SDK_BASELINE` at 4.13.6 (O-7), `DatabaseView` promoted out of `SDK_NEXT_APIS`, `Interceptor`
      registered as `interceptor` (`sys_wizard`, verified:false). The P-7 guide-audit descriptors
      (CORE-18, 19, 21 and `sys_ui_formatter` in CUI-6) landed 2026-10-09 (0dd9fda); CORE-20 table
      augments stay columns of `table`.
- [x] **H-1 · Make the gate green again** — done 2026-09-03 (uncommitted): SDK `^1.30.0`, zod
      `^3.25.0`, lock-only `npm audit fix` for the transitive `fast-uri` / `ip-address` / `hono` /
      `@hono/node-server` / `qs` / `body-parser`; `npm run check` green (406/406, audit 0),
      CHANGELOG `[Unreleased]` → Security. Still open from the item: cut **2.1.0** (owner:
      version bump + tag), and two dev-only HIGH advisories (`brace-expansion`, `js-yaml`) that
      the gate does not cover — ROADMAP-V3 §H-1.
- [x] **H-2 · Credential host binding** — done 2026-09-09 (uncommitted): an instance change on a
      configured profile needs `user` + `password` in the same call (`CREDENTIALS_INCOMPLETE`, nothing
      written), the elicitation confirmation fails closed unless `SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1`,
      8 new tests (414/414). Open inside the item: the allow-list / `isBlockedHost` bullet is deferred
      to H-6 as an open decision (keep the documented opt-in, a per-client `HostPolicy` flag, or
      strict for both) — ROADMAP-V3 §H-2.
- [x] **E-9 · Process lifecycle + bounded state** — done 2026-09-10 (uncommitted): crash handlers
      log one structured secret-free line and exit 1 (SIGTERM = SIGINT), `dispose()` in
      `src/core/lifecycle.ts` resets the singletons on signals / HTTP session close, the HTTP
      transport fails startup on a bind error, LRU schema cache `SN_SCHEMA_CACHE_MAX` (256) with
      counters in `get_status`; 17 new tests (431/431). H-10's dispatcher / queue / breaker hooks
      were wired into `dispose()` on 2026-09-23 — ROADMAP-V3 §E-9.
- 👤 **Owner decisions that gate v3.0** (ROADMAP-V3 §O): **O-1** ARCH-14 go/no-go (also settles
  ARCH-10 / 11b / 12b, scheduled as E-8 / M-2 / E-4); **O-2** PDI credentials for the live smoke
  (GA-9 → E-6); **O-3** distribution + KPI checkpoint (GA-8, DX-3 GIF; the 2026-08-01 checkpoint
  passed unreviewed — next at 3.0.0 + 30 days); **O-4** approve the breaking-change register
  (B1–B13; B11–B13 were added on 2026-09-09) before any 3.0.0-beta.
  - **Decided 2026-10-01:** **O-4 approved** — the whole register B1–B13 ships in 3.0 (B10 stays
    out: ARCH-14 is deferred). **O-7 approved** — `@servicenow/sdk` 4.12.2 (exact) as a dev
    dependency, the P-29 type-check oracle. **O-1 / ARCH-14 deferred** — E-8 stays blocked, the
    Jira scaffold stays dark and untouched. **S-12 approved** — `acorn` as a runtime parser
    dependency with the regex rules as fallback. O-2, O-3 and O-5 remain open.
  - **Decided 2026-10-09:** **O-1 = NO-GO** — the dark Jira scaffold is deleted (E-8, B10,
    [ADR 0007](adr/0007-delete-jira-scaffold.md)); ARCH-10, ARCH-11b, ARCH-12b and ARCH-14 below
    are closed by it.
- [x] **H-10 · HTTP client resilience + identity** — done 2026-09-23 (uncommitted): one
      `getDispatcher(host)` for proxy (`SN_HTTPS_PROXY` → `HTTPS_PROXY` / `HTTP_PROXY` + `NO_PROXY`)
      and TLS without a client cert, identifying `User-Agent` (+ `SN_USER_AGENT_SUFFIX`),
      `SN_DEADLINE_MS` / `SN_RETRY_AFTER_MAX_MS`, bounded per-host queue (`SN_MAX_QUEUE`,
      `SN_QUEUE_TIMEOUT_MS` → `BUSY`), `UPSTREAM_HTML` shaping, OAuth through the shared primitive,
      host:port / IPv6 allow-list policy, opt-in breaker (`SN_BREAKER_*` → `CIRCUIT_OPEN`), `code` /
      `hint` on errors, `get_status.http`; 50 new tests (481/481). Slipped to 3.x: rate-limit header
      parsing into telemetry (L1-07 second half) — ROADMAP-V3 §H-10.
- [x] **S-1 · Inherited + global business rules in the trace** — done 2026-09-23 (uncommitted):
      `traceTableEvent` and `generateTableFlow` walk `getTableChain` (now cached) and query
      `collectionIN<chain>^ORglobal=true…^ORDERBYorder`; entries carry `table` / `inherited_from` /
      `global`, the diagram gets inherited / global lanes, flow triggers / workflows / notifications
      are filtered by the traced operation; 5 new tests (486/486) — ROADMAP-V3 §S-1.
- [x] **H-9 · CI + version hygiene** — done 2026-09-23 (uncommitted): SHA-pinned actions,
      least-privilege `permissions`, `concurrency` / `timeout-minutes` / `actionlint` in `ci.yml`,
      `pack:check` tarball guard (`!build/**/jira/**`), `sync-version` + `npm version` hook +
      `test/version-sync.test.js`, checksummed `mcp-publisher` 1.8.1, `.env*` ignore rules,
      Prettier idempotency; 8 new tests (494/494) — ROADMAP-V3 §H-9.
- [x] **H-8 · Platform corner-case pins** — done 2026-09-23 (uncommitted): `INSTANCE_HTML_RESPONSE` + wake hint for a 2xx HTML page, `fetchAll` past ACL-short pages with `truncatedReason` /
      `filtered`, `display_value=all` pins, attachment edges (`data:` URLs, `sizeBytes`), plugin
      inactive vs missing, drift / where-used `caveats`; 25 new tests (519/519 after the port onto
      H-10 / S-1 / H-9). Open: plugin ids and the hibernation wording are unverified live;
      snapshot's scan-limit message — ROADMAP-V3 §H-8. With it the 2.1.0 hardening batch (items
      1–5) is complete; the 2.1.0 cut is the owner's (commit, `npm version minor`, tag).
- [x] **Instance-documentation analysis · S-14…S-16** — done 2026-09-23 (docs only, uncommitted):
      `project/INSTANCE-DOCS-ANALYSIS-2026-09.md` (17 findings `ID-01`…`ID-17` over the docs store,
      the Mermaid generators, the `document_table` prompt and the missing table / app / instance
      documents) added **S-14** docs store v2 + generator depth (must-have, after S-2), **S-15**
      document generators (stretch, after S-4/S-7) and **S-16** native discovery (with D-8) to
      ROADMAP-V3 and refined S-7, S-11, M-3, M-4, M-8, M-9, E-7, H-5, D-8. No code changed.
- [x] **Instance-documentation analysis, second pass · ID-18…ID-29** — done 2026-09-25 (docs only,
      uncommitted): `project/INSTANCE-DOCS-ANALYSIS-2026-09-25.md` reassessed `ID-01`…`ID-17`
      against the batch-6 tree (7 closed, 3 partial, 7 open — `document_app` and the `security`
      kind unblocked by P-1 / S-4 / P-5 / S-3) and added 12 findings: per-writer generator
      version, manifest `runs` / `partial`, `.json` companions, compare report placement,
      registry-driven `document_app` over `listArtifacts`, the `security` kind from
      `securityScan()`, named E-7 collectors, prompt gating (M-8's ID-16 bullet overstated —
      `registerPrompts` is unconditional), Mermaid truncation on two builders, the shared
      metadata-only guard, writer goldens, the registry catalog in discovery. ROADMAP-V3 S-15 /
      S-16 / M-4 / M-8 / S-7 / E-6 / E-7 + rows 53–54, SDK-PARITY P-21, mirrors. No code changed.
- [x] **H-5 · Journal v2 + deep redaction** — done 2026-09-23 (uncommitted): v2 journal lines
      (ULID `id`, `result` applied/failed/refused, `before` on update/delete, `client`, sha256 `prev`
      chain with `write-journal.head`), rotation at `SN_JOURNAL_MAX_BYTES`, one line per batch
      sub-request (`batch_id`), `local_write` and `config` entries, deep redaction at `ok()`/`fail()`,
      CSV formula guard + BOM. Deferred: `plan_token` (H-3), `update_set` (S-6), revert (S-2), batch
      `before`, `SN_BATCH_MAX_REQUESTS` (H-4) — ROADMAP-V3 §H-5.
- [x] **H-6 · Outbound hardening** — done 2026-09-23 (uncommitted): redirects blocked
      (`REDIRECT_BLOCKED`), `SN_MAX_BODY_BYTES`, IPv6-aware host guard (settles the H-2 allow-list
      decision: a suffix entry never opens an internal host), TLS-off warning, OAuth callback path +
      `state`, upload caps + MIME allow-list, docs store guards, `send_email` recipient allow-list.
      **Behaviour change for O-4:** `send_email` now fails closed to `sys_user` addresses unless
      `SN_EMAIL_ALLOWED_DOMAINS` is set (`*` = old behaviour). Deferred: connect-time DNS check,
      email body preview cap (H-3), size cap on `docsWriteRaw` — ROADMAP-V3 §H-6. Gate after the
      merge: 568/568.
- [x] **E-3 · Runtime container** — done 2026-09-23 (uncommitted): `src/core/runtime.ts`
      (`createRuntime()` / `installRuntime()` / `runWithRuntime()` / `currentRuntime()`, lazy
      parts for caches, tokens, telemetry, queue, breakers, dispatchers, profiles, plugin
      availability); passed to `registerAllTools`; `dispose()` in place; `_reset*` hooks deleted,
      tests use `freshRuntime()`. Session registry + task store join as parts with H-7.
- [x] **S-2 · Journal-based revert** — done 2026-09-23 (uncommitted): opt-in `revert` package,
      `servicenow_list_writes` + `servicenow_revert_write` (plan/apply, `STALE_RECORD` drift guard
      unless `force`, `NOT_REVERTIBLE` with a reason, `reverts:<id>`); journal lines record `tool`
      and `after_mod_count`. 69 tools in 19 packages. Owner questions: core profile or opt-in;
      CMDB create stays non-revertible; redacted `before` refuses the whole entry (partial opt-in?).
- [x] **S-14 · Docs store v2 + generator depth** — done 2026-09-23 (uncommitted): `sn_*`
      frontmatter + `sn_source_hash`, `unchanged` re-runs, manual blocks, `DOC_GENERATED` both ways,
      `index.json` manifest, docs tool filters, `src/api/mermaid.ts`, ER `columns` / `max_columns` /
      `depth`, table-flow `operation`; defaults byte-identical (goldens). Owner questions: detailed
      ER as the 3.0 default (BREAKING); the metadata allow-list now includes `sys_ui_policy`,
      `sys_ui_action`, `sys_transform_script`, `sys_ws_operation`, `sysauto_script`. Gate after the
      E-3 + S-2 + S-14 merge: 621/621.
- [x] **M-3 · `extra` plumbing** — done 2026-09-24 (uncommitted): call context (`runWithCall`),
      cancellation → `CANCELLED` (no retry), throttled progress (250 ms), log context. Owner
      questions: a cancelled write has an unknown outcome (hint points to the journal); throttle 250 ms.
- [x] **S-3 · Security-scan extension** — done 2026-09-24 (uncommitted): `src/api/security.ts`,
      seven checks with per-check `available`. Owner questions: severities; `table-no-acl` only for
      `u_` / `x_` tables; `public` role = everyone; 404 on ACLs now degrades; report header `Item`.
- [x] **S-8 · Table API completeness + cursor paging** — done 2026-09-24 (uncommitted): new query
      params, keyset paging, encoded-query resource, `servicenow_upsert_record` (70 tools). Owner
      questions: upsert joins the core profile (16 → 17); `expected_action` / `expected_sys_id` until
      H-3 plan tokens; new code `AMBIGUOUS_KEY`; pack size now close to the 600 KB limit.
- [x] **P-1 · Artefact registry** — done 2026-09-24 (uncommitted): `src/core/artifacts/registry.ts`,
      byte-identical derived views. Owner questions: `sdkSince` convention (`"<=3.0"` / null);
      natural keys beyond `script_include`; widen the capability probe to the new seeds.
- [x] **S-4 · Script-intelligence widening** — done 2026-09-24 (uncommitted). Owner questions:
      unverified field names (`data_source`, `validator`, `rest_message_fn`); `dictionary_script`
      `baseQuery`; sweeps now 24 queries instead of 9; `scope` on the remaining script tools.
- [x] **S-13 · Capability preflight v2** — done 2026-09-24 (uncommitted). Owner questions: extended
      `check_capabilities` instead of a new tool; plugin negative TTL 5 min → 60 s; matrix is
      informational (no doctor verdict change); 5xx = `unknown`, cached 60 s.
- [x] **D-2 · Credentials model completeness** — done 2026-09-24 (uncommitted). Owner questions:
      `api_key` elicitation-only; `password` argument kept (move to elicitation = O-4 candidate);
      `SN_TOKEN_FILE` wins over `SN_BEARER_TOKEN`; auth env vars not yet in the settings manifest.
- [x] **P-3 / P-4 · SDK-managed detection + release tracking** — done 2026-09-24 (uncommitted).
      Owner questions: O-6 authority order; bump `SDK_BASELINE` to 4.13.0; allow-list
      JsInclude / CssInclude (no docs page); `~` expansion in `SN_SDK_PROJECT_DIRS`.
- [x] **M-8 · Small protocol fixes** — done 2026-09-24 (uncommitted). Owner questions: lenient
      `sysId` / `tableName` patterns; `encodedQuery` cap 8000 (spec said 4000); list caps (fields 200,
      sys_ids 500, recipients 50, batch 1000); optional filters now reject `""`; `SN_LOG_NOTIFY_RATE`
      default 20/s; private SDK `isMessageIgnored` reached via a guard.
- [x] **S-9 · Structural where-used** — done 2026-09-24 (uncommitted). Owner questions: default ON
      (up to 9 extra reads per call); unverified catalog / flow-input / report columns; catalog
      mapped fields match on any table.
- [x] **E-5 · Observability** — done 2026-09-24 (uncommitted). Owner questions: logger now masks
      credential keys and applies `SN_REDACT_*`; `SN_LOG_FILE` always JSONL, 5 generations fixed;
      `/metrics` needs `SN_HTTP_TOKEN`; `diagnostics_channel` names become public API.
- [x] **P-5 · Generic artifact reads** — done 2026-09-24 (uncommitted). Owner questions: opt-in
      package vs reader/developer (SDK-PARITY §5(d)); list default 50 / max 1000, 200 children per
      level; which types declare `secretFields`.
- [ ] **Pack size (blocking `npm run check`):** 1416.6 KB unpacked after batch 12, over the 800 KB `pack:check` ceiling (1298.7 KB after batch 11, 1222.8 KB after batch 10, 1136.2 KB after batch 9, 984.5 KB after batch 8, 868.7 KB after batch 7, 794.0 KB after batch 6) — raise the ceiling
      or trim the package before the next feature batch. S-15's first writer
      (`src/api/document.ts` + goldens) will not fit under 800 KB — decide before it starts
      (INSTANCE-DOCS pass 2 §7).
- [x] **S-5 · Trace v2** — done 2026-09-25 (uncommitted). Owner questions: lane placement in the
      chain is a modelling choice; scheduled jobs matched by `scriptLIKE<table>` (false positives);
      transform maps on the traced table only; script-fired events missed; lane columns unverified (O-5).
- [x] **S-7 · Snapshot/compare v2** — done 2026-09-25 (uncommitted). Owner questions: snapshot
      default now all eleven sections (7 more reads) vs the old four; `renamed` status lowers drift
      count for renames; property redaction heuristic; should the manifest read `sn_*` from `.json`.
- [x] **M-4 · Completions + reference resources** — done 2026-09-25 (uncommitted). Owner
      questions: prompt arguments now capped at 200 chars; docs resource content wrapped in the
      boundary (text changes); docs template `{+path}`; `tools-reference` always on; boundary on
      tool results left out.
- [x] **P-6 · explain_artifact** — done 2026-09-25 (uncommitted). Owner questions: opt-in package
      vs reader/developer; budget split 1/20 per value, 4/5 per result; `whenFields` descriptor field.
- [ ] **Next up (2026-09-24):** **H-3** plan-token binding + elicitation (BREAKING parts wait for
      O-4; the opt-in part landed 2026-09-26, see below). H-11 and every BREAKING item wait for O-4. Five **high** findings gate 3.0.0: L1-03 and
      L1-10 (done in H-10), L3-01 (H-11, BREAKING → O-4), L5-01 (M-6/E-6), L6-01 (D-2).
- [ ] **Owner decisions from the 2026-09-25 instance-docs pass:** (a) raise the `pack:check`
      ceiling (1 MB) or trim before S-15; (b) accept a generic `servicenow_document_kind` tool
      (73rd) so the `security` kind ships with `document_table` before the E-7 split, or hold it
      for `document_instance`; (c) restate M-6's tool-count budget (86 today after batch 9).
- [ ] **Owner decisions from batch 8 (2026-09-25):** (a) S-11 — default `SN_OVERSIZE_TO_FILE` on?
      keep `readOnlyHint` on `format:"file"` reads or refuse them under `SN_READONLY`? export
      retention / size cap under `exports/`; the `preview_truncated` name; CSV columns come from the
      first page only. (b) S-6 — always restore the previous update set? preference writes are not
      journalled; the switch lock is per process; `canSet` is a heuristic; scoped sets also switch
      `updateSetForScope<app>`; fail closed on an invalid `SN_UPDATE_SET`? bind the other write
      packages (catalog, change, knowledge) later? (c) P-9 — keep the `scriptToolsOptIn` /
      `extended` split, and when do opt-in types join lint and snapshot; `wf_activity` parent
      field and `FLOW_CHILDREN` tables need a live instance (O-5). (d) P-7 — `available`
      semantics (table present vs readable); field names unverified (O-5); `choice_set` has no
      `sdkSince`. (e) `test/cancel-progress.test.js` "a cancelled snapshot stops issuing requests
      within one retry window" is timing-sensitive under load — widen its headroom?
- [ ] **Owner decisions from batch 9 (2026-09-26):** (a) S-10b — syslog level values, the
      `sys_trigger` states treated as stuck, the `sys_email` fields, reading `sys_semaphore`, Stats
      API `having` support, the orphan-reference query and its ACL effect, `javascript:` clauses in
      queries; is `data_health` right in `ops`? (b) P-8 — tables / fields unverified (O-5), the
      licensed families (O-9); child rows now accumulate across parents. (c) S-10a —
      `set_property` binds to the update set?; the secret-name regex, and secret properties cannot
      be reverted; no property create; the `import_set_run` fields; the IRE identify endpoint and
      `sysparm_data_source`; the `since` `javascript:` clause; `sys_audit` / journal / directory
      field names; CI/CD status codes. (d) S-15 — 93 `verified:false` types listed in the app
      document; `sys_app` / `sys_store_app` fields; property values omitted from documents; ID-23:
      expose `security` via `document_kind` or `document_instance`?; where-used lost its 40-edge
      Mermaid cap (now `mermaidTruncated`). (e) E-7 — a cancelled compare now throws `CANCELLED`;
      collector signatures are ctx-first; `expectJson` skipped. (f) The pack ceiling (1136.2 KB).
- [ ] **Owner decisions from batch 10 (S-15, 2026-09-26):** (a) ID-23 — `security` is reachable
      only through `document_instance({kinds:["security"]})`; ship `servicenow_document_kind`
      (88th tool) or leave it there? (b) the README is written first, so its links may point at
      documents a cancelled run never reached (a Caveats line says so) — accept, or write it last?
      (c) with no `tables` / `apps` the run writes only the README, the requested kinds and
      `artifact-types.md` — auto-select (e.g. every custom scope) instead? (d) the 50-target cap
      on `tables` and `apps` each; (e) `catalog` lists only variables attached directly to an item
      (not variable-set variables), and `integrations` reads descriptive fields only — the
      `sc_cat_item.sc_catalogs`, `item_option_new.type` codes and `sys_ws_definition` /
      `sys_rest_message` / `sys_data_source` field names need a live instance (O-5); (f)
      "Collected in this run" on `artifact-types.md` means "a document of this run read the type's
      table", not "records found"; (g) `depth` (S-16) not shipped yet; (h) tool count 88 after the batch 10 merge — M-6's
      budget; (i) the pack ceiling — 1416.6 KB unpacked after batch 12 (1298.7 KB after batch 11).
- [ ] **Owner decisions from batch 10 (M-9)** (2026-09-26, `SN_EXPERIMENTAL_TASKS`): (a) native
      task augmentation — advertise `tasks.requests.tools.call` and register the task tools with
      the SDK's `registerToolTask` (`execution.taskSupport:"optional"`)? The SDK then turns every
      plain call of those tools into a blocking create-and-poll, so M-9 ships the `run_as_task`
      argument only. (b) Clients without the `tasks/*` methods (most chat clients today) get a
      handle they cannot poll — add a model-facing `servicenow_task_status` / `_task_result` tool?
      (c) No cap on the number of retained tasks / result bytes (1 h TTL only) — add one
      (e.g. 50 tasks per runtime)? (d) The TTL runs from creation, not from completion, and a
      client-requested `ttl` can only shorten it. (e) The SDK API is marked experimental — pin
      the SDK minor while M-9 stays in, or drop M-9 on the first breaking change? (f) The ATF
      `wait_seconds` loop and a task both bound a run — cap `wait_seconds` differently when
      `run_as_task` is set? (g) Add `document_instance` / `document_app` to `TASK_TOOLS` once
      S-15 lands (ID-15). Done 2026-10-09.
- [ ] **Owner decisions from batch 10 (P-16, 2026-09-26):** (a) a new opt-in `ui` package for
      `servicenow_explain_portal` (SDK-PARITY §5(d)) — or fold it into `artifacts`? (b) Every SP
      field name is unverified (O-5): `sp_column.size`, rows nested in a column via
      `sp_row.sp_column`, `sp_page_route_map.portals` as a sys_id list, `sp_instance.widget_parameters`
      as JSON, the m2m include tables. (c) Bounds: full layout for 5 pages (`LAYOUT_PAGES`), depth
      default 3 / max 6 — right defaults? (d) Classic widget options stored in `sp_instance`
      columns (not `widget_parameters`) are not mapped; a `widget_parameters` key absent from
      `option_schema` lands in `unknownOptions`. (e) The pack grows further past the 800 KB ceiling.
- [ ] **Owner decisions from batch 10 (M-6, 2026-09-26):** (a) the `tools/list` budget — measured
      `all` 124,050 / `core` 30,560 against the 45,000 / 14,000 targets; the test ratchets at
      125,000 / 31,000 ("owner to restate (M-6 budget)"); after the batch 10 merge (88 tools) `all`
      measured 127,239 and the ratchet moved to 128,000. Restate, or trim? (b) The bulk is parameter
      descriptions; trim them further, and should `core` keep `get_status`'s ~3.6 KB output schema?
      (c) `structuredContent` duplicates the text payload (e.g. `query_table`, `get_record`) — keep
      it always, or make it opt-in? (d) Manifest `since` is 2.0.1 for every tool — backfill from
      history? (e) Tools added by later batches must regenerate the manifest and raise the budget
      constants (about 760 bytes of headroom on `all` after batch 10). (f) M-9 interplay: a task-capable
      tool's output schema has every field optional while `SN_EXPERIMENTAL_TASKS` is on, so the
      task handle validates — accept, or give handles their own result type?
- [ ] **Owner decisions from round 9 (token-optimization plan, 2026-10-05):** see
      [TOKEN-OPTIMIZATION-PLAN-2026-10.md](TOKEN-OPTIMIZATION-PLAN-2026-10.md) §7. O-10 (a) budgets
      as data with an automatic tightening ratchet; (b) restated targets — `discovery` ≤ 22 KB
      (stretch 14 KB), `all` ≤ 120 KB (with N-54) non-default — and the N-58 / N-63 wire changes
      (**(a) and (b) decided 2026-10-06**, [ADR 0006](adr/0006-tools-list-budget-ratchet.md)); (c) shallow
      output schemas (N-60; **decided 2026-10-09**, shallow on the wire, full in the reference — done in 90dea84); (d) N-18 eval models and API budget (**decided 2026-10-09**: `claude-sonnet-5-5`, three repeats with McNemar, baseline and after each, roughly $60–90 in all; the owner provides `ANTHROPIC_API_KEY` and the run waits for it). O-19 (d) per-connection
      `tools/list` vs M-5 / N-63 (**decided 2026-10-10**, fixed per server on the 2026-07-28 wire, [ADR 0008](adr/0008-full-protocol-2026-07-28-conformance.md)). O-21 (**decided 2026-10-09**): (a) compact reads (N-62) are opt-in only, defaults stay
      byte-identical; (b) 48 k result cap with the automatic file result on, and the `list_tables`
      default limit ruled a bug fix (N-61, done); (c) Claude Code `_meta` hints (N-65) on by default
      with an env off switch; (d) an opt-in `SN_STRUCTURED=0` that drops `structuredContent`. Done 2026-10-09: (a) fc2f949, (c) b9e46e7, (d) 9d92986 (`SN_STRUCTURED=false`). O-4 amendments: proposed B14 selective consolidation (N-64) or a name freeze; `discovery` as default and `attachment` out of `core` (N-63).
- [ ] **Owner decisions from batch 11 (D-4, 2026-09-26):** (a) client syntaxes not verified
      against a live client — Zed `context_servers` (`"source": "custom"` + flat `command` /
      `args`; older Zed builds nest `command: {path, args}`), the JetBrains AI Assistant menu path
      (Settings → Tools → AI Assistant → Model Context Protocol → Add → As JSON), the Cursor web
      redirect `https://cursor.com/en/install-mcp?...` and the Windsurf / Cline file locations;
      Gemini CLI is documented through `settings.json` only (no `gemini mcp add` line, its
      handling of `-y` after the command was not confirmed). Click-test the three README buttons on
      github.com once pushed. (b) No link carries an `env` block, so a fresh install still needs
      the env file / `login` / `set_credentials` — accept, or add VS Code `inputs` (prompted,
      `password: true`) to the VS Code link? (c) The server key is `servicenow` everywhere
      (matches the plugin manifest); the MCP registry name is
      `io.github.IvanBBaev/servicenow-mcp-ai` — keep the short key? (d) D-1 (`init` wizard) could
      later write these client configs itself.
- [ ] **Owner decisions from batch 11 (M-1, 2026-09-26):** (a) the core `tools/list` budget rose
      31,000 → 32,000 (measured core 31,151, all 127,830 — about 170 bytes of headroom on `all`;
      batch 11 merges that add tools must raise it): `get_status` v2 declares only anchor keys
      (`server`, `policy`, `writes`, `profileDetails`) in its passthrough output schema — declare
      the rest (`redaction`, `docs`, `limits`, `profileSource`, `writeMode`) at ~450 more bytes?
      (b) `profiles` stays a string list for compatibility; rename `profileDetails` to `profiles`
      in the O-4 breaking window (M-2)? (c) Per-profile `env` (dev/test/prod) has no source until
      H-11 / L3-03 — `profileDetails` omits it. (d) The instructions name the active instance host
      but never the user or the env-file path (get_status shows the path) — acceptable? Cap 2 KB,
      measured 511 B (core, configured) / 868 B (all packages, unconfigured). (e) `NOT_CONFIGURED`
      is tagged on the existing "not configured" / "requires …" errors (messages unchanged); M-2
      makes `code` mandatory. (f) Icon: a brand-neutral inline SVG (not the ServiceNow logo);
      `websiteUrl` is the GitHub Pages site. (g) Write counters are per runtime (reset on dispose),
      counted per journal line (a batch counts its sub-requests); plans are not counted.
- [ ] **Owner decisions from batch 11 (P-10/P-13, 2026-09-26):** (a) `servicenow_explain_flow`
      sits in the `flows` package, so the `reader` / `developer` profiles gain it — keep it there, or
      move it to an opt-in package (`artifacts`, a new `explain`)? (b) The `tools/list` budget moved
      again: `all` measured 129,083 with 89 tools and the ratchet is now 130,000. (c) `get_flow` does
      not delegate to `explain_flow` (S-5 bullet, SDK-PARITY P-10): its `FlowDetail` contract differs,
      so a delegation is a behaviour change — do it under O-4, or leave `get_flow` as the light read?
      (d) Every Flow Designer and workflow field is unverified (O-5): the `values` compression
      (plain JSON vs base64 + gzip JSON), v1 vs `_v2` authority when a step is in both (the `_v2` row
      wins today), how snapshot children are keyed (`flow = <snapshot sys_id>`), the `label_cache`
      shape, `wf_activity` keyed by `workflow_version`, the `sys_flow_log` level values (`error` or
      `2` counts as an error) and the `wf_context` state values (`executing`). No PDI fixtures yet;
      the Workflow Studio tree check of the acceptance criterion is still manual. (e) `runs` and
      `migration` read runtime tables (`sys_flow_context`, `sys_flow_log`, `wf_context`) — opt-in,
      off by default; acceptable in `flows`? (f) Bounds: runs default 5 / max 20, 10 log errors per
      run, step depth 32, 50 inputs per step, 1,000-char raw preview — right defaults? (g) The pack
      grows further past the 800 KB ceiling.
- [ ] **Owner decisions from batch 11 (E-6, 2026-09-26):** (a) O-2 — the redacted PDI fixture
      corpus and the optional live smoke job (secrets-gated) are not started. (b) `--help` /
      `--version` spawn tests wait for D-1 (no such flags today). (c) L9-03 folder layout stays
      deferred — the new suites sit flat in `test/`. (d) Property runs: 100 per property by
      default (`SN_FC_RUNS`, fixed `SN_FC_SEED`); add a nightly or CI leg with `SN_FC_RUNS=800` and
      a random seed? (e) Extension lint: `extension/` has no ESLint config and the root config
      ignores it — the new CI job typechecks only; add a lint config there, or lint it from the root?
      (f) The policy-glob property covers the host and MIME allow-lists only; the table glob lands
      with H-11 / L3-01. (g) Three defects found by the properties, kept as `todo` tests, src
      untouched: **F1** — `formatEnvValue` writes a quoted value that ends in `\` as `'…\'`; dotenv
      reads `\'` as an escaped quote and swallows the next line (e.g. a password `pa#ss\` loses the
      following key); **F2** — U+2028 / U+2029 are written unquoted and break dotenv's line split;
      **F3** — `docsWriteRaw` accepts `index.md` / `index.json`, which the store silently rebuilds
      after the write. Fix F1/F2 in the env writer and reject the store's own files in F3?
      **Update 2026-10-01 (E-2):** F1 and F2 are resolved by the switch to Node's env-file
      parser (`process.loadEnvFile` / `util.parseEnv`), which has neither hazard; both are now
      regular tests. **F3 resolved 2026-10-09 (owner):** `docsWriteRaw` refuses the store's root `index.md` / `index.json` with 400; the todo test is a regular test.
- [ ] **Owner decisions from batch 12 (S-16/D-8, 2026-09-26):** (a) The S-16 acceptance says
      `document_instance({depth:"apps"})` produces the four-file set; as built, `depth` is
      cumulative — `apps` writes `overview.md`, `apps.md` and `tables-<scope>.md`, and
      `artifacts-<scope>.md` needs `depth:"artefacts"`. Keep the tiers, or make `apps` write all
      four? (b) Without `apps`, discovery scopes come from `sys_app` only (non-global, capped at
      `INSTANCE_TARGETS_MAX`, the rest reported as skipped) — store apps (`sys_store_app`) are
      not included; add them? (c) ~~The D-8 `PreToolUse` hook waits for H-3 / O-4~~ — **done
      2026-10-01:** `hooks/hooks.json` + `hooks/require-plan-token.mjs` deny a token-less
      destructive `apply:true` (presence check only, fails open, honours
      `SN_DESTRUCTIVE_CONFIRM=off`; `SN_WRITE_MODE=apply` is not visible to it). (d) Slash
      commands (`commands/*.md`) were skipped — the plugin skills are already invocable as
      `/servicenow-mcp-ai:sn-*`; add thin command wrappers anyway? (e) The harness
      `~/.claude/skills/discovery` should delegate to `servicenow_document_instance({depth})` when
      a configured profile exists and keep `curl` as the fallback — a harness change outside this
      repo, not done. (f) `pack:check` stays over the 800 KB ceiling (the skills are not in the
      tarball; the growth is `src/api/document.ts`).
- [ ] **Owner decisions from batch 12 (P-11, 2026-09-26):** (a) `explain_flow` now expands
      subflow / action calls by default (`depth` 1): every flow read costs up to four more bounded
      reads per level (actions, their steps, called subflows and their step tables) and expands OOB
      spoke actions too — keep the default at 1, or make it 0 (opt-in expansion) or custom-scope only?
      (b) The bounds — depth max 3, 20 distinct callees per call, a cycle marked, not re-read — right?
      (c) Unverified fields (O-5): `sys_hub_step_instance` (`action`, `label`, `step_type`, `values`),
      `sys_hub_action_input` / `_output` with `element` falling back to `name`, `sys_decision_input.model`,
      `sys_decision_question` (`condition`, `answer`, `default_answer`, `label`) and
      `sys_decision.answer_table`; no PDI fixture yet. (d) `decision_table` is `R` + `X` now; the
      SDK-PARITY target is R/X/A/S — the `A`/`S` tiers wait for P-17 / P-20. (e) `kind:"action"` does
      not read `sys_hub_action_type_snapshot` (published vs draft) — a later item? (f) The `tools/list`
      `all` budget measured 129,926 (ratchet unchanged at 130,000; core 31,151) and the pack grows
      further past the 800 KB ceiling (1,312.7 KB).
- [ ] **Owner decisions from batch 12 (P-17, 2026-09-26):** (a) `servicenow_artifact_dependencies`
      sits in the opt-in `artifacts` package — keep it there (it is not in `reader` / `developer`)?
      (b) The `tools/list` budget moved again: `all` measured 133,469 with 90 tools and the ratchet
      is now 134,000; `core` is unchanged at 31,151. (c) Inbound flow-step edges use a `valuesLIKE`
      query, so steps whose `values` are stored base64 + gzip are not found (O-5 still open; the
      result carries a caveat). (d) Script callers come from `search_code` over the default script
      types (not the `extended` set) and are re-checked for a real call (`new X(`, `X.method(`,
      `GlideAjax('X')`); a name mentioned only in a comment line with a call shape still counts.
      (e) Bounds: depth default 1 / max 3, 25 rows per inbound source (max 100), 150 nodes — right
      defaults? (f) Tables are leaves (no dictionary walk); a record reached only by an inbound edge
      is not expanded outbound. (g) The pack grows further past the 800 KB ceiling.
- [ ] **Owner decisions from batch 12 (M-5, 2026-09-26):** (a) A client can now widen the
      surface beyond `SN_TOOL_PACKAGES` with `servicenow_enable_package`, write packages included;
      only `SN_PACKAGES_DENY` / `SN_PACKAGES_READONLY` bound it. Add an off switch (e.g.
      `SN_DYNAMIC_PACKAGES=off`) or an allow-list for toggles? (b) The M-1 server instructions are a
      startup snapshot and are not refreshed after a toggle. (c) The overview prompt always tells
      the model to treat the profile as production until the H-11 environment marker lands. (d) A
      call to a disabled tool now returns the SDK's "Tool X disabled" instead of "not found". (e)
      Package resource templates are registered / `remove()`d rather than toggled (the SDK ignores
      `enabled` on templates) — revisit on an SDK upgrade. (f) The core `tools/list` budget rose to
      35,000 (measured 34,426) for the three new admin tools; `all` to 133,000 (132,949); the merged
      batch 12 tree (93 tools) measured 137,276 / 34,426, ratchets 138,000 / 35,000 — M-6
      budget restatement is still open. (g) Enable accepts one package per call — accept a list or
      named profiles? (h) `get_status` reports the session set only after a toggle; the configured
      set otherwise.
- [ ] **Owner decisions from batch 12 (D-1, 2026-09-26):** (a) `init` accepts only
      `*.service-now.com` names (or a bare instance name) unless `SN_ALLOWED_HOSTS` allows the custom
      domain — offer to add it to the allow-list from the wizard? (b) `init` exits with the doctor
      code (1 when the fresh credentials cannot reach the instance) — keep, or exit 0 once written?
      (c) An unknown command or option now exits 2 instead of starting the server (clients that pass
      stray arguments break) — changelog it as breaking for O-4? (d) `login` / `drift` are recognised
      only as the first argument (`servicenow-mcp-ai --foo login` no longer logs in). (e) The support
      bundle is one JSON file, not a zip; secret masking is by key-name heuristic plus a scrub of
      the masked values — instance and user names stay visible. (f) `doctor` text output is ASCII
      whenever stdout is not a TTY (piped / CI). (g) `init` writes through `persistEnv`, so the E-6
      defects F1/F2 (a value ending in `\`, U+2028/U+2029) apply to wizard answers too. (h) The
      pack grew to 1328.6 KB unpacked (ceiling 800 KB, pending the owner).
- [ ] **H-3 · Plan tokens + elicitation — partly done 2026-09-26 (uncommitted), non-breaking.**
      `SN_DESTRUCTIVE_CONFIRM=off|token|elicit` (default `off`) + `SN_PLAN_TOKEN_TTL_SEC`; six
      destructive-apply tools gain `plan_token`; `PLAN_REQUIRED` / `CONFIRM_DECLINED`; 16 tests.
      Owner decisions: (a) the 3.0 default — `token` or `elicit` (B4, O-4)? (b) the token is an
      opaque server-held id, not the HMAC the roadmap sketched (single use + `SN_REDACT_PII`
      safety) — accept? (c) `PLAN_REQUIRED` is not journaled (only elicitation refusals are) —
      journal injected applies too? (d) a mismatched token stays valid until it expires or is
      used — consume on any failed attempt instead? (e) `revert_write` with `force:true` needs a
      plan made with `force:true` (the arguments are bound) — fine? (f) tools/list `all` budget
      139,000 (measured 137,894). Still open inside H-3: `change_conflicts` (H-4), `STALE_RECORD`
      on delete, email `body_preview`, `unknown_fields`, prod `CONFIRM_REQUIRED` (H-11).
      **Resolved 2026-10-01 (O-4 approved):** (a) the default is `token` (B4; `off` opts out);
      the in-H-3 items above all landed (H-3 remainder, H-4, H-11). (b)–(e) stay as built unless
      the owner says otherwise. Left: O-5 PDI verification.
- [ ] **P-21 · Application documentation detail — done 2026-09-26 (uncommitted) bar UIB
      experiences (P-14).** `document_app({detail})`; 2 tests. Owner decisions: (a) `detail` is
      opt-in — make it the default for `document_app` (and pass it from `document_instance`)?
      (b) bounds 10 diagrams per type, 10 dependency roots, 50 lint rows per type; (c) the
      dependency graph merges each root's outbound edges only (no inbound walk).
- [ ] **P-20 · Snapshot / compare over the registry — done 2026-09-26 (uncommitted) bar flow
      snapshots.** `types` / `scope` on both tools; 8 tests. Owner decisions: (a) flows from
      `sys_hub_flow_snapshot` need the published/draft authority confirmed (O-5); (b) nested
      children (portal layout rows / columns / instances) are skipped with a warning — walk them?
      (c) secret fields are masked, so a changed secret is not drift — hash them instead? (d)
      `["all"]` reads every registry type (about 100 primary reads plus children) — cap it? (e)
      the `all` tools/list budget rose to 141,000 (measured 140,142).
- [x] **P-18 · Registry-driven lint and search** — done 2026-09-26 (uncommitted): three portal
      rules, `lint_script` opt-in types, `code_health({extended, limit})` registry sweep,
      `where_used({extended})`; 6 tests. Owner decisions: (a) the sweep is opt-in (`extended`) —
      about 30 bounded reads; make it the default? (b) per-type default 50 / max 200; (c) the
      `sp-param-unvalidated` sinks (encoded query, GlideRecord / GlideAggregate table name,
      `gs.eval`, `GlideEvaluator`) — more? (d) findings verified on mocks only (O-5).
- [x] **H-3 remainder** — done 2026-09-26 (uncommitted): `expected_mod_count` → `STALE_RECORD` on
      update / delete, `unknown_fields` from the schema cache, email `body_preview` (2 KB) +
      `body_sha256`, `expected_*` outside the plan-token hash; 5 tests. Owner decisions: (a) no
      `force` flag — omitting `expected_mod_count` applies unchecked; make the check automatic
      when a `plan_token` is used? (b) `unknown_fields` only when the schema is cached — read it
      on demand in plan mode instead (one dictionary read per table)? (c) the email preview cap
      2,048 characters.
- [x] **P-22 · SDK-managed write guard** — done 2026-09-26 (uncommitted): `SN_SDK_MANAGED_WRITES`
      (default `warn`), `sdkManaged` in plans and results, `SDK_MANAGED_SCOPE` under `deny`; 9 tests.
      Owner decisions: (a) O-6 authority order is still the P-3 default; (b) the guard skips batch
      sub-requests and a create without `sys_scope` (resolving the user's current app scope costs
      a preference read per create) — extend? (c) `deny` as the 4.0 default (breaking register).
- [ ] **H-11 · Policy model v2 — done 2026-09-26 (uncommitted) bar the BREAKING defaults.** Glob
      patterns + one evaluator (`explain_policy`, `servicenow://policy`), `POLICY_DENIED`,
      `SN_PROTECTED_TABLES_WRITE` (default `allow`), `SN_IMPORT_SET_TABLES`, write caps (`WRITE_CAP`),
      `SN_ENV` / `SN_PROFILE_<NAME>_ENV` + per-profile `WRITE_MODE` + `PROD_WRITES` ack; 17 tests.
      Owner decisions: (a) 3.0 defaults — `SN_PROTECTED_TABLES_WRITE=deny` (B11),
      `SN_IMPORT_SET_TABLES=u_*,imp_*`, caps 500 writes (HTTP) / 100 deletes / 50 batch writes? (b)
      the protected list — `sys_security_acl_role` added; anything else (`sys_user_preference`,
      `sys_script_include`, `sys_ui_script`, `sys_hub_*`)? (c) should an attachment upload/delete
      on a protected table's record count as a protected write? (d) `SN_TABLE_POLICY_FILE` —
      still wanted? (e) `SN_ENV` is the default profile's only; should it also be the fallback for
      unmarked named profiles? (f) prod + apply mode + a client without elicitation refuses
      destructive applies (`CONFIRM_REQUIRED`) even with `I_UNDERSTAND` — right? (g) the
      `tools/list` budgets rose to 140,000 / 36,000 (measured 139,089 / 35,473).
      **Resolved 2026-10-01 (O-4 approved):** (a) all four defaults shipped —
      `SN_PROTECTED_TABLES_WRITE=deny` (B11; `allow` or an exact `SN_TABLES_ALLOW` entry opts
      out), `SN_IMPORT_SET_TABLES=u_*,imp_*` (`*` lifts it), caps 500 writes per HTTP session (none
      on stdio) / 100 deletes / 50 batch writes (`0` = no cap). Note: `set_property` and
      `sys_script` writes are now refused by default, and the 50-batch-write cap is only reachable
      with `SN_BATCH_MAX_REQUESTS` raised above 50. Still open: (b), (c), (d) (no format was ever
      specified, so the policy file is not built), (e), (f).
- [ ] **H-4 · Policy-axis bypass closure — partly done 2026-09-26 (uncommitted).** Attachments follow
      the parent table; plugin-API tools check backing tables; Code Search hits filtered; batch:
      nested batch refused, tables from query/body, attachment-by-id resolved under a table policy,
      `SN_BATCH_UNMAPPED` (default `allow`), `SN_BATCH_MAX_REQUESTS` (default 1000), bodies in the
      preview; `change_conflicts(calculate)` is plan/apply + journaled (**behaviour change**,
      CHANGELOG → Changed); 17 tests incl. the read-only / table-deny sweep over every write tool.
      Owner decisions: (a) 3.0 defaults — `SN_BATCH_UNMAPPED=deny` and `SN_BATCH_MAX_REQUESTS=50`
      (O-4)? (b) the knob is `SN_BATCH_UNMAPPED=allow|deny`, not the roadmap's
      `SN_BATCH_ALLOW_UNMAPPED=1` — accept the rename? (c) `change_conflicts(calculate:true)` now
      previews in plan mode — ship in 2.1 as a plan-by-default fix, or hold for O-4? (d)
      `test_connection` stays outside the table policy (one `sys_user` sys_id) — keep the
      exception? (e) a denied parent table now also hides attachment metadata and an unscoped
      attachment list in a batch is refused while a table policy is set — acceptable? (f) the Code
      Search LIKE fallback refuses the whole search when a default script table is denied, while
      the API path filters — make the LIKE path skip denied types too? (g) `delete_attachment`
      apply reads the metadata twice (journal `before` + the policy check) — one extra GET.
      **Resolved 2026-10-01 (O-4 approved):** (a) `SN_BATCH_UNMAPPED=deny` and
      `SN_BATCH_MAX_REQUESTS=50` are the defaults (B8); (b) the `SN_BATCH_UNMAPPED=allow` knob is
      the one documented (breaking register fixed); (c) moot — ships in 3.0. Still open: (d)–(g).
- [x] **Test hermeticity** — done 2026-09-26 (uncommitted): with `HTTPS_PROXY` set in the shell
      (corporate / cloud dev environments) 553 tests failed and `test/tasks.test.js` spun at 100 %
      CPU — H-10's dispatcher asks for the optional `undici` package. `baselineEnv()` in
      `test/helpers.js` now clears `SN_HTTPS_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`
      (both cases); the suite is green with a proxy in the environment.
- [ ] **Open items from batch 18 (M-7, 2026-10-03, uncommitted).**
  - Next minor: remove the legacy tool aliases, the `legacyParams` maps and
    `SN_LEGACY_TOOL_NAMES`; remove the old `servicenow://{profile}/schema/{table}` template; keep
    or drop `class_name` on the CMDB tools (documented as deprecated, always accepted today).
  - camelCase parameters were not normalized (`inputDisplayValue`, `artifactType` and similar);
    a later naming pass, if wanted — it would be another breaking change.
  - With the `class_name` alias published, `table` is optional in the CMDB tools' JSON schema
    (one of the two is enforced in the handler); same for `children[].fields` on
    `upsert_artifact`, which is normalized in the handler, not in the schema.
  - `run_atf_test` keeps `execution_id` (it names an execution, not the test record).
  - `kind` keeps its one meaning (selector of the target's variant / category: docs, flows,
    directory, ops, scripts) — not renamed; confirm.
  - The D-8 hook always maps the legacy `change_conflicts` name, whether or not the server runs
    with the flag (the hook cannot read the server's env).
  - With `SN_LEGACY_TOOL_NAMES=1`, `tools/list` grows about 20 KB (`all`); the budget test
    measures the default (flag off).
- [ ] **Open items from batch 18 (M-2, 2026-10-02, uncommitted).**
  - Acceptance deviation: the manifest carries one global `errorCodes` table (manifest v3) instead
    of a per-tool code list — most tools can raise most codes (profile, policy, instance HTTP), so
    a per-tool list would be noise. Confirm, or ask for per-tool lists.
  - Older suites still match only the message text on failures; convert them to `code` asserts as
    they are touched (the new `test/error-contract.test.js` covers the contract itself).
    2026-10-09: 52 sites in 18 suites converted (every regex-only `rejects`/`throws` whose error
    carries one stable code); the rest have no code, mixed codes, or are the dark Jira suites.
  - A resource `McpError` reaches clients as `MCP error -32602: MCP error -32602: …` (the SDK's
    `McpError` prefixes its message on the server and again when the client rebuilds it) — SDK
    behaviour, not fixed.
- [ ] **Open items from N-6 (`ops` v2, 2026-10-03, uncommitted).**
  - O-5 on a PDI: `sys_outbound_http_log` (`url`, `http_method`, `response_status`,
    `response_time`, `rest_message`; is the log on by default, and what is its retention?),
    `syslog_transaction` (`url`, `response_time`), `ecc_agent` (`status`, `version`,
    `last_refreshed`, `host_name`) and `ecc_queue` (`agent` = `mid.server.<name>`, the `ready` /
    `error` state values, `error_string`).
  - The slow threshold is a fixed 5,000 ms (`SLOW_MS`); make it an argument? (It would cost
    `tools/list` bytes; N-0 / O-10.)
  - The filter-field dictionary guard adds two cached metadata reads each for `integrations` and
    `transactions`, also in `overview`.
- [ ] **Owner decisions from batch 17 (2026-10-01, uncommitted).**
  - P-29: `SPPage`, flow variables, stages, action inputs / outputs and process inputs take no `$id`
    in SDK 4.12.2, so `now-sdk build` mints new sys_ids — installing generated Fluent on the
    source instance can duplicate those records. Accept with the per-file note, or refuse to emit
    pages until the SDK supports `$id`? O-2 / O-5: fixtures for the per-field instance comparison.
  - H-11: the `SN_TABLE_POLICY_FILE` format; attachments as parent-table writes.
  - H-4: the Code Search LIKE fallback refuses the whole search on a denied default table.
  - E-2: TypeScript 7 waits for typescript-eslint support.
  - `pack:check`: 2012.7 KB vs the 800 KB ceiling (still open).
- [ ] **Owner decisions from batch 16 (2026-09-30, uncommitted).**
  - ~~O-7~~ approved 2026-10-01; the P-29 oracle now verifies the shapes (was: O-7, now also gating P-27 / P-28): the SDK dev dependency + 4.12.2 target; the P-29 oracle
    would verify the `Flow` / `Subflow` / `Action` / `PlaybookDefinition` and portal / workspace /
    catalog property names, which are taken from SDK-PARITY and are unverified.
  - P-27: `wfa.dataPill` without a type argument; step-output pills emitted as text; the subflow
    call shape. O-5 / O-9: verify generated flows on a PDI.
  - P-28: the passthrough camelCase fields of `Dashboard` / `UxListMenuConfig` / `Applicability`;
    standalone `io_set_item` rows emitted as `Record()`; UIB stays `Record()` (no Fluent API).
- [ ] **Owner decisions from batch 15 (2026-09-30, uncommitted).**
  - O-7: may `@servicenow/sdk` be a dev dependency (type-check oracle for P-26), and is 4.12.2 the
    target SDK for generated Fluent? Until then P-26 output is only proven to parse.
  - P-20: keep reading the published flow snapshot by default? (A flow whose `master_snapshot` has
    child rows hashes differently from snapshots stored before batch 15 — one-time drift against old
    `from_snapshot` files.) Are the Mermaid diff caps (10 records, 120 lines) right? O-5: confirm
    snapshot child rows are keyed by the snapshot sys_id.
  - M-6: restate the `tools/list` budget (`TOOLS_LIST_BUDGET_ALL` now 149,000).
  - E-6: the O-2 PDI fixture corpus + live smoke job; L9-03 layout (still deferred).
- [ ] **Owner decisions from batch 14 (2026-09-30, uncommitted).**
  - E-4: flip `SN_STRICT_SETTINGS` on by default in 3.0? B5: drop the implicit `.env` fallback?
  - H-7: B6 `SN_HTTP_REQUIRE_TOKEN` default on; B12 `use_instance` `persist` over stdio; a default
    `SN_HTTP_ALLOWED_HOSTS` for non-loopback binds; the OAuth (MCP authorization) design.
  - P-24: `SCOPE_PREFIX` warn vs refuse; cross-scope duplicate semantics; the `sp_dependency.module` field.
  - O-5 verification on a PDI: P-24 fields, flow `master_snapshot` behaviour (P-25), the `sys_ux_*`
    (P-14 / P-15) and `sys_pd_*` (P-12) tables.
  - M-6: restate the `tools/list` budget (`TOOLS_LIST_BUDGET_ALL` raised to 146,500 in
    `test/output-schema.test.js`).
  - P-19: severity of `uib-data-broker-no-acl`. P-21: UIB depth beyond page-map diagrams.
  - D-6: publish the extension only after 3.0.0; delete the stale registry entries; the Open VSX
    namespace and `OVSX_PAT` secret; the `exports` map (B10).
- [ ] **Owner decisions from batch 13 (2026-09-28, uncommitted).**
      **D-5:** (a) publish the image (GHCR / Docker Hub) and pin base images by digest? (b) list on
      Smithery / Glama? (c) a public `/healthz` so `HEALTHCHECK` can use HTTP instead of TCP? (d)
      warn on world-readable secret files (Docker secrets are 0444)? (e) `removeComments` would cut
      our JS 1,430 → 1,166 KB — still over 800; raise the ceiling or bundle? The SDK tree is ~93 %
      of the install. **D-7:** (f) marketplace publish; (g) keep the HTTP transport option? (h)
      extension unit tests run only in CI. **D-9:** (i) enable private vulnerability reporting;
      (j) confirm the 3 / 7 / 30-day targets and "< 2.0 unsupported"; (k) the fallback e-mail in
      SECURITY.md; (l) create labels `breaking`, `security`, `changed`, `ci`, `internal`,
      `skip-changelog`; (m) the roadmap's "O-1 checklist" names ARCH-14 go/no-go — no such
      checklist exists. **P-19:** (n) field names verified on mocks only (O-5); (o) make the
      long-wait threshold configurable? **P-23:** (p) the strict `writeFields` allow-list (none
      yet for business rules / script includes); (q) `apps.current_app` unverified (O-5), and a
      child create takes the current app's scope, not its parent's; (r) add `prune_children`,
      whole-artefact revert, child staleness? (s) a plan token on a tool with
      `destructiveHint:false`; (t) `tools/list` `all` budget 144,000 (measured 143,644).
      **All:** (u) pack 1596.2 KB unpacked vs the 800 KB ceiling.
- [ ] **SDK parity epic** (P-1…P-29, owner gates O-5…O-9) — post-3.0 (3.x minors; only P-22's
      `deny` default is a 4.0 break); plan in [SDK-PARITY.md](SDK-PARITY.md), rows 55–83 of
      ROADMAP-V3 §"Sequencing".
- Everything else in the plan is 🔴 not started and waits for the owner to pick the cut
  (recommended: ROADMAP-V3 §"Sequencing", items 1–19 + 25–29 + 46–50 + 52).

## Full review (2026-06-16 → 17) — architect → dev → qa

> Fresh `/full-review` pass over the whole tree on top of the 1.0.0 release, then a follow-up that
> closed **every** remaining finding. **All fixed and moved to [DONE.md](DONE.md):** ARCH-3
> (`fetchAll` truncation made visible in snapshot/compare), DEV-5 (stale cache comment),
> QA-18/QA-19 (tests locking the `truncated` contract), ARCH-4 (unified `result`-envelope unwrap
> across every API module), ARCH-5 (the Batch API now obeys the package axis — a batch can no longer
> reach a denied plugin API or write to a read-only package), and the two former "won't-fix"
> security decisions, now hardened: SEC-7 (`.env` written `0600`) and SEC-8 (a host must be
> `*.service-now.com` unless `SN_ALLOWED_HOSTS` is set). No deferred review items remain.

## Owner action

- ✅ **R-2 · Publish 2.0.0 — done (2026-06-22).** Tagged `v2.0.0` → `publish.yml` re-ran the gate
  (303 tests) and `npm publish --provenance --access public` → `publish-mcp.yml` registered the
  listing. Live: npm `servicenow-mcp-ai@2.0.0` (the `latest` tag) and MCP Registry
  `io.github.IvanBBaev/servicenow-mcp-ai → 2.0.0`. Repo public, `NPM_TOKEN` bound.
- 👤 **DX-3 · screen-capture GIF** — the only remaining manual piece; the demo scenario itself
  already ships in the README and the docs site (see [ROADMAP-V2.md](archive/ROADMAP-V2.md)).

## Full review (2026-06-18) — architect → dev → qa (3 cycles)

> Fresh `/full-review 3` pass. **All findings fixed and moved to [DONE.md](DONE.md):** ARCH-6
> (Markdown render dedup; snapshot/compare `|`-escaping drift closed), ARCH-7 (per-profile auth — the
> MI-1 `_AUTH`/`_OAUTH_*` convention now actually works), ARCH-8 (the `fetchAll`/`SN_MAX_RECORDS`
> truncation signal now reaches `servicenow_query_table`), DEV-6 + DEV-7 (caret-injection guards on
> `describeTable` and `generateTableFlow`), QA-21 + QA-22 (change/cmdb read/update + meta-cache paths
> pinned) and QA-20 (the coverage gate now fails clearly on Node ≥ 25 via `scripts/coverage-guard.mjs`
> instead of a cryptic yargs crash; `npm run verify` is the coverage-free path there). No open items.

## Full review (2026-07-01) — architect → dev → qa (scope: the uncommitted Jira integration)

### ARCHITECT REVIEW (2026-07-01)

> **ARCH-9, ARCH-11, ARCH-12, ARCH-13 fixed and moved to [DONE.md](DONE.md)** (shared
> `resolveHostWithPolicy` SSRF guard, `JiraError`, shared-knob docstrings, `parseTotalCount` back in
> `http.ts`). Gate green: 358 tests, coverage 95.22/84.07/98.56, audit 0. What remains below are the
> deferred design decisions.

- ✅ **ARCH-10 · The request/retry loop is duplicated between the twin HTTP clients.** _Closed 2026-10-09 by O-1 NO-GO ([ADR 0007](adr/0007-delete-jira-scaffold.md))._
  `src/core/http.ts:127-265` and `src/core/jira/http.ts:134-252` copy the ~120-line engine
  (transport catch → idempotence gate → status retry → error parse → telemetry → json/binary tail);
  `http-util.ts` shares only the policy primitives. The `http-util.ts` header documents the split
  as deliberate ("the two callers differ only in host resolution, auth and error-body shape").
  Unifying into a hook-parameterised engine (~7 hooks: per-attempt auth, 401-retry, dispatcher,
  error extractor, total-count, labels) reverses that documented choice — **owner decision**. The
  two concrete drifts already visible (SN builds `AbortSignal.timeout` before the semaphore slot;
  SN lacks the `?`-join guard) are handled as DEV findings in this review.
- ✅ **ARCH-11b · Fuller error-taxonomy rename.** _Closed 2026-10-09 by O-1 NO-GO ([ADR 0007](adr/0007-delete-jira-scaffold.md))._ `JiraError extends ServiceNowError` is in; a
  neutral base class (+ `snDetail` → a generic key in `mcp/result.ts`) is a public-contract change
  — **owner decision**.
- [x] ~~ARCH-12b · Per-system `JIRA_*` transport overrides.\*\* Jira currently rides
      `SN_TIMEOUT_MS`/`SN_MAX_RETRIES`/`SN_MAX_CONCURRENT` (now documented in `settings.ts`). Splitting
      the config surface per system is an owner decision.
- ✅ **ARCH-14 · The Jira surface is dark and the safety rails are undecided.** _Closed 2026-10-09 by O-1 NO-GO ([ADR 0007](adr/0007-delete-jira-scaffold.md))._ `api/jira/`
  contains only `shared.ts`; no domain modules, no tools, no `jira` package in the registry, no
  ARCHITECTURE.md/README mention. When Jira tools land they must ride the same rails as ServiceNow
  tools — the package axis (`SN_TOOL_PACKAGES`/`SN_PACKAGES_DENY`/`SN_PACKAGES_READONLY`),
  `SN_READONLY`, plan/apply (`SN_WRITE_MODE`), the write journal and DF-5 redaction — or the
  server's safety contract silently weakens for a whole system. Design decision for the owner
  before the tool layer is built; the docs update belongs to that change, not this review. The
  business framing (options matrix, the bridge-MVP case, the Atlassian comparator) is in
  [BUSINESS-REVIEW-2026-07.md](archive/BUSINESS-REVIEW-2026-07.md) §5 and §8.2.

### DEV REVIEW (2026-07-01)

> **DEV-8, DEV-9, DEV-10 fixed and moved to [DONE.md](DONE.md)** (timeout signal now created
> inside the semaphore slot in `snRequest`; the `?`-join guard added to `snRequest`; `jiraRequest`
> rejects reserved headers in `extraHeaders`). The 503-retry tightening and the `Retry-After` cap
> that ship with this change were reviewed and confirmed correct (pinned by tests). Gate green:
> 358 tests, coverage 95.19/84.01/98.56, audit 0. Nothing deferred.

### QA REVIEW (2026-07-01)

> **QA-23, QA-24, QA-25, QA-26, QA-27 fixed and moved to [DONE.md](DONE.md)** — all five were test
> gaps, no product bugs: the `JiraError` contract pinned (name, inheritance, status/detail), the
> `snRequest` `?`-join guard tested, the reserved-`extraHeaders` rejection tested (was uncovered),
> the Jira per-host telemetry breakdown tested, and the `message` error-body fallback covered.
> Gate green — see the gate line in DONE.md. Nothing deferred.

## Gap analysis (2026-07-01) — ruthless sweep: product · code · CI/tests · docs

> Two parallel code sweeps plus a manual verification pass on top of the 2026-07-01 gate
> (358 tests, coverage 95.19/84.01/98.56, audit 0). The heavy code claims were **verified
> false** (probeTable error isolation, the flows caret guard, the OAuth login timeout and
> per-instance schema-cache keying are all fine) — the codebase itself is sound; the real
> gaps are product-side and in CI/test hygiene. Jira findings are already tracked as
> ARCH-10/11b/12b/14 above and are not duplicated here.

### Actionable

> **GA-1 … GA-6 fixed and moved to [DONE.md](DONE.md) (2026-07-02):** dependabot (npm root +
> `extension/` + github-actions, weekly), the CodeQL workflow, the extension 2.0.1 bump + the
> version-sync gate in `publish-vscode.yml`, lint/format on the Windows CI leg, dedicated unit
> tests for `core/policy.ts` / `core/write-journal.ts` (+ the missing `parseRedirect` edges in
> `oauth.test.js`), and the env-docs sync test (`test/env-docs-sync.test.js`, with an ARCH-14
> dark-surface exception that self-destructs once `JIRA_*` is documented). `.env.example`
> gained `SN_OAUTH_JWT_KID`, `SN_OAUTH_JWT_EXP_SEC`, `SN_CODESEARCH`. Gate green: **380 tests**
> (+17), coverage 95.29/84.36/98.56, audit 0. Nothing actionable remains from this sweep.

### Deferred (trigger-gated)

- ⏳ **GA-7 · Batch `PACKAGE_BY_PATH` is a static list.** _trigger: a new plugin API is
  added to any package._ An unknown `/api/...` sub-request path falls back to
  table-only policy (`api/batch.ts`); when a new plugin API lands, its path must be
  added to the map in the same change — add a manifest-vs-map pin test then.

### Owner actions

- 👤 **GA-8 · Distribution / adoption.** 1 star · 0 forks · 0 issues · 63 unique
  visitors in 2 weeks · ~939 npm downloads/month (mostly mirrors). The supply side
  (npm, registry, marketplace, docs site, badges) is done; the demand side is
  untouched: the DX-3 GIF (still the only open roadmap item), community posts (sndevs
  Slack, community.servicenow.com, r/servicenow, LinkedIn) and a comparison post
  distilled from COMPETITIVE-ANALYSIS.md. Also pending: the stale
  `io.github.LeassTaTT` registry duplicates.
- 👤 **GA-9 · PDI e2e nightly.** The whole suite is mock-fetch; nothing proves the
  server against a live instance. Listed as "on request" in ROADMAP; recommendation:
  promote it — it is the strongest missing evidence for a project whose thesis is
  "knows your instance". Needs a PDI + credentials (owner).

## Deferred backlog (trigger-gated — not active work)

- ⏳ **A2-2 · ConfigStore covers only credentials.** _trigger: MI-1 follow-up (Phase 7)._
  Policy/settings read env per call — deliberate (see A-2); the profile store will unify them;
  until then new settings go through `settings.ts` only.
- ⏳ **A2-3 · Global singletons.** _trigger: "when it hurts" — not earlier._ The token/schema/plugin
  caches and telemetry have `clear*` hooks instead of injection. Fine for one process; if multiple
  servers ever share a process (tests do!), state is shared. _Solution:_ a container object created
  at bootstrap — when it hurts, not before.
- ⏳ **A2-4 · Bootstrap will fork at X-8.** _trigger: an X-8 request_ (HTTP transport) — extract the
  choice into `mcp/transport.ts` when X-8 is requested; not pre-emptively.
- ⏳ **A2-5 · Resource errors are JSON content.** _trigger: MCP protocol evolution_ (the protocol has
  no `isError` for resources) — a client cannot tell an error from data. Known; documented in
  ARCHITECTURE.
