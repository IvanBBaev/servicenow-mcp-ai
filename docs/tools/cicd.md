# `cicd` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

1 tool (0 read-only, 1 write). Opt-in: add `cicd` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_commit_update_set`](#servicenow_commit_update_set) | no | Preview or commit a retrieved update set |

## servicenow_commit_update_set

**Preview or commit a retrieved update set.** Preview (step:'preview') or commit (step:'commit') a retrieved update set (sys_remote_update_set) via the CI/CD API. A commit needs a clean preview — state previewed, no unresolved problem — and is never forced; its plan lists the preview problems.

**Writes:** Destructive write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`). Under `SN_DESTRUCTIVE_CONFIRM=token|elicit` an apply needs the `plan_token` of a matching preview.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `update_set` | string | yes | sys_remote_update_set sys_id. |
| `step` | "preview" \| "commit" | yes |  |
| `wait_seconds` | integer | no | Seconds to wait for the job, polling (default 0). On timeout wait.tracker is the progress id. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |
| `plan_token` | string | no | Plan preview token (apply:true) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `mode` | string |  |
| `executionId` | string |  |
| `status` | string |  |
| `clean` | boolean |  |
