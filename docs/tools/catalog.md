# `catalog` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

5 tools (4 read-only, 1 write). Opt-in: add `catalog` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_catalogs`](#servicenow_list_catalogs) | yes | List service catalogs |
| [`servicenow_list_catalog_categories`](#servicenow_list_catalog_categories) | yes | List catalog categories |
| [`servicenow_list_catalog_items`](#servicenow_list_catalog_items) | yes | List catalog items |
| [`servicenow_get_catalog_item`](#servicenow_get_catalog_item) | yes | Get catalog item |
| [`servicenow_order_catalog_item`](#servicenow_order_catalog_item) | no | Order catalog item |

## servicenow_list_catalogs

**List service catalogs.** List the Service Catalogs available on the instance (Service Catalog API).

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_list_catalog_categories

**List catalog categories.** List the categories within a service catalog.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Catalog sys_id. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_list_catalog_items

**List catalog items.** Search/list orderable catalog items, optionally by text or category.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `text` | string | no | Free-text search filter. |
| `category` | string | no | Category sys_id. |
| `limit` | integer | no |  |
| `offset` | integer | no |  |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_get_catalog_item

**Get catalog item.** Get a catalog item, including its order variables, by sys_id.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Catalog item sys_id. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_order_catalog_item

**Order catalog item.** Order a catalog item directly ('order now'). Creates a request/RITM. Provide variable values keyed by their names.

**Writes:** Write. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`). Under `SN_DESTRUCTIVE_CONFIRM=token|elicit` an apply needs the `plan_token` of a matching preview.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Catalog item sys_id. |
| `quantity` | integer | no | Quantity to order (default 1). |
| `variables` | record<any> | no | Variable name/value pairs. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |
| `plan_token` | string | no | Plan preview token (apply:true) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).
