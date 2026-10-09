# `directory` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

1 tool (1 read-only, 0 write). Opt-in: add `directory` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_lookup_directory`](#servicenow_lookup_directory) | yes | Look up users, groups and roles |

## servicenow_lookup_directory

**Look up users, groups and roles.** Find users, groups or roles by search term or sys_id. With include_details and one match: a user's roles and groups, a group's members and roles, or a role's contained roles and granting groups.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `kind` | "user" \| "group" \| "role" | yes | What to look up. |
| `term` | string | no | user_name / email prefix or name fragment (users); name fragment (groups, roles). |
| `sys_id` | string | no | Exact sys_id. |
| `active` | boolean | no | Filter users / groups by active. |
| `include_details` | boolean | no | Add roles, groups, members when one record matches. |
| `limit` | integer | no | Max records (default 20). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `count` | number |  |
| `records` | any[] |  |
