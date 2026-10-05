# `history` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

1 tool (1 read-only, 0 write). Opt-in: add `history` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_get_record_history`](#servicenow_get_record_history) | yes | Get record history |

## servicenow_get_record_history

**Get record history.** Read a record's history: sys_audit changes and journal entries (comments, work_notes), newest first — journal fields read back empty via the Table API. Each source degrades separately.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Record table, e.g. 'incident'. |
| `sys_id` | string | yes | Record sys_id. |
| `source` | "all" \| "audit" \| "journal" | no | all (default), audit (field changes) or journal (comments / work notes). |
| `fields` | string[] | no | Only these fields / journal elements, e.g. ['state','work_notes']. |
| `since` | string | no | Only entries at or after 'YYYY-MM-DD[ HH:MM:SS]'. |
| `limit` | integer | no | Max entries after merging (default 100). |
| `value_max_chars` | integer | no | Chars per value (default 2000). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).
