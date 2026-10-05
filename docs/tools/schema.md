# `schema` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

2 tools (2 read-only, 0 write). In the default `core` profile. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_tables`](#servicenow_list_tables) | yes | List ServiceNow tables |
| [`servicenow_describe_table`](#servicenow_describe_table) | yes | Describe ServiceNow table |

## servicenow_list_tables

**List ServiceNow tables.** List tables from sys_db_object, optionally filtered by a name or label fragment.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `filter` | string | no | Case-insensitive name or label fragment. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `count` | number |  |
| `tables` | any[] |  |

## servicenow_describe_table

**Describe ServiceNow table.** List a table's columns from sys_dictionary (name, label, type, mandatory, reference, default, flags). details:true adds choice lists and dictionary overrides.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table, e.g. 'incident'. |
| `details` | boolean | no | Add choice lists and dictionary overrides (two extra reads). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `table` | string |  |
| `count` | number |  |
| `columns` | any[] |  |
| `warnings` | any[] |  |
