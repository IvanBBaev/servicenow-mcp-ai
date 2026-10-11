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

| Commit  | Change                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| b7238e5 | `recordDomain` ignores a `global` value in `sys_overrides` (45 business rules on the PDI hold it). Caveats updated where the PDI confirmed them: ACL `admin_overrides`, role-assignment `state` (`active` or empty), the default deny (`glide.sm.default_mode=deny`), the `sys_domain.name` dot-walk, the tables carrying `sys_domain` / `sys_overrides`, `sys_domain_path`, the workspace category sys_id. |
| b5cb05b | ATF `success_with_warnings` counts as a pass; i18n coverage tables and fields confirmed; `sys_restricted_caller_access.status` is an integer choice, now mapped to `requested` / `denied` / `allowed` / `invalidated` (an output value change).                                                                                                                                                             |
| 8591ca4 | UI Builder: per-element `eventMappings` are read into the event chains (`origin: "element"`); tools/list delta 0 B.                                                                                                                                                                                                                                                                                         |
| bc411b2 | UI Builder data resources: all seven PDI `definition.type` values map to a table (COMPOSITE, CLIENT_STATE, CONTROLLER added); import names with spaces resolve.                                                                                                                                                                                                                                             |

Gate on the merged tip: 2415/2415, pack 2547.2 KB.

Still unverified after this pass:

- Elevation: the `security_admin` row in `sys_user_role` is hidden from the
  PDI admin's reads (total 1, count 0), so its `elevated_privilege` flag and
  the write gating cannot be checked with GETs.
- The field-ACL fallback order.
- Whether a non-separated instance omits `sys_domain` or returns it empty
  (this PDI is domain-separated).
- Whether ATF step or suite edits bump `sys_updated_on` / `sys_mod_count`.
- Whether a UI Builder composition `definition.id` is a `sys_ux_macroponent`
  sys_id.
- Registry GraphQL names (in progress): `sys_graphql_typeresolver` has no
  `name` column; `schema_namespace` on the GraphQL API does not exist
  (`namespace` / `application_namespace`).

## Next steps

The non-breaking fixes are in (see the re-run above). The four key-field
renames wait for the owner (O-4). The scope-field types need an owner
decision. The plugin-gated tables stay as they are until a PDI with the
plugin can confirm them. The registry `verified` flags are not changed yet.
