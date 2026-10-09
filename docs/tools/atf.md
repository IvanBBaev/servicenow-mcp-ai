# `atf` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

5 tools (3 read-only, 2 write). Opt-in: add `atf` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_atf_tests`](#servicenow_list_atf_tests) | yes | List ATF tests |
| [`servicenow_list_atf_suites`](#servicenow_list_atf_suites) | yes | List ATF suites |
| [`servicenow_run_atf_test`](#servicenow_run_atf_test) | no | Run an ATF test |
| [`servicenow_run_atf_suite`](#servicenow_run_atf_suite) | no | Run an ATF suite |
| [`servicenow_get_atf_result`](#servicenow_get_atf_result) | yes | Get ATF run result |

## servicenow_list_atf_tests

**List ATF tests.** List ATF tests (sys_atf_test) as metadata: name, active, description.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
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

## servicenow_list_atf_suites

**List ATF suites.** List ATF test suites (sys_atf_test_suite) as metadata.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
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
| `suites` | any[] |  |

## servicenow_run_atf_test

**Run an ATF test.** Run one ATF test through the CI/CD API. EXECUTES CODE on the instance — non-production only, sn_cicd plugin required. Returns an execution id to poll with servicenow_get_atf_result, or pass wait_seconds to wait for the result.

**Writes:** Write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | sys_atf_test sys_id. |
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

## servicenow_run_atf_suite

**Run an ATF suite.** Run an ATF test suite through the CI/CD API. EXECUTES CODE on the instance. Returns an execution id to poll with servicenow_get_atf_result, or pass wait_seconds to wait for the result.

**Writes:** Write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | sys_atf_test_suite sys_id. |
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
