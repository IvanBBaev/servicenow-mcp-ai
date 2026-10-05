# `ops` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

2 tools (2 read-only, 0 write). Opt-in: add `ops` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_read_ops`](#servicenow_read_ops) | yes | Read instance operations data |
| [`servicenow_check_data_health`](#servicenow_check_data_health) | yes | Data health report |

## servicenow_read_ops

**Read instance operations data.** Bounded ops views for 'why is it slow' triage: overview, syslog, jobs (sys_trigger), email_queue, semaphores, integrations (failed/slow outbound), transactions (slow), mid (MID/ECC queue). Unreadable section: available:false + why.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `kind` | "overview" \| "syslog" \| "jobs" \| "email_queue" \| "semaphores" \| "integrations" \| "transactions" \| "mid" | yes | View to read. |
| `minutes` | integer | no | Time window in minutes (default 60, max 1440). |
| `level` | "error" \| "warning" \| "info" \| "debug" | no | syslog: minimum severity (default 'warning'). |
| `source` | string | no | syslog: source fragment (contains). |
| `filter` | "overdue" \| "running" \| "queued" | no | jobs: 'overdue' (default; ready, past next action), 'running' or 'queued'. |
| `overdue_minutes` | integer | no | jobs: minutes past next_action before a ready job counts as overdue (default 5, max 1440). |
| `limit` | integer | no | Maximum rows to return (default 25, max 200). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_check_data_health

**Data health report.** Data-quality counts for one table: duplicate groups over key_fields, orphaned or stale references per field, each with the query listing the rows. Unreadable checks: available:false.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table to check, e.g. 'incident'. |
| `key_fields` | string[] | no | Columns unique together, e.g. ['email']; omit to skip duplicates. |
| `reference_fields` | string[] | no | Reference columns (default: first 10). |
| `query` | string | no | Encoded query scoping every check (no ^NQ or ORDERBY). |
| `stale` | boolean | no | Count references to inactive rows (default true). |
| `limit` | integer | no | Maximum duplicate groups to return (default 20, max 100). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).
