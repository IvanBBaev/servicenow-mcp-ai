# `change` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

5 tools (2 read-only, 3 write). Opt-in: add `change` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_changes`](#servicenow_list_changes) | yes | List change requests |
| [`servicenow_get_change`](#servicenow_get_change) | yes | Get change request |
| [`servicenow_create_change`](#servicenow_create_change) | no | Create change request |
| [`servicenow_update_change`](#servicenow_update_change) | no | Update change request |
| [`servicenow_check_change_conflicts`](#servicenow_check_change_conflicts) | no | Change schedule conflicts |

## servicenow_list_changes

**List change requests.** List change requests (Change Management API) with an encoded query, fields and paging.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `query` | string | no | Encoded query (sysparm_query). |
| `fields` | string[] | no | Columns to return. |
| `limit` | integer | no | Rows (default 10). |
| `offset` | integer | no |  |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_get_change

**Get change request.** Get a single change request by sys_id.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Change request sys_id. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_create_change

**Create change request.** Create a normal, standard or emergency change. Standard changes require a template_id.

**Writes:** Write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `type` | "normal" \| "standard" \| "emergency" | yes | Change type. |
| `template_id` | string | no | Template sys_id (required for standard). |
| `values` | record<string \| number \| boolean \| null> | no | Field name/value pairs, e.g. { "risk": "low" }. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_update_change

**Update change request.** Update fields on a change request by sys_id.

**Writes:** Write, idempotent. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Change request sys_id. |
| `values` | record<string \| number \| boolean \| null> | yes | Field name/value pairs, e.g. { "risk": "low" }. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_check_change_conflicts

**Change schedule conflicts.** Read schedule conflicts for a change, or recalculate them (calculate=true). Recalculation is a write: plan/apply like other writes, journaled, blocked in read-only mode.

**Writes:** Write, idempotent. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`). Under `SN_DESTRUCTIVE_CONFIRM=token|elicit` an apply needs the `plan_token` of a matching preview.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Change request sys_id. |
| `calculate` | boolean | no | Recalculate (POST) instead of reading. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |
| `plan_token` | string | no | Plan preview token (apply:true) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).
