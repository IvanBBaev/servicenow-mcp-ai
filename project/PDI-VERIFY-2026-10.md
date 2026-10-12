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

| Commit  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| b7238e5 | `recordDomain` ignores a `global` value in `sys_overrides` (45 business rules on the PDI hold it). Caveats updated where the PDI confirmed them: ACL `admin_overrides`, role-assignment `state` (`active` or empty), the default deny (`glide.sm.default_mode=deny`), the `sys_domain.name` dot-walk, the tables carrying `sys_domain` / `sys_overrides`, `sys_domain_path`, the workspace category sys_id.                                                                                                                                                     |
| b5cb05b | ATF `success_with_warnings` counts as a pass; i18n coverage tables and fields confirmed; `sys_restricted_caller_access.status` is an integer choice, now mapped to `requested` / `denied` / `allowed` / `invalidated` (an output value change).                                                                                                                                                                                                                                                                                                                 |
| 8591ca4 | UI Builder: per-element `eventMappings` are read into the event chains (`origin: "element"`); tools/list delta 0 B.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| bc411b2 | UI Builder data resources: all seven PDI `definition.type` values map to a table (COMPOSITE, CLIENT_STATE, CONTROLLER added); import names with spaces resolve.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7e9718e | Registry GraphQL names confirmed (`sys_graphql_typeresolver` names by `type_name`; `namespace` / `application_namespace`, already fixed in 2bd8a54); broker comments record the confirmed tables. Comments only.                                                                                                                                                                                                                                                                                                                                                |
| 4d794b6 | UI Builder: composition `definition.id` values are `sys_ux_macroponent` sys_ids (17/17 sampled, primitives included), so that table is read first; built-ins whose id equals their type (REPEATER, MACROPONENT_VIEWPORT_HEADLESS) count as `oob` instead of `unresolved`.                                                                                                                                                                                                                                                                                       |
| ba87579 | Privilege and capabilities comments: 8 of 10 elevated roles are visible (`maint` and `security_admin` rows are hidden); the 15 S-4 widened types and their script fields exist. The registry `verified` flags are unchanged.                                                                                                                                                                                                                                                                                                                                    |
| 3adfca6 | Workspace action configurations (N-30): the experience-restricted m2m is `sys_ux_m2m_action_assignment_action_config`, reached from the experience's `actionConfigId` page property; `explain_ui_experience.actionConfigs` is an optional key, tools/list delta 0 B. No dedicated side panel or form config table exists beyond `sys_ux_form_action_layout`.                                                                                                                                                                                                    |
| b1132f1 | Workspace action exclusions (N-30): `sys_workspace_declarative_action_exclusion` has `action_assignment`, `table`, `exclude_self`, `exclude_all_child_tables` and `view` (475 rows, 33 with a view); read into the optional `actionExclusions` key, tools/list delta 0 B.                                                                                                                                                                                                                                                                                       |
| ea2561a | CI/CD Instance Scan routes (N-3, NX-03): plugin `com.glide.continuousdelivery` active; `full_scan`, `point_scan` (`target_table` / `target_sys_id`) and `progress/{id}` match the CICD Spoke REST steps; the plain `suite_scan/{id}` does not exist (400), so `scan_run: "suite"` posts to `suite_scan/combo/{sys_id}` with a `scan_combo` sys_id. Routes checked by GET only (405 = POST route exists), no scan started; tools/list delta 0 B.                                                                                                                 |
| 27f25ee | Workspace action exclusions inherited through `exclude_all_child_tables` (N-30): the parent-table chain is read (cached, depth cap 20, first 25 tables) and inherited rows carry `inheritedFrom`; tools/list delta 0 B.                                                                                                                                                                                                                                                                                                                                         |
| 2ed740a | UI Builder variants (N-27, UX-05): `sys_ux_screen` has no `applicability`; audiences are the m2m `sys_ux_applicability_m2m_screen` (508 rows, 4 inactive, often 2–4 per screen), `applicability.roles` holds `sys_user_role` sys_ids; `sys_ux_app_config` has no `roles`; `screen_condition` is an inline string (156 screens); `sys_ux_screen_condition.active` exists; `admin_panel_table` is `sys_aw_master_config` on 1 page. tools/list delta 0 B.                                                                                                         |
| 7f2b7a0 | A missing table answers the Table API with HTTP 400 "Invalid table <name>", not 404 (an empty query is 200 `[]`). `isAbsentTableError()` reads both as absent: the capability matrix, workspace probe, `document_instance` workspaces, preflight and security-scan reasons; tools/list delta 0 B.                                                                                                                                                                                                                                                               |
| 294fc1f | Table chain dot-walk (N-61): `sys_db_object` answers a six-level `super_class.….name` dot-walk in one request, every level present and empty past the root (`incident` → `task` → ""). `getTableChain` reads six levels per request; the describe-table replay fixture holds one request. tools/list delta 0 B.                                                                                                                                                                                                                                                 |
| 61cdc8d | Field ACL order (N-2): not readable by GET; taken from the ServiceNow docs (ACL rule types): `table.field`, parent `.field`, `*.field`, `table.*`, parent `.*`, `*.*`. The explainer had `*.field` after `table.*`; fixed. tools/list delta 0 B.                                                                                                                                                                                                                                                                                                                |
| 7f11293 | Too-long Table API query (N-26): a big IN list with more rows than the page answers 400 "Pagination not supported" (the Link header URLs cannot be built); with `sysparm_suppress_pagination_header=true` the read works and `X-Total-Count` stays. `queryTable` retries once on that error only. tools/list delta 0 B.                                                                                                                                                                                                                                         |
| 2ae3d3b | UI Builder page map shapes (N-26, UX-02/03/04/06): props, typed bindings, handler targets and component resolution hold on five experiences (cmdb, access-management, admin-center, change-management, calendar-demo-ex); every binding resolved, one dangling component id. Screen audiences come from `sys_ux_applicability_m2m_screen`. tools/list delta 0 B.                                                                                                                                                                                                |
| 52647de | Workspace coverage (N-30): `m2m_app_theme` links a theme to a `sys_ux_app` through `ux_app` (no `app` field; 0 rows on the PDI); an experience names its app in `sys_ux_page_registry.parent_app` (147 experiences) and `sys_ux_app.theme` is the app theme; `sys_declarative_action_definition` has `name` (no `label` / `action_name`); the payload definition has `label` / `action_key` (no `key`); every `sys_declarative_action_assignment` field read exists; `sys_aw_list.title` / `table` and `sys_aw_master_config.name` exist. tools/list delta 0 B. |
| f38f1c7 | `pendingApprovals` names an approval on a non-task record (a scoped app table such as `x_nuvo_com_ecr`) by `source_table` and `document_id`; the `sysapproval.*` dot-walks are empty there. `task_sla` `stage` and `has_breached` are read as stored (a PDI demo SLA shows stage Breached with `has_breached=false`).                                                                                                                                                                                                                                           |

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
- Whether ATF step or suite edits bump `sys_updated_on` / `sys_mod_count`.

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

## Next steps

The non-breaking fixes are in (see the re-run above). The four key-field
renames wait for the owner (O-4). The scope-field types need an owner
decision. The plugin-gated tables stay as they are until a PDI with the
plugin can confirm them. The registry `verified` flags are not changed yet.
