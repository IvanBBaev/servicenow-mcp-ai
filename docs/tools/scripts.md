# `scripts` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

5 tools (5 read-only, 0 write). Opt-in: add `scripts` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_scripts`](#servicenow_list_scripts) | yes | List ServiceNow scripts |
| [`servicenow_get_script`](#servicenow_get_script) | yes | Get ServiceNow script |
| [`servicenow_search_code`](#servicenow_search_code) | yes | Search ServiceNow code |
| [`servicenow_describe_table_logic`](#servicenow_describe_table_logic) | yes | Explain ServiceNow table logic |
| [`servicenow_where_used`](#servicenow_where_used) | yes | Where used |

## servicenow_list_scripts

**List ServiceNow scripts.** List script artefacts of one type as metadata (no source). Filter by table, name, active or encoded query.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `type` | "business_rule" \| "script_include" \| "client_script" \| "ui_policy" \| "ui_action" \| "scheduled_job" \| "transform" \| "rest_operation" \| "acl" \| "script_action" \| "transform_map" \| "transform_entry" \| "fix_script" \| "email_script" \| "processor" \| "data_source" \| "rest_message_fn" \| "ui_script" \| "ui_page" \| "ui_macro" \| "validation_script" \| "sp_widget" \| "catalog_client_script" \| "dictionary_script" \| "uib_client_script" \| "uib_client_script_include" \| "uib_data_broker_transform" \| "uib_data_broker_scriptlet" \| "sp_ng_template" \| "sp_angular_provider" \| "sp_theme" \| "sp_css" \| "sp_search_source" | yes | Script type; opt-in (read only when named): uib_client_script, uib_client_script_include, uib_data_broker_transform, uib_data_broker_scriptlet, sp_ng_template, sp_angular_provider, sp_theme, sp_css, sp_search_source. |
| `table` | string | no | Applied table (types that have one). |
| `name` | string | no | Case-insensitive name fragment. |
| `active` | boolean | no | Filter by the active flag. |
| `query` | string | no | Encoded query ANDed with the filters. |
| `limit` | integer | no | Max rows (default 50). |
| `offset` | integer | no | Rows to skip (paging). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `type` | string |  |
| `count` | number |  |
| `scripts` | any[] |  |

## servicenow_get_script

**Get ServiceNow script.** Read one script artefact in full: source code and execution context.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `type` | "business_rule" \| "script_include" \| "client_script" \| "ui_policy" \| "ui_action" \| "scheduled_job" \| "transform" \| "rest_operation" \| "acl" \| "script_action" \| "transform_map" \| "transform_entry" \| "fix_script" \| "email_script" \| "processor" \| "data_source" \| "rest_message_fn" \| "ui_script" \| "ui_page" \| "ui_macro" \| "validation_script" \| "sp_widget" \| "catalog_client_script" \| "dictionary_script" \| "uib_client_script" \| "uib_client_script_include" \| "uib_data_broker_transform" \| "uib_data_broker_scriptlet" \| "sp_ng_template" \| "sp_angular_provider" \| "sp_theme" \| "sp_css" \| "sp_search_source" | yes | Script type; opt-in (read only when named): uib_client_script, uib_client_script_include, uib_data_broker_transform, uib_data_broker_scriptlet, sp_ng_template, sp_angular_provider, sp_theme, sp_css, sp_search_source. |
| `sys_id` | string | yes | Script sys_id. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `type` | string |  |
| `table` | string |  |
| `record` | any |  |

## servicenow_search_code

**Search ServiceNow code.** Search script source for a literal substring across one or all script types. One entry per artefact: a snippet plus matching lines with one line of context (max 20; hitCount is the total), not whole scripts. Answers 'where is X used?'.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `text` | string | yes | Substring to search for. |
| `type` | "business_rule" \| "script_include" \| "client_script" \| "ui_policy" \| "ui_action" \| "scheduled_job" \| "transform" \| "rest_operation" \| "acl" \| "script_action" \| "transform_map" \| "transform_entry" \| "fix_script" \| "email_script" \| "processor" \| "data_source" \| "rest_message_fn" \| "ui_script" \| "ui_page" \| "ui_macro" \| "validation_script" \| "sp_widget" \| "catalog_client_script" \| "dictionary_script" \| "uib_client_script" \| "uib_client_script_include" \| "uib_data_broker_transform" \| "uib_data_broker_scriptlet" \| "sp_ng_template" \| "sp_angular_provider" \| "sp_theme" \| "sp_css" \| "sp_search_source" | no | One type; opt-in (read only when named): uib_client_script, uib_client_script_include, uib_data_broker_transform, uib_data_broker_scriptlet, sp_ng_template, sp_angular_provider, sp_theme, sp_css, sp_search_source. |
| `table` | string | no | Only scripts applied to this table. |
| `scope` | string | no | One scope: namespace (e.g. 'x_acme_app') or sys_id. |
| `limit` | integer | no | Max matches over all types (default 50). |
| `extended` | boolean | no | Without 'type': also search the opt-in types after the default ones (default false). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `count` | number |  |
| `matches` | any[] |  |
| `unreadable` | any[] |  |

## servicenow_describe_table_logic

**Explain ServiceNow table logic.** The automation on a table: business rules (by when+order), client scripts, UI policies, UI actions, ACLs. Metadata only.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table to analyse, e.g. 'incident'. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `table` | string |  |
| `businessRules` | any[] |  |
| `clientScripts` | any[] |  |
| `uiPolicies` | any[] |  |
| `uiActions` | any[] |  |
| `acls` | any[] |  |

## servicenow_where_used

**Where used.** Find references to a table, field (table.field) or script: matching script lines, rules/ACLs on a table, structural config (reference fields, layouts, variables, flow inputs, reports). Optional scope and Mermaid graph.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `kind` | "table" \| "field" \| "script" | yes | A table, a field, or a script/script-include name (also a UIB component, macroponent or broker sys_id). |
| `name` | string | yes | Name to find usages of (table, table.field or script). |
| `mermaid` | boolean | no | Also render a Mermaid reference graph. |
| `scope` | string | no | One scope: namespace (e.g. 'x_acme_app') or sys_id. |
| `structural` | boolean | no | Also search configuration structurally (default true). |
| `extended` | boolean | no | Also search the opt-in UIB / portal script types. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `kind` | string |  |
| `name` | string |  |
| `count` | number |  |
| `references` | any[] |  |
| `caveats` | any[] |  |
