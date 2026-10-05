# `cmdb` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

7 tools (4 read-only, 3 write). Opt-in: add `cmdb` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_cis`](#servicenow_list_cis) | yes | List configuration items |
| [`servicenow_get_ci`](#servicenow_get_ci) | yes | Get configuration item |
| [`servicenow_create_ci`](#servicenow_create_ci) | no | Create configuration item |
| [`servicenow_update_ci`](#servicenow_update_ci) | no | Update configuration item |
| [`servicenow_get_cmdb_meta`](#servicenow_get_cmdb_meta) | yes | Get CMDB class metadata |
| [`servicenow_list_ci_relations`](#servicenow_list_ci_relations) | yes | List CI relationships |
| [`servicenow_identify_reconcile`](#servicenow_identify_reconcile) | no | Identify and reconcile CIs (IRE) |

## servicenow_list_cis

**List configuration items.** List configuration items of a CMDB class through the class-aware CMDB Instance API.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | no | CMDB class/table, e.g. 'cmdb_ci_server'. |
| `query` | string | no | Encoded query (sysparm_query). |
| `limit` | integer | no |  |
| `offset` | integer | no |  |
| `instance` | string | no | Profile (default active) |
| `class_name` | string | no | Deprecated: use table |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_get_ci

**Get configuration item.** Get a CI with its attributes and inbound/outbound relations by class and sys_id.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | no | CI class, e.g. 'cmdb_ci_server'. |
| `sys_id` | string | yes | CI sys_id. |
| `instance` | string | no | Profile (default active) |
| `class_name` | string | no | Deprecated: use table |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_create_ci

**Create configuration item.** Create a CI via the CMDB Instance API (routed through Identification & Reconciliation).

**Writes:** Write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | no | CI class, e.g. 'cmdb_ci_server'. |
| `values` | record<string \| number \| boolean \| null> | yes | CI attribute name/value pairs. |
| `source` | string | no | IRE discovery source (e.g. 'ServiceNow'). |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |
| `class_name` | string | no | Deprecated: use table |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_update_ci

**Update configuration item.** Update a CI's attributes via the CMDB Instance API (IRE).

**Writes:** Write, idempotent. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | no | CI class, e.g. 'cmdb_ci_server'. |
| `sys_id` | string | yes | CI sys_id. |
| `values` | record<string \| number \| boolean \| null> | yes | CI attribute name/value pairs. |
| `source` | string | no | Discovery source for IRE. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |
| `class_name` | string | no | Deprecated: use table |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_get_cmdb_meta

**Get CMDB class metadata.** Schema of a CMDB class (attributes, relationship rules) from the CMDB Meta API.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | no | CI class, e.g. 'cmdb_ci_server'. |
| `instance` | string | no | Profile (default active) |
| `class_name` | string | no | Deprecated: use table |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_list_ci_relations

**List CI relationships.** List one CI's relationships (cmdb_rel_ci), outbound = parent, inbound = child, with the related CI's name and class. Filter by direction and type.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | CI sys_id. |
| `direction` | "both" \| "outbound" \| "inbound" | no | Default both. |
| `type` | string | no | Relationship type name ('Depends on::Used by') or sys_id. |
| `limit` | integer | no | Max relationships (default 100). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_identify_reconcile

**Identify and reconcile CIs (IRE).** Send CIs and relationships through the Identification & Reconciliation Engine: matched by identification rules, then inserted or updated. The plan preview is identify-only.

**Writes:** Write, idempotent. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `items` | object[] | yes | The CIs to identify (IRE payload `items`). |
| `relations` | object[] | no | Relationships between the items. |
| `data_source` | string | no | sysparm_data_source (default 'ServiceNow'). |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).
