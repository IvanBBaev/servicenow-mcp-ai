# `aggregate` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

1 tool (1 read-only, 0 write). In the default `core` profile. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_aggregate`](#servicenow_aggregate) | yes | Aggregate ServiceNow records |

## servicenow_aggregate

**Aggregate ServiceNow records.** Server-side aggregates (count, avg, min, max, sum) over a table via the Stats API, optionally grouped.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table, e.g. 'incident'. |
| `query` | string | no | Encoded query filtering the rows. |
| `count` | boolean | no | Include a count (sysparm_count). |
| `avg_fields` | string[] | no | Numeric fields to average. |
| `min_fields` | string[] | no | Fields to take the min of. |
| `max_fields` | string[] | no | Fields to take the max of. |
| `sum_fields` | string[] | no | Numeric fields to sum. |
| `group_by` | string[] | no | Fields to group by. |
| `having` | string | no | HAVING clause (sysparm_having). |
| `displayValue` | boolean | no | Add display values (sysparm_display_value=all). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `result` | any |  |
