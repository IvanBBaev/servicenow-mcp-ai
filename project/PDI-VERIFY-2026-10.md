# O-5 — table and field names checked against a PDI

Date: 2026-10-10. Instance: the owner's PDI (`ven03019`, basic auth). Read-only:
only GETs on `sys_db_object` and `sys_dictionary`. Tool:
`scripts/pdi-verify.mjs` (needs `npm run build`; run with a raised
`SN_MAX_RECORDS`, e.g. `SN_MAX_RECORDS=5000 node scripts/pdi-verify.mjs`).

## Method

The script reads the names from two places:

- the artefact registry (`ARTIFACT_TYPES`). For each type and child it takes
  the table, every named field (name, scope, active, applies-to, order,
  parent link, key, script, client, markup, secret, meta, when, write,
  unique, scope-prefix, JSON and ref fields), the parent keys and `alsoMatch`
  pairs, and each reference target table;
- reader calls in `build/api` and `build/tools`: any object literal with a
  literal `table` and a literal `fields` array.

On the instance side, a table exists if it has a `sys_db_object` row. A field
exists if the table or any ancestor in its `super_class` chain has a
`sys_dictionary` row for it. Dot-walked fields are checked by their first
segment only.

## Totals

265 tables and 1,309 `table.field` names. **5 tables and 74 fields are
missing** on the PDI. The suggested names below come from the real
dictionary columns of each table.

A missing name is not always a code bug. Plugins that are not active on the
PDI hide their tables. Dot-walked and computed values in readers are not
checked. The `verified` flags in the registry are not changed by this report.

## Missing tables

| Table                         | Used by                               | Finding                                                                                   |
| ----------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `change_risk_asmt`            | `risk_assessment`                     | Plugin `com.snc.change_management.risk_assessment` is inactive on the PDI — unverifiable. |
| `change_risk_asmt_threshold`  | `risk_assessment` child               | Same plugin — unverifiable.                                                               |
| `sys_package_dependency`      | `application` child                   | Not present. The PDI has `sys_package_dependency_m2m` and `sys_package_dependency_item`.  |
| `sys_scope_dependency`        | `app_dependency`, `application` child | Not present; no equivalent found.                                                         |
| `sys_ux_composite_definition` | `uib_composite_definition`            | Not present; only `sys_ux_composite_data*` tables exist.                                  |

## Reader bugs (wrong results today)

These names are read by code paths outside the artefact registry, so a call
returns empty columns or matches nothing.

| Name                                                            | Reader                            | Real column(s)                                                        |
| --------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| `sys_flow_context.table`                                        | `api/flows-designer`              | `source_table`                                                        |
| `sys_flow_context.document_id`                                  | `api/flows-designer`              | `source_record`                                                       |
| `sys_hub_trigger_instance.condition / table_name / when_to_run` | `api/flows`, `api/flows-designer` | Not columns; the trigger inputs live in `trigger_inputs` (glide_var). |
| `wf_workflow.active`, `wf_workflow.condition`                   | `api/flows`, `api/flows-designer` | On `wf_workflow_version`.                                             |
| `wf_activity.order`                                             | `api/flows-designer`              | No such column.                                                       |
| `sys_script.global`                                             | `api/flows`                       | No such column on `sys_script`.                                       |
| `sys_script_client.inherited`                                   | `api/flows-lanes`                 | `applies_extended` (and `global`).                                    |
| `sys_upgrade_history.state`                                     | `api/upgrade`                     | No such column (closest: `summary_complete_status`).                  |
| `sys_upgrade_history_log.application`                           | `api/upgrade`                     | No such column (closest: `application_category`, `plugin`).           |

## Registry mismatches

| Artefact (child)                                            | Name in code                                                | Real column(s)                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `data_lookup`                                               | `dl_definition.table`                                       | `source_table` (also `matcher_table`)                                         |
| `data_lookup` > `dl_definition_rel_match`                   | `definition`, `source_field`                                | `dl_definition`, `source_table_field`                                         |
| `data_lookup` > `dl_definition_rel_set`                     | `definition`, `target_field`                                | `dl_definition`, `source_table_field` / `matcher_table_field`                 |
| `pa_script`                                                 | `facts_table`, `fields`                                     | `table`, `arguments`                                                          |
| `pa_breakdown`, `pa_indicator`                              | `active`                                                    | No such column.                                                               |
| `dashboard` > `par_dashboard_widget`                        | `tab`                                                       | `canvas`                                                                      |
| `ai_agent`, `ai_agentic_workflow`                           | `active`                                                    | No such column on `sn_aia_agent` / `sn_aia_usecase`.                          |
| `ai_agent` > `sn_aia_trigger_configuration`                 | `agent`                                                     | `usecase`                                                                     |
| `ai_agent` > `sn_aia_version`                               | `agent`                                                     | `target_id` + `target_table` (document id)                                    |
| `sp_dependency`                                             | `include_on_page_load`                                      | `page_load`                                                                   |
| `state_model`                                               | `sttrm_model.table`                                         | `table_name`                                                                  |
| `state_model` > `sttrm_state`                               | `label`, `model`                                            | `state_label`, `sttrm_model`                                                  |
| `state_model` > `sttrm_state_transition`                    | `model`                                                     | No such column (`from_state`, `to_state`, `name`).                            |
| `state_model` > `sttrm_transition_condition`                | `transition`                                                | `sttrm_state_transition`                                                      |
| `data_policy`                                               | `use_as_ui_policy`                                          | `enforce_ui`                                                                  |
| `ux_declarative_action_definition`                          | `action_name`, `label`                                      | `name` / `dispatch_action`; no `label`                                        |
| `ux_declarative_action_payload`                             | `key`, `payload`                                            | `action_key`, `payload_template`                                              |
| `graphql_api`                                               | `schema_namespace`                                          | `namespace` / `application_namespace`                                         |
| `graphql_api`, `graphql_type_resolver`                      | `sys_graphql_typeresolver.name`                             | `type_name`                                                                   |
| `flow`, `subflow` > `sys_hub_action_instance`               | `values`                                                    | `action_inputs`                                                               |
| `flow_action` > `sys_hub_step_instance`                     | `values`                                                    | `inputs`                                                                      |
| `flow`, `subflow` > `sys_hub_sub_flow_instance_v2`          | `values`                                                    | `subflow_inputs`                                                              |
| `workflow` > `wf_activity`                                  | `workflow`, `order`                                         | `workflow_version`; no `order`                                                |
| `workflow`                                                  | `wf_workflow.active`                                        | On `wf_workflow_version`.                                                     |
| `js_module`                                                 | `sys_module.name`                                           | `path` (also `content`)                                                       |
| `source_control`                                            | `branch`, `application`, `sys_scope`                        | `current_branch`; no `application` / `sys_scope`                              |
| `rest_message`                                              | `use_mid_server`                                            | No such column.                                                               |
| `business_rule`                                             | `sys_script.global`                                         | No such column.                                                               |
| `security_data_filter`                                      | `condition`, `table`, `name`                                | `filter`, `table_name`; no `name`                                             |
| `uib_route`, `uib_app_config` > `sys_ux_app_route`          | `parameters`                                                | `fields`, `optional_parameters`                                               |
| `uib_data_broker_*` (graphql, rest, scriptlet, transform)   | `properties`                                                | `props` (on the `sys_ux_data_broker` base)                                    |
| `uib_event`                                                 | `sys_ux_event.name`                                         | `event_name` (also `label`)                                                   |
| `uib_form_action`, `workspace_form_action`                  | `action` / `action_name`, `label`, `order`, `applicability` | `declarative_action` / `ui_action`, `name`, `specificity`; no `applicability` |
| `uib_form_action_layout` > `sys_ux_form_action_layout_item` | `form_action`, `form_action_layout`                         | `action`, `layout_group`                                                      |
| `uib_component`                                             | `sys_ux_lib_component.name`, `properties`                   | `tag`, `source_script`; no `properties`                                       |
| `uib_screen`                                                | `applicability`                                             | `screen_condition`                                                            |
| `inbound_email_action`                                      | `condition`                                                 | `filter_condition` / `condition_script`                                       |

## Scope field on tables without `sys_scope`

These tables have no `super_class` and no `sys_scope` column, so the default
`scopeField` does not apply. A scope filter on them matches nothing.

`sys_app` (it is itself a `sys_scope` subclass, so its own `sys_id` is the
scope), `kb_knowledge_base`, `sys_user_preference`, `sys_pd_context`,
`wf_context`, `sys_flow_context`.

## Re-run after the fixes

Date: 2026-10-10, same PDI. The verifier now also resolves same-file
`const` table and field lists (a42105e), so it checks **273 tables and
1,339 names**. What is left: **5 tables and 12 fields**, all of them
explained below. Every reader bug and every non-breaking registry mismatch
in the tables above is fixed:

| Area                                            | Commit(s)                 |
| ----------------------------------------------- | ------------------------- |
| `api/flows-designer` flow runs                  | 0678927                   |
| `api/flows` trigger inputs                      | 6abfbb3                   |
| `api/flows` workflow state, global rules        | 4d8fe30                   |
| `api/upgrade`                                   | 65b411c                   |
| Registry: UI / process / platform rows          | 4bc142c, 66fc4d4, 2bd8a54 |
| Registry: flow step inputs, `sys_script.global` | 3732ece                   |
| Explainers: state model, data policy            | 59bcf6d                   |
| `api/meta` indexes, `api/importset` run fields  | 485bc67                   |

Flow step inputs: the plain `sys_hub_action_instance` has no `values` — its
`action_inputs` is a glide_var whose values live in `sys_variable_value`. The
encoded inputs are read from `sys_hub_action_instance_v2.values`,
`sys_hub_sub_flow_instance_v2.subflow_inputs` and
`sys_hub_flow_logic_instance_v2.values`. `sys_index` has no `name` or
`col_name`; an index is named from `logical_table_name` and
`col_name_string`. The PDI admin gets a 403 on `sys_index` over REST.

Still open:

- **Plugin-gated or absent tables (5):** `change_risk_asmt`,
  `change_risk_asmt_threshold`, `sys_package_dependency`,
  `sys_scope_dependency`, `sys_ux_composite_definition` — unchanged.
- **Scope field (7):** `sys_scope` on `kb_knowledge_base`, `sys_app`,
  `sys_flow_context`, `sys_pd_context`, `sys_repo_config`,
  `sys_user_preference`, `wf_context` (see above). Needs an owner decision
  per type: no scope filter, or a different field.
- **BREAKING key fields (4, O-4):** `sys_declarative_action_definition.action_name`
  (real: `name`), `sys_declarative_action_payload_definition.key`
  (`action_key`), `sys_ux_event.name` (`event_name`),
  `sys_ux_form_action_layout_item.form_action_layout` (`layout_group`). They
  are registry key fields, so renaming them changes the output keys.

## Second pass: queries, payloads and JSON shapes

Date: 2026-10-10, same PDI. The verifier also reads the field names in the
static parts of each reader's encoded `query` (6572cc8): **1,351 names**; the
only new miss was `scan_finding.active`. Row samples (GET only) covered what
the dictionary cannot show — property names, reference targets, choice
values, payloads and JSON columns:

| Area                        | Finding                                                                                                                                                                                     | Commit  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Hardening rules             | The code-tag property is `glide.ui.security.allow_codetag` (singular); its default is dropped (unknown). Rule table v2.                                                                     | e7755d8 |
| Access review               | `included_in_role` references `sys_user_has_role`, so the containing role is `included_in_role.role.name`. The `sys_audit_delete` payload format matches the parser.                        | 65430f6 |
| Task context, instance scan | `scan_finding` has no `active`; open findings are `muted=false`.                                                                                                                            | c72111d |
| Upgrade store (N-1)         | `resolution_status` labels and the skip disposition values (4, 9, 10, 11, 104) normalised.                                                                                                  | a00d470 |
| Decision tables, playbooks  | Condition column `condition_to_run`; trigger type through `trigger_type.name`; runs by `process_definition.source` (`sys_pd_context` references `sys_pd_snapshot`); absent columns dropped. | e1b0aa6 |
| UI Builder (N-25)           | Children nest under `overrides.composition` with a `slot`; event handlers have `type` / `event` / `operation` / `clientScript`; the broker input schema column is `props`.                  | 3f104f7 |

Caveats from this pass:

- The newest `scan_result` on the PDI is a run with 0 findings (2026-08-21),
  so "latest scan" reads come back empty there. Whether to fall back to the
  newest run with findings is an owner choice.
- The PDI admin gets a 403 on `sys_store_app` over REST.
- Hardening: `glide.stax.allow_entity_resolution` and
  `glide.login.no_blank_password` have no row on the PDI, so their defaults
  stay unverified.
- UI Builder follow-ups (new coverage, not fixes): element `eventMappings`
  are not read yet (done in the third pass); one OOB composition holds a raw
  control character and decodes as `decoded:false`.

## Third pass: domain, access, ATF, i18n, cross-scope, UI Builder

| Commit  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| b7238e5 | `recordDomain` ignores a `global` value in `sys_overrides` (45 business rules on the PDI hold it). Caveats updated where the PDI confirmed them: ACL `admin_overrides`, role-assignment `state` (`active` or empty), the default deny (`glide.sm.default_mode=deny`), the `sys_domain.name` dot-walk, the tables carrying `sys_domain` / `sys_overrides`, `sys_domain_path`, the workspace category sys_id.                                                                                                                                                                                                                                                                       |
| b5cb05b | ATF `success_with_warnings` counts as a pass; i18n coverage tables and fields confirmed; `sys_restricted_caller_access.status` is an integer choice, now mapped to `requested` / `denied` / `allowed` / `invalidated` (an output value change).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8591ca4 | UI Builder: per-element `eventMappings` are read into the event chains (`origin: "element"`); tools/list delta 0 B.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| bc411b2 | UI Builder data resources: all seven PDI `definition.type` values map to a table (COMPOSITE, CLIENT_STATE, CONTROLLER added); import names with spaces resolve.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7e9718e | Registry GraphQL names confirmed (`sys_graphql_typeresolver` names by `type_name`; `namespace` / `application_namespace`, already fixed in 2bd8a54); broker comments record the confirmed tables. Comments only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 4d794b6 | UI Builder: composition `definition.id` values are `sys_ux_macroponent` sys_ids (17/17 sampled, primitives included), so that table is read first; built-ins whose id equals their type (REPEATER, MACROPONENT_VIEWPORT_HEADLESS) count as `oob` instead of `unresolved`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| ba87579 | Privilege and capabilities comments: 8 of 10 elevated roles are visible (`maint` and `security_admin` rows are hidden); the 15 S-4 widened types and their script fields exist. The registry `verified` flags are unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3adfca6 | Workspace action configurations (N-30): the experience-restricted m2m is `sys_ux_m2m_action_assignment_action_config`, reached from the experience's `actionConfigId` page property; `explain_ui_experience.actionConfigs` is an optional key, tools/list delta 0 B. No dedicated side panel or form config table exists beyond `sys_ux_form_action_layout`.                                                                                                                                                                                                                                                                                                                      |
| b1132f1 | Workspace action exclusions (N-30): `sys_workspace_declarative_action_exclusion` has `action_assignment`, `table`, `exclude_self`, `exclude_all_child_tables` and `view` (475 rows, 33 with a view); read into the optional `actionExclusions` key, tools/list delta 0 B.                                                                                                                                                                                                                                                                                                                                                                                                         |
| ea2561a | CI/CD Instance Scan routes (N-3, NX-03): plugin `com.glide.continuousdelivery` active; `full_scan`, `point_scan` (`target_table` / `target_sys_id`) and `progress/{id}` match the CICD Spoke REST steps; the plain `suite_scan/{id}` does not exist (400), so `scan_run: "suite"` posts to `suite_scan/combo/{sys_id}` with a `scan_combo` sys_id. Routes checked by GET only (405 = POST route exists), no scan started; tools/list delta 0 B.                                                                                                                                                                                                                                   |
| 27f25ee | Workspace action exclusions inherited through `exclude_all_child_tables` (N-30): the parent-table chain is read (cached, depth cap 20, first 25 tables) and inherited rows carry `inheritedFrom`; tools/list delta 0 B.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2ed740a | UI Builder variants (N-27, UX-05): `sys_ux_screen` has no `applicability`; audiences are the m2m `sys_ux_applicability_m2m_screen` (508 rows, 4 inactive, often 2–4 per screen), `applicability.roles` holds `sys_user_role` sys_ids; `sys_ux_app_config` has no `roles`; `screen_condition` is an inline string (156 screens); `sys_ux_screen_condition.active` exists; `admin_panel_table` is `sys_aw_master_config` on 1 page. tools/list delta 0 B.                                                                                                                                                                                                                           |
| 7f2b7a0 | A missing table answers the Table API with HTTP 400 "Invalid table <name>", not 404 (an empty query is 200 `[]`). `isAbsentTableError()` reads both as absent: the capability matrix, workspace probe, `document_instance` workspaces, preflight and security-scan reasons; tools/list delta 0 B.                                                                                                                                                                                                                                                                                                                                                                                 |
| 294fc1f | Table chain dot-walk (N-61): `sys_db_object` answers a six-level `super_class.….name` dot-walk in one request, every level present and empty past the root (`incident` → `task` → ""). `getTableChain` reads six levels per request; the describe-table replay fixture holds one request. tools/list delta 0 B.                                                                                                                                                                                                                                                                                                                                                                   |
| 61cdc8d | Field ACL order (N-2): not readable by GET; taken from the ServiceNow docs (ACL rule types): `table.field`, parent `.field`, `*.field`, `table.*`, parent `.*`, `*.*`. The explainer had `*.field` after `table.*`; fixed. tools/list delta 0 B.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7f11293 | Too-long Table API query (N-26): a big IN list with more rows than the page answers 400 "Pagination not supported" (the Link header URLs cannot be built); with `sysparm_suppress_pagination_header=true` the read works and `X-Total-Count` stays. `queryTable` retries once on that error only. tools/list delta 0 B.                                                                                                                                                                                                                                                                                                                                                           |
| 2ae3d3b | UI Builder page map shapes (N-26, UX-02/03/04/06): props, typed bindings, handler targets and component resolution hold on five experiences (cmdb, access-management, admin-center, change-management, calendar-demo-ex); every binding resolved, one dangling component id. Screen audiences come from `sys_ux_applicability_m2m_screen`. tools/list delta 0 B.                                                                                                                                                                                                                                                                                                                  |
| 52647de | Workspace coverage (N-30): `m2m_app_theme` links a theme to a `sys_ux_app` through `ux_app` (no `app` field; 0 rows on the PDI); an experience names its app in `sys_ux_page_registry.parent_app` (147 experiences) and `sys_ux_app.theme` is the app theme; `sys_declarative_action_definition` has `name` (no `label` / `action_name`); the payload definition has `label` / `action_key` (no `key`); every `sys_declarative_action_assignment` field read exists; `sys_aw_list.title` / `table` and `sys_aw_master_config.name` exist. tools/list delta 0 B.                                                                                                                   |
| f38f1c7 | `pendingApprovals` names an approval on a non-task record (a scoped app table such as `x_nuvo_com_ecr`) by `source_table` and `document_id`; the `sysapproval.*` dot-walks are empty there. `task_sla` `stage` and `has_breached` are read as stored (a PDI demo SLA shows stage Breached with `has_breached=false`).                                                                                                                                                                                                                                                                                                                                                             |
| 011df75 | UI Builder page hints (N-31): a data resource in `sys_ux_macroponent.data` carries `readEvaluationMode` (EAGER 4,960 / EXPLICIT 3,047 / absent 57 / ON_DEMAND 1 over 8,066 resources on 2,342 macroponents) and once a typed `conditional` (`{type:"BINARY", operation}`); no `when` / `evaluationMode` key exists, so every resource had counted as on load. `required_translations` is `[{message, code, comment}]` (833), `[{message, comment}]` (1,153) or `[]` (1,009); composition literals are `TRANSLATION_LITERAL` (`value.message`); 96% of the strings found on 400 pages are declared. Composition reads page at 50 rows (500 rows pass 50 MB). tools/list delta 0 B. |
| 385dba0 | ATF definitions (N-16, NX-20): editing a step (`sys_atf_step`) or a suite membership (`sys_atf_test_suite_test`) does not bump the parent's `sys_updated_on` — 2,702 of 4,772 steps and 280 of 335 memberships are newer than their test / suite. The unchanged-test check now also reads the newest child `sys_updated_on`; both child queries return sorted rows (47 steps for 5 tests, 22 memberships for 5 suites). The PDI has no ATF result rows, so the full history path was not run live. tools/list delta 0 B.                                                                                                                                                          |

Gate on the merged tip: 2496 pass / 0 fail / 1 skipped, pack 2629.4 KB.

Still unverified after this pass:

- Elevation: the `security_admin` and `maint` rows in `sys_user_role` are
  counted but hidden from the PDI admin's reads, so their
  `elevated_privilege` flag and the write gating cannot be checked with GETs.
- Whether a non-separated instance omits `sys_domain` or returns it empty
  (this PDI is domain-separated).
- S-4 widened script field types, for the `verified` flags:
  `sys_dictionary.default_value` and `sys_rest_message_fn`
  `rest_endpoint` / `content` are strings, `sys_ui_macro.xml` and
  `sys_ui_page.html` are xml, `sp_widget.css` is css.

## Fourth pass: `ops` (N-6 and the v1 kinds)

Date: 2026-10-12. Same PDI, GETs only (`sys_dictionary`, `sys_choice`,
`sys_properties`, `sys_table_rotation`, Aggregate API counts). The N-6 field
names live in constants (`HTTP_LOG`, `TXN`, `AGENT_FIELDS`, `ECC`), not in a
literal `fields` array, so the script above did not reach them.

| Table                   | Read by `ops`                                                            | Result                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sys_outbound_http_log` | `url`, `http_method`, `response_status`, `response_time`, `rest_message` | **2 wrong.** The method is `method`; there is no `rest_message` column (the caller is `source_table` + `source_record`). Fixed: rows are grouped by host and `source_table`, and the group key `rest_message` is now `source_table`. |
| `syslog_transaction`    | `url`, `response_time`, `sys_created_by`                                 | All present.                                                                                                                                                                                                                         |
| `ecc_agent`             | `name`, `status`, `version`, `last_refreshed`, `host_name`               | All present (the PDI has no MID server, so `status` values are not seen).                                                                                                                                                            |
| `ecc_queue`             | `agent`, `state`, `error_string`, `queue`, `topic`, `name`               | All present. `state` choices: `ready`, `processing`, `processed`, `error`. `agent` values are `mid.server.<name>` (also the broadcast `mid.server.*`) and `RESTClient`.                                                              |
| `syslog`                | `level`                                                                  | `-1` / `0` / `1` / `2` as mapped; the choice list also has `3` Fatal and `-2` Trace, which no level filter selects.                                                                                                                  |
| `sys_trigger`           | `state`                                                                  | `0` / `1` / `2` as mapped; also `-1` Error, `-2` Permanent Error and `-1776` Paused, now labelled in `by_state`.                                                                                                                     |
| `sys_email`             | `type`                                                                   | `send-ready`, `send-failed` present.                                                                                                                                                                                                 |
| `sys_semaphore`         | (all fields)                                                             | Present; it is the semaphore definition table, so rows describe the configured pools.                                                                                                                                                |

Outbound logging is on by default: `glide.outbound_http.db.log` = `true` at
level Basic (18,575 rows on the PDI). Retention (`sys_table_rotation`):
`sys_outbound_http_log` and `syslog_transaction` rotate 8 × 7 days (about 8
weeks); `ecc_queue` rotates 7 × 1 day.

## Fifth pass: form action layouts (P-15)

Date: 2026-10-13. Same PDI, GETs only. Live run: 2 layouts in
`stefan-platform-analytics`, 7 layouts with 33 items in `playground`, no
missing field and no unreadable table.

| Table                             | Was read as                                 | Result                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sys_ux_form_action_layout_item`  | child by `form_action_layout`, ref `action` | **No layout reference.** Fields: `action`, `label`, `item_type`, `layout_group`, `order`, `name`, `table`, `active`. Items link to a layout through `sys_ux_m2m_action_layout_item`. |
| `sys_ux_m2m_action_layout_item`   | (not read)                                  | `ux_form_action_layout`, `ux_form_action_layout_item`, `order`, `active`, `display_type`, `variant`, `icon`, `table`. Now the registry child and the item order source.              |
| `sys_ux_form_action`              | `label`, `action`, `applicability`          | **None exist.** It has `name`, `action_type`, `ui_action`, `declarative_action`, `table`, `specificity`, `active`. Items are labelled from the item `label` or the action `name`.    |
| `sys_ux_applicability_m2m_layout` | (not read)                                  | `action_layout`, `applicability`, `order`, `active`: audiences are per layout, now `formActionLayouts[].applicability`.                                                              |

Fixed in b07993f (`explain_ui_experience` items, the `uib_form_action_layout`
child). The OD-1 key-field renames are left as they are. The fourth OD-1 row
(`form_action_layout` → `layout_group`) is not a key field and is not the
right link: `layout_group` groups items inside a layout. tools/list delta 0 B.

## Sixth pass: secret column types (N-21)

Date: 2026-10-13. Same PDI, GETs only (`sys_glide_object`, `sys_dictionary`
counts grouped by `internal_type` and `element`).

- `password` (one-way, 11 columns, e.g. `sys_user.user_password`) and
  `password2` (two-way, 894 columns) are field types in `sys_glide_object`.
  `glide_encrypted` is not: it comes with column-level encryption, so it stays
  in `SECRET_INTERNAL_TYPES` for instances that have it.
- All 12 names in `FALLBACK_SECRET_FIELDS` exist as columns. All are
  `password` / `password2` except `ssh_private_key`, which is a plain string
  column, so only the name list masks it.
- Names that are `password2` on every table they occur on, added to the
  fallback: `sn_auth_token` (703 tables), `auth_token`, `secret`,
  `accesskey_secret`, `credential_value`, `keystore_password`,
  `truststore_password`, `key_password`, `signing_key_password`,
  `current_password`, `temp_password`, plus `secret_key` (4 of 5 tables).
  `token` (97 string columns), `api_key`, `password`, `new_password` and
  `old_password` are mixed; only `api_key` and `password` were already listed.

## Seventh pass: compact reads (N-62)

Date: 2026-10-13. Same PDI, GETs only (`sys_ui_list`, `sys_ui_list_element`,
`sys_ui_view`, `sys_dictionary`, `incident` and `sys_user` with
`display_value=all`).

- The default list view has the sys_id `Default view` and an empty name,
  which `list_id.view.name=NULL` matches. With `list_id.parentISEMPTY` and
  `list_id.sys_userISEMPTY`, the `fields:"summary"` query returns its 11
  `incident` columns (`number` … `sys_updated_by`) and skips the 23 other
  `incident` lists: named views (`ess`, `sow`, `workspace`, `Mobile`, the
  `RPT…` report views) and the `parent` lists.
- `display=true` is set on `task.number` and `kb_knowledge.number` only among
  the tables checked; `sys_user` and `cmdb_ci` have none and show `name`,
  which is the resolver's fallback.
- The journal types are `journal` (30 columns), `journal_input` (66) and
  `journal_list` (6), the three the compaction drops. A journal cell with
  `display_value=all` has an empty `value` and the history in
  `display_value`, so a named journal column keeps its display text.
- A date cell's `value` is UTC and its `display_value` is in the user's time
  zone; the compaction keeps the value.

No code change; the `compact-read.ts` note and N-62 are updated.

## Eighth pass: Flow Designer (`explain_flow`, flow snapshots)

Date: 2026-10-13. Same PDI, GETs only (`sys_dictionary`, `sys_choice`, Table
API reads of the step tables, `sys_variable_value`, `sys_flow_log`,
`wf_context`, `wf_activity`).

| Item                       | Was assumed                             | Result                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot children          | `flow = <snapshot sys_id>` (unverified) | **Confirmed.** All six step tables have rows under `sys_hub_flow` (draft) and under `sys_hub_flow_snapshot` (published).                                                                                                                       |
| `_v2` step inputs          | `values` on every `_v2` table           | **1 wrong.** `sys_hub_action_instance_v2` and `sys_hub_flow_logic_instance_v2` use `values`; `sys_hub_sub_flow_instance_v2` has no `values` and keeps its inputs in `subflow_inputs` (all 286 rows base64 + gzip JSON). Fixed: read per table. |
| v1 step inputs             | not read                                | v1 tables have no `values` column (`sys_hub_flow_logic` / `sys_hub_sub_flow_instance` have a `glide_var` `inputs`). Values are `sys_variable_value` rows (`document` = v1 table, `document_key` = step). Now read, as format `variables`.      |
| v1 vs `_v2` on one `ui_id` | `_v2` wins                              | Clashes: action 466, logic 578, subflow 32, half under the flow and half under the snapshot. On every clash the `_v2` row is the newer one. Kept; which table is authoritative per release stays unconfirmed.                                  |
| `label_cache`              | JSON array                              | Confirmed.                                                                                                                                                                                                                                     |
| `values` encoding          | plain JSON or base64 + gzip JSON        | base64 + gzip JSON, sometimes behind leading whitespace; the decoder already handles it.                                                                                                                                                       |
| `sys_flow_log.level`       | `error` or `2` is an error              | String choices `-1` Debug, `0` Information, `1` Warning, `2` Error. The level caveat is dropped.                                                                                                                                               |
| `wf_context.state`         | `executing` is running                  | Confirmed (`cancelled`, `executing`, `finished`).                                                                                                                                                                                              |
| `wf_activity`              | keyed by `workflow_version`             | Confirmed (`workflow_version`, `activity_definition`, `x`, `y`, `out_of_date`).                                                                                                                                                                |

Not checked: P-25 (does toggling a flow's `active` leave `master_snapshot`
unchanged) needs a write, and this PDI is read-only for us. tools/list delta 0 B.

## Ninth pass: UI Builder pages, brokers and client scripts (N-28, N-29, N-32)

Date: 2026-10-13. Same PDI, GETs only (`sys_dictionary`, `sys_update_xml`,
`sys_security_acl`, `sys_ux_*`).

| Table / field                          | Was read as                                         | Result                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sys_update_xml.name` for UIB records  | `<table>_<sys_id>`                                  | Confirmed: 557 of 557.                                                                                                                                                                |
| `sys_security_acl.type`                | the string `ux_data_broker` (`type=ux_data_broker`) | **Wrong.** A reference to `sys_security_type`; the query matched no row. Now `type.name=ux_data_broker` (2,376 ACLs named by a broker sys_id). Three readers fixed.                   |
| `sys_ux_screen.applicability`          | the variant's audience                              | **Does not exist.** Audiences are `sys_ux_applicability_m2m_screen` links (`screen`, `applicability`, `order`, `active`). `uib_completeness` and `uib-screen-no-applicability` fixed. |
| `sys_ux_macroponent.dispatched_events` | JSON array of names                                 | **A glide_list of `sys_ux_event` sys_ids** (`handled_events` too). Even resolved to `event_name`, about two thirds of OOB `api.emit` calls name undeclared page events.               |
| UIB client-script API                  | `handler({api, event, helpers, imports})`           | Confirmed in OOB scripts: `api.setState`, `api.state`, `api.emit`, `api.data`, `helpers.timing`, `helpers.snHttp`, `helpers.modal`, `imports[…]`.                                     |

Fixed in 110aa5c (ACL `type.name`, screen audiences) and b67dc93
(`dispatched_events`: `lint_script` no longer reads it, the registry drops
the JSON decoder). tools/list delta 0 B.

## Tenth pass: `upsert_artifact` write fields and the scope prefix (P-23, P-24)

Date: 2026-10-13. Same PDI, GETs only (`sys_dictionary`, `sys_choice`,
aggregates over `sys_ui_policy_action`, `catalog_ui_policy_action`,
`catalog_script_client`, `item_option_new` and the `sp_*` tables).

| Item                                     | Was assumed                          | Result                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write field names (P-23, P-24)           | registry `writeFields` (unverified)  | **Confirmed.** Every name exists (the `pdi-verify` re-run of 2026-10-13 covers `writeFields`, `unique` and `scopePrefixFields`).                                                         |
| `sys_ui_policy_action` flags             | `visible` / `mandatory` / `disabled` | String choices `ignore` / `true` / `false` (default `ignore`); `value_action` is `ignore` / `set_value` / `clear_value`; `field_message_type` is `none` / `info` / `warning` / `error`.  |
| `catalog_ui_policy_action` flags         | as above                             | Same values in use (`true`, `false`, `ignore`).                                                                                                                                          |
| `catalog_script_client.type` / `ui_type` | written as given                     | Choices come from `sys_script_client`: `onLoad` / `onChange` / `onSubmit` / `onCellEdit`; `ui_type` `0` Desktop, `1` Mobile / Service Portal, `10` All.                                  |
| `item_option_new.type`                   | written as given                     | The numeric variable type (`6`, `8`, …, 29 values in use), not a label. Noted in the registry.                                                                                           |
| `sp_rectangle_menu_item.type`            | written as given                     | Choices `page`, `url`, `sc`, `sc_category`, `sc_cat_item`, `kb`, `kb_topic`, `kb_article`, `kb_category`, `filtered`, `scripted`.                                                        |
| Scope prefix on `sp_*` ids               | the SDK convention                   | **Not enforced by the platform.** Scoped records hold ids without `<scope>_` (`x_nuvo_eam`: `nuvo_eam_catalog`, `bulk_update`; most scoped widgets have an empty `id`). Stays a warning. |

No behaviour change: the registry comments, the `SCOPE_PREFIX` message and
P-23 / P-24 are updated; the `verified` flags are not changed. tools/list
delta 0 B.

## Eleventh pass: UI Builder binding shapes (N-25)

Date: 2026-10-13. Same PDI, GETs only: every `sys_ux_macroponent.composition`
(5,040 rows, all valid JSON), plus the four data broker tables the UIB rules
read.

| Item                       | Was read as                  | Result                                                                                                                                           |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typed binding values       | `{type, binding: {address}}` | Confirmed. STATE (10.2k), DATA_OUTPUT (5.4k) and CONTEXT (5k) bindings; literals, MAP / LIST containers and BINARY / UNARY operations wrap them. |
| `CONTEXT_BINDING.category` | not read (`@context.x`)      | **Part of the path**: `props`, `session` or `app`. Now `@context.props.x`.                                                                       |
| `REPEATER_ITEM_BINDING`    | not recognised               | **New kind `item`**: category `value` / `index` / `parent`, the address may be empty (`@item.index`). 2.5k uses.                                 |
| `ELEMENT_BINDING`          | not recognised               | **New kind `element`**: address `[elementId, prop, …]`, written `@elements.<id>.<prop>`. 870 uses, plus 126 `@elements.` strings.                |
| `CLIENT_TRANSFORM`         | a script                     | **An operator** (`CONCAT`, `LEN`, …) over a LIST_CONTAINER of operands; its bindings are now walked. `CLIENT_TRANSFORM_SCRIPT` stays a script.   |
| UIB broker tables (N-29)   | unverified                   | Confirmed: transform / scriptlet / REST / GraphQL extend `sys_ux_data_broker_simple`, which holds every field read.                              |

After the fix every bound prop on the PDI yields a binding expression (none
left without one). Fixed in 912abab. `UibBindingKind` is internal (no
output-schema enum), so tools/list delta 0 B; the `@context` expressions in
opt-in binding detail now carry the category.

## Twelfth pass: response and record sizes (N-57)

Date: 2026-10-13. Same PDI, GETs only. The 11 cases of
`test/response-size.test.js` were run through `runSpec` against the PDI and
measured with `measureResultBytes`; text and structured bytes were equal in
every case.

| Case                             | PDI bytes | Synthetic golden | Note                             |
| -------------------------------- | --------- | ---------------- | -------------------------------- |
| `query_table`, 1 row             | 2,359     | 3,113            |                                  |
| `query_table`, 200 rows          | 2,772     | 2,549            | file result on both              |
| `get_record`                     | 2,329     | 3,073            | `INC0000054`                     |
| `describe_table` incident        | 15,613    | 12,772           | 109 columns                      |
| `get_artifact` business_rule     | 2,310     | 1,355            | longer OOB script                |
| `explain_artifact` business_rule | 1,781     | 1,372            |                                  |
| `aggregate` group_by priority    | 394       | 397              |                                  |
| `list_update_sets`               | 16,004    | 15,255           | 50 rows, truncated               |
| `list_flows`                     | 27,178    | 7,518            | `description` is 20,989 B (77 %) |
| `list_atf_tests`                 | 10,554    | 15,106           |                                  |
| `list_scripts` business_rule     | 16,513    | 15,263           |                                  |

Real record sizes, the 50 newest rows per table, raw Table API JSON with
`exclude_reference_link=true`:

| Table            | Rows | Fields | Bytes min / median / max | Empty share (median) | Omit-empty (median) | `display_value=all` |
| ---------------- | ---- | ------ | ------------------------ | -------------------- | ------------------- | ------------------- |
| `incident`       | 50   | 107    | 2,121 / 2,308 / 2,492    | 65 %                 | 1,066 B (−54 %)     | ×2.65               |
| `change_request` | 31   | 113    | 2,381 / 2,446 / 4,707    | 62 %                 | 1,126 B (−54 %)     | ×2.52               |
| `sys_user`       | 50   | 72     | 1,703 / 1,856 / 2,097    | 38 %                 | 1,386 B (−25 %)     | ×2.36               |
| `cmdb_ci_server` | 41   | 121    | 2,503 / 2,696 / 2,784    | 62 %                 | 1,309 B (−51 %)     | ×2.49               |
| `sys_script`     | 50   | 48     | 1,485 / 1,999 / 9,108    | 27 %                 | 1,770 B (−11 %)     | ×2.27               |

A default `query_table` on `incident` (10 rows, all fields) is 23,518 B.

Findings:

- The synthetic goldens are within 0.7–1.7× of the PDI except `list_flows`.
  They stay synthetic (`synthetic: true`): they pin a deterministic payload,
  not instance data.
- `list_flows` passes each flow's full `description` (about 420 B per flow on
  this PDI, `src/api/flows-designer.ts`). Shortening it is an output change and
  waits for the owner.
- TOKEN-OPTIMIZATION-PLAN §1.3 now carries the measured table. tools/list
  delta 0 B.

## Thirteenth pass: Flow actions, decision tables, playbooks (P-11, P-12, P-17)

Date: 2026-10-13. Same PDI, GETs only (`sys_dictionary`, `sys_db_object`,
Table API reads of the action, decision and `sys_pd_*` tables,
`sys_variable_value`).

| Item                               | Was assumed                                  | Result                                                                                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sys_hub_step_instance` inputs     | a `values` JSON column (registry: `inputs`)  | **Wrong.** No `values` or `comment` column; `inputs` is a `glide_var`. Values are `sys_variable_value` rows (`document` = `sys_hub_step_instance`): 14,698 rows on 3,953 of 3,972 steps. Now read, as format `variables`. |
| Step keying                        | `action` → the action definition             | Confirmed (`action` references `sys_hub_action_type_base`): 1,857 steps under `sys_hub_action_type_definition`, 1,950 under `sys_hub_action_type_snapshot`, 165 orphaned. `label`, `order`, `step_type` exist.            |
| Action root, inputs, outputs       | SDK inventory                                | Confirmed. `name`, `internal_name`, `category`, `access`, `description` are inherited from `sys_hub_action_type_base`; inputs / outputs extend `var_dictionary`, keyed by `model`.                                        |
| Decision tables                    | `sys_decision_input.model`, question columns | Confirmed (61 of 61 inputs, 47 of 47 questions keyed). `answer` is a `document_id`, `default_answer` a boolean.                                                                                                           |
| Playbook tables                    | readers aligned in e1b0aa6                   | Confirmed: 58 definitions, 142 of 143 lanes and 275 of 275 activities keyed. No timer or variant rows on this PDI; their columns exist.                                                                                   |
| `playbook_context` refField        | `process_definition` → the playbook          | **Wrong.** It references `sys_pd_snapshot` (44 of 44 runs); the snapshot's `source` is the playbook. Registry fixed; the explainer already queried `process_definition.source`.                                           |
| Inbound `LIKE` on flow step values | some values may be base64 + gzip             | Every `values` (2,789 action, 4,162 logic) and `subflow_inputs` is base64 + gzip, so the inbound read finds none of them on this PDI. The caveat says so.                                                                 |

Fixed in b2b7b1a. Still open: `kind:"action"` reads the draft definition,
not `sys_hub_action_type_snapshot` (TODO batch-11 (e)). tools/list delta 0 B.

## Fourteenth pass: Service Portal and workflow domain rules (P-19)

Date: 2026-10-13. Same PDI, GETs only (`sys_dictionary`, `sys_db_object`,
Table API reads of the `sp_*`, `sc_cat_item` and `contract_sla` tables, and
one `analyseDomains` run).

| Item                            | Was assumed                                                               | Result                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Widget and page fields          | SDK inventory                                                             | Confirmed: `sp_widget` `id`, `name`, `public`, `script`, `client_script`, `link`, `template`; `sp_page` `id`, `title`, `public`. 557 widgets (111 public, 83 with an empty `id`), 220 pages (6 public). |
| Instance → page chain           | `sp_column.sp_row.sp_container.sp_page`                                   | Confirmed, but only for a top-level row: 750 of 875 instances. 86 sit in a row nested in a column (none deeper), 39 reach no page. **Missed before:** the rule now reads both paths.                    |
| Route maps                      | `route_from_page`, `route_to_page`, `order`, `roles`, `active`, `portals` | Confirmed (`portals` is a glide_list of `sp_portal`). 44 maps, 36 active, none with roles. Whether chained maps apply at run time cannot be checked with GETs; the caveat stays.                        |
| Page references                 | `sp_portal` page columns, `sp_rectangle_menu_item` `sp_page` / `url`      | Confirmed: six page columns on `sp_portal`; 38 menu items name a page, 16 a `url` with `id=`.                                                                                                           |
| Workflow callers                | `sc_cat_item.workflow`, `contract_sla.workflow`                           | Confirmed (both reference `wf_workflow`): 93 catalog items and 33 SLAs name one.                                                                                                                        |
| v2 flow step reads in the sweep | —                                                                         | A long `flowIN` chunk with more rows than the limit answers 400 "Pagination not supported"; the Table API retry without the Link header (7f11293) reads it. Only the first try is logged.               |

Live run: `portal-public-data-widget` 61 scanned / 26 findings,
`portal-orphan-widget` 49, `portal-orphan-page` 83, `portal-route-map-loop`
36 / 0, `workflow-migration-candidate` 126 / 11. The domain-analyser caveat
now names Service Portal and workflow as confirmed. tools/list delta 0 B.

## Next steps

The non-breaking fixes are in (see the re-run above). The four key-field
renames wait for the owner (O-4). The scope-field types need an owner
decision. The plugin-gated tables stay as they are until a PDI with the
plugin can confirm them. The registry `verified` flags are not changed yet.
