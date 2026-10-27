# `importset` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

2 tools (1 read-only, 1 write). Opt-in: add `importset` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_insert_import_set_row`](#servicenow_insert_import_set_row) | no | Insert ServiceNow import set row |
| [`servicenow_get_import_set_row`](#servicenow_get_import_set_row) | yes | Get ServiceNow import set row result |

## servicenow_insert_import_set_row

**Insert ServiceNow import set row.** Insert one row (values), several (rows) or a CSV/JSONL file under SN_DOCS_DIR (file_path) into a staging table and run its transform map. Returns the transform result, the run (sys_import_set_run) and the transform maps, used ones marked.

**Writes:** Write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Staging table, e.g. 'u_imp_incident'. |
| `values` | record<string \| number \| boolean \| null> | no | One row: column/value pairs. |
| `rows` | record<string \| number \| boolean \| null>[] | no | Several rows, each column/value pairs. |
| `file_path` | string | no | CSV (header row) or JSONL file under SN_DOCS_DIR. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `mode` | string |  |
| `message` | string |  |
| `result` | any |  |

## servicenow_get_import_set_row

**Get ServiceNow import set row result.** Read a staging row's transform outcome.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Import staging table. |
| `sys_id` | string | yes | Staging row sys_id. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `result` | any |  |
