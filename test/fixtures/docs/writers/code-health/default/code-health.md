---
sn_generated: true
sn_generator: servicenow_check_code_health
sn_generator_version: 1
sn_kind: code-health
sn_profile: default
sn_instance: dev00000.service-now.com
sn_generated_at: <generatedAt>
sn_source_hash: sha256:df2a14d6cf8b709733269d7903cdf365d426f0d5963ba410582529eef14ea4ff
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

## Security — hardening

Rule table v1: 0 pass, 0 fail (high 0, medium 0, low 0), 18 not set, 0 unreadable.

| Property | Status | Severity | Expected | Value | Rationale |
| --- | --- | --- | --- | --- | --- |
| `glide.security.use_csrf_token` | not_set | high | true | (no row; default true) | Requires an anti-CSRF token on state-changing UI requests. |
| `glide.sm.default_mode` | not_set | high | deny | (no row; default deny) | With no matching ACL the security manager denies access instead of allowing it. |
| `glide.script.use.sandbox` | not_set | high | true | (no row; default true) | Runs client-supplied scripts (filters, ranges) in the restricted script sandbox. |
| `glide.stax.allow_entity_resolution` | not_set | high | false | (no row; default false) | Blocks XML external entity (XXE) resolution in parsed XML. |
| `glide.script.allow.ajaxevaluate` | not_set | high | false | (no row; default unknown) | Stops clients from evaluating arbitrary server-side expressions through AJAXEvaluate. |
| `glide.security.strict_elevate_privilege` | not_set | medium | true | (no row; default unknown) | Elevated-privilege roles grant their access only after the session elevates. |
| `glide.ui.escape_text` | not_set | medium | true | (no row; default true) | Escapes text fields rendered in the UI (stored XSS). |
| `glide.html.escape_script` | not_set | medium | true | (no row; default true) | Escapes script tags in HTML fields (stored XSS). |
| `glide.ui.security.allow_codetags` | not_set | medium | false | (no row; default false) | Disallows [code] tags that render raw HTML in journal fields. |
| `glide.set_x_frame_options` | not_set | medium | true | (no row; default true) | Sends X-Frame-Options so other sites cannot frame the UI (clickjacking). |
| `glide.cookies.http_only` | not_set | medium | true | (no row; default true) | Marks session cookies HttpOnly so page scripts cannot read them. |
| `glide.ui.secure_cookies` | not_set | medium | true | (no row; default unknown) | Marks cookies Secure so they never travel over plain HTTP. |
| `glide.ui.rotate_sessions` | not_set | medium | true | (no row; default unknown) | Issues a new session id at login (session fixation). |
| `glide.security.file.mime_type.validation` | not_set | medium | true | (no row; default unknown) | Checks that an uploaded attachment's content matches its extension. |
| `glide.login.no_blank_password` | not_set | medium | true | (no row; default unknown) | Refuses logins with a blank password. |
| `glide.basicauth.required.scriptedprocessor` | not_set | medium | true | (no row; default true) | Requires authentication for scripted processors. |
| `glide.ui.session_timeout` | not_set | low | ≤ 30 | (no row; default 30) | Ends idle UI sessions within 30 minutes. |
| `glide.ui.forgetme` | not_set | low | true | (no row; default unknown) | Hides the "Remember me" option that keeps a login for days. |

Property names, expected values and defaults are unverified until O-5 (PDI); a property row hidden by its read roles counts as not set.

## Instance Scan

Unavailable: scan_result could not be read (Instance Scan plugin missing or no read role): ServiceNow API error (404): unmocked: /api/now/table/scan_result

## Baseline delta

Baseline recorded in `default/code-health.baseline.json`; the next run reports new and fixed findings.

| Section | Compared | New | Fixed | Unchanged | Partial |
| --- | --- | --- | --- | --- | --- |
| security | recorded | 0 | 0 | 0 | 0 |
