---
sn_generated: true
sn_generator: servicenow_code_health
sn_generator_version: 1
sn_kind: code-health
sn_profile: default
sn_instance: dev00000.service-now.com
sn_generated_at: <generatedAt>
sn_source_hash: sha256:77f7724a532666d3bcf897c318e85d6df9ca52b1aa00b392f13da1fc6b965f56
---

# Code health — profile `default`

Generated <generatedAt>.

## Script inventory

| Type | Table | Count |
| --- | --- | --- |
| business_rule | sys_script | 5 |
| script_include | sys_script_include | 5 |
| client_script | sys_script_client | 5 |
| ui_policy | sys_ui_policy | 5 |
| ui_action | sys_ui_action | 5 |
| scheduled_job | sysauto_script | 5 |
| transform | sys_transform_script | 5 |
| rest_operation | sys_ws_operation | 5 |
| acl | sys_security_acl | 5 |
| script_action | sysevent_script_action | 5 |
| transform_map | sys_transform_map | 5 |
| transform_entry | sys_transform_entry | 5 |
| fix_script | sys_script_fix | 5 |
| email_script | sys_script_email | 5 |
| processor | sys_processor | 5 |
| data_source | sys_data_source | 5 |
| rest_message_fn | sys_rest_message_fn | 5 |
| ui_script | sys_ui_script | 5 |
| ui_page | sys_ui_page | 5 |
| ui_macro | sys_ui_macro | 5 |
| validation_script | sys_script_validator | 5 |
| sp_widget | sp_widget | 5 |
| catalog_client_script | catalog_script_client | 5 |
| dictionary_script | sys_dictionary | 0 |

## Security — ACL scan

1 active ACLs scanned · 1 findings (error 0 · warn 1 · info 0).

| Check | Status | Scanned | Findings |
| --- | --- | --- | --- |
| acl_roles | unavailable — sys_security_acl_role does not exist on this instance or is not exposed (HTTP 404). | 0 | 0 |
| role_inheritance | unavailable — sys_user_role_contains does not exist on this instance or is not exposed (HTTP 404). | 0 | 0 |
| public_rest_resources | unavailable — sys_ws_operation does not exist on this instance or is not exposed (HTTP 404). | 0 | 0 |
| public_ui_pages | unavailable — sys_public does not exist on this instance or is not exposed (HTTP 404). | 0 | 0 |
| tables_without_acl | ok | 2 | 1 |
| admin_overlap_roles | unavailable — sys_user_role_contains does not exist on this instance or is not exposed (HTTP 404). | 0 | 0 |
| elevated_privilege_acls | unavailable — sys_security_acl_role does not exist on this instance or is not exposed (HTTP 404). | 0 | 0 |

| Item | Operation | Rule | Severity |
| --- | --- | --- | --- |
| task |  | table-no-acl | warn |
