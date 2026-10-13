# `atf` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

3 tools (2 read-only, 1 write). Opt-in: add `atf` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_atf`](#servicenow_list_atf) | yes | List ATF tests or suites |
| [`servicenow_run_atf`](#servicenow_run_atf) | no | Run an ATF test or suite |
| [`servicenow_get_atf_result`](#servicenow_get_atf_result) | yes | Get ATF run result |

## servicenow_list_atf

**List ATF tests or suites.** List ATF tests (sys_atf_test, default) or suites (kind:'suite', sys_atf_test_suite) as metadata: name, active, description.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `kind` | "test" \| "suite" | no | test (default) or suite. |
| `active` | boolean | no | Filter by active. |
| `query` | string | no | Extra encoded query. |
| `limit` | integer | no |  |
| `with_results` | boolean | no | Add each item's last result, pass rate over its last 20 runs and a flaky flag (up to 100 items). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `count` | number |  |
| `tests` | any[] |  |
| `suites` | any[] |  |

## servicenow_run_atf

**Run an ATF test or suite.** Run an ATF test (default) or suite (kind:'suite') via the CI/CD API. EXECUTES CODE on the instance — non-production only, sn_cicd required. Returns an execution id for servicenow_get_atf_result, or pass wait_seconds to wait.

**Writes:** Write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `kind` | "test" \| "suite" | no | test (default) or suite. |
| `sys_id` | string | yes | sys_atf_test (or sys_atf_test_suite) sys_id. |
| `wait_seconds` | integer | no | Seconds to wait for the run, polling (default 0: return at once). On timeout wait.state is 'running' and wait.tracker is the id for servicenow_get_atf_result. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `mode` | string |  |
| `executionId` | string |  |
| `status` | string |  |

## servicenow_get_atf_result

**Get ATF run result.** Poll an ATF run by its execution id: status, percent complete and message (CI/CD progress API).

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `execution_id` | string | yes | Execution id from a run tool. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `executionId` | string |  |
| `status` | string |  |
| `percentComplete` | number |  |
