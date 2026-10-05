# `attachment` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

5 tools (3 read-only, 2 write). In the default `core` profile. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_attachments`](#servicenow_list_attachments) | yes | List ServiceNow attachments |
| [`servicenow_get_attachment`](#servicenow_get_attachment) | yes | Get ServiceNow attachment metadata |
| [`servicenow_download_attachment`](#servicenow_download_attachment) | yes | Download ServiceNow attachment |
| [`servicenow_upload_attachment`](#servicenow_upload_attachment) | no | Upload ServiceNow attachment |
| [`servicenow_delete_attachment`](#servicenow_delete_attachment) | no | Delete ServiceNow attachment |

## servicenow_list_attachments

**List ServiceNow attachments.** List attachment metadata, optionally for one record (table + sys_id).

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | no | Record table, e.g. 'incident'. |
| `sys_id` | string | no | Record sys_id. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_get_attachment

**Get ServiceNow attachment metadata.** Read a single attachment's metadata by its sys_id.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Attachment sys_id. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_download_attachment

**Download ServiceNow attachment.** Download an attachment's bytes, returned as base64. Large files are refused (see SN_MAX_RESULT_CHARS).

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Attachment sys_id. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_upload_attachment

**Upload ServiceNow attachment.** Attach a file (provided as base64) to a record identified by table + sys_id.

**Writes:** Write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Record table. |
| `sys_id` | string | yes | Record sys_id. |
| `file_name` | string | yes | File name, e.g. 'log.txt'. |
| `content_base64` | string | yes | File contents, base64-encoded. |
| `content_type` | string | no | MIME type (default application/octet-stream). |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_delete_attachment

**Delete ServiceNow attachment.** Delete an attachment by its sys_id.

**Writes:** Destructive write, idempotent. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`). Under `SN_DESTRUCTIVE_CONFIRM=token|elicit` an apply needs the `plan_token` of a matching preview.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Attachment sys_id. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |
| `plan_token` | string | no | Plan preview token (apply:true) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).
