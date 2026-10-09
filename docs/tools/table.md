# `table` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

6 tools (2 read-only, 4 write). In the default `core` profile. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_query_table`](#servicenow_query_table) | yes | Query ServiceNow table |
| [`servicenow_get_record`](#servicenow_get_record) | yes | Get ServiceNow record |
| [`servicenow_create_record`](#servicenow_create_record) | no | Create ServiceNow record |
| [`servicenow_update_record`](#servicenow_update_record) | no | Update ServiceNow record |
| [`servicenow_upsert_record`](#servicenow_upsert_record) | no | Upsert ServiceNow record |
| [`servicenow_delete_record`](#servicenow_delete_record) | no | Delete ServiceNow record |

## servicenow_query_table

**Query ServiceNow table.** Read records from any table (Table API): encoded query, fields, paging, fetchAll. '^' cannot be escaped inside a value; very long queries can hit HTTP 414 — split them. See the servicenow://reference/encoded-query resource.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table, e.g. 'incident'. |
| `query` | string | no | Encoded query (sysparm_query), e.g. 'active=true^ORDERBYDESCsys_created_on'. |
| `fields` | string[] \| "summary" | no | Columns (default all); 'summary': the list view's. |
| `limit` | integer | no | Max records (default 10). |
| `offset` | integer | no | Records to skip (paging). |
| `displayValue` | "true" \| "false" \| "all" \| "display" | no | 'true' display, 'false' raw (default), 'all' both, 'display' compact ([sys_id, name] refs). |
| `omitEmpty` | boolean | no | Drop empty cells; columns are listed. |
| `fetchAll` | boolean | no | All matches (≤ SN_MAX_RECORDS): sys_id cursor without an ORDERBY (stable), else offset. |
| `view` | string | no | UI view's fields (sysparm_view); 'fields' wins. |
| `queryCategory` | string | no | sysparm_query_category, e.g. a read replica. |
| `noCount` | boolean | no | Skip the row count (sysparm_no_count): faster on huge tables; 'total' unknown. |
| `queryNoDomain` | boolean | no | Query all accessible domains (sysparm_query_no_domain). |
| `domain` | string | no | Only this domain's rows (sys_id). |
| `suppressPaginationHeader` | boolean | no | sysparm_suppress_pagination_header. |
| `format` | "json" \| "csv" \| "table" \| "file" | no | 'json' (default), 'csv', 'table' (columns + rows) or 'file': the full (redacted) result to <profile>/exports/. |
| `fileFormat` | "csv" \| "jsonl" | no | With format 'file': 'csv' (default; columns from 'fields' or page 1) or 'jsonl' (all keys). |
| `explain` | boolean | no | Read no records: which conditions can use an index, with cost notes (advice). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `count` | number |  |
| `total` | number |  |
| `truncated` | boolean |  |
| `note` | string |  |
| `records` | any[] |  |
| `format` | string |  |
| `rows` | number \| any[] |  |
| `explain` | any |  |

## servicenow_get_record

**Get ServiceNow record.** Read a single record from a table by its sys_id.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table, e.g. 'incident'. |
| `sys_id` | string | yes | Record sys_id. |
| `fields` | string[] | no | Columns (default all). |
| `displayValue` | "true" \| "false" \| "all" \| "display" | no | As in query_table. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_create_record

**Create ServiceNow record.** Create a new record in a table with the given field values.

**Writes:** Write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table, e.g. 'incident'. |
| `values` | record<string \| number \| boolean \| null> | yes | Field name/value pairs, e.g. { "short_description": "x" }. |
| `inputDisplayValue` | boolean | no | Values are display values the instance resolves (sysparm_input_display_value); default false: raw. |
| `update_set` | string | no | Update set (sys_id or exact name, in progress) to record the write in; switched for it, then restored. Default SN_UPDATE_SET, else unchanged. Data-row tables are not captured. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_update_record

**Update ServiceNow record.** Update fields on an existing record identified by its sys_id.

**Writes:** Write, idempotent. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table, e.g. 'incident'. |
| `sys_id` | string | yes | Record sys_id. |
| `values` | record<string \| number \| boolean \| null> | yes | Field name/value pairs to change. |
| `inputDisplayValue` | boolean | no | Values are display values the instance resolves (sysparm_input_display_value); default false: raw. |
| `update_set` | string | no | Update set (sys_id or exact name, in progress) to record the write in; switched for it, then restored. Default SN_UPDATE_SET, else unchanged. Data-row tables are not captured. |
| `expected_mod_count` | integer | no | sys_mod_count from the plan's apply_with; with apply, a changed record is refused (STALE_RECORD). |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_upsert_record

**Upsert ServiceNow record.** Create or update one record matched by an exact key of field/value pairs: no match creates, one updates, several are refused (AMBIGUOUS_KEY). Pass the plan's expected_action / expected_sys_id with apply:true; a changed decision gives STALE_RECORD.

**Writes:** Write, idempotent. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table name, e.g. 'cmdb_ci_server'. |
| `key` | record<string \| number \| boolean> | yes | Field/value pairs identifying the record, matched on raw values ('' matches an empty field); no '^' in values. |
| `values` | record<string \| number \| boolean \| null> | yes | Fields to write (plus the key fields on create). |
| `expected_action` | "create" \| "update" | no | The plan's action; with apply, refused (STALE_RECORD) if the key now resolves differently. |
| `expected_sys_id` | string | no | The plan's sys_id; with apply, refused (STALE_RECORD) if the key now matches another record or none. |
| `inputDisplayValue` | boolean | no | Values are display values the instance resolves (sysparm_input_display_value); default false: raw. |
| `update_set` | string | no | Update set (sys_id or exact name, in progress) to record the write in; switched for it, then restored. Default SN_UPDATE_SET, else unchanged. Data-row tables are not captured. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_delete_record

**Delete ServiceNow record.** Delete a record from a table by its sys_id.

**Writes:** Destructive write, idempotent. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`). Under `SN_DESTRUCTIVE_CONFIRM=token|elicit` an apply needs the `plan_token` of a matching preview.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table, e.g. 'incident'. |
| `sys_id` | string | yes | Record sys_id. |
| `update_set` | string | no | Update set (sys_id or exact name, in progress) to record the write in; switched for it, then restored. Default SN_UPDATE_SET, else unchanged. Data-row tables are not captured. |
| `expected_mod_count` | integer | no | sys_mod_count from the plan's apply_with; with apply, a changed record is refused (STALE_RECORD). |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |
| `plan_token` | string | no | Plan preview token (apply:true) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).
