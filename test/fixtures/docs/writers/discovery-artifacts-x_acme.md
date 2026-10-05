---
sn_generated: true
sn_generator: servicenow_document_instance
sn_generator_version: 1
sn_kind: discovery_artifacts
sn_profile: default
sn_instance: dev00000.service-now.com
sn_generated_at: <masked>
sn_source_hash: <masked>
---

# Discovery: artefacts of `x_acme` — profile `default`

Every artefact type this server knows (servicenow_artifact_types), with what this scope has of it and, when nothing was collected, why. [Overview](overview.md) · [Applications](apps.md)

- **Types:** 136
- **Collected:** 12

## Types

| Type | Group | Table | Verified | Collected / not collected and why |
| --- | --- | --- | --- | --- |
| `business_rule` | server | `sys_script` | yes | yes (5) |
| `script_include` | server | `sys_script_include` | yes | yes (1) |
| `client_script` | classic-ui | `sys_script_client` | yes | no — unreadable for this user (ACL or table policy) |
| `ui_policy` | classic-ui | `sys_ui_policy` | yes | yes (1) |
| `ui_action` | classic-ui | `sys_ui_action` | yes | no — unreadable for this user (ACL or table policy) |
| `scheduled_job` | server | `sysauto_script` | yes | no — no records in this scope |
| `transform` | server | `sys_transform_script` | yes | no — no records in this scope |
| `rest_operation` | server | `sys_ws_operation` | yes | no — no records in this scope |
| `acl` | core | `sys_security_acl` | yes | yes (3) |
| `script_action` | server | `sysevent_script_action` | no | no — no records in this scope |
| `transform_map` | server | `sys_transform_map` | no | no — unverified: the instance has no such table |
| `transform_entry` | server | `sys_transform_entry` | no | no — no records in this scope |
| `fix_script` | server | `sys_script_fix` | no | no — no records in this scope |
| `email_script` | server | `sys_script_email` | no | no — no records in this scope |
| `processor` | server | `sys_processor` | no | no — no records in this scope |
| `data_source` | server | `sys_data_source` | no | yes (1) |
| `rest_message_fn` | server | `sys_rest_message_fn` | no | no — no records in this scope |
| `ui_script` | classic-ui | `sys_ui_script` | no | no — no records in this scope |
| `ui_page` | classic-ui | `sys_ui_page` | no | no — unverified: the instance has no such table |
| `ui_macro` | classic-ui | `sys_ui_macro` | no | no — no records in this scope |
| `validation_script` | classic-ui | `sys_script_validator` | no | no — no records in this scope |
| `sp_widget` | portal | `sp_widget` | no | no — no records in this scope |
| `catalog_client_script` | catalog | `catalog_script_client` | no | no — no records in this scope |
| `dictionary_script` | core | `sys_dictionary` | no | no — no records in this scope |
| `rest_api` | server | `sys_ws_definition` | no | yes (1) |
| `table` | core | `sys_db_object` | no | see [tables-x_acme.md](tables-x_acme.md) |
| `choice_set` | core | `sys_choice_set` | no | no — no records in this scope |
| `state_model` | core | `sttrm_model` | no | no — no records in this scope |
| `property` | core | `sys_properties` | no | yes (1) |
| `user_preference` | core | `sys_user_preference` | no | no — no records in this scope |
| `role` | core | `sys_user_role` | no | yes (1) |
| `cross_scope_privilege` | core | `sys_scope_privilege` | no | no — no records in this scope |
| `user_criteria` | core | `user_criteria` | no | no — no records in this scope |
| `field_style` | core | `sys_ui_style` | no | no — no records in this scope |
| `schedule` | core | `cmn_schedule` | no | no — no records in this scope |
| `event` | core | `sysevent_register` | no | no — no records in this scope |
| `relationship` | core | `sys_relationship` | no | no — no records in this scope |
| `ldap_server` | core | `ldap_server_config` | no | no — no records in this scope |
| `js_module` | server | `sys_module` | no | no — no records in this scope |
| `rest_message` | server | `sys_rest_message` | no | yes (1) |
| `graphql_api` | server | `sys_graphql_schema` | no | no — no records in this scope |
| `alias` | server | `sys_alias` | no | no — no records in this scope |
| `alias_template` | server | `sys_alias_templates` | no | no — no records in this scope |
| `retry_policy` | server | `sys_retry_policy` | no | no — no records in this scope |
| `data_lookup` | server | `dl_definition` | no | no — no records in this scope |
| `email_notification` | server | `sysevent_email_action` | no | no — no records in this scope |
| `inbound_email_action` | server | `sysevent_in_email_action` | no | no — no records in this scope |
| `sla` | server | `contract_sla` | no | no — no records in this scope |
| `data_policy` | classic-ui | `sys_data_policy2` | no | no — no records in this scope |
| `workspace_form_action` | classic-ui | `sys_ux_form_action` | no | no — no records in this scope |
| `form` | classic-ui | `sys_ui_form` | no | no — no records in this scope |
| `ui_section` | classic-ui | `sys_ui_section` | no | no — no records in this scope |
| `list` | classic-ui | `sys_ui_list` | no | no — no records in this scope |
| `application_menu` | classic-ui | `sys_app_application` | no | no — no records in this scope |
| `ui_view` | classic-ui | `sys_ui_view` | no | no — no records in this scope |
| `list_control` | classic-ui | `sys_ui_list_control` | no | no — no records in this scope |
| `workspace` | next-experience | `sys_ux_page_registry` | no | no — no records in this scope |
| `dashboard` | next-experience | `par_dashboard` | no | no — no records in this scope |
| `ux_list_menu_config` | next-experience | `sys_ux_list_menu_config` | no | no — no records in this scope |
| `ux_applicability` | next-experience | `sys_ux_applicability` | no | no — no records in this scope |
| `uib_app_config` | uib | `sys_ux_app_config` | no | no — no records in this scope |
| `uib_route` | uib | `sys_ux_app_route` | no | no — no records in this scope |
| `uib_screen_type` | uib | `sys_ux_screen_type` | no | no — no records in this scope |
| `uib_screen` | uib | `sys_ux_screen` | no | no — no records in this scope |
| `uib_macroponent` | uib | `sys_ux_macroponent` | no | no — no records in this scope |
| `uib_client_script` | uib | `sys_ux_client_script` | no | no — no records in this scope |
| `uib_client_script_include` | uib | `sys_ux_client_script_include` | no | no — no records in this scope |
| `uib_data_broker_transform` | uib | `sys_ux_data_broker_transform` | no | no — no records in this scope |
| `uib_data_broker_scriptlet` | uib | `sys_ux_data_broker_scriptlet` | no | no — no records in this scope |
| `uib_event` | uib | `sys_ux_event` | no | no — no records in this scope |
| `uib_component` | uib | `sys_ux_lib_component` | no | no — no records in this scope |
| `uib_theme` | uib | `sys_ux_theme` | no | no — no records in this scope |
| `uib_style` | uib | `sys_ux_style` | no | no — no records in this scope |
| `uib_form_action` | uib | `sys_ux_form_action` | no | no — no records in this scope |
| `uib_form_action_layout` | uib | `sys_ux_form_action_layout` | no | no — no records in this scope |
| `uib_composite_definition` | uib | `sys_ux_composite_definition` | no | no — no records in this scope |
| `uib_data_broker_rest` | uib | `sys_ux_data_broker_rest` | no | no — no records in this scope |
| `uib_data_broker_graphql` | uib | `sys_ux_data_broker_graphql` | no | no — no records in this scope |
| `ux_declarative_action` | uib | `sys_declarative_action_assignment` | no | no — no records in this scope |
| `ux_declarative_action_definition` | uib | `sys_declarative_action_definition` | no | no — no records in this scope |
| `ux_declarative_action_payload` | uib | `sys_declarative_action_payload_definition` | no | no — no records in this scope |
| `uib_app_theme` | uib | `m2m_app_theme` | no | no — no records in this scope |
| `aw_master_config` | uib | `sys_aw_master_config` | no | no — no records in this scope |
| `aw_list` | uib | `sys_aw_list` | no | no — no records in this scope |
| `sp_portal` | portal | `sp_portal` | no | no — no records in this scope |
| `sp_page` | portal | `sp_page` | no | no — no records in this scope |
| `sp_ng_template` | portal | `sp_ng_template` | no | no — no records in this scope |
| `sp_dependency` | portal | `sp_dependency` | no | no — no records in this scope |
| `sp_angular_provider` | portal | `sp_angular_provider` | no | no — no records in this scope |
| `sp_js_include` | portal | `sp_js_include` | no | no — no records in this scope |
| `sp_css_include` | portal | `sp_css_include` | no | no — no records in this scope |
| `sp_theme` | portal | `sp_theme` | no | no — no records in this scope |
| `sp_menu` | portal | `sp_instance_menu` | no | no — no records in this scope |
| `sp_header_footer` | portal | `sp_header_footer` | no | no — no records in this scope |
| `sp_page_route_map` | portal | `sp_page_route_map` | no | no — no records in this scope |
| `sp_css` | portal | `sp_css` | no | no — no records in this scope |
| `sp_search_source` | portal | `sp_search_source` | no | no — no records in this scope |
| `flow` | flow | `sys_hub_flow` | no | no — no records in this scope |
| `subflow` | flow | `sys_hub_flow` | no | no — no records in this scope |
| `flow_action` | flow | `sys_hub_action_type_definition` | no | no — no records in this scope |
| `flow_trigger_definition` | flow | `sys_hub_trigger_definition` | no | no — no records in this scope |
| `flow_context` | flow | `sys_flow_context` | no | no — no records in this scope |
| `playbook` | flow | `sys_pd_process_definition` | no | no — no records in this scope |
| `playbook_context` | flow | `sys_pd_context` | no | no — no records in this scope |
| `decision_table` | flow | `sys_decision` | no | no — no records in this scope |
| `workflow` | workflow | `wf_workflow` | no | no — no records in this scope |
| `workflow_activity_definition` | workflow | `wf_activity_definition` | no | no — no records in this scope |
| `workflow_context` | workflow | `wf_context` | no | no — no records in this scope |
| `catalog_item` | catalog | `sc_cat_item` | no | yes (2) |
| `record_producer` | catalog | `sc_cat_item_producer` | no | no — no records in this scope |
| `variable_set` | catalog | `item_option_new_set` | no | no — no records in this scope |
| `catalog_variable` | catalog | `item_option_new` | no | yes (3) |
| `catalog_ui_policy` | catalog | `catalog_ui_policy` | no | no — no records in this scope |
| `atf_test` | quality | `sys_atf_test` | no | no — no records in this scope |
| `atf_test_suite` | quality | `sys_atf_test_suite` | no | no — no records in this scope |
| `linter_check` | quality | `scan_linter_check` | no | no — no records in this scope |
| `script_only_check` | quality | `scan_script_only_check` | no | no — no records in this scope |
| `column_type_check` | quality | `scan_column_type_check` | no | no — no records in this scope |
| `table_check` | quality | `scan_table_check` | no | no — no records in this scope |
| `assessment` | quality | `asmt_metric_type` | no | no — no records in this scope |
| `risk_assessment` | quality | `change_risk_asmt` | no | no — no records in this scope |
| `ai_agent` | ai | `sn_aia_agent` | no | no — no records in this scope |
| `ai_agentic_workflow` | ai | `sn_aia_usecase` | no | no — no records in this scope |
| `now_assist_skill` | ai | `sn_nowassist_skill_config` | no | no — no records in this scope |
| `application` | application | `sys_app` | no | yes (1) |
| `app_dependency` | application | `sys_scope_dependency` | no | no — no records in this scope |
| `customer_update` | application | `sys_update_xml` | no | no — no records in this scope |
| `source_control` | application | `sys_repo_config` | no | no — no records in this scope |
| `report` | reporting | `sys_report` | no | no — no records in this scope |
| `report_source` | reporting | `sys_report_source` | no | no — no records in this scope |
| `pa_indicator` | reporting | `pa_indicators` | no | no — no records in this scope |
| `pa_indicator_source` | reporting | `pa_cubes` | no | no — no records in this scope |
| `pa_breakdown` | reporting | `pa_breakdowns` | no | no — no records in this scope |
| `pa_script` | reporting | `pa_scripts` | no | no — no records in this scope |
| `pa_dashboard` | reporting | `pa_dashboards` | no | no — no records in this scope |
| `database_view` | core | `sys_db_view` | no | no — no records in this scope |

## core

### `acl`

| name | active | sdkManaged | operation | type | admin_overrides |
| --- | --- | --- | --- | --- | --- |
| incident | true | unknown | read | record | true |
| incident.caller_id | true | unknown | write | record | true |
| incident_task | true | unknown | read | record | true |

### `property`

| name | sdkManaged | type | is_private | read_roles | write_roles |
| --- | --- | --- | --- | --- | --- |
| x_acme.api_token | unknown | password2 |  |  |  |

### `role`

| name | sdkManaged | elevated_privilege | assignable_by | description |
| --- | --- | --- | --- | --- |
| x_acme.admin | unknown | false |  | Administers requests |

## server

### `business_rule`

| name | active | sdkManaged | collection | global | when | order | condition |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Validate caller | true | unknown | incident | false | before | 100 |  |
| Notify assignee | true | unknown | incident | false | after | 200 |  |
| Sync to CMDB | true | unknown | incident | false | async | 300 |  |
| Show SLA | true | unknown | incident | false | display | 100 |  |
| Default step order | true | unknown | x_acme_step |  | before | 100 |  |

### `script_include`

| name | key | active | sdkManaged | api_name | client_callable | access |
| --- | --- | --- | --- | --- | --- | --- |
| AcmeUtils | x_acme.AcmeUtils | true | unknown | x_acme.AcmeUtils | false | package_private |

### `data_source`

| name | sdkManaged | type | format | import_set_table_name |
| --- | --- | --- | --- | --- |
| HR feed | unknown | File | CSV | u_hr_import |

### `rest_api`

| name | active | sdkManaged |
| --- | --- | --- |
| Acme Orders | true | unknown |

### `rest_message`

| name | sdkManaged | rest_endpoint | authentication_type | use_mid_server |
| --- | --- | --- | --- | --- |
| Weather | unknown | https://api.example.com/weather | no_authentication |  |

## classic-ui

### `ui_policy`

| name | active | sdkManaged | table | run_scripts |
| --- | --- | --- | --- | --- |
| Caller mandatory on new | true | unknown | incident |  |

## catalog

### `catalog_item`

| name | active | sdkManaged | sys_class_name | category | sc_catalogs | order |
| --- | --- | --- | --- | --- | --- | --- |
| Request access | true | unknown | sc_cat_item_producer |  | 22222222222222222222222222222222 |  |
| Standard laptop | true | unknown | sc_cat_item | 44444444444444444444444444444444 | 11111111111111111111111111111111,22222222222222222222222222222222 |  |

### `catalog_variable`

| name | active | sdkManaged | question_text | type | order | mandatory | cat_item | variable_set |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| justification | true | unknown | Why do you need it? | 2 | 200 | true | 55555555555555555555555555555555 |  |
| model | true | unknown | Model | 5 | 100 | false | 55555555555555555555555555555555 |  |
| role | true | unknown | Role \| level | 8 | 100 | true | 66666666666666666666666666666666 |  |

## application

### `application`

| name | key | active | sdkManaged | scope | version | vendor |
| --- | --- | --- | --- | --- | --- | --- |
| Acme Requests | x_acme | true | unknown |  | 1.2.0 |  |

## Caveats

- Property and preference values and descriptor secret fields are left out.
- Discovery files are thin renderings of the same data the other documents of this profile use; re-run with the same depth to refresh them.
- Visibility: every read runs as this profile's user. On a domain-separated instance only the records of the user's domain (and its visible parents) are seen, and ACLs can hide definitions, so an absent entry is not proof that none exists.
- Metadata only: built from dictionary, automation and access-control definitions; no business records were read.
