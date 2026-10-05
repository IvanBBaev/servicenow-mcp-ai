# servicenow-mcp-ai — UI Builder Gap Analysis & Implementation Plan (2026-10)

Date: 2026-10-03 · Status: **proposed — docs only, no code.** Baseline: `main` at `78fa65c` plus
the uncommitted N-0 / N-6 work (97 tools in 26 packages).

The question for this pass: **what does the server need so that a developer can work with UI
Builder (UIB), Next Experience and workspaces as well as possible?** It is round 5 of the
2026-10 gap pass ([GAP-ANALYSIS-2026-10.md](GAP-ANALYSIS-2026-10.md)). It has its own document
because the topic is large. Findings carry ids `UX-01` … `UX-24`. The plan items continue the
N pillar as `N-25` … `N-34`, tracked as rows 109–118 in [ROADMAP-V3.md](ROADMAP-V3.md), with the
new owner gate **O-18**.

Evidence marker: **verified** = re-checked in code during this pass. Every UIB table and field
is **unverified** until O-5 (PDI): the registry marks all 17 UIB / Next Experience types
`verified:false`.

## 1. What exists today

UIB support today is read and explain.

- **Registry.** It holds 17 types in the groups `next-experience` and `uib`
  (`src/core/artifacts/registry.ts:163-177`, `:1824-2266`).
  - Next Experience: `workspace`, `dashboard`, `ux_list_menu_config`, `ux_applicability`.
  - UIB: app config, route, screen type, screen, macroponent, client script, client script
    include, transform and scriptlet data brokers, event, component, theme, style, form action,
    form action layout, composite definition.
  - No UIB type has `writeFields`, and the eight macroponent JSON fields are `writable:false`
    (`:2057-2087`).
- **`servicenow_explain_ui_experience`** (opt-in `ui` package, `src/api/ui-experience.ts`).
  - It walks page registry → page properties → app config → routes → screens and variants →
    macroponent → client scripts (names only) → transform / scriptlet brokers → broker ACLs.
  - It also covers dashboards, list menus, form action layouts and applicability.
  - Output is a Mermaid page map or Markdown. It reads metadata only, never script bodies
    (`:29`).
- **Composition parsing** (`src/core/artifacts/uib-composition.ts`, capped at 500 elements and
  depth 12). It reads:
  - the element tree (`elementId`, `definition.id`, label, `isHidden`, slots);
  - the data resources (`elementId`, `definition.id`);
  - the state property names;
  - event wiring as name strings only.
- **Code health.** Three opt-in domain rules: `uib-route-no-screen`,
  `uib-screen-no-applicability` and `uib-data-broker-no-acl`
  (`src/api/domain-analysers.ts:1209-1362`). The UIB script types are linted only through the
  `extended` sweeps.
- **Fluent.** `Workspace`, `Dashboard`, `UxListMenuConfig` and `Applicability` have emitters
  (`src/api/fluent-ui.ts`). Every `uib` type falls back to `Record()` (`:2063-2066`), because the
  SDK has no API for them.
- **Writes.** There is no dedicated tool; writes go through the generic `upsert_artifact`.
  - Scalar, script and reference fields can be written, unverified.
  - A macroponent JSON change is plan-only and apply refuses it
    (`src/api/upsert-artifact.ts:539-545`).
- **Tests.**
  - 15 tests in `test/explain-ui-experience.test.js`.
  - 3 UIB domain-analyser tests.
  - Fluent goldens and the plan-only refusal.
  - All of them run against mocks; none runs against a live instance.

## 2. Findings

### 2.1 Understanding a page

| Id    | Finding                                                                                                                                                                                                                                                                                               | Evidence                                                                                                           | Severity | → Item |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| UX-01 | **Nothing is live-verified.** All 17 UIB / NX types, their child tables and their JSON shapes are assumptions. Any write work (UX-12, UX-13) is unsafe until a PDI confirms them.                                                                                                                     | **verified**: `verified:false` on every UIB descriptor; SDK-PARITY §4.5 "Now" column is "—"                        | High     | N-25   |
| UX-02 | **Element props and data bindings are not read.** The composition reader keeps the tree but drops element props, config, overrides and binding expressions (`@data.*`, `@state.*`, `@context.*`). "Where does this value come from?" and "why is this element hidden?" cannot be answered.            | **verified**: `src/core/artifacts/uib-composition.ts:110-154`                                                      | High     | N-26   |
| UX-03 | **Event wiring stops at names.** `internal_event_mappings` yields source, event and handler names. They are not resolved to the client script, the broker operation or the state change they trigger.                                                                                                 | **verified**: `src/core/artifacts/uib-composition.ts:255-285`                                                      | High     | N-26   |
| UX-04 | **Components are not resolved.** `definition.id` is not mapped to an OOB `now-*` component, a custom `sys_ux_lib_component` or a nested macroponent.                                                                                                                                                  | **verified**: no lookup from composition ids to `uib_component`                                                    | Medium   | N-26   |
| UX-05 | **No "which variant does this user see".** The rule `uib-screen-no-applicability` flags shadowed variants, but nothing evaluates audiences and applicability for a given user's roles. `sys_ux_screen_condition` is in the registry but never read, and `sys_ux_app_config.roles` is not read either. | **verified**: `registry.ts:2029`; 0 reads of `screen_condition` / `app_config.roles` in `src/api/ui-experience.ts` | Medium   | N-27   |
| UX-06 | **Script bodies are never shown.** `explain_ui_experience` prints client-script and broker names only, so a reader must make a second call per script.                                                                                                                                                | **verified**: `src/api/ui-experience.ts:29,685,1280-1283`                                                          | Low      | N-26   |

### 2.2 Impact and dependencies

| Id    | Finding                                                                                                                                                                                          | Evidence                                                      | Severity | → Item |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------- | ------ |
| UX-07 | **Composition and data are not dependency edges.** Component ids and broker ids from the macroponent are not turned into edges, although SDK-PARITY P-17 lists "UIB data resources" as a source. | **verified**: `src/api/dependencies.ts:35-37,265-310`         | High     | N-28   |
| UX-08 | **No UIB where-used.** "Which pages use this broker, client script include or component?" has no answer. `where_used` and `references` have no UIB source.                                       | **verified**: `src/api/whereused.ts`, `src/api/references.ts` | High     | N-28   |
| UX-09 | **No update-set completeness check.** A page spans route, screen, variant, macroponent, client scripts, brokers, ACLs and applicability. Nothing checks that an update set carries all of them.  | **verified**: no such check in `src/api/updatesets.ts`        | Medium   | N-28   |

### 2.3 Data brokers and security

| Id    | Finding                                                                                                                                                                                                                | Evidence                                                                                            | Severity | → Item |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------- | ------ |
| UX-10 | **REST and GraphQL brokers are invisible.** Only transform and scriptlet brokers are read; all other broker ids land in `unresolvedBrokers`. GraphQL schemas and resolvers are not read.                               | **verified**: `src/api/ui-experience.ts:747-781`; 0 hits for `sys_ux_data_broker_rest` / `_graphql` | Medium   | N-29   |
| UX-11 | **No broker-specific lint rules.** Missing: `mutates_server_data` without an ACL, GlideRecord in a transform without an ACL check, no input schema. Broker scripts are linted only on request, with the generic rules. | **verified**: `src/api/codecheck.ts:989-1019` (the `extended` sweep)                                | Medium   | N-29   |
| UX-12 | **The security scan ignores `ux_data_broker` ACLs.** `security.ts` scans `acl`, `rest_resource`, `ui_page`, `table` and `role` only. The UIB rule checks only that an ACL exists, not what it allows.                  | **verified**: `src/api/security.ts`; `src/api/ui-experience.ts:782-800`                             | Medium   | N-29   |

### 2.4 Writing

| Id    | Finding                                                                                                                                                                                                                                        | Evidence                                                                               | Severity | → Item |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------- | ------ |
| UX-13 | **Composition cannot be edited.** A macroponent JSON change is plan-only, and the only way to express it is a whole-field replacement. There are no structured operations (add an element, set a prop, bind data, add an event handler, move). | **verified**: `src/api/upsert-artifact.ts:539-545`; `test/upsert-artifact.test.js:268` | High     | N-33   |
| UX-14 | **No page or variant scaffolding.** Nothing creates a variant with its applicability, copies a page, or adds a route.                                                                                                                          | **verified**: no such tool                                                             | Medium   | N-33   |
| UX-15 | **No UIB-aware client-script lint.** UIB client scripts use `api.setState`, `api.emit`, `helpers` and imports. They get the generic script rules only.                                                                                         | **verified**: no UIB rules in `src/api/codecheck.ts`                                   | Low      | N-32   |

### 2.5 Workspace coverage

| Id    | Finding                                                                                                                                                               | Evidence                                                                        | Severity | → Item |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------- | ------ |
| UX-16 | **No declarative actions.** The list and form buttons of a workspace live in `sys_declarative_action_*`. These tables appear only in the generated SDK sort-key list. | **verified**: `src/api/fluent-sdk-actions.ts:1396`; no descriptor               | High     | N-30   |
| UX-17 | **App shell, chrome, menus, UX form config and the contextual side panel are not covered.** Only `sys_ux_app_config.landing_path` is read.                            | **verified**: 0 hits for `sys_ux_app_shell*`, `sys_ux_form*` (bar form actions) | Medium   | N-30   |
| UX-18 | **Agent Workspace and Configurable Workspace are not told apart.** Agent Workspace is the legacy model; customers migrate off it. There is no migration help.         | **verified**: 0 hits                                                            | Medium   | N-30   |
| UX-19 | **Themes are descriptors only.** `m2m_app_theme` is not read, so "which theme does this workspace use" has no answer.                                                 | **verified**: 0 hits for `m2m_app_theme`                                        | Low      | N-30   |
| UX-20 | **UX list columns and conditions are not decoded.** `sys_ux_list` rows are shown without parsing their columns or conditions.                                         | **verified**: `src/api/ui-experience.ts:865`                                    | Low      | N-30   |

### 2.6 Quality and tooling

| Id    | Finding                                                                                                                                                                            | Evidence                                                               | Severity | → Item |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------- | ------ |
| UX-21 | **Composition diffs are text diffs.** `compare_instances` diffs the normalised JSON, so a moved button shows as a large JSON hunk instead of "element X moved".                    | **verified**: `src/api/artifact-snapshot.ts:109-125` (`normalizeRow`)  | Medium   | N-31   |
| UX-22 | **No page performance hints.** Nothing counts brokers fired on page load, brokers without a `when` condition, or very deep compositions.                                           | **verified**: no such rule                                             | Low      | N-31   |
| UX-23 | **`required_translations` is not checked.** The field is declared JSON but only decoded generically, so missing translations on a page are not reported.                           | **verified**: registry jsonFields; not read by `explain_ui_experience` | Low      | N-31   |
| UX-24 | **No guided entry and one duplicate descriptor.** There is no UIB prompt or plugin skill. `sys_ux_form_action` is described twice (`workspace_form_action` and `uib_form_action`). | **verified**: `src/mcp/prompts.ts`; `registry.ts:1665-1679,2213`       | Low      | N-34   |

## 3. Design principles

- **Verify before write.** N-25 runs first. No UIB write ships before a PDI round-trip test
  proves that read → patch → write → read leaves every untouched byte of the JSON unchanged.
- **Extend, don't add.** The read items extend `explain_ui_experience`, `artifact_dependencies`,
  `where_used`, `check_code_health` and `compare_instances`. Only N-27 and N-33 may add a tool.
  Each item states its `tools/list` delta (N-0).
- **The `ui` package stays opt-in.** No UIB item touches the `core` package.
- **Degrade per section.** An unreadable table becomes `available:false` plus a caveat, as in
  `explain_ui_experience` today.
- **Writes use the existing rails.** That means plan → token → apply, the journal, the H-11
  policy and `revert`. No code is executed on the instance.
- **Still out:**
  - `/api/now/uxf/*` (the runtime page API);
  - building or deploying custom components (`snc ui-component`);
  - Fluent APIs for UIB internals that the SDK does not have.

  SDK-PARITY lists all three as out (`:907-915`), and this pass keeps them out unless O-18 says
  otherwise.

## 4. Implementation plan

### N-25 — UIB live verification (S + owner, O-5)

- **Why:** UX-01.
- **Scope:** a PDI probe (an extension of P-2) over every UIB / NX table, child table and JSON
  field in the registry and in SDK-PARITY §4.5. It records:
  - which tables exist;
  - which fields the integration user can read;
  - one real sample of each JSON shape (composition, data, event mappings, macroponent config).

  The samples become sanitised fixtures under `test/fixtures/uib/`, and `verified:true` is set
  where the probe confirms the table.

- **Done when:** the descriptors carry probe results, and the composition reader passes the
  real fixtures.

### N-26 — Page explainer depth (M)

- **Why:** UX-02, UX-03, UX-04, UX-06.
- **Surface:** `explain_ui_experience` gains `detail: "elements" | "bindings" | "events" | "scripts"`.
  - **Bindings:** element props with their binding expressions, classified as data, state,
    context or literal, with the data resource or state property each one resolves to.
  - **Events:** source → event → handler → target, where the target is a client script, a
    broker operation, a state set or a page event.
  - **Components:** each element is resolved to `now-*`, a custom `sys_ux_lib_component` or a
    nested macroponent, with a link to its descriptor.
  - **Scripts:** with `detail: "scripts"`, client-script and broker bodies are included through
    the S-11 file result when large.
  - The Mermaid map gains an optional event-flow view.
- **Tests:** extend `test/explain-ui-experience.test.js` with N-25 fixtures (bindings, event
  chain, unresolved component, script body via the file result).

### N-27 — Variant resolution for a user (M)

- **Why:** UX-05.
- **Surface:** `explain_ui_experience` with `as_user: <user>` evaluates applicability, audience
  roles, `sys_ux_screen_condition` and `sys_ux_app_config.roles` for that user. It returns the
  variant the user would see, the variants shadowed before it, and the reason. Script conditions
  give `undetermined`, like N-2. The privacy stance follows O-13.
- **Tests:** `test/uib-variant-resolution.test.js` covers roles, order, shadowing, a script
  condition (`undetermined`) and a missing app config.

### N-28 — UIB dependencies, where-used, update-set completeness (M)

- **Why:** UX-07, UX-08, UX-09.
- **Surface:**
  - `artifact_dependencies` emits edges from composition component ids and data-resource broker
    ids.
  - `where_used` gains UIB sources: pages using a broker, client script include, component or
    macroponent.
  - `updatesets` `preview` (S-6) gains a `uib_completeness` section: for each page touched by the
    update set, the records of the page (from the N-26 walk) that are not in it.
- **Tests:** extend `test/dependencies.test.js`, `test/references.test.js` and the update-set
  tests.

### N-29 — Data brokers and their security (M)

- **Why:** UX-10, UX-11, UX-12.
- **Surface:**
  - Registry descriptors for REST and GraphQL brokers and for the GraphQL schema and resolver
    tables. Their script fields join script intelligence (P-18).
  - Three codecheck rules:
    - `uib-broker-mutates-no-acl` (error);
    - `uib-transform-gliderecord-no-acl-check` (warn);
    - `uib-broker-no-input-schema` (info).
  - The S-3 security scan gains a `ux_data_broker` kind: open or role-less broker ACLs, and
    brokers that mutate data without one.
- **Unverified (O-5):** the REST / GraphQL broker tables and the GraphQL metadata tables.
- **Tests:** extend `test/p19-domain-analysers.test.js` and `test/security-scan.test.js`.

### N-30 — Workspace coverage (M–L)

- **Why:** UX-16 … UX-20.
- **Surface:**
  - Descriptors and explain support for declarative actions (definitions, assignments, payload
    and client actions), the app shell and chrome, UX form config, the contextual side panel and
    `m2m_app_theme`.
  - `explain_ui_experience` gains an `actions` section: which buttons appear on which list and
    form, and what they run.
  - `sys_ux_list` columns and conditions are decoded through the encoded-query reader.
  - `check_capabilities` and `document_instance` report Agent Workspace vs Configurable
    Workspace. A `workspace_migration` section lists the Agent Workspace pieces without a
    Configurable Workspace counterpart.
- **Unverified (O-5):** all the new table names.
- **Tests:** `test/uib-workspace-coverage.test.js` and a Fluent fallback golden for the new
  types.

### N-31 — Composition diff, performance and translation hints (M)

- **Why:** UX-21, UX-22, UX-23.
- **Surface:**
  - `compare_instances` and `snapshot` diff macroponents per element, reported as added,
    removed, moved, prop changed or binding changed. The JSON hunk is kept behind `raw:true`.
  - The `uib-page-weight` rule reports brokers fired on load, brokers without a `when`
    condition, and depth or element count over a threshold.
  - `required_translations` feeds the N-7 i18n kind.
- **Tests:** property tests for the element diff (diffing a page against itself is empty; a move
  is never reported as remove + add) and a page-weight golden.

### N-32 — UIB client-script lint (S)

- **Why:** UX-15.
- **Surface:** codecheck rules for the UIB client-script API:
  - `api.setState` on an undeclared state property;
  - `api.emit` of an undeclared event;
  - an unused import;
  - a synchronous wait.

  The rules check against the macroponent's `state_properties` and `dispatched_events`.

- **Tests:** extend `test/p18-registry-lint.test.js`.

### N-33 — Structured composition edits and scaffolding (L) — owner gate O-18

- **Why:** UX-13, UX-14.
- **Surface:** `servicenow_edit_ui_page` in the `ui` package. Its operations, each a planned
  JSON patch, are:
  - `add_element`, `remove_element`, `move_element`;
  - `set_prop`, `bind_data`;
  - `add_event_handler`, `add_data_resource`;
  - `add_variant` (with applicability), `copy_page` and `add_route`.

  The plan shows the element diff from N-31 and the records to be created. Apply writes through
  `upsert_artifact`, so the journal, the policy and `revert` apply. The macroponent JSON fields
  become `writable:true` only after the N-25 round-trip test passes on a PDI.

- **Owner decision O-18:**
  - whether UIB writes ship at all;
  - whether they need an open update set;
  - whether `/api/now/uxf/*` stays out;
  - whether custom-component deployment stays out.
- **Done when:** on a PDI, each operation round-trips, and `revert` restores the page byte for
  byte.
- **Tests:** `test/edit-ui-page.test.js` (each op, the untouched-bytes property, refusal before
  N-25, revert).

### N-34 — UIB guided entry and registry cleanup (S)

- **Why:** UX-24.
- **Surface:**
  - A `uib-page-review` prompt (explain the page, N-28 impact, N-29 security, N-31 weight), gated
    on the `ui` package.
  - A plugin skill `sn-uib` (D-8).
  - The duplicate `sys_ux_form_action` descriptor is merged into one type, with the other name
    kept as an alias.
- **Tests:** prompt test; registry-lint test that one table has one descriptor.

## 5. Sequencing

| Phase | Items            | Why this order                                                                      |
| ----- | ---------------- | ----------------------------------------------------------------------------------- |
| R     | N-25 (O-5), N-34 | Verify the shapes first; the cleanup is small and unblocks the registry-lint test.  |
| A     | N-26, N-28       | Read-only, highest value: understand a page and see what a change would touch.      |
| B     | N-29, N-30, N-27 | Security, then workspace coverage, then per-user variant resolution.                |
| C     | N-31, N-32       | Quality and authoring aids; N-31's element diff is a prerequisite for N-33's plans. |
| D     | N-33 (O-18)      | Writes, after the PDI round-trip and the owner decision.                            |

Rough total for one maintainer: phases R–C ≈ 6–8 weeks plus the owner's PDI time; phase D ≈
3–4 weeks after O-18.

## 6. Owner gate (new)

- **O-18** UIB writes (N-33):
  - whether they ship at all;
  - whether they require an open update set;
  - whether `/api/now/uxf/*` stays out;
  - whether custom-component deployment (`snc ui-component`) stays out.

All N-25 … N-34 items also depend on **O-5** (PDI verification) and on **O-2** for fixtures.
