# `email` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

2 tools (1 read-only, 1 write). Opt-in: add `email` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_send_email`](#servicenow_send_email) | no | Send ServiceNow email |
| [`servicenow_get_email`](#servicenow_get_email) | yes | Get ServiceNow email |

## servicenow_send_email

**Send ServiceNow email.** Send an email (Email API plugin), optionally tied to a record (table + sys_id). Recipients must match SN_EMAIL_ALLOWED_DOMAINS or, when that is unset, be users of the instance (sys_user.email).

**Writes:** Write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`). Under `SN_DESTRUCTIVE_CONFIRM=token|elicit` an apply needs the `plan_token` of a matching preview.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `to` | string[] | yes | Recipient email addresses (1–50). |
| `subject` | string | yes | Email subject. |
| `body` | string | yes | Plain-text email body. |
| `cc` | string[] | no | CC addresses. |
| `bcc` | string[] | no | BCC addresses. |
| `table` | string | no | Table of the record to associate. |
| `sys_id` | string | no | sys_id of the record to associate. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |
| `plan_token` | string | no | Plan preview token (apply:true) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `mode` | string |  |
| `message` | string |  |
| `result` | any |  |

## servicenow_get_email

**Get ServiceNow email.** Read a sent/received email record by its sys_id (Email API).

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Email sys_id. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `result` | any |  |
