# `access` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

1 tool (0 read-only, 1 write). Opt-in: add `access` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_change_access`](#servicenow_change_access) | no | Grant or revoke a user role |

## servicenow_change_access

**Grant or revoke a user role.** Grant or revoke one role for one user (a direct sys_user_has_role row). The plan shows the effective roles before and after. Privileged roles (admin, security_admin, maint, elevated or containing one) and inherited roles are always refused.

**Writes:** Destructive write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`). Under `SN_DESTRUCTIVE_CONFIRM=token|elicit` an apply needs the `plan_token` of a matching preview.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `user` | string | yes | sys_user sys_id. |
| `role` | string | yes | Role name, e.g. 'itil'. |
| `action` | "grant" \| "revoke" | yes |  |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |
| `plan_token` | string | no | Plan preview token (apply:true) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `mode` | string |  |
| `message` | string |  |
| `sys_id` | string |  |
