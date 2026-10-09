# servicenow-mcp-ai — ServiceNow SDK parity epic

Date: 2026-09-23 · Status: **proposed (docs only, no code)**. Execution rows 55–83 in
[ROADMAP-V3.md](ROADMAP-V3.md) → "SDK parity epic". Evidence: the 2026-09-23 SDK coverage
inventory (a local research capture of the 4.12.2 docs, npm metadata and release notes v3.0.0–v4.12.0)
and a read of `src/` in the 2026-09-23 working tree. Table and field names below come from that
inventory; anything it marked (U) stays **unverified** here and must be confirmed on a live instance
(gate O-5) before an item designs around it.

## 1. Purpose and scope

The server should be able to read, explain, analyse, snapshot, write (safely) and emit as Fluent
source **every artefact the ServiceNow SDK (`@servicenow/sdk`, `now-sdk`, Fluent) can describe**, plus
the adjacent artefacts the SDK only reaches through `Record()` or does not model at all. That
includes UI Builder / Next Experience internals (`sys_ux_*`), Service Portal (`sp_*`), Flow Designer /
Workflow Studio (`sys_hub_*`), Process Automation Designer playbooks (`sys_pd_*`) and legacy Workflow
(`wf_*`).

In scope:

- Every Fluent API in SDK 4.12.2 and the 4.13 additions `DatabaseView` and `Interceptor` (§2 of the inventory).
- Every artefact an SDK **guide** builds through `Record()` or an option of another API, even without an
  API page of its own (assignment rules, knowledge base access, table augments, security attributes and
  data filters, form formatters — rows added by the 2026-10-09 guide audit).
- The `Record()`-only / transform-only areas: UIB internals, legacy workflow, decision tables,
  `sys_data_source`, portal search sources, guide-only tables (`sys_ui_style`, `sysevent_register`,
  `sys_relationship`, LDAP, views).
- The scoped application as the deployment unit (`sys_app`, `sys_scope`, dependencies,
  `sys_update_xml`), because SDK-managed scopes change the write rules.

Out of scope (see §8): executing the SDK CLI against an instance (`now-sdk install`, `cicd publish`),
UI Builder / Flow Designer internal endpoints, custom UX component builds (`snc ui-component`),
runtime execution of portal widgets, and background scripts.

## 2. SDK baseline and tracking rule

| Channel             | Version     | Date       | Notes                                                                                                                                                                                                             |
| ------------------- | ----------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm `latest` (GA)   | **4.12.2**  | 2026-09-15 | Baseline for every "Since" value and for the gap matrix.                                                                                                                                                          |
| npm `next`          | **4.13.0**  | 2026-09-23 | Adds `DatabaseView` (`sys_db_view`, `sys_db_view_table` (U)); the API page returned 404 — **unverified** (§6.2).                                                                                                  |
| npm `latest` (seen) | **4.13.6**  | 2026-10-09 | `sdk:drift` run: `DatabaseView` and `Interceptor` (`sys_wizard`) now have API pages. The owner re-pinned the SDK and the baseline to 4.13.6 the same day (O-7, ADR 0002).                                         |
| API history (recap) | 4.0 → 4.12  | —          | 4.0 ScriptInclude/UiPage/UiAction/ScriptAction/SPWidget · 4.2 ImportSet/UiPolicy · 4.3 Flow MVP, Catalog, Workspace, Dashboard, Sla …                                                                             |
| API history (recap) | 4.5 → 4.8   | —          | 4.5 scan checks, ScheduledScript, SPPage/SPTheme/SPMenu, AiAgent · 4.6 Action, subflow calls, Form · 4.7 DataPolicy, `$override` · 4.8 PlaybookDefinition, RestMessage, Alias, RetryPolicy, DataLookup, `Now.del` |
| API history (recap) | 4.10 → 4.12 | —          | 4.10 StateModel, `cicd` · 4.11 TestSuite, GraphQLApi · 4.12 Assessment, RiskAssessment                                                                                                                            |

**Tracking rule.**

1. The artefact registry (P-1) records `sdkApi` and `sdkSince` per artefact type, and a single
   `SDK_BASELINE` constant (`4.12.2`) that CI reads.
2. A scheduled check (P-4) compares the baseline with the npm `latest` dist-tag and diffs the SDK docs
   index (`https://servicenow.github.io/sdk/llms.txt`) against the registry's `sdkApi` list. A new
   API, a renamed API or a new major opens a tracking issue; it never fails `npm run check`.
3. A new SDK **minor**: add or adjust registry descriptors within one release (R/X tiers first, same
   rules as P-7…P-9). A new **major**: re-run the inventory and re-baseline this file before G-tier work
   targets it. Generated Fluent (P5) declares the SDK version it targets in its header comment.
4. `next`-only APIs (none since the 4.13.6 re-pin; `DatabaseView` was one) get a descriptor with `verified:false` and no G tier until
   they reach `latest` and O-5 confirms the tables.
5. **Guides are tracked too.** The API index alone misses artefacts that a guide builds with `Record()`
   or with an option of another API. `GUIDE_COVERAGE` in `scripts/sdk-drift.mjs` maps every guide slug
   of the docs index (`## Guides`) to the §4 rows it describes, or to `n/a` with a reason (CLI, process,
   reference pages). A guide missing from the map, or a mapped guide gone from the index, is a drift
   finding; `test/sdk-drift.test.js` keeps every mapped row id present in §4.

## 3. Capability tiers

A tier is **covered (✅)** only when an artefact-aware tool handles that artefact type (knows its
tables, child records and fields). Generic reach does not count: `query_table` / `get_record` read any
table and `create_record` / `update_record` / `delete_record` write any table that policy allows.

| Tier  | Name                      | Definition                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R** | read                      | List artefacts of a type (filter by scope, name, active, updated) and get one by `sys_id` or natural key, **including its child records** (e.g. `sys_ui_policy` + `sys_ui_policy_action`), scope and SDK-managed flag (P-3).                                                                  |
| **X** | explain / describe        | A structured, typed description of one artefact: what it does, when it runs, what it references. JSON/compressed fields are **decoded** (`sys_hub_*_v2.values`, `sys_ux_macroponent.composition`, `sp_instance.widget_parameters`); undecodable values are returned raw with `decoded:false`. |
| **A** | analyse                   | Lint rules, where-used (inbound references) and dependencies (outbound references) across artefact types, including references hidden in decoded JSON and scripts.                                                                                                                            |
| **S** | snapshot / compare / docs | The type participates in `snapshot_instance`, `compare_instances` and generated docs; Mermaid output where a graph helps (flows, UIB routes, portal layouts, workflows, state models).                                                                                                        |
| **W** | write                     | Artefact-aware create/update/delete through **plan → apply**: one plan covers parent and children, it is journaled with `before` (H-5), policy-gated (H-11) and refused/warned for SDK-managed scopes (P-22).                                                                                 |
| **G** | generate Fluent           | Emit Fluent `.now.ts` source for the artefact (with `Now.ID` keys, `Now.include` sidecar files, `Now.ref` references; `Record()` fallback where the SDK has no API) that `now-sdk build` accepts.                                                                                             |

Coverage marks: **✅** artefact-aware · **◐** partial (some fields or children only, or only as a
script body through `SCRIPT_TYPES`) · **—** not covered (generic reach only). **n/a** = the tier does
not apply.

## 4. Gap matrix

Reference keys used in the "Now (refs)" column:

| Key    | Location                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| `[ST]` | `src/api/scripts.ts:31-95` `SCRIPT_TYPES` → `list_scripts`, `get_script`, `search_code`                    |
| `[WU]` | `src/api/whereused.ts:97` `where_used` (text search over `SCRIPT_TYPES`)                                   |
| `[CC]` | `src/api/codecheck.ts` — `lint_script` :208, `lint_table` :253, ACL security scan :348, `code_health` :433 |
| `[SN]` | `src/api/snapshot.ts:74` `snapshot_instance` (tables, schema, plugins, apps :226, the 9 script types)      |
| `[CP]` | `src/api/compare.ts:292` `compare_instances`                                                               |
| `[MT]` | `src/api/meta.ts` — `list_tables` :23, `describe_table` :95                                                |
| `[DG]` | `src/api/diagrams.ts` — ER diagram :35, table flow :75                                                     |
| `[FL]` | `src/api/flows.ts` — `trace_table_event` :313, `list_flows` :378, `get_flow` :473, `get_flow_runs` :587    |
| `[AT]` | `src/api/atf.ts` — tests :30, suites :52, run via `sn_cicd` :113-143                                       |
| `[CT]` | `src/api/catalog.ts` — consumer view through `/api/sn_sc/servicecatalog` (items, variables, order)         |
| `[AS]` | `src/tools/attachment.ts` — attachment package                                                             |

Target tiers use the letters of §3; phases refer to §6. Rows marked (U) name tables the inventory did
not verify.

### 4.1 Core platform / data model

| Id      | Artefact (SDK API)                            | ServiceNow table(s)                                                                                  | R   | X   | A   | S   | W   | G   | Now (refs)                                     | Target | Phase    | Items                  |
| ------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | --- | ---------------------------------------------- | ------ | -------- | ---------------------- |
| CORE-1  | `Table`                                       | sys_db_object, sys_dictionary, sys_dictionary_override, sys_documentation, sys_choice                | ✅  | ◐   | ◐   | ◐   | —   | —   | `[MT]`, `[DG]`, schema in `[SN]`               | RXASWG | P1,P3,P5 | P-7, S-7, P-26         |
| CORE-2  | `ChoiceSet`                                   | sys_choice, sys_choice_set (legacy)                                                                  | —   | —   | —   | —   | —   | —   | —                                              | RXSWG  | P1,P5    | P-7, S-7, P-26         |
| CORE-3  | `DatabaseView` (4.13)                         | sys_db_view, sys_db_view_table (U)                                                                   | —   | —   | —   | —   | —   | —   | — (on the 4.13.6 baseline, unverified)         | RXS    | P1       | P-7, P-4               |
| CORE-4  | `StateModel`                                  | sttrm_model, sttrm_state, sttrm_state_transition, sttrm_transition_condition                         | —   | —   | —   | —   | —   | —   | —                                              | RXASG  | P1,P3,P5 | P-7, P-20, P-26        |
| CORE-5  | `Property`                                    | sys_properties                                                                                       | —   | —   | —   | —   | —   | —   | — (S-10 plans get/set)                         | RXASWG | P1,P4    | P-7, S-10, P-23        |
| CORE-6  | `UserPreference`                              | sys_user_preference                                                                                  | —   | —   | —   | —   | —   | —   | —                                              | RXSG   | P1,P5    | P-7, P-26              |
| CORE-7  | `Role`                                        | sys_user_role, sys_user_role_contains                                                                | —   | —   | —   | —   | —   | —   | —                                              | RXASWG | P1,P4    | P-7, P-17, P-23        |
| CORE-8  | `Acl`                                         | sys_security_acl, sys_security_acl_role                                                              | ◐   | ◐   | ✅  | ◐   | —   | —   | script body `[ST]`, scan `[CC]` :348           | RXASWG | P1,P4    | P-7, S-3, P-23         |
| CORE-9  | `CrossScopePrivilege`                         | sys_scope_privilege                                                                                  | —   | —   | —   | —   | —   | —   | —                                              | RXASG  | P1,P3    | P-7, P-17              |
| CORE-10 | `UserCriteria`                                | user_criteria                                                                                        | —   | —   | —   | —   | —   | —   | —                                              | RXASG  | P1,P3    | P-7, P-17              |
| CORE-11 | `Record` (generic fallback)                   | any table                                                                                            | ✅  | —   | —   | —   | ✅  | —   | generic Table API tools (`src/tools/table.ts`) | RXG    | P1,P5    | P-5, P-26              |
| CORE-12 | field styles (Record)                         | sys_ui_style                                                                                         | —   | —   | —   | —   | —   | —   | —                                              | RXSG   | P1       | P-7                    |
| CORE-13 | schedules (Record)                            | cmn_schedule, cmn_schedule_span (U)                                                                  | —   | —   | —   | —   | —   | —   | —                                              | RXS    | P1       | P-7                    |
| CORE-14 | events (Record)                               | sysevent_register                                                                                    | —   | —   | —   | —   | —   | —   | —                                              | RXASG  | P1,P3    | P-7, P-17              |
| CORE-15 | relationships (Record)                        | sys_relationship                                                                                     | —   | —   | —   | —   | —   | —   | —                                              | RXSG   | P1       | P-7                    |
| CORE-16 | LDAP (Record)                                 | ldap_server_config, ldap_server_url                                                                  | —   | —   | —   | —   | —   | —   | —                                              | RXS    | P1       | P-7 (secrets redacted) |
| CORE-17 | attachments (`Now.attach`)                    | sys_attachment                                                                                       | ✅  | —   | —   | —   | ✅  | —   | `[AS]`                                         | RWG    | P5       | P-26                   |
| CORE-18 | assignment rules (Record)                     | sysrule_assignment                                                                                   | —   | —   | —   | —   | —   | —   | —                                              | RXASG  | P1,P3,P5 | P-7, P-17, P-26        |
| CORE-19 | knowledge base access (Record)                | kb_uc_can_read_mtom, kb_uc_can_contribute_mtom, kb_uc_cannot_read_mtom, kb_uc_cannot_contribute_mtom | —   | —   | —   | —   | —   | —   | —                                              | RXAS   | P1,P3    | P-7, P-17              |
| CORE-20 | table augments (`Table` `augments`)           | sys_dictionary rows a scope adds to a table owned by another scope                                   | ◐   | —   | —   | —   | —   | —   | columns only, through `[MT]`                   | RXA    | P1,P3    | P-7, P-17              |
| CORE-21 | security attributes and data filters (Record) | sys_security_attribute, sys_security_data_filter                                                     | —   | —   | —   | —   | —   | —   | —                                              | RXAS   | P1,P3    | P-7, P-17              |

### 4.2 Server-side logic

| Id     | Artefact (SDK API)          | ServiceNow table(s)                                                                              | R   | X   | A   | S   | W   | G   | Now (refs)                             | Target | Phase    | Items                            |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------ | --- | --- | --- | --- | --- | --- | -------------------------------------- | ------ | -------- | -------------------------------- |
| SRV-1  | `BusinessRule`              | sys_script                                                                                       | ✅  | ◐   | ✅  | ✅  | —   | —   | `[ST]`, `[WU]`, `[CC]`, `[SN]`, `[FL]` | RXASWG | P1,P4,P5 | P-7, P-23, P-26                  |
| SRV-2  | `ScriptInclude`             | sys_script_include                                                                               | ✅  | ◐   | ✅  | ✅  | —   | —   | `[ST]`, `[WU]`, `[CC]`, `[SN]`         | RXASWG | P1,P4,P5 | P-7, P-23, P-26                  |
| SRV-3  | `ScriptAction`              | sysevent_script_action                                                                           | —   | —   | —   | —   | —   | —   | — (S-4 adds)                           | RXASWG | P1,P4,P5 | S-4, P-7, P-23                   |
| SRV-4  | `ScheduledScript`           | sysauto_script                                                                                   | ✅  | ◐   | ✅  | ✅  | —   | —   | `[ST]` `scheduled_job`                 | RXASWG | P1,P4,P5 | P-7, P-23, P-26                  |
| SRV-5  | JS modules (`src/server`)   | sys_module (U)                                                                                   | —   | —   | —   | —   | —   | n/a | —                                      | RXAS   | P1,P3    | P-7, P-18                        |
| SRV-6  | `RestApi`                   | sys_ws_definition, sys_ws_operation, sys_ws_version (+ query/header params)                      | ◐   | ◐   | ◐   | ◐   | —   | —   | `[ST]` `rest_operation` only           | RXASWG | P1,P4,P5 | S-4, P-7, P-23, P-26             |
| SRV-7  | `RestMessage`               | sys_rest_message, sys_rest_message_fn (+ headers/params)                                         | —   | —   | —   | —   | —   | —   | — (S-4 adds `sys_rest_message_fn`)     | RXASWG | P1,P4,P5 | S-4, P-7, P-23                   |
| SRV-8  | `GraphQLApi`                | sys_graphql_schema, sys_graphql_resolver, sys_graphql_resolver_mapping, sys_graphql_typeresolver | —   | —   | —   | —   | —   | —   | —                                      | RXASG  | P1,P3,P5 | P-7, P-18, P-26                  |
| SRV-9  | `Alias` / `AliasTemplate`   | sys_alias, sys_alias_templates                                                                   | —   | —   | —   | —   | —   | —   | —                                      | RXSG   | P1       | P-7 (credential fields redacted) |
| SRV-10 | `RetryPolicy`               | sys_retry_policy                                                                                 | —   | —   | —   | —   | —   | —   | —                                      | RXSG   | P1       | P-7                              |
| SRV-11 | `DataLookup`                | dl_definition, dl_definition_rel_match, dl_definition_rel_set, dl_matcher                        | —   | —   | —   | —   | —   | —   | —                                      | RXASG  | P1,P3    | P-7                              |
| SRV-12 | `ImportSet`                 | sys_transform_map, sys_transform_entry, sys_transform_script (U for children)                    | ◐   | ◐   | ◐   | ◐   | —   | —   | `[ST]` `transform` script only         | RXASWG | P1,P4,P5 | S-4, P-7, P-23                   |
| SRV-13 | data source (Record)        | sys_data_source                                                                                  | —   | —   | —   | —   | —   | —   | — (S-4 adds)                           | RXASG  | P1       | S-4, P-7                         |
| SRV-14 | `EmailNotification`         | sysevent_email_action                                                                            | ◐   | —   | ◐   | —   | —   | —   | trace lane `[FL]` :221                 | RXASWG | P1,P4,P5 | P-7, S-7, P-23                   |
| SRV-15 | `InboundEmailAction`        | sysevent_in_email_action                                                                         | —   | —   | —   | —   | —   | —   | —                                      | RXASWG | P1,P4    | P-7, P-23                        |
| SRV-16 | `Sla`                       | contract_sla                                                                                     | —   | —   | —   | —   | —   | —   | — (S-5 lane)                           | RXASWG | P1,P3    | P-7, S-5, P-13                   |
| SRV-17 | UI scripts (no SDK API)     | sys_ui_script                                                                                    | —   | —   | —   | —   | —   | —   | — (S-4 adds)                           | RXAS   | P1       | S-4                              |
| SRV-18 | fix scripts (no SDK API)    | sys_script_fix                                                                                   | —   | —   | —   | —   | —   | —   | — (S-4 adds)                           | RXAS   | P1       | S-4                              |
| SRV-19 | email scripts (no SDK API)  | sys_script_email                                                                                 | —   | —   | —   | —   | —   | —   | — (S-4 adds)                           | RXAS   | P1       | S-4                              |
| SRV-20 | other scripted (no SDK API) | sys_ui_macro, sys_processor, sys_script_validator                                                | —   | —   | —   | —   | —   | —   | — (S-4 adds)                           | RXAS   | P1       | S-4                              |

### 4.3 Classic UI

| Id     | Artefact (SDK API)   | ServiceNow table(s)                                                                                                        | R   | X   | A   | S   | W   | G   | Now (refs)                      | Target | Phase    | Items           |
| ------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | --- | ------------------------------- | ------ | -------- | --------------- |
| CUI-1  | `ClientScript`       | sys_script_client                                                                                                          | ✅  | ◐   | ✅  | ✅  | —   | —   | `[ST]`, `[WU]`, `[CC]`, `[SN]`  | RXASWG | P1,P4,P5 | P-7, P-23, P-26 |
| CUI-2  | `UiAction`           | sys_ui_action (+ sys_ux_form_action for workspace buttons)                                                                 | ✅  | ◐   | ✅  | ✅  | —   | —   | `[ST]`, `[WU]`, `[CC]`, `[SN]`  | RXASWG | P1,P4,P5 | P-7, P-23, P-26 |
| CUI-3  | `UiPolicy`           | sys_ui_policy, sys_ui_policy_action                                                                                        | ◐   | ◐   | ◐   | ◐   | —   | —   | `[ST]` scripts only, no actions | RXASWG | P1,P4,P5 | P-7, P-23, P-26 |
| CUI-4  | `DataPolicy`         | sys_data_policy2, sys_data_policy_rule                                                                                     | —   | —   | —   | —   | —   | —   | — (S-5 lane)                    | RXASWG | P1,P4,P5 | P-7, S-5, P-23  |
| CUI-5  | `UiPage`             | sys_ui_page                                                                                                                | —   | —   | —   | —   | —   | —   | — (S-4 adds)                    | RXASWG | P1,P4,P5 | S-4, P-7, P-26  |
| CUI-6  | `Form`               | sys_ui_form, sys_ui_section, sys_ui_element, sys_ui_form_section, sys_ui_annotation, sys_ui_formatter (+ sys_process_flow) | —   | —   | —   | —   | —   | —   | — (S-9 plans `sys_ui_section`)  | RXASWG | P1,P3,P4 | P-7, S-9, P-23  |
| CUI-7  | `List`               | sys_ui_list, sys_ui_list_element                                                                                           | —   | —   | —   | —   | —   | —   | — (S-9 plans `sys_ui_list`)     | RXASWG | P1,P3,P4 | P-7, S-9, P-23  |
| CUI-8  | `ApplicationMenu`    | sys_app_application, sys_app_module                                                                                        | —   | —   | —   | —   | —   | —   | —                               | RXASWG | P1,P4,P5 | P-7, P-23, P-26 |
| CUI-9  | views (Record)       | sys_ui_view, sysrule_view, sys_ui_list_control                                                                             | —   | —   | —   | —   | —   | —   | —                               | RXS    | P1       | P-7             |
| CUI-10 | `Interceptor` (4.13) | sys_wizard, sys_wizard_answer, sys_wizard_choice, sys_wizard_choice_list (U)                                               | —   | —   | —   | —   | —   | —   | — (registered, unverified)      | RXS    | P1       | P-7, P-4        |

### 4.4 Next Experience — SDK APIs

| Id   | Artefact (SDK API) | ServiceNow table(s)                                                                          | R   | X   | A   | S   | W   | G   | Now (refs) | Target | Phase    | Items            |
| ---- | ------------------ | -------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | --- | ---------- | ------ | -------- | ---------------- |
| NX-1 | `Workspace`        | sys_ux_page_registry (+ generated sys_ux_app_config, routes, pages)                          | —   | —   | —   | —   | —   | —   | —          | RXASG  | P2,P3,P5 | P-9, P-15, P-28  |
| NX-2 | `Dashboard`        | par_dashboard, par_dashboard_tab (U), par_dashboard_widget (U), par_dashboard_permission (U) | —   | —   | —   | —   | —   | —   | —          | RXSG   | P2,P5    | P-9, P-15, P-28  |
| NX-3 | `UxListMenuConfig` | sys_ux_list_menu_config, sys_ux_list_category (U), sys_ux_list (U)                           | —   | —   | —   | —   | —   | —   | —          | RXASWG | P2,P4,P5 | P-15, P-23, P-28 |
| NX-4 | `Applicability`    | sys_ux_applicability, sys_ux_applicability_m2m_list (U)                                      | —   | —   | —   | —   | —   | —   | —          | RXASWG | P2,P4,P5 | P-15, P-23, P-28 |

### 4.5 UI Builder internals (no Fluent API; `Record()` / transform only)

| Id     | Artefact               | ServiceNow table(s) and key fields                                                                                                                                 | R   | X   | A   | S   | W   | G   | Now (refs) | Target              | Phase    | Items            |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | --- | --- | --- | --- | --- | ---------- | ------------------- | -------- | ---------------- |
| UIB-1  | experience config      | sys_ux_app_config (landing_path, roles)                                                                                                                            | —   | —   | —   | —   | —   | —   | —          | RXASW               | P2,P4    | P-14, P-23       |
| UIB-2  | routes                 | sys_ux_app_route (route_type, app_config, screen_type, parent_macroponent, parameters JSON, optional_parameters), sys_ux_screen_type, sys_ux_screen_collection (U) | —   | —   | —   | —   | —   | —   | —          | RXAS                | P2,P3    | P-14, P-19       |
| UIB-3  | page variants          | sys_ux_screen (screen_type, macroponent, order, applicability, event_mappings, macroponent_config JSON), sys_ux_screen_condition (U)                               | —   | —   | —   | —   | —   | —   | —          | RXAS                | P2,P3    | P-14, P-19       |
| UIB-4  | page definition        | sys_ux_macroponent (composition, data, props, internal_event_mappings, state_properties, dispatched_events, handled_events, required_translations, root_component) | —   | —   | —   | —   | —   | —   | —          | RXAS, W plan-only   | P2,P3    | P-14, P-17, P-23 |
| UIB-5  | UX client scripts      | sys_ux_client_script, sys_ux_client_script_include (macroponent, script, type)                                                                                     | —   | —   | —   | —   | —   | —   | —          | RXASW               | P2,P3    | P-9, P-14, P-18  |
| UIB-6  | data brokers           | sys_ux_data_broker_transform, sys_ux_data_broker_scriptlet, sys_ux_data_broker_rest (U), sys_ux_data_broker_graphql (U)                                            | —   | —   | —   | —   | —   | —   | —          | RXAS                | P2,P3    | P-14, P-19       |
| UIB-7  | events                 | sys_ux_event, sys_ux_addon_event_mapping (U)                                                                                                                       | —   | —   | —   | —   | —   | —   | —          | RXA                 | P2       | P-14             |
| UIB-8  | components             | sys_ux_lib_component (tag, category, properties), sys_ux_lib_source_script (U)                                                                                     | —   | —   | —   | —   | —   | —   | —          | RXA                 | P2       | P-14             |
| UIB-9  | themes                 | sys_ux_theme, sys_ux_style, m2m_app_theme (U)                                                                                                                      | —   | —   | —   | —   | —   | —   | —          | RXS                 | P2       | P-9              |
| UIB-10 | workspace form actions | sys_ux_form_action, sys_ux_form_action_layout, sys_ux_form_action_layout_item                                                                                      | —   | —   | —   | —   | —   | —   | —          | RXASWG (`Record()`) | P2,P4,P5 | P-15, P-23, P-26 |
| UIB-11 | search composite       | sys_ux_composite_definition                                                                                                                                        | —   | —   | —   | —   | —   | —   | —          | RXS                 | P2       | P-9              |

### 4.6 Service Portal

| Id    | Artefact (SDK API)         | ServiceNow table(s) and key fields                                                                                                                                                                  | R   | X   | A   | S   | W   | G   | Now (refs)           | Target | Phase       | Items                  |
| ----- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | --- | -------------------- | ------ | ----------- | ---------------------- |
| SP-1  | `ServicePortal`            | sp_portal (url_suffix, homepage, login_page, notfound_page, theme, sp_rectangle_menu, quick_start_config) + m2m catalogs/KBs (U)                                                                    | —   | —   | —   | —   | —   | —   | —                    | RXASWG | P2,P4,P5    | P-16, P-24, P-28       |
| SP-2  | `SPWidget`                 | sp_widget (id, name, template, css, client_script, script, link, option_schema, demo_data, controller_as, public, roles), sp_ng_template, m2m_sp_widget_dependency (U), m2m_sp_ng_pro_sp_widget (U) | —   | —   | —   | —   | —   | —   | — (S-4 adds scripts) | RXASWG | P2,P3,P4,P5 | S-4, P-16, P-24, P-28  |
| SP-3  | `SPWidgetDependency`       | sp_dependency (name, module, include_on_page_load), m2m_sp_dependency_js_include, m2m_sp_dependency_css_include                                                                                     | —   | —   | —   | —   | —   | —   | —                    | RXASWG | P2,P4,P5    | P-16, P-24, P-28       |
| SP-4  | `SPAngularProvider`        | sp_angular_provider (name, type, script)                                                                                                                                                            | —   | —   | —   | —   | —   | —   | —                    | RXASWG | P2,P4,P5    | P-16, P-24, P-28       |
| SP-5  | `JsInclude` / `CssInclude` | sp_js_include, sp_css_include (source, url, sys_ui_script / sp_css)                                                                                                                                 | —   | —   | —   | —   | —   | —   | —                    | RXSWG  | P2,P5       | P-16, P-28             |
| SP-6  | `SPPage`                   | sp_page (id, title, public, roles, draft), sp_container, sp_row, sp_column, sp_instance (sp_widget, widget_parameters JSON, order)                                                                  | —   | —   | —   | —   | —   | —   | —                    | RXASWG | P2,P3,P4,P5 | P-16, P-19, P-24, P-28 |
| SP-7  | `SPTheme`                  | sp_theme (header, footer, css_variables), m2m_sp_theme_js_include, m2m_sp_theme_css_include                                                                                                         | —   | —   | —   | —   | —   | —   | —                    | RXSWG  | P2,P4,P5    | P-16, P-24, P-28       |
| SP-8  | `SPMenu`                   | sp_instance_menu, sp_rectangle_menu_item (type, url, sp_page, condition, order, parent)                                                                                                             | —   | —   | —   | —   | —   | —   | —                    | RXASWG | P2,P5       | P-16, P-28             |
| SP-9  | `SPHeaderFooter`           | sp_header_footer                                                                                                                                                                                    | —   | —   | —   | —   | —   | —   | —                    | RXSWG  | P2,P5       | P-16, P-28             |
| SP-10 | `SPPageRouteMap`           | sp_page_route_map (portals, route_from_page, route_to_page, roles, active, order)                                                                                                                   | —   | —   | —   | —   | —   | —   | —                    | RXASWG | P2,P3,P5    | P-16, P-19, P-28       |
| SP-11 | not modelled by the SDK    | sp_search_source, m2m_sp_portal_search_source, sp_css, sp_config, sp_chat_queue, announcement / sp_announcement\* (U)                                                                               | —   | —   | —   | —   | —   | —   | —                    | RXS    | P2          | P-9, P-16              |

### 4.7 Flow Designer / Workflow Studio and playbooks

| Id     | Artefact (SDK API)       | ServiceNow table(s) and key fields                                                                                                                                                                         | R   | X   | A   | S   | W   | G   | Now (refs)                                                | Target                 | Phase       | Items                       |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | --- | --------------------------------------------------------- | ---------------------- | ----------- | --------------------------- |
| FLW-1  | `Flow`                   | sys_hub_flow (name, internal_name, type, status, active, run_as, run_with_roles, latest_snapshot, master_snapshot, label_cache), sys_hub_flow_snapshot (U)                                                 | ◐   | ◐   | ◐   | —   | —   | —   | `[FL]` list :378, get :473, trace :313 (triggers :159)    | RXAS, W active only, G | P2,P3,P4,P5 | S-5, P-10, P-20, P-25, P-27 |
| FLW-2  | `Subflow`                | sys_hub_flow (type subflow), sys_hub_sub_flow_instance(\_v2) (U)                                                                                                                                           | ◐   | ◐   | —   | —   | —   | —   | listed as sys_hub_flow rows by `[FL]`; calls not resolved | RXASG                  | P2,P3,P5    | P-11, P-17, P-27            |
| FLW-3  | `Action` (custom)        | sys_hub_action_type_definition, sys_hub_action_type_snapshot (U), sys_hub_step_instance, sys_hub_step_ext_input/output (U), sys_hub_action_input, sys_hub_action_output                                    | ◐   | ◐   | —   | —   | —   | —   | —                                                         | RXASG                  | P2,P3,P5    | P-11, P-18, P-27            |
| FLW-4  | triggers (`trigger.*`)   | sys_hub_trigger_instance(\_v2) (U), sys_hub_trigger_definition                                                                                                                                             | ◐   | ◐   | ◐   | —   | —   | —   | `[FL]` :159 (table_name, condition, trigger_type)         | RXASG                  | P2,P5       | P-10, P-27                  |
| FLW-5  | action steps             | sys_hub_action_instance(\_v2) (U) (action_type, order, ui_id, parent_ui_id, values — compressed)                                                                                                           | ◐   | —   | —   | —   | —   | —   | `[FL]` get_flow: order + action name, values not decoded  | RXASG                  | P2,P5       | P-10, P-27                  |
| FLW-6  | flow logic               | sys_hub_flow_logic_instance_v2 (logic_definition, order, ui_id, parent_ui_id, values)                                                                                                                      | —   | —   | —   | —   | —   | —   | —                                                         | RXASG                  | P2,P5       | P-10, P-27                  |
| FLW-7  | flow I/O and variables   | sys_hub_flow_input, sys_hub_flow_output, sys_hub_flow_variable                                                                                                                                             | —   | —   | —   | —   | —   | —   | —                                                         | RXASG                  | P2,P5       | P-10, P-27                  |
| FLW-8  | stages                   | sys_hub_flow_stage                                                                                                                                                                                         | —   | —   | —   | —   | —   | —   | —                                                         | RXSG                   | P2,P5       | P-10, P-27                  |
| FLW-9  | flow runtime             | sys_flow_context, sys_flow_log, sys_flow_report_doc_chunk (U)                                                                                                                                              | ◐   | —   | —   | n/a | n/a | n/a | `[FL]` get_flow_runs :587 (context only)                  | RX                     | P2          | P-10                        |
| FLW-10 | `PlaybookDefinition`     | sys_pd_process_definition, sys_pd_lane, sys_pd_activity, sys_pd_trigger_instance, sys_pd_process_input, sys_pd_process_output, sys_pd_timer_attributes, sys_pd_activity_definition, sys_pd_process_variant | —   | —   | —   | —   | —   | —   | —                                                         | RXASG                  | P2,P3,P5    | P-12, P-20, P-27            |
| FLW-11 | playbook runtime         | sys_pd_context, sys_pd_lane_context (U), sys_pd_activity_context                                                                                                                                           | —   | —   | —   | n/a | n/a | n/a | —                                                         | RX                     | P2          | P-12                        |
| FLW-12 | decision tables (Record) | sys_decision, sys_decision_question (U)                                                                                                                                                                    | ◐   | ◐   | —   | —   | —   | —   | —                                                         | RXAS                   | P2          | P-11                        |

### 4.8 Legacy Workflow (no SDK API; transform-only)

| Id   | Artefact                   | ServiceNow table(s) and key fields                                                                        | R   | X   | A   | S   | W   | G   | Now (refs)                                     | Target | Phase | Items      |
| ---- | -------------------------- | --------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | --- | ---------------------------------------------- | ------ | ----- | ---------- |
| WF-1 | workflow + versions        | wf_workflow (name, table, condition), wf_workflow_version (published, checked_out, stages, condition) (U) | ✅  | ◐   | ◐   | —   | n/a | n/a | `[FL]` list `kind:"workflow"` :392, trace :187 | RXAS   | P2,P3 | P-13, P-20 |
| WF-2 | activities                 | wf_activity (activity_definition, x, y, vars), wf_activity_definition (U)                                 | ◐   | —   | —   | —   | n/a | n/a | `[FL]` get_flow legacy branch :478             | RXAS   | P2    | P-13       |
| WF-3 | transitions and conditions | wf_transition (from, to, condition), wf_condition (U)                                                     | —   | —   | —   | —   | n/a | n/a | —                                              | RXS    | P2    | P-13       |
| WF-4 | stages                     | wf_stage (U)                                                                                              | —   | —   | —   | —   | n/a | n/a | —                                              | RX     | P2    | P-13       |
| WF-5 | runtime                    | wf_context, wf_executing, wf_history, wf_log (U)                                                          | —   | —   | —   | n/a | n/a | n/a | —                                              | RX     | P2    | P-13       |
| WF-6 | inbound references         | sc_cat_item.workflow, contract_sla.workflow → wf_workflow                                                 | —   | n/a | —   | n/a | n/a | n/a | —                                              | A      | P3    | P-13, P-19 |

### 4.9 Service Catalog

| Id    | Artefact (SDK API)              | ServiceNow table(s)                                                       | R   | X   | A   | S   | W   | G   | Now (refs)                                       | Target | Phase       | Items                |
| ----- | ------------------------------- | ------------------------------------------------------------------------- | --- | --- | --- | --- | --- | --- | ------------------------------------------------ | ------ | ----------- | -------------------- |
| CAT-1 | `CatalogItem`                   | sc_cat_item, sc_cat_item_category (U), sc_cat_item_user_criteria_mtom (U) | ◐   | ◐   | —   | —   | —   | —   | `[CT]` consumer view (not the definition record) | RXASWG | P1,P3,P4,P5 | P-8, S-7, P-24, P-28 |
| CAT-2 | `CatalogItemRecordProducer`     | sc_cat_item_producer                                                      | —   | —   | —   | —   | —   | —   | —                                                | RXASWG | P1,P4,P5    | P-8, P-24, P-28      |
| CAT-3 | `VariableSet`                   | item_option_new_set, io_set_item                                          | ◐   | —   | —   | —   | —   | —   | `[CT]` variables as rendered                     | RXASWG | P1,P4,P5    | P-8, P-24, P-28      |
| CAT-4 | variables + dependent questions | item_option_new, question_choice                                          | ◐   | —   | —   | —   | —   | —   | `[CT]` variables as rendered                     | RXASWG | P1,P3,P4,P5 | P-8, S-9, P-24, P-28 |
| CAT-5 | `CatalogClientScript`           | catalog_script_client                                                     | —   | —   | —   | —   | —   | —   | — (S-4 adds)                                     | RXASWG | P1,P4,P5    | S-4, P-8, P-24       |
| CAT-6 | `CatalogUiPolicy`               | catalog_ui_policy, catalog_ui_policy_action                               | —   | —   | —   | —   | —   | —   | —                                                | RXASWG | P1,P4,P5    | P-8, P-24, P-28      |

### 4.10 Testing, quality and assessment

| Id   | Artefact (SDK API)                                                | ServiceNow table(s)                                                                 | R   | X   | A   | S   | W   | G   | Now (refs)                       | Target | Phase    | Items           |
| ---- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | --- | -------------------------------- | ------ | -------- | --------------- |
| QA-1 | `Test` (ATF)                                                      | sys_atf_test, sys_atf_step                                                          | ◐   | —   | —   | —   | —   | —   | `[AT]` :30 tests; steps not read | RXASG  | P1,P5    | P-8, P-26       |
| QA-2 | `TestSuite`                                                       | sys_atf_test_suite, sys_atf_test_suite_test                                         | ◐   | —   | —   | —   | —   | —   | `[AT]` :52 suites, run :113      | RXSG   | P1,P5    | P-8, S-10, P-26 |
| QA-3 | `LinterCheck`, `ScriptOnlyCheck`, `ColumnTypeCheck`, `TableCheck` | scan_linter_check, scan_script_only_check, scan_column_type_check, scan_table_check | —   | —   | —   | —   | —   | —   | —                                | RXASG  | P1,P3,P5 | P-8, P-18, P-26 |
| QA-4 | `Assessment`                                                      | asmt_metric_type, asmt_metric_category, asmt_metric, asmt_metric_definition         | —   | —   | —   | —   | —   | —   | —                                | RXSG   | P1       | P-8             |
| QA-5 | `RiskAssessment`                                                  | change_risk_asmt, change_risk_asmt_threshold                                        | —   | —   | —   | —   | —   | —   | —                                | RXSG   | P1       | P-8             |

### 4.11 AI

| Id   | Artefact (SDK API)     | ServiceNow table(s)                                                                                                 | R   | X   | A   | S   | W   | G   | Now (refs) | Target | Phase | Items     |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | --- | ---------- | ------ | ----- | --------- |
| AI-1 | `AiAgent`              | sn_aia_agent, sn_aia_agent_config, sn_aia_tool, sn_aia_agent_tool_m2m, sn_aia_trigger_configuration, sn_aia_version | —   | —   | —   | —   | —   | —   | —          | RXSG   | P1,P5 | P-8, P-26 |
| AI-2 | `AiAgenticWorkflow`    | sn_aia_usecase, sn_aia_team, sn_aia_team_member                                                                     | —   | —   | —   | —   | —   | —   | —          | RXSG   | P1,P5 | P-8, P-26 |
| AI-3 | `NowAssistSkillConfig` | sn_nowassist_skill\_\* (U)                                                                                          | —   | —   | —   | —   | —   | —   | —          | RX     | P1    | P-8       |

### 4.12 Application, scope and delivery

| Id    | Artefact                       | ServiceNow table(s)                              | R   | X   | A   | S   | W   | G   | Now (refs)                | Target | Phase    | Items          |
| ----- | ------------------------------ | ------------------------------------------------ | --- | --- | --- | --- | --- | --- | ------------------------- | ------ | -------- | -------------- |
| APP-1 | scoped app (`now.config.json`) | sys_app, sys_scope                               | —   | —   | —   | ◐   | —   | —   | apps list in `[SN]` :226  | RXSG   | P0,P1,P5 | P-3, P-8, P-26 |
| APP-2 | app dependencies               | sys_scope_dependency, sys_package_dependency (U) | —   | —   | —   | —   | —   | —   | —                         | RXA    | P1,P3    | P-8, P-17      |
| APP-3 | customer updates               | sys_update_xml                                   | —   | —   | —   | —   | —   | n/a | — (S-6 plans update sets) | RA     | P0       | S-6, P-3       |
| APP-4 | instance source control        | sys_repo_config (U)                              | —   | —   | —   | —   | n/a | n/a | —                         | R      | P0       | P-3            |

### 4.13 Reports and Performance Analytics

Added by N-8 (2026-10-03). There is no Fluent API for these artefacts, so the target stops at R and X.
The registry descriptors are `verified:false` (O-5: verify on a live instance). The `pa_*` rows are
`licensed` (Performance Analytics, gate O-9), so an absent table degrades to `available:false`.

| Id    | Artefact (no Fluent API) | ServiceNow table(s)                                 | R   | X   | A   | S   | W   | G   | Now (refs)                                 | Target | Phase | Items |
| ----- | ------------------------ | --------------------------------------------------- | --- | --- | --- | --- | --- | --- | ------------------------------------------ | ------ | ----- | ----- |
| RPT-1 | report                   | sys_report, sys_report_users_groups                 | ◐   | ◐   | ◐   | ◐   | n/a | n/a | registry `report`; S-9 `report` where-used | RX     | P1    | N-8   |
| RPT-2 | report source            | sys_report_source                                   | ◐   | ◐   | ◐   | ◐   | n/a | n/a | registry `report_source`                   | RX     | P1    | N-8   |
| PA-1  | PA indicator             | pa_indicators, pa_indicator_breakdowns              | ◐   | ◐   | ◐   | ◐   | n/a | n/a | registry `pa_indicator` (licensed)         | RX     | P1    | N-8   |
| PA-2  | PA indicator source      | pa_cubes                                            | ◐   | ◐   | ◐   | ◐   | n/a | n/a | registry; where-used `pa_indicator_source` | RX     | P1    | N-8   |
| PA-3  | PA breakdown             | pa_breakdowns, pa_breakdown_mappings, pa_dimensions | ◐   | ◐   | ◐   | ◐   | n/a | n/a | registry `pa_breakdown` (licensed)         | RX     | P1    | N-8   |
| PA-4  | PA script                | pa_scripts                                          | ◐   | ◐   | ◐   | ◐   | n/a | n/a | registry `pa_script` (not in script tools) | RX     | P1    | N-8   |
| PA-5  | PA dashboard             | pa_dashboards, pa_m2m_dashboard_tabs, pa_tabs       | ◐   | ◐   | ◐   | ◐   | n/a | n/a | registry `pa_dashboard` (licensed)         | RX     | P1    | N-8   |

Totals: **120 rows** — 21 core, 20 server, 10 classic UI, 4 Next Experience APIs, 11 UIB internals, 11
portal, 12 flow/playbook, 6 legacy workflow, 6 catalog, 5 quality, 3 AI, 4 application, 7 reporting
and Performance Analytics. **Artefact-aware
coverage today:** R ✅ on 9 rows, ◐ on 17; X ✅ on none; A ✅ on 6; S ✅ on 5; W ✅ only on the
generic `Record` and attachment rows; G on none.

## 5. Key design decisions

### (a) One data-driven artefact registry, extending S-4

`SCRIPT_TYPES` (`src/api/scripts.ts:31-95`, 9 entries: table, `nameField`, `appliesToField?`,
`metaFields`, `scriptFields`) becomes a superset registry `ARTIFACT_TYPES` in `src/core/artifacts/`.
It holds data, not behaviour:

| Descriptor field            | Purpose                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`, `group`             | Stable id (`business_rule`, `sp_widget`, `uib_macroponent`, …) and gap-matrix group.                                                       |
| `sdkApi`, `sdkSince`        | Fluent API name (or `Record`/`none`) and version; drives P-4 tracking and G eligibility.                                                   |
| `table`, `children[]`       | Primary table plus child tables with the parent reference field and order field (`sys_ui_policy_action.ui_policy`, `sp_row.sp_container`). |
| `nameField`, `keyFields`    | Display name and natural key (SDK coalescing keys, e.g. `sp_widget.id`, `sys_user_role.name`).                                             |
| `scopeField`, `activeField` | Usually `sys_scope` / `active`; overridable.                                                                                               |
| `scriptFields`              | Script bodies (feed `search_code`, `where_used`, `lint_script` exactly as today).                                                          |
| `jsonFields`                | Field → decoder id (`json`, `flow-values`, `uib-composition`) and `writable` (`false` = plan-only, see (c)).                               |
| `refFields`                 | Reference fields that form dependency edges, with the target type.                                                                         |
| `secretFields`              | Always redacted (credential material on `sys_alias`, `ldap_server_config`, `sys_rest_message_fn` auth fields — exact names unverified).    |
| `tiers`, `verified`         | Supported tiers, and whether O-5 confirmed the tables/fields; `verified:false` types answer with a caveat.                                 |

Rationale: every consumer that today loops `SCRIPT_TYPES` (`list_scripts`, `get_script`,
`search_code`, `where_used`, `lint_script`, `code_health`, snapshot, compare, the `ARTEFACT_TABLES` probe list at `src/api/capabilities.ts:23-25`)
gets the new types without new code, which is exactly S-4's first bullet. Deep domains (flows, UIB,
portal, workflow) add **decoders and tree builders** keyed by descriptor, not new registries. Missing
tables (plugin not active, table absent on the family release) are detected once per instance by the
P-2 probe and cached with the S-13 preflight.

### (b) Reading Flow Designer

| Option | Source                                                                                                                                                                                        | Pros                                                                               | Cons                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1      | Table API over definition rows: sys_hub_flow → trigger / action / logic / subflow instances (`_v2`), flow input/output/variable, stages; tree from `ui_id` / `parent_ui_id`, `values` decoded | Documented API; same auth and policy as every read; already used by `get_flow`.    | `values` compression format **unverified** (§6.5); `_v2` vs non-`_v2` table choice varies by release (U).          |
| 2      | Published snapshot: `sys_hub_flow.master_snapshot` / `latest_snapshot` → sys_hub_flow_snapshot (U) and its child rows                                                                         | Shows what actually runs (runtime executes the snapshot); draft-vs-published diff. | Whether child instance rows are keyed to the snapshot sys_id is **unverified**.                                    |
| 3      | `/api/now/processflow/*`, `/api/sn_flow_designer/*`                                                                                                                                           | Pre-assembled flow model.                                                          | Undocumented and version-volatile (U); rejected — the inventory says do not depend on them.                        |
| 4      | `sn_fd.FlowAPI` behind a scripted REST resource                                                                                                                                               | Official server-side API.                                                          | Requires installing server code on the instance; out of lane (same class as background scripts); rejected.         |
| 5      | Local `now-sdk transform --table sys_hub_flow`                                                                                                                                                | Exact Fluent the SDK would produce.                                                | Needs the SDK CLI, credentials in the OS keychain and a project directory; use only as the P-29 round-trip oracle. |

**Recommendation: 1 + 2.** Read definition rows through the Table API, build the step tree from
`ui_id`/`parent_ui_id` and `order`, and decode `values` with format detection: plain JSON → base64 +
gzip JSON → unknown (return raw with `decoded:false` and the byte length). Read the snapshot the same
way when `master_snapshot` is set and report `draftDiffers`. Resolve action/subflow names through
`sys_hub_action_type_definition` and `sys_hub_flow`; use `label_cache` for data-pill labels.
**Unverified and gated by O-5:** the compression format on Zurich/Australia, which of
`sys_hub_action_instance` / `sys_hub_action_instance_v2` is authoritative per release, snapshot
child-row keying, and the `label_cache` JSON shape. The decoder ships with recorded fixtures from the
PDI and a property test (`fast-check`) for the detection path.

### (c) Writes: direct table writes vs Fluent generation

The SDK deploys a whole scoped app per `now-sdk install`. A direct MCP write into an SDK-managed app
lands in `sys_update_xml` and **is overwritten by the next install** unless it is pulled back with
`transform`/`download`. Decision per artefact class:

| Class                                 | Examples                                                                                                                    | Unmanaged scope / global                                                         | SDK-managed scope                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Single record, scalar + script fields | sys_script, sys_script_include, sys_script_client, sys_ui_action, sys_properties, sys_user_role, sysauto_script             | Direct plan/apply (P-23)                                                         | Generate Fluent (G); direct only with the P-22 override |
| Parent + ordered children             | sys_ui_policy(+action), sys_data_policy2(+rule), sp_page layout, sc_cat_item + item_option_new, sys_atf_test + sys_atf_step | Direct child-aware plan/apply (P-23, P-24)                                       | Generate Fluent; direct refused by default              |
| Flow Designer / playbooks             | sys_hub_flow, sys_hub_action_type_definition, sys_pd_process_definition                                                     | Generate Fluent only; direct write limited to `active` toggle (P-25, unverified) | Generate Fluent only                                    |
| UIB internals with JSON layout        | sys_ux_macroponent.composition / data / state_properties, sys_ux_screen.macroponent_config                                  | **Plan-only** (preview, never apply) until a round-trip test exists              | Plan-only                                               |
| Legacy workflow                       | wf\_\*                                                                                                                      | Read-only                                                                        | Read-only                                               |
| Security-sensitive                    | sys_security_acl, sys_user_role, sys_scope_privilege, sys_alias                                                             | Direct, subject to H-11 protected-table default                                  | Generate Fluent                                         |

**SDK-managed scope detection (P-3).** Result is `managed: "yes" | "no" | "unknown"` with evidence.
Sources, in order of authority:

1. Owner declaration: `SN_SDK_MANAGED_SCOPES` (scope names) — deterministic.
2. Local evidence: `now.config.json` files under `SN_SDK_PROJECT_DIRS` whose `scope` / `scopeId` match
   the `sys_scope` record — deterministic.
3. Instance heuristics, all **unverified** (§6.7): `sys_app` / `sys_metadata` markers left by SDK
   installs, install history of the app package, absence of `sys_repo_config` source control. Advisory
   only; they can raise `unknown` → `yes` but never produce `no`.

**Policy default.** `SN_SDK_MANAGED_WRITES = deny | warn | allow`. Proposed: `warn` in 3.x (the plan
preview carries a `sdkManaged` warning and the Fluent alternative); `deny` from 4.0 (BREAKING, gate
O-6). `unknown` always warns.

### (d) Tool-surface budget

Generic tools take an `artifactType` string validated against the registry. It is **not** a JSON
schema `enum`: about 90 values repeated on six tools would add roughly 6–8k chars to `tools/list`,
against the 3.0 exit criterion of ≤ 45,000 chars for `all` (62,325 today). Values are offered through
M-4 completions and a `servicenow://artifact-types` reference resource.

| Tool                    | Package           | Tier | Replaces / extends                                                           |
| ----------------------- | ----------------- | ---- | ---------------------------------------------------------------------------- |
| `list_artifacts`        | `artifacts` (new) | R    | Superset of `list_scripts` (kept; becomes a thin alias in 4.0 if O-8 agrees) |
| `get_artifact`          | `artifacts`       | R    | Superset of `get_script`; returns children, scope, `sdkManaged`              |
| `explain_artifact`      | `artifacts`       | X    | Decoded, structured view for any registered type                             |
| `artifact_dependencies` | `artifacts`       | A    | Outbound + inbound edges; `format:"mermaid"`                                 |
| `upsert_artifact`       | `artifacts`       | W    | Plan/apply, child-aware; same read-only-profile rule as `create_record`      |
| `generate_fluent`       | `artifacts`       | G    | Emits `.now.ts` under `<SN_DOCS_DIR>/fluent/` or returns text                |
| `explain_flow`          | `flows`           | X    | `kind: flow \| subflow \| action \| playbook \| workflow`; Mermaid           |
| `explain_ui_experience` | `ui` (new)        | X    | Experience → routes → variants → macroponent tree                            |
| `explain_portal`        | `ui`              | X    | Portal → pages → layout → instances → widgets → dependencies                 |

Tool names are shown without the `servicenow_` prefix that every registered tool carries. Delta: **+9 tools (67 → 76), +2 packages (18 → 20)**. No new tools for snapshot/compare/where-used/
lint — `snapshot_instance`, `compare_instances`, `where_used`, `search_code`, `lint_script`, `code_health`
gain registry coverage and an optional `types` filter. Profiles: `reader` gains the `artifacts` read
tools, `ui` and the new `flows` tool; `developer` gains all of them; `core` is unchanged. Names follow the
M-7 convention once it lands (prefix and parameter normalisation apply to these tools like every other).

### (e) Policy and safety

- Reads are ordinary Table API reads. The table allow/deny axis applies **per child table**: a denied
  child is returned as `{ redacted: true, table }`, not as a failure of the whole artefact.
- `secretFields` are always redacted in results, journals, snapshots and generated Fluent (Fluent
  output uses a placeholder and a `// TODO: credential` comment).
- Writes: plan → token → apply (H-3); one plan per artefact with an ordered child plan; the journal
  holds `before` for every child record (H-5) so S-2 revert restores the whole artefact; H-11 protected
  tables (`sys_security_acl`, `sys_user_role`, `sys_properties`, …) stay write-denied by default; the
  P-22 SDK-managed guard runs after the table policy.
- SDK pre-flight parity for writes: `sp_widget.id`, `sp_page.id`, `sp_portal.url_suffix`,
  `sp_dependency` name/module and `sp_ng_template` id uniqueness and the scope prefix are checked at plan
  time (inventory §3.2).
- `generate_fluent` writes only under the docs path guard; the server never runs `now-sdk` commands and
  never calls `now-sdk install`.
- Never used: `/api/now/uxf/*`, `/api/now/processflow/*`, `/api/sn_flow_designer/*`,
  `/api/now/sp/widget/*` (executes widget server scripts), background scripts.

## 6. Phased plan

Effort key as in ROADMAP-V3: **S** ≤ 1 day · **M** 2–5 days · **L** 1–2 weeks. No item is BREAKING
unless it says so.

### P0 — Foundation

#### P-1 — Artefact registry (M)

- [x] `src/core/artifacts/registry.ts` holds `ARTIFACT_TYPES` with the descriptor of §5(a); the 9
      `SCRIPT_TYPES` entries migrate to it with identical output (`SCRIPT_TYPES` becomes a derived view).
- [x] Descriptor validation test: unique `type`, every `children[].parentField` present, every
      `jsonFields` decoder id exists, every `sdkApi` is on the baseline list.
- [x] `capabilities.ts` reads the registry for the script-table probe list.
- **Depends on:** S-4 (this item implements S-4's registry bullet).
- **Acceptance:** `npm run check` green with byte-identical `list_scripts` / `search_code` fixtures.
- **Done 2026-09-24 (local, uncommitted).** `src/core/artifacts/registry.ts` (SDK baseline 4.12.2, §5(a) descriptor + validator); `SCRIPT_TYPES` / `ARTEFACT_TABLES` derived, byte-identical; unverified seeds for portal, UIB, flow, workflow, catalog, REST, transform. Seeds are `verified:false` and stay out of the script tools until P-2; the capability probe list is unchanged.

#### P-2 — Registry verification probe (S)

- [ ] `npm run verify:artifacts` queries `sys_db_object` + `sys_dictionary` for every registry table and
      field on the active profile and writes a JSON report (present, missing, extra fields).
- [ ] Runtime: types whose primary table is absent answer `available:false` (cached with the S-13
      preflight, negative TTL).
- [ ] The PDI report is committed as a test fixture; descriptors confirmed by it flip to `verified:true`.
- **Depends on:** P-1, S-13, O-5.
- **Acceptance:** the PDI run resolves inventory §6.3 for every (U) table in §4 or lists it as absent.

#### P-3 — SDK-managed scope detection (M)

- [x] `detectSdkManaged(scope)` returns `yes | no | unknown` with evidence from the three sources in
      §5(c); `SN_SDK_MANAGED_SCOPES` and `SN_SDK_PROJECT_DIRS` added to the settings manifest and env docs.
- [x] Instance heuristics are marked unverified in code and in the tool output until O-5 confirms one.
- [x] `get_status` / `check_capabilities` list detected SDK-managed scopes.
- **Depends on:** P-1, O-5 (heuristics), O-6 (sources of authority).
- **Acceptance:** a fixture project with `now.config.json` marks its scope `yes`; an unrelated scope is
  `no` only when sources 1–2 are configured and do not match, else `unknown`.
- **Done 2026-09-24 (local, uncommitted).** `src/core/artifacts/sdk-managed.ts`: `yes|no|unknown` with evidence from `SN_SDK_MANAGED_SCOPES` / `SN_SDK_PROJECT_DIRS` (`now.config.json`); `sdkManaged` block in status and capabilities; instance heuristics empty until O-5.

#### P-4 — SDK release tracking (S)

- [x] `SDK_BASELINE = "4.12.2"` in the registry; `scripts/sdk-drift.mjs` compares it with the npm
      `latest` / `next` dist-tags and diffs the docs `llms.txt` API list against registry `sdkApi` values.
- [x] Weekly scheduled workflow opens or updates one tracking issue; never part of `npm run check`.
- **Depends on:** P-1.
- **Acceptance:** run against the 4.13.0 `next` tag reports `DatabaseView` as a known `verified:false` type.
- **Done 2026-09-24 (local, uncommitted).** `scripts/sdk-drift.mjs` (`npm run sdk:drift`) + weekly `sdk-drift.yml` tracking issue; `SDK_NEXT_APIS = ["DatabaseView"]`; not in the gate. Live run: npm `latest` is 4.13.0 against the 4.12.2 baseline.

#### P-5 — Generic read tools (M)

- [x] `artifacts` package: `list_artifacts({artifactType, scope?, query?, active?, limit})` and
      `get_artifact({artifactType, sys_id | key})` with children, scope, `sdkManaged`, redaction.
- [ ] `servicenow://artifact-types` resource (done); completions for `artifactType` (M-4 when available).
- [x] `outputSchema` on both tools (M-6); manifest, README table and budget test updated.
- **Depends on:** P-1, P-3; M-6 and M-7 when landed.
- **Acceptance:** `get_artifact` on a `ui_policy` returns its `sys_ui_policy_action` children; the
  `tools/list` budget test still passes.
- **Done 2026-09-24 (local, uncommitted).** Opt-in `artifacts` package: `servicenow_list_artifacts` / `servicenow_get_artifact` over the P-1 registry with children, scope, `sdkManaged`, policy + redaction, `degraded` for unverified types; `servicenow://artifact-types`. 72 tools in 20 packages. Left out: `artifactType` completions (M-4) and the `tools/list` budget test (none exists yet). The package is opt-in, not in reader/developer as §5(d) proposes, pending the owner.

### P1 — Read/explain breadth (R + X for every artefact type)

#### P-6 — `explain_artifact` framework + JSON decoders (M)

- [x] `explain_artifact` returns `{summary, when, fields, children, references, decoded}` from
      descriptor data; decoders `json` (tolerant parse) and a pluggable interface for P2 decoders.
- [x] Undecodable values return raw with `decoded:false`; size-capped per M-6 token budget.
- **Depends on:** P-5.
- **Acceptance:** snapshot tests for one type per §4 group; an invalid JSON field never fails the call.
- **Done 2026-09-25 (local, uncommitted).** `servicenow_explain_artifact` in the opt-in `artifacts` package (`src/api/explain-artifact.ts`) over `getArtifactFor`; decoder framework `src/core/artifacts/decoders.ts` (tolerant `json`, `registerDecoder`; `flow-values` / `uib-composition` fall back to `json` with `via: "json"`); optional descriptor `whenFields`; output capped against `SN_MAX_RESULT_CHARS`. JSON goldens in `test/fixtures/explain/` for the nine §4 groups that have registered types (quality, ai and application have none yet — they come with P-8). Registry `tiers` still list no `X`; P-7 / P-8 add it per row. 73 tools in 20 packages.

#### P-7 — Descriptors: core, server logic, classic UI (M)

- [x] Descriptors for rows CORE-1…17, SRV-1…20, CUI-1…9 (tables and children as in §4).
- [x] `sttrm_*` state model and `sys_choice` explainers render a transition list / choice table;
      `sys_ui_policy` / `sys_data_policy2` explain field effects from their action/rule children.
- [x] CUI-10 `Interceptor`: `interceptor` descriptor (`sys_wizard` + `sys_wizard_answer`), added with
      the 4.13.6 re-pin (2026-10-09).
- [ ] Descriptors for rows CORE-18…21 (added 2026-10-09 by the guide audit) and `sys_ui_formatter` in CUI-6.
- **Depends on:** P-1, P-2, P-6.
- **Acceptance:** `list_artifacts` + `explain_artifact` work for every row on the PDI fixture; rows
  whose table is absent answer `available:false`.
- **Done 2026-09-25 (local, uncommitted).** 31 new CORE/SRV/CUI registry rows (`ArtifactChild.parentKey` / `alsoMatch` for value-linked children; `acl` gains `sys_security_acl_role`); `available` in list/get/explain results via a `sys_db_object` probe (`tableAvailable()` in `src/api/artifacts.ts`); explainer registry `src/api/explainers.ts` with state-model (transition list), choice-table and field-effects (`sys_ui_policy` / `sys_data_policy2`) enrichers, surfaced as `explanation` by `explain_artifact`. Tests: `test/explain-enrichers.test.js`, fixtures `state_model`, `choice_set`, `data_policy`. Field names on the PDI fixture wait for O-5.

#### P-8 — Descriptors: catalog, quality, AI, application (M)

- [x] Descriptors for CAT-1…6 (definition records, not the `sn_sc` consumer view), QA-1…5, AI-1…3,
      APP-1…4; `sc_cat_item` explain includes variables, variable sets, client scripts and UI policies.
- [x] Licensed-plugin families (`sn_aia_*`, `sn_nowassist_skill_*`) degrade to `available:false`.
- **Depends on:** P-1, P-2, P-6, O-9.
- **Acceptance:** fixture explain of a catalog item lists its `item_option_new` rows in order with
  `question_choice` values.
- **Done 2026-09-26 (local, uncommitted).** CAT/QA/AI/APP descriptors in `src/core/artifacts/registry.ts` (121 types); `licensed?` marks `sn_aia_*` / `sn_nowassist_skill_*` families, which degrade to `available:false`; catalog-form and catalog-variable explainers in `src/api/explainers.ts`; child rows accumulate across parents. Tests: `test/explain-catalog.test.js`, `test/artifact-registry.test.js`. Tables and fields unverified until O-5; licensed families pending O-9.

#### P-9 — Descriptors: portal, UIB, flow and workflow (shallow) (S)

- [x] R-tier descriptors for NX-1…4, UIB-1…11, SP-1…11, FLW-1…12, WF-1…6 with children and script
      fields (`sys_ux_client_script.script`, `sp_widget` script/client_script/link/css) so script
      intelligence covers them before P2.
- **Depends on:** P-1, P-2.
- **Acceptance:** `search_code` finds a string inside an `sp_widget.client_script` and a
  `sys_ux_client_script.script` on the fixture.
- **Done 2026-09-25 (local, uncommitted).** NX/UIB/SP/FLW/WF rows rewritten (registry 71 types); `scriptToolsOptIn` marks 9 script-bearing types reachable only through `search_code({extended:true})` and the widened `type` enums (`scriptTypeView`, `OPT_IN_SCRIPT_TYPES` in `src/api/scripts.ts`), so the default tool surface is unchanged; `FLOW_CHILDREN`, `READ_TIER` constants. Tests: `test/artifact-registry.test.js`, `test/scripts.test.js`, fixtures `explain/workspace.json`, `explain/workflow.json`. FLOW_CHILDREN tables to confirm on a live instance (O-5).

### P2 — Deep domains

#### P-10 — Flow Designer decoder + `explain_flow` (L)

- [x] Decoder `flow-values` per §5(b) with format detection and fixtures from the PDI; property test
      for the detection path.
- [x] `explain_flow({sys_id, kind:"flow"|"subflow"})`: trigger (`sys_hub_trigger_instance(_v2)` +
      `sys_hub_trigger_definition`), ordered step tree from `ui_id`/`parent_ui_id` mixing
      `sys_hub_action_instance(_v2)`, `sys_hub_flow_logic_instance_v2`, `sys_hub_sub_flow_instance(_v2)`;
      inputs/outputs/variables; stages; `run_as` / `run_with_roles`; decoded step inputs with data-pill labels
      from `label_cache`.
- [x] Draft vs published: `master_snapshot` read the same way; `draftDiffers` flag.
- [x] `format:"mermaid"` flowchart; latest `sys_flow_context` runs + `sys_flow_log` errors (opt-in).
- **Depends on:** P-5, P-6, O-5, S-14 (`format:"mermaid"` renders through `src/api/mermaid.ts`); absorbs
  S-5's `get_flow` bullet (`get_flow` delegates to it).
- **Acceptance:** a fixture flow with if/else, forEach, tryCatch and a subflow call renders the same
  tree as Workflow Studio (checked manually once, then pinned); undecodable values do not fail the call.
- **Done 2026-09-26 (local, uncommitted).** `servicenow_explain_flow` in the `flows` package (`src/api/explain-flow.ts`, `src/tools/flows.ts`); decoder `src/core/artifacts/flow-values.ts` (JSON → base64 + gzip JSON → `decoded:false` with the byte length; inflation capped at 4 MiB), registered as `flow-values` in `decoders.ts` (no longer a `json` fallback). Step tree from `ui_id` / `parent_ui_id` over the `_v2` then v1 tables (deduped by `ui_id`), depth cap 32, orphan / cycle caveats; draft vs published via `latest_snapshot` / `master_snapshot` (`draftDiffers`); pill labels from `label_cache`; opt-in runs (max 20, 10 `sys_flow_log` errors each). Tests: `test/explain-flow.test.js` (with fast-check properties for the decoder), goldens `test/fixtures/explain/flow.mmd`, `workflow.mmd`. Open: fixtures from the PDI and the manual Workflow Studio check (O-5: values compression, v1 vs `_v2` authority, snapshot child keying, `label_cache` shape, `sys_flow_log` levels); `get_flow` does **not** delegate to it — its `FlowDetail` contract is kept (a delegation is a behaviour change for O-4); the package placement (`flows`, so reader / developer gain it) is an owner question.

#### P-11 — Subflows, custom actions, decision tables (M)

- [x] `explain_flow` `kind:"action"`: `sys_hub_action_type_definition` with inputs/outputs and
      `sys_hub_step_instance` steps; subflow calls resolved recursively with a depth cap and cycle guard.
- [x] Decision tables (`sys_decision`, `sys_decision_question` (U)) as an explainer via P-6.
- **Depends on:** P-10.
- **Acceptance:** a flow calling a custom action shows the action's steps one level down.
- **Done 2026-09-26 (local, uncommitted).** `servicenow_explain_flow` `kind:"action"` (`src/api/explain-flow.ts`, `src/tools/flows.ts`): the `sys_hub_action_type_definition` header, `sys_hub_action_input` / `sys_hub_action_output` and the `sys_hub_step_instance` steps (one bounded `action IN …` read, ordered by `order`). Flow / subflow calls expand through a new `depth` input (default 1, max 3, `0` = none): breadth-first per level with one batched read per table, a memo keyed `kind:sys_id` (a callee shared by several call sites is read once), a cycle guard (a callee on its own call path is marked `cycle:true`, not re-read), at most 20 distinct callees (`CALLEES_MAX`) and caveats for skipped, cyclic and too-deep calls; `counts.callees`; Mermaid dotted `-.->` edges to the callee steps, Markdown "↳ calls …" lines. Decision tables: a `decision-table` enricher in `src/api/explainers.ts` registered for `decision_table` (tiers now `R` + `X`): answer table, `sys_decision_input` inputs and `sys_decision_question` rows in order with condition / answer / default / inactive, capped and unread notes, an O-5 caveat. Tests in `test/explain-flow.test.js` (acceptance: a flow calling a custom action shows the action's steps one level down; depth cap, cycle, callee cap, 403 degrade, action JSON / Markdown / Mermaid golden `test/fixtures/explain/action.mmd`) and `test/explain-decision.test.js`. All fields stay (U) until O-5.

#### P-12 — Playbooks (M)

- [x] `explain_flow` `kind:"playbook"`: `sys_pd_process_definition` → `sys_pd_lane` → `sys_pd_activity`
      (with `sys_pd_activity_definition`), triggers, inputs/outputs, timers; variants listed
      (`sys_pd_process_variant`); runtime from `sys_pd_context`.
- **Depends on:** P-10 (shared tree/Mermaid renderer), O-9.
- **Acceptance:** fixture playbook renders lanes as Mermaid subgraphs.

- **Done 2026-09-30 (local, uncommitted).** `explainPlaybook` in `src/api/explain-flow.ts`, `servicenow_explain_flow({kind:"playbook"})`:
  lanes as Mermaid subgraphs, activities with their definitions, triggers, inputs / outputs, timers,
  variants, opt-in `runs` from `sys_pd_context`; `available:false` when the `sys_pd_*` tables are absent;
  `verified:false` until O-5. Tests: `test/explain-playbook.test.js`.

#### P-13 — Legacy workflow graph + migration report (M)

- [x] `explain_flow` `kind:"workflow"`: `wf_workflow` → published `wf_workflow_version` → `wf_activity`
      nodes + `wf_transition` / `wf_condition` edges → Mermaid; `wf_stage` list; runtime from `wf_context`.
- [x] Migration report: workflows still referenced by `sc_cat_item.workflow` and `contract_sla.workflow`
      or with running `wf_context` rows.
- **Depends on:** P-6.
- **Acceptance:** fixture workflow graph matches the activity/transition rows one-to-one.
- **Done 2026-09-26 (local, uncommitted).** `servicenow_explain_flow({kind:"workflow"})`: published `wf_workflow_version` (else the newest, with a caveat) → `wf_activity` (by version, falling back to the workflow) → `wf_condition` / `wf_transition` edges with the condition as the edge label → Mermaid (golden `test/fixtures/explain/workflow.mmd`, edges asserted one-to-one against the transition rows); `wf_stage` list; opt-in `wf_context` runs. `migration: true` adds the report — per workflow the `sc_cat_item.workflow` and `contract_sla.workflow` references and executing `wf_context` rows; without a `sys_id` it covers every workflow in use. Open: `wf_activity` keying and `wf_context` state values to confirm on the PDI (O-5).

#### P-14 — UI Builder experience tree (L)

- [x] `explain_ui_experience({sys_id | path})`: `sys_ux_page_registry` → `sys_ux_app_config` →
      `sys_ux_app_route` → `sys_ux_screen` (variants with applicability and order) → `sys_ux_macroponent`.
- [x] Decoder `uib-composition`: component tree from `composition`, data resources from `data`,
      client state from `state_properties`, event wiring from `internal_event_mappings`; schemaless, pinned
      by fixtures.
- [x] Client scripts (`sys_ux_client_script`), data brokers (`sys_ux_data_broker_*`) and their ACLs of
      type `ux_data_broker`; Mermaid page map.
- **Depends on:** P-6, P-9, O-5.
- **Acceptance:** a fixture workspace lists every route with its variants and each variant's component
  tree; unknown composition shapes return raw with `decoded:false`.

- **Done 2026-09-30 (local, uncommitted).** `servicenow_explain_ui_experience` in the `ui` package
  (`src/api/ui-experience.ts`), decoder `src/core/artifacts/uib-composition.ts` (unknown shapes return raw
  with `decoded:false`), client scripts, data brokers with their `ux_data_broker` ACLs, Mermaid page map.
  Tables unverified (O-5). Tests: `test/explain-ui-experience.test.js`.

#### P-15 — Workspace, dashboard, list menu, applicability (S)

- [x] Explainers for NX-1…4 and UIB-10 inside `explain_ui_experience` (workspace landing dashboard tabs
      and widgets, list categories and lists, applicability roles, form action layouts).
- **Depends on:** P-14.
- **Acceptance:** a Fluent-built fixture workspace explains the objects its `Workspace()` generated.

- **Done 2026-09-30 (local, uncommitted).** NX-1…4 and UIB-10 join the `explain_ui_experience` tree
  (dashboard tabs / widgets, list categories and lists, applicability roles, form action layouts).

#### P-16 — Service Portal tree (M)

- [x] `explain_portal({portal | page})`: `sp_portal` → pages → `sp_container` → `sp_row` → `sp_column`
      → `sp_instance` (decoded `widget_parameters`) → `sp_widget` → `sp_dependency` / `sp_js_include` /
      `sp_css_include` / `sp_angular_provider` / `sp_ng_template`; theme, menu, header/footer, route maps.
- [x] Mermaid layout tree.
- **Depends on:** P-6, P-9.
- **Done 2026-09-26 (local, uncommitted).** `src/api/portal.ts` + `servicenow_explain_portal` in the new
  opt-in `ui` package (§5(d)); `json` / `markdown` / `mermaid` / `file` formats, depth 1–6 (default 3),
  full layout for the first 5 portal pages (homepage first; the rest listed), `option_schema`-mapped
  widget options, dependencies with JS / CSS includes, providers, templates, theme, menu, header /
  footer and route maps; every child table degrades on its own. Field names are `verified:false`
  (O-5). Tests: `test/explain-portal.test.js`, golden `test/fixtures/explain/portal.mmd`.
- **Acceptance:** the fixture portal home page renders its full layout; widget option values match
  `option_schema` names.

### P3 — Analyse, snapshot, docs

#### P-17 — `artifact_dependencies` (M)

- [x] Outbound edges from `refFields`, decoded JSON (flow step inputs, UIB data resources, widget
      options) and script text (`GlideRecord('x')`, script include calls); inbound edges by reverse
      query; `format:"mermaid"`, depth cap.
- **Depends on:** P-7, P-8, P-9; S-9 (structural where-used shares the reference extractor).
- **Acceptance:** a script include used by a business rule, a flow script step and a widget shows all
  three inbound edges.
- **Done 2026-09-26 (local, uncommitted):** `servicenow_get_artifact_dependencies` (`artifacts`
  package, `src/api/dependencies.ts`). Tests: `test/dependencies.test.js`, golden
  `test/fixtures/explain/dependencies.mmd`.

#### P-18 — Registry-driven lint and search (M)

- [ ] `lint_script`, `code_health`, `search_code`, `where_used` iterate all registry `scriptFields`
      (widget client/server/link, UX client scripts, action script steps, GraphQL resolvers, scan checks).
- [ ] Portal client rules: `$sce.trustAsHtml`, `$sanitize` bypass; server rules: `$sp.getParameter`
      without validation, GlideRecord in loops.
- **Depends on:** P-9, S-4 (search/where-used bullet), S-3; S-12 when landed.
- **Acceptance:** `code_health` on the fixture reports findings in at least one widget and one UX client script.
- **Done 2026-09-26 (local, uncommitted)** against a mock fixture (no PDI fixture yet — O-5).
  Rules `sce-trust-as-html`, `sanitize-bypass`, `sp-param-unvalidated` (GlideRecord-in-loop was
  already `query-in-loop`); `lint_script` over the opt-in types; `code_health({extended, limit})`
  sweeps every registry script type (`lintArtifacts`, `src/api/codecheck.ts`);
  `where_used({extended})`; `search_code` already had `extended` (S-4). Action script steps,
  GraphQL resolvers and scan checks join as soon as the registry declares their `scriptFields`
  (their descriptors carry none today). `test/p18-registry-lint.test.js` (6 tests,
  mutation-checked).

#### P-19 — Domain analysers (M)

- [x] Flows: `run_as` system touching H-11 protected tables, drafts differing from snapshot, unused
      subflows/actions, no error handling around integration steps, long waits.
- [x] UIB: routes without a screen, screens without applicability, data brokers without a `ux_data_broker`
      ACL. Portal: public widgets reading data, orphaned widgets/pages, route-map loops.
- [x] Legacy: workflows referenced by catalog items or SLAs (from P-13).
- **Depends on:** P-10, P-13, P-14, P-16, P-18.
- **Acceptance:** each rule has a positive and a negative fixture; results appear in `code_health`.

- **Done 2026-09-28 (local, uncommitted) — flows, portal and legacy workflows; bar UIB.**
  `src/api/domain-analysers.ts` (`analyseDomains`) behind the opt-in `servicenow_check_code_health({domains:true})`
  (default unchanged): `flow-run-as-system-protected`, `flow-draft-differs`, `flow-unused-subflow`,
  `flow-unused-action`, `flow-integration-no-error-handling`, `flow-long-wait` (> 86,400 s),
  `portal-public-data-widget`, `portal-orphan-widget`, `portal-orphan-page`, `portal-route-map-loop`,
  `workflow-migration-candidate`. Newest `limit` candidates per rule (50 / 200), child reads ≤ 500
  rows, `truncated` and `available:false` per rule, caveats for unverified fields (O-5). UI Builder
  rules wait for P-14 / O-5; the flow-level error handler and FlowAPI script callers are not read.
  `test/p19-domain-analysers.test.js` (19 tests, mutation-checked).
- **UIB rules added 2026-09-30:** `uib-route-no-screen`, `uib-screen-no-applicability`,
  `uib-data-broker-no-acl` (severity is an owner call).

#### P-20 — Snapshot/compare over the registry (L)

- [x] `snapshot_instance({types?, scope?})` snapshots every registry type with children, decoded JSON
      normalised (stable key order, volatile fields dropped), flows from the published snapshot.
- [x] `compare_instances` matches by `sys_id`, then natural key; child-aware diff; Mermaid graphs
      diffed as text.
- **Depends on:** S-7 (this extends its snapshot list to the whole registry), P-7…P-10.
- **Acceptance:** snapshot of the same instance twice gives an empty diff; `drift` exit codes unchanged.
- **Done 2026-09-26 (local, uncommitted); remainder done 2026-09-30 (local, uncommitted).**
  `src/api/artifact-snapshot.ts` (`collectArtifactType`, `normalizeRow`, `diffArtifactType`,
  `changedArtifactPairs`); `types` / `scope` on both tools (opt-in, so defaults and the `drift` CLI
  are unchanged). Direct children only — a child that hangs off another child (`parentTable`, e.g.
  the portal layout tree) is named in a warning; `alsoMatch` composite links are honoured.
  `test/p20-artifact-snapshot.test.js` (8 tests, mutation-checked).
  Remainder: flows (`sys_hub_flow`) whose `master_snapshot` names another record with child rows
  are read from that published snapshot (children keyed by the snapshot sys_id, as
  `explain_flow` reads published steps); the record carries `source: "published"` and `snapshot`
  (neither is hashed) and the result warns that the published/draft authority and the keying are
  unverified (O-5). No `master_snapshot`, or a snapshot without child rows (warned), keeps the
  draft read, so outputs are unchanged when no snapshot exists. `compare_instances({types,
mermaid: true})` renders each changed record of `flow`, `subflow`, `flow_action`, `workflow`,
  `playbook`, `sp_portal`, `sp_page` and `workspace` on both sides with the existing explainers
  and returns `mermaidDiffs` (unified diffs of the Mermaid sources, `src/api/artifact-mermaid.ts`):
  opt-in, live even with `from_snapshot`, at most 10 records (`MERMAID_DIFFS_MAX`) and 120 lines
  each (`MERMAID_DIFF_LINES`), never counted as drift. `test/p20-mermaid-published.test.js`
  (9 tests, mutation-checked).

#### P-21 — Application documentation generator (M)

- [x] `docs_write`-backed report per scope: inventory by type, dependency graph, one Mermaid diagram per
      flow / experience / portal / workflow, lint summary.
- **Depends on:** P-17, P-10, P-14, P-16, S-14, S-15 (extends `document_app` / `DOC_KINDS` rather than
  adding a second writer; `document_app` already collects through P-5's `listArtifacts` over
  `ARTIFACT_GROUPS` — INSTANCE-DOCS pass 2 ID-22; frontmatter + manifest from the S-14 store contract).
- **Acceptance:** fixture scope produces a Markdown doc that `docs_read` returns and Mermaid blocks that parse.
- **Done 2026-09-26 (local, uncommitted) bar UI Builder experiences (P-14).** `document_app({detail})`
  (`collectAppDetail` / `renderAppDetail`, `src/api/document.ts`): diagrams per flow / subflow /
  workflow / portal (10 per type), a merged outbound dependency graph (10 roots, depth 1), the P-18
  lint sweep scoped to the app (50 per type); every piece degrades to a caveat. The test helper's
  metadata allow-list now admits versioned `sys_hub_*_v2` tables (explain_flow reads
  `sys_hub_trigger_instance_v2`). Mocked fixture only (O-5).

- **UIB experiences added 2026-09-30:** `document_app({detail})` draws a workspace page map per
  experience (P-14); deeper UIB prose is an owner call.

### P4 — Writes

#### P-22 — SDK-managed write guard (S) — BREAKING only when the default flips to `deny`

- [x] `SN_SDK_MANAGED_WRITES = deny | warn | allow` evaluated for every write tool (generic and
      artefact-aware) after the H-11 table policy; plan preview carries `sdkManaged` and the Fluent
      alternative. Default `warn` in 3.x.
- [ ] `deny` default proposed for 4.0 → new breaking-register row at that time.
- **Depends on:** P-3, H-11, O-6.
- **Acceptance:** a write plan into a declared SDK-managed scope warns (3.x) / is refused with
  `SDK_MANAGED_SCOPE` (deny).
- **Done 2026-09-26 (local, uncommitted).** `src/mcp/sdk-guard.ts`; wired into `create_record`,
  `update_record`, `upsert_record`, `delete_record`, `set_property` and `revert_write` (plan and
  apply). The scope comes from the written `sys_scope` and the record's current one (a
  `sysparm_fields=sys_scope` read, only while `SN_SDK_MANAGED_SCOPES` / `SN_SDK_PROJECT_DIRS` is
  set), detection with `lookup:true`; the guard asserts the H-11 write policy first. `deny` →
  `SDK_MANAGED_SCOPE` (409). Not covered: `servicenow_batch` sub-requests, CMDB / import-set /
  attachment writes (data, not scoped metadata), and a create without `sys_scope` (the user's
  current application scope is not resolved). `test/sdk-guard.test.js` (9 tests, mutation-checked).

- **Remainder done 2026-09-28 (local, uncommitted).** Table API write sub-requests in
  `servicenow_batch` are guarded (a `deny` stops the whole batch before it is sent; `warn` returns
  `sdkManaged[]`). A create without `sys_scope` takes the scope from the session's
  `apps.current_app` preference (`sys_metadata` tables only; a failed read adds `sdkScopeWarning`,
  never an error; nothing is read while detection is off). +5 tests in `test/sdk-guard.test.js`.

#### P-23 — `upsert_artifact` plan/apply (L)

- [x] `upsert_artifact({artifactType, key, fields, children?})`: action decided at plan time (S-8
      upsert semantics), field allow-list from the descriptor, `jsonFields.writable:false` → plan-only,
      child records diffed and applied in order, journal `before` per record (H-5), one plan token (H-3).
- [x] Classes of §5(c): scalar and parent/child types only; flows, playbooks, legacy workflow excluded.
- **Depends on:** H-3, H-5, H-11, S-2, S-8, P-22, P-7.
- **Acceptance:** create → update → S-2 revert of a UI policy with two actions restores both actions;
  a `sys_ux_macroponent.composition` change returns a plan and refuses `apply`.

- **Done 2026-09-28 (local, uncommitted).** `servicenow_upsert_artifact` in the opt-in
  `artifacts` package (`src/api/upsert-artifact.ts`): create / update / noop per record as in S-8,
  parent first then ordered children; fields limited to the descriptor's `writeFields`; a
  `writable:false` JSON field makes it plan-only (`PLAN_ONLY_FIELD`); flow and workflow types refused
  (`NOT_WRITABLE_TYPE`); every record journaled with `before` and linked by `artifact_write`, so S-2
  reverts each line; one plan token; H-11 policy and the P-22 guard per table; stale-parent check,
  duplicate child keys refused, 200 child writes max. Deferred: `prune_children`, whole-artefact
  revert, child staleness, `writeFields` for business rules and script includes.
  `test/upsert-artifact.test.js` (10 tests, mutation-checked).

#### P-24 — Portal and catalog structural writes (M)

- [x] `upsert_artifact` for SP-1…10 and CAT-1…6 with SDK pre-flight parity (uniqueness of
      `sp_widget.id`, `sp_page.id`, `url_suffix`, `sp_dependency` name/module, `sp_ng_template` id; scope
      prefix) and layout-tree writes (`sp_container` → `sp_instance`).
- **Depends on:** P-23, P-16, P-8.
- **Acceptance:** a duplicate `sp_widget.id` is rejected at plan time; a page layout round-trips
  through get → upsert → get unchanged.

- **Done 2026-09-30 (local, uncommitted).** `upsert_artifact` for SP-1…10 and CAT-1…6: `children[].parent`
  layout-tree writes, uniqueness pre-flight from registry `unique` rules (`DUPLICATE_UNIQUE_FIELD`),
  `SCOPE_PREFIX` warning, `PREFLIGHT_INVALID` / `CHILD_PARENT_INVALID`. Fields unverified until O-5.
  Tests: `test/upsert-artifact.test.js`.

#### P-25 — Flow activation toggle (S)

- [ ] `upsert_artifact` for `flow` accepts only `{active}`; behaviour on the published snapshot verified
      on the PDI first (inventory marks it unverified).
- **Depends on:** P-23, O-5.
- **Acceptance:** deactivate → activate on the fixture flow leaves `master_snapshot` unchanged and the
  flow triggers again.

- **Partly done 2026-09-30 (local, uncommitted).** Flow upsert accepts `{active}` only
  (`FLOW_ACTIVE_ONLY`, `UNVERIFIED` warning); the `master_snapshot` behaviour waits for O-5.

### P5 — Fluent generation and round-trip

#### P-26 — Fluent emitter core (L)

- [x] `generate_fluent({artifactType, sys_id | scope})` emits `.now.ts` for every registry type with an
      `sdkApi`: `Now.ID['<key>']` keys plus a `keys.ts` fragment, `Now.include('./…')` sidecar files for
      script/html/css bodies, `Now.ref(table, id)` for references, `Record()` for types without an API.
- [x] Output under `<SN_DOCS_DIR>/<profile>/fluent/<scope>/` (through `docsWriteRaw`, an S-14 manifest
      kind with the frontmatter contract) or inline; header comment names the target SDK version (§2);
      secrets replaced by placeholders.
- **Depends on:** P-7, P-8, O-7.
- **Acceptance:** generated files for the scalar fixture types type-check against the pinned SDK types
  (only if O-7 allows the dev dependency; otherwise a recorded `now-sdk build` result is the oracle).

- **Done 2026-09-30 (local, uncommitted), bar the type-check oracle.** `servicenow_generate_fluent`
  in the opt-in `artifacts` package (`src/api/fluent.ts`, `src/api/fluent-render.ts`): dedicated
  emitters for business rules, script includes, client scripts, UI policies, UI actions, scheduled
  jobs, script actions, ACLs, UI pages, properties and roles; every other type falls back to
  `Record()` and is listed in `unsupported[]` (P-27 for flows / playbooks, P-28 for portal / UIB /
  workspace / catalog); unmapped fields and unreadable children are reported, not dropped. Secrets
  become placeholders; output is deterministic; `format:"file"` writes through `docsWriteRaw` with a
  `kind:"fluent"` companion and a hand-edit guard. The target SDK is an **assumption pending O-7**:
  headers name `@servicenow/sdk` 4.12.2 (`SDK_BASELINE`), and the acceptance oracle (type-check against
  pinned SDK types, or a recorded `now-sdk build`) is still open — tests only prove the output parses
  as TypeScript. The `G` tier is not claimed in the registry until that oracle exists (P-29).
  `test/fluent.test.js` (23 tests, goldens, mutation-checked).

#### P-27 — Flow, subflow, action and playbook emitters (L)

- [x] From the P-10…P-12 trees: `Flow()` / `Subflow()` / `Action()` with `trigger.*`, `action.core.*`,
      `wfa.*` logic (if/elseIf/else, forEach, tryCatch, doInParallel, stages), `wfa.dataPill()`;
      `PlaybookDefinition()` with `ActivityDefinitions.Core.*`.
- [x] Unsupported constructs (spoke actions outside `action.core`, nested doInParallel, playbook
      Questionnaire activities, variants) produce an explicit `unsupported[]` list and a `Record()` fallback
      — never silent loss.
- **Depends on:** P-10, P-11, P-12, P-26.
- **Acceptance:** the fixture flow regenerates to Fluent whose build output matches the instance step
  tree (via P-29).

- **Done 2026-09-30 (local, uncommitted), bar the P-29 oracle (O-7).** `src/api/fluent-flow.ts`,
  hooked into `servicenow_generate_fluent` (`emitter: "flow"`): the flow-group types are emitted from
  their `explain_flow` tree — `Flow()` / `Subflow()` / `Action()` with `trigger.*`, `action.core.*`,
  `wfa.flowLogic.*`, `wfa.subflow` and `wfa.dataPill()`, and `PlaybookDefinition()` with
  `ActivityDefinitions.Core.*`. Every construct without a mapping (spoke / custom actions, nested
  doInParallel, Questionnaire activities, variants, unknown logic or definitions, undecodable values,
  rows outside the tree) is an `unsupported[]` entry plus a `Record()` fallback; a degraded tree falls
  back to the P-26 `Record()` form. The API names are the SDK-PARITY names, marked `verified:false`;
  goldens (`test/fixtures/fluent/{flow,subflow,action,playbook}_emitter.golden.txt`) only prove the
  output is deterministic and parses as TypeScript. **2026-10-01:** the P-29 oracle type-checks and
  builds the goldens against SDK 4.12.2; `action.core` inputs are typed from the generated
  `src/api/fluent-sdk-actions.ts`, steps are called by name, `endFlow` only inside blocks, and
  `wfa.action` keys sit on `sys_hub_action_instance_v2`. Comparison with the instance step tree
  stays open (O-5).

#### P-28 — Portal, workspace and catalog emitters (M)

- [x] `ServicePortal`, `SPPage` (layout tree), `SPWidget` (+ `Now.include` for template/css/scripts),
      `SPTheme`, `SPMenu`, `SPHeaderFooter`, `SPPageRouteMap`; `Workspace`, `Dashboard`,
      `UxListMenuConfig`, `Applicability`; `CatalogItem` with variables, variable sets, client scripts, UI
      policies. UIB internals stay `Record()` (the SDK has no API).
- **Depends on:** P-26, P-15, P-16, P-8.
- **Acceptance:** fixture portal page and catalog item regenerate and pass P-29.

- **Done 2026-09-30 (local, uncommitted), bar the P-29 oracle (O-7).** Emitters in
  `src/api/fluent-ui.ts`, dispatched from `src/api/fluent.ts` (`UI_EMITTERS`): `ServicePortal`,
  `SPPage` with its container / row / column / instance tree, `SPWidget` and `SPHeaderFooter`
  (template, CSS, client / server script and link as `Now.include` sidecars; Angular templates inline,
  dependencies and providers as `Now.ref` lists), `SPTheme` (JS / CSS includes), `SPMenu` (items),
  `SPPageRouteMap`, `SPWidgetDependency`, `SPAngularProvider`, `JsInclude`, `CssInclude`; `Workspace`
  (page properties; the root macroponent and app config are referenced by `Now.ref` and reported as
  UIB `Record()` exports), `Dashboard` (tabs, widgets, permissions), `UxListMenuConfig` (categories,
  lists), `Applicability`; `CatalogItem` / `CatalogItemRecordProducer` with typed `<Kind>Variable`
  calls (choices included), variable-set includes, categories and user criteria, followed by the
  `VariableSet`, `CatalogClientScript` and `CatalogUiPolicy` (with actions) calls the item uses; the
  standalone set, client script and UI policy types have the same emitters. UIB internals and
  standalone Angular templates stay `Record()` with an `unsupported[]` entry. Rows that do not fit the
  tree (orphans, unknown variable type codes, m2m rows without a target) are emitted as `Record()` rows
  and reported; unmapped fields are reported — never silent loss. Secrets become placeholders and the
  output is deterministic, as in P-26. Property names follow this document and are **not verified**
  (`verified: false`, a `warnings[]` entry and a header note per file); the `Dashboard` /
  `UxListMenuConfig` / `Applicability` nested structures (U) use camelCase field names. The acceptance
  oracle (P-29, owner gate O-7) type-checks and builds every UI golden against SDK 4.12.2 since
  2026-10-01; `SPPage` takes no `$id`. `test/fluent-ui.test.js` (26 tests, goldens `test/fixtures/fluent/ui_*.golden.txt`,
  mutation-checked).

#### P-29 — Round-trip verification harness (M)

- [ ] Test harness: generate → `now-sdk build` in a temp project → compare built XML field values with
      the instance records (normalised); runs locally when the SDK CLI is present, CI uses recorded builds.
- [ ] Mismatch report per field; the report drives `unsupported[]` in P-27.
- **Depends on:** P-26, O-7.
- **Acceptance:** zero field mismatches for every G-tier fixture type, or a documented `unsupported` entry.
- **Partly done 2026-10-01 (local, uncommitted; O-7 approved — `@servicenow/sdk` 4.12.2 exact as a
  dev dependency).** `scripts/fluent-verify.mjs` (`npm run fluent:verify`, flags `--no-build`,
  `--json`, `--keep`) writes every golden of `test/fixtures/fluent/` into temporary SDK projects,
  type-checks them with strict `tsc` (excess-property checks on) and runs `now-sdk build` offline.
  Goldens that emit a common record are built in separate projects. Every key a golden declares must
  come out under its own sys*id — as `dist/app/update/<table>*<sys_id>.xml`or nested in the
parent's update XML (flow logic, actions, trigger, playbook lanes / activities) — and no`DELETE`may be emitted.`test/fluent-sdk-oracle.test.js`runs it (skipped without the SDK); result: 27
goldens, 0 type errors, 93 keyed records among 100 built.`scripts/gen-fluent-actions.mjs`
(`npm run fluent:actions`, `--check`in`npm run check`) generates the `action.core`/`actionStep` input table (`src/api/fluent-sdk-actions.ts`) from the SDK's built-ins.
  - SDK facts the oracle established: an unreferenced `keys.ts` entry builds as a `DELETE` (the
    emitter now declares only keys a `$id` uses); a key on a table other than the one the SDK writes
    (`wfa.action` → `sys_hub_action_instance_v2`) is re-minted; `SPPage`, flow variables, stages,
    action inputs / outputs and process inputs take no `$id`, so the SDK mints their sys_ids (a
    per-file note warns that installing on the source instance can duplicate the page).
  - Open: the field-value comparison with instance records and the per-field mismatch report
    (needs O-2 / O-5 fixtures).

### Summary

| Phase     | Items     | S   | M   | L   | Weighted (S=1, M=2, L=4) |
| --------- | --------- | --- | --- | --- | ------------------------ |
| P0        | P-1…P-5   | 2   | 3   | 0   | 8                        |
| P1        | P-6…P-9   | 1   | 3   | 0   | 7                        |
| P2        | P-10…P-16 | 1   | 4   | 2   | 17                       |
| P3        | P-17…P-21 | 0   | 4   | 1   | 12                       |
| P4        | P-22…P-25 | 2   | 1   | 1   | 8                        |
| P5        | P-26…P-29 | 0   | 2   | 2   | 12                       |
| **Total** | **29**    | 6   | 17  | 6   | **64**                   |

At the ROADMAP-V3 effort key that is roughly 20–25 single-maintainer weeks.

## 7. Reconciliation with existing ROADMAP-V3 items

| Existing | Relationship                                                                                                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S-14** | Prerequisite for P2 onwards: P-10 and P-21 render Mermaid through `src/api/mermaid.ts`; P-21 and P-26 write through the store contract (frontmatter, `index.json` manifest, `fluent` kind). Nothing in S-14 changes for the epic.                                           |
| **S-15** | P-21 is the registry-wide successor of `document_app`: it reuses `documentApp` and `DOC_KINDS` and registers its kinds there. Ship `document_table` (2.x) and `document_app` first — the latter over P-5's `listArtifacts` (INSTANCE-DOCS pass 2, ID-22); P-21 widens them. |
| **S-3**  | Stays as is. P-18/P-19 add artefact-aware rules to the same `code_health` output; the ACL scan pagination stays in S-3.                                                                                                                                                     |
| **S-4**  | P-1 **implements** S-4's registry bullet with the §5(a) descriptor (so there is one registry, not two); S-4's second bullet (all matches, line context, `scope` filter) stays in S-4 and P-18 builds on it. If S-4 is pulled into 3.0, build it on the P-1 shape.           |
| **S-5**  | The lane work stays in S-5. S-5's `get_flow` bullet is delivered by P-10 (`get_flow` delegates to the flow tree); the stable-snapshot acceptance moves to P-20.                                                                                                             |
| **S-7**  | S-7 keeps `describe_table` field additions and fan-out/resume; its "adds properties, choices, ACLs, notifications, flows, catalog items, roles" list is subsumed by P-20 (registry-wide). Ship S-7 first; P-20 widens it.                                                   |
| **S-9**  | S-9 builds the structural reference extractor (dictionary references, `sys_ui_list`/`sys_ui_section`, catalog variables, flow inputs); P-17 reuses it for `artifact_dependencies`. Flow action inputs need P-10's decoder.                                                  |
| **S-10** | Unchanged scope (ops/data/history). `sys_properties` get/set in S-10 and P-23 must share the plan/apply path — whichever lands first owns it. `atf_run` stays in S-10; ATF definitions (QA-1/2) are read by P-8.                                                            |
| **S-6**  | Update-set binding applies to P-23 writes in non-SDK scopes; SDK-managed scopes have no update sets (inventory §4) — P-22's warning says so.                                                                                                                                |
| **H-11** | P-22 runs after the H-11 protected-table policy; H-11's list is the input to P-19's "flow runs as system and writes protected tables" rule.                                                                                                                                 |

**Explicitly out of the epic:**

- Running `now-sdk install`, `pack`, `cicd install|publish|rollback` from the server (the server never
  deploys an app package).
- `/api/now/uxf/*`, `/api/now/processflow/*`, `/api/sn_flow_designer/*`, `/api/now/sp/*`; installing
  scripted REST shims to reach `sn_fd.FlowAPI`.
- Applying edits to UIB composition JSON (plan-only), direct writes of `sys_hub_*` step rows, any write
  to `wf_*`.
- Building or deploying custom UX components (`snc ui-component`) — only `sys_ux_lib_component` reads.
- Instance Scan execution (`/api/sn_cicd/instance_scan/...`, unverified) — authoring reads only (QA-3).

### Open owner questions (gates)

- [ ] **O-5** Live verification on the PDI (extends O-2): run P-2 and confirm inventory §6 items —
      (1) "Since" versions for `<=3.0` APIs; (2) `DatabaseView` tables; (3) every (U) child/m2m table and
      field in §4; (4) that no feature depends on internal endpoints and the exact `sn_cicd` paths;
      (5) the `*_v2` `values` compression format on Zurich/Australia; (6) whether custom UX components
      moved into the SDK; (7) an instance-side signal for SDK-managed apps. Blocks P-2, P-3 heuristics,
      P-10, P-14, P-25.
- [ ] **O-6** SDK-managed writes: accept `warn` in 3.x → `deny` in 4.0, and the authority order
      (declared list → `now.config.json` → heuristics).
- [ ] **O-7** Fluent generation: may the repo take `@servicenow/sdk` as a dev dependency (types +
      round-trip builds in CI), and which SDK major does generated code target?
- [ ] **O-8** Tool budget: approve +9 tools / +2 packages and their profile placement, and whether
      `list_scripts` / `get_script` become aliases of the generic tools in 4.0.
- [ ] **O-9** Licensed families: are `sn_aia_*`, `sn_nowassist_skill_*` and `sys_pd_*` in scope when the
      PDI cannot activate the plugin (descriptors ship `verified:false` otherwise)?

## 8. Release placement

- **3.0.0: nothing from this epic enters the must-have cut** (items 1–19, 25–29, 46–50 stay as they
  are). 3.0 stays shippable on its own schedule; the epic has no breaking change that must ride 3.0.
- **Exception:** if S-4 (row 31) is pulled into 3.0, it is built on the P-1 descriptor shape so the
  registry is not migrated twice. P-1 itself is non-breaking and may land on 2.x/3.0 at any time.
- **3.x (non-breaking minors)**, in order: P0 + P1 (≈ 3.1), P2 (≈ 3.2–3.3), P3 (≈ 3.3–3.4), P4 with
  the P-22 `warn` default (after 3.0 ships H-3, H-5, H-11 and S-2, which P-23 needs), P5 after O-7.
- **4.0:** only the P-22 default flip to `deny` (new breaking-register row) and, if O-8 agrees, the
  `list_scripts` / `get_script` alias retirement.
