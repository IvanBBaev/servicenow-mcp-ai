# `updatesets` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

3 tools (3 read-only, 0 write). Opt-in: add `updatesets` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_update_sets`](#servicenow_list_update_sets) | yes | List update sets |
| [`servicenow_get_update_set`](#servicenow_get_update_set) | yes | Get update set |
| [`servicenow_compare_update_set`](#servicenow_compare_update_set) | yes | Compare update set |

## servicenow_list_update_sets

**List update sets.** List update sets, newest first, with state, scope and whether each is the user's current one. Filter by state, name or application.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `state` | "in progress" \| "complete" \| "ignore" | no | Only sets in this state. |
| `name` | string | no | Name fragment (contains). |
| `application` | string | no | Scope namespace (e.g. 'x_acme_app') or sys_id. |
| `query` | string | no | Extra encoded query ANDed with the filters. |
| `limit` | integer | no | Max update sets (default 50, max 500). |
| `offset` | integer | no | Rows to skip (paging). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `count` | number |  |
| `total` | number |  |
| `truncated` | boolean |  |
| `current_update_set` | string \| null |  |
| `update_sets` | record<any>[] |  |

## servicenow_get_update_set

**Get update set.** Summarise one update set: its customer updates (sys_update_xml) per artefact — type, target, action, table — with counts; UIB pages it touches list the records it lacks. include_payload adds parsed field values, capped, secrets masked.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `update_set` | string | yes | Update set sys_id or exact name (a shared name resolves to the one in progress). |
| `type` | string | no | Only this type label, e.g. 'Business Rule'. |
| `limit` | integer | no | Max updates (default 200, max 1000). |
| `include_payload` | boolean | no | Add parsed payload fields. |
| `payload_max_chars` | integer | no | Chars per payload field (default 500). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `update_set` | record<any> |  |
| `count` | number |  |
| `total` | number |  |
| `truncated` | boolean |  |
| `by_type` | record<number> |  |
| `by_action` | record<number> |  |
| `updates` | record<any>[] |  |

## servicenow_compare_update_set

**Compare update set.** Compare an update set's artefacts with another profile (live) or a stored snapshot: a status per artefact (same, different with field names, missing, …) plus a summary. Audit columns ignored.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `update_set` | string | yes | Update set sys_id or exact name (a shared name resolves to the one in progress). |
| `with_profile` | string | no | Profile to compare against live; this or with_snapshot. |
| `with_snapshot` | string | no | Profile snapshot to compare with (record sections); this or with_profile. |
| `limit` | integer | no | Max updates to compare (default 100, max 500). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `update_set` | record<any> |  |
| `against` | record<string> |  |
| `count` | number |  |
| `total` | number |  |
| `truncated` | boolean |  |
| `summary` | record<number> |  |
| `artefacts` | record<any>[] |  |
| `warnings` | string[] |  |
| `caveats` | string[] |  |
