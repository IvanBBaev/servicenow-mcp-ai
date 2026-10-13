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

- **Types:** 144
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
| `script_action` | server | `sysevent_script_action` | yes | no — no records in this scope |
| `transform_map` | server | `sys_transform_map` | yes | no — unreadable for this user (ACL or table policy) |
| `transform_entry` | server | `sys_transform_entry` | yes | no — no records in this scope |
| `fix_script` | server | `sys_script_fix` | yes | no — no records in this scope |
| `email_script` | server | `sys_script_email` | yes | no — no records in this scope |
| `processor` | server | `sys_processor` | yes | no — no records in this scope |
| `data_source` | server | `sys_data_source` | yes | yes (1) |
| `rest_message_fn` | server | `sys_rest_message_fn` | yes | no — no records in this scope |
| `ui_script` | classic-ui | `sys_ui_script` | yes | no — no records in this scope |
| `ui_page` | classic-ui | `sys_ui_page` | yes | no — no records in this scope |
| `ui_macro` | classic-ui | `sys_ui_macro` | yes | no — no records in this scope |
| `validation_script` | classic-ui | `sys_script_validator` | yes | no — no records in this scope |
| `sp_widget` | portal | `sp_widget` | yes | no — no records in this scope |
| `catalog_client_script` | catalog | `catalog_script_client` | yes | no — no records in this scope |
| `dictionary_script` | core | `sys_dictionary` | yes | no — no records in this scope |
| `rest_api` | server | `sys_ws_definition` | yes | yes (1) |
| `table` | core | `sys_db_object` | yes | see [tables-x_acme.md](tables-x_acme.md) |
| `choice_set` | core | `sys_choice_set` | yes | no — no records in this scope |
| `state_model` | core | `sttrm_model` | yes | no — no records in this scope |
| `property` | core | `sys_properties` | yes | yes (1) |
| `user_preference` | core | `sys_user_preference` | yes | no — no application scope column (OD-2) |
| `role` | core | `sys_user_role` | yes | yes (1) |
| `cross_scope_privilege` | core | `sys_scope_privilege` | yes | no — no records in this scope |
| `user_criteria` | core | `user_criteria` | yes | no — no records in this scope |
| `assignment_rule` | core | `sysrule_assignment` | yes | no — no records in this scope |
| `knowledge_base` | core | `kb_knowledge_base` | yes | no — no application scope column (OD-2) |
| `security_attribute` | core | `sys_security_attribute` | yes | no — no records in this scope |
| `security_data_filter` | core | `sys_security_data_filter` | yes | no — no records in this scope |
| `field_style` | core | `sys_ui_style` | yes | no — no records in this scope |
| `schedule` | core | `cmn_schedule` | yes | no — no records in this scope |
| `event` | core | `sysevent_register` | yes | no — no records in this scope |
| `relationship` | core | `sys_relationship` | yes | no — no records in this scope |
| `ldap_server` | core | `ldap_server_config` | yes | no — no records in this scope |
| `js_module` | server | `sys_module` | yes | no — no records in this scope |
| `rest_message` | server | `sys_rest_message` | yes | yes (1) |
| `graphql_api` | server | `sys_graphql_schema` | yes | no — no records in this scope |
| `graphql_resolver` | server | `sys_graphql_resolver` | yes | no — no records in this scope |
| `graphql_type_resolver` | server | `sys_graphql_typeresolver` | yes | no — no records in this scope |
| `alias` | server | `sys_alias` | yes | no — the instance has no such table (plugin not installed) |
| `alias_template` | server | `sys_alias_templates` | yes | no — no records in this scope |
| `retry_policy` | server | `sys_retry_policy` | yes | no — no records in this scope |
| `data_lookup` | server | `dl_definition` | yes | no — no records in this scope |
| `email_notification` | server | `sysevent_email_action` | yes | no — no records in this scope |
| `inbound_email_action` | server | `sysevent_in_email_action` | yes | no — no records in this scope |
| `sla` | server | `contract_sla` | yes | no — no records in this scope |
| `data_policy` | classic-ui | `sys_data_policy2` | yes | no — no records in this scope |
| `workspace_form_action` | classic-ui | `sys_ux_form_action` | no | no — no records in this scope |
| `form` | classic-ui | `sys_ui_form` | yes | no — no records in this scope |
| `ui_section` | classic-ui | `sys_ui_section` | yes | no — no records in this scope |
| `formatter` | classic-ui | `sys_ui_formatter` | yes | no — no records in this scope |
| `list` | classic-ui | `sys_ui_list` | yes | no — no records in this scope |
| `application_menu` | classic-ui | `sys_app_application` | yes | no — no records in this scope |
| `interceptor` | classic-ui | `sys_wizard` | yes | no — no records in this scope |
| `ui_view` | classic-ui | `sys_ui_view` | yes | no — no records in this scope |
| `list_control` | classic-ui | `sys_ui_list_control` | yes | no — no records in this scope |
| `workspace` | next-experience | `sys_ux_page_registry` | yes | no — no records in this scope |
| `dashboard` | next-experience | `par_dashboard` | yes | no — no records in this scope |
| `ux_list_menu_config` | next-experience | `sys_ux_list_menu_config` | yes | no — no records in this scope |
| `ux_applicability` | next-experience | `sys_ux_applicability` | yes | no — no records in this scope |
| `uib_app_config` | uib | `sys_ux_app_config` | yes | no — no records in this scope |
| `uib_route` | uib | `sys_ux_app_route` | yes | no — no records in this scope |
| `uib_screen_type` | uib | `sys_ux_screen_type` | yes | no — no records in this scope |
| `uib_screen` | uib | `sys_ux_screen` | yes | no — no records in this scope |
| `uib_macroponent` | uib | `sys_ux_macroponent` | yes | no — no records in this scope |
| `uib_client_script` | uib | `sys_ux_client_script` | yes | no — no records in this scope |
| `uib_client_script_include` | uib | `sys_ux_client_script_include` | yes | no — no records in this scope |
| `uib_data_broker_transform` | uib | `sys_ux_data_broker_transform` | yes | no — no records in this scope |
| `uib_data_broker_scriptlet` | uib | `sys_ux_data_broker_scriptlet` | yes | no — no records in this scope |
| `uib_event` | uib | `sys_ux_event` | yes | no — no records in this scope |
| `uib_component` | uib | `sys_ux_lib_component` | yes | no — no records in this scope |
| `uib_theme` | uib | `sys_ux_theme` | yes | no — no records in this scope |
| `uib_style` | uib | `sys_ux_style` | yes | no — no records in this scope |
| `uib_form_action` | uib | `sys_ux_form_action` | no | no — no records in this scope |
| `uib_form_action_layout` | uib | `sys_ux_form_action_layout` | yes | no — no records in this scope |
| `uib_composite_definition` | uib | `sys_ux_composite_definition` | no | no — no records in this scope |
| `uib_data_broker_rest` | uib | `sys_ux_data_broker_rest` | yes | no — no records in this scope |
| `uib_data_broker_graphql` | uib | `sys_ux_data_broker_graphql` | yes | no — no records in this scope |
| `ux_declarative_action` | uib | `sys_declarative_action_assignment` | yes | no — no records in this scope |
| `ux_declarative_action_definition` | uib | `sys_declarative_action_definition` | yes | no — no records in this scope |
| `ux_declarative_action_payload` | uib | `sys_declarative_action_payload_definition` | yes | no — no records in this scope |
| `uib_app_theme` | uib | `m2m_app_theme` | yes | no — no records in this scope |
| `aw_master_config` | uib | `sys_aw_master_config` | yes | no — no records in this scope |
| `aw_list` | uib | `sys_aw_list` | yes | no — no records in this scope |
| `sp_portal` | portal | `sp_portal` | yes | no — no records in this scope |
| `sp_page` | portal | `sp_page` | yes | no — no records in this scope |
| `sp_ng_template` | portal | `sp_ng_template` | yes | no — no records in this scope |
| `sp_dependency` | portal | `sp_dependency` | yes | no — no records in this scope |
| `sp_angular_provider` | portal | `sp_angular_provider` | yes | no — no records in this scope |
| `sp_js_include` | portal | `sp_js_include` | yes | no — no records in this scope |
| `sp_css_include` | portal | `sp_css_include` | yes | no — no records in this scope |
| `sp_theme` | portal | `sp_theme` | yes | no — no records in this scope |
| `sp_menu` | portal | `sp_instance_menu` | yes | no — no records in this scope |
| `sp_header_footer` | portal | `sp_header_footer` | yes | no — no records in this scope |
| `sp_page_route_map` | portal | `sp_page_route_map` | yes | no — no records in this scope |
| `sp_css` | portal | `sp_css` | yes | no — no records in this scope |
| `sp_search_source` | portal | `sp_search_source` | yes | no — no records in this scope |
| `flow` | flow | `sys_hub_flow` | yes | no — no records in this scope |
| `subflow` | flow | `sys_hub_flow` | yes | no — no records in this scope |
| `flow_action` | flow | `sys_hub_action_type_definition` | yes | no — no records in this scope |
| `flow_trigger_definition` | flow | `sys_hub_trigger_definition` | yes | no — no records in this scope |
| `flow_context` | flow | `sys_flow_context` | yes | no — no application scope column (OD-2) |
| `playbook` | flow | `sys_pd_process_definition` | yes | no — no records in this scope |
| `playbook_context` | flow | `sys_pd_context` | yes | no — no application scope column (OD-2) |
| `decision_table` | flow | `sys_decision` | yes | no — no records in this scope |
| `workflow` | workflow | `wf_workflow` | yes | no — no records in this scope |
| `workflow_activity_definition` | workflow | `wf_activity_definition` | yes | no — no records in this scope |
| `workflow_context` | workflow | `wf_context` | yes | no — no application scope column (OD-2) |
| `catalog_item` | catalog | `sc_cat_item` | yes | yes (2) |
| `record_producer` | catalog | `sc_cat_item_producer` | yes | no — no records in this scope |
| `variable_set` | catalog | `item_option_new_set` | yes | no — no records in this scope |
| `catalog_variable` | catalog | `item_option_new` | yes | yes (4) |
| `catalog_ui_policy` | catalog | `catalog_ui_policy` | yes | no — no records in this scope |
| `atf_test` | quality | `sys_atf_test` | yes | no — no records in this scope |
| `atf_test_suite` | quality | `sys_atf_test_suite` | yes | no — no records in this scope |
| `linter_check` | quality | `scan_linter_check` | yes | no — no records in this scope |
| `script_only_check` | quality | `scan_script_only_check` | yes | no — no records in this scope |
| `column_type_check` | quality | `scan_column_type_check` | yes | no — no records in this scope |
| `table_check` | quality | `scan_table_check` | yes | no — no records in this scope |
| `assessment` | quality | `asmt_metric_type` | yes | no — no records in this scope |
| `risk_assessment` | quality | `change_risk_asmt` | no | no — no records in this scope |
| `ai_agent` | ai | `sn_aia_agent` | yes | no — no records in this scope |
| `ai_agentic_workflow` | ai | `sn_aia_usecase` | yes | no — no records in this scope |
| `now_assist_skill` | ai | `sn_nowassist_skill_config` | yes | no — no records in this scope |
| `application` | application | `sys_app` | no | yes (1) |
| `app_dependency` | application | `sys_scope_dependency` | no | no — no records in this scope |
| `customer_update` | application | `sys_update_xml` | yes | no — no records in this scope |
| `source_control` | application | `sys_repo_config` | yes | no — no application scope column (OD-2) |
| `report` | reporting | `sys_report` | yes | no — no records in this scope |
| `report_source` | reporting | `sys_report_source` | yes | no — no records in this scope |
| `pa_indicator` | reporting | `pa_indicators` | yes | no — no records in this scope |
| `pa_indicator_source` | reporting | `pa_cubes` | yes | no — no records in this scope |
| `pa_breakdown` | reporting | `pa_breakdowns` | yes | no — no records in this scope |
| `pa_script` | reporting | `pa_scripts` | yes | no — no records in this scope |
| `pa_dashboard` | reporting | `pa_dashboards` | yes | no — no records in this scope |
| `database_view` | core | `sys_db_view` | yes | no — no records in this scope |

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

| name | active | sdkManaged | collection | when | order | condition |
| --- | --- | --- | --- | --- | --- | --- |
| Validate caller | true | unknown | incident | before | 100 |  |
| Notify assignee | true | unknown | incident | after | 200 |  |
| Sync to CMDB | true | unknown | incident | async | 300 |  |
| Show SLA | true | unknown | incident | display | 100 |  |
| Default step order | true | unknown | x_acme_step | before | 100 |  |

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

| name | sdkManaged | rest_endpoint | authentication_type |
| --- | --- | --- | --- |
| Weather | unknown | https://api.example.com/weather | no_authentication |

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
| picker | true | unknown | Picker | 14 | 200 | false | 66666666666666666666666666666666 |  |
| role | true | unknown | Role \| level | 8 | 100 | true | 66666666666666666666666666666666 |  |

## application

### `application`

| name | key | active | sdkManaged | scope | version | vendor |
| --- | --- | --- | --- | --- | --- | --- |
| Acme Requests | x_acme |  | unknown |  | 1.2.0 | Acme |

## Caveats

- Property and preference values and descriptor secret fields are left out.
- Discovery files are thin renderings of the same data the other documents of this profile use; re-run with the same depth to refresh them.
- Visibility: every read runs as this profile's user. On a domain-separated instance only the records of the user's domain (and its visible parents) are seen, and ACLs can hide definitions, so an absent entry is not proof that none exists.
- Metadata only: built from dictionary, automation and access-control definitions; no business records were read.
