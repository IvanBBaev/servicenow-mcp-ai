# `revert` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

2 tools (1 read-only, 1 write). Opt-in: add `revert` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_writes`](#servicenow_list_writes) | yes | List journaled writes |
| [`servicenow_revert_write`](#servicenow_revert_write) | no | Revert a journaled write |

## servicenow_list_writes

**List journaled writes.** List the local write journal (newest first): every write this server made, with entry id, outcome and whether servicenow_revert_write can invert it. Filter by profile, table, since, result or action.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `profile` | string | no | Profile whose journal to read (default: active). |
| `table` | string | no | Only writes to this table. |
| `since` | string | no | Only writes at or after this ISO 8601 time. |
| `result` | "applied" \| "failed" \| "refused" | no | Only writes with this outcome. |
| `action` | "create" \| "update" \| "delete" \| "execute" \| "local_write" \| "config" | no | Only writes of this kind. |
| `limit` | integer | no | Max entries (default 50, max 500). |
| `verbose` | boolean | no | Full journal lines (fields, before) instead of summaries. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_revert_write

**Revert a journaled write.** Undo one applied write from the local journal: an update restores its before values, a create is deleted, a delete is re-created. Refused if the record changed since (unless force:true) or the line is not invertible (NOT_REVERTIBLE). Journaled.

**Writes:** Destructive write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`). Under `SN_DESTRUCTIVE_CONFIRM=token|elicit` an apply needs the `plan_token` of a matching preview.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `entry_id` | string | yes | Journal entry id (ULID) from servicenow_list_writes. |
| `force` | boolean | no | Revert even if the record changed since (or that cannot be verified), overwriting the later changes. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |
| `plan_token` | string | no | Plan preview token (apply:true) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).
