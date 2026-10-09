# `codecheck` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

3 tools (2 read-only, 1 write). Opt-in: add `codecheck` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_lint_script`](#servicenow_lint_script) | yes | Lint a script |
| [`servicenow_lint_table`](#servicenow_lint_table) | yes | Lint a table's scripts |
| [`servicenow_check_code_health`](#servicenow_check_code_health) | no | Code health report |

## servicenow_lint_script

**Lint a script.** Run deterministic code-quality rules on one script (hard-coded sys_ids, unbounded or in-loop GlideRecord, eval, …): findings with rule, severity, line, fix hint.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `type` | "business_rule" \| "script_include" \| "client_script" \| "ui_policy" \| "ui_action" \| "scheduled_job" \| "transform" \| "rest_operation" \| "acl" \| "script_action" \| "transform_map" \| "transform_entry" \| "fix_script" \| "email_script" \| "processor" \| "data_source" \| "rest_message_fn" \| "ui_script" \| "ui_page" \| "ui_macro" \| "validation_script" \| "sp_widget" \| "catalog_client_script" \| "dictionary_script" \| "graphql_resolver" \| "graphql_type_resolver" \| "uib_client_script" \| "uib_client_script_include" \| "uib_data_broker_transform" \| "uib_data_broker_scriptlet" \| "sp_ng_template" \| "sp_angular_provider" \| "sp_theme" \| "sp_css" \| "sp_search_source" | yes | Script type (default and opt-in types). |
| `sys_id` | string | yes | Script sys_id. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `type` | string |  |
| `sys_id` | string |  |
| `results` | any[] |  |

## servicenow_lint_table

**Lint a table's scripts.** Lint every active business rule, client script and UI policy of a table: per-script findings and a severity summary.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table to lint, e.g. 'incident'. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `table` | string |  |
| `scriptCount` | number |  |
| `findingCount` | number |  |
| `results` | any[] |  |
| `warnings` | any[] |  |

## servicenow_check_code_health

**Code health report.** Code-health report: script counts, ACL scan, table lint, new/fixed findings vs baseline. Writes <profile>/code-health.md.

**Writes:** Write, idempotent. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `scope` | string | no | Table to lint; omit for an instance-wide inventory. |
| `extended` | boolean | no | Also count opt-in types and lint every script type instance-wide (newest `limit`). |
| `limit` | integer | no | Records per type for extended, candidates per rule for domains (default 50). |
| `domains` | boolean | no | Also run the flow, portal, UI Builder and legacy-workflow analysers. |
| `update_baseline` | boolean | no | Reset the baseline to this run; otherwise new/fixed findings are reported against it. |
| `scan_run` | "full" \| "point" \| "suite" | no | Run Instance Scan; point: scope+sys_id, suite: sys_id. |
| `sys_id` | string | no | Its target. |
| `apply` | boolean | no | true runs it. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `scope` | string |  |
| `generatedAt` | string |  |
| `reportFile` | string |  |
| `warnings` | any[] |  |
