# `properties` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

2 tools (1 read-only, 1 write). Opt-in: add `properties` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_get_properties`](#servicenow_get_properties) | yes | Get system properties |
| [`servicenow_set_property`](#servicenow_set_property) | no | Set system property |

## servicenow_get_properties

**Get system properties.** Read system properties (sys_properties) by name or prefix: value, type, description, roles, scope, last update. Password-type and secret-looking values are masked; long values truncated.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `name` | string | no | Exact property name, e.g. 'glide.ui.session_timeout'. |
| `prefix` | string | no | Name prefix, e.g. 'glide.email.'. |
| `limit` | integer | no | Max properties (default 50). |
| `value_max_chars` | integer | no | Chars per value (default 4000). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `count` | number |  |
| `properties` | any[] |  |

## servicenow_set_property

**Set system property.** Set one existing system property by name. The plan shows current and new value; the write is journaled and revertible (except secret properties, whose values are never journaled).

**Writes:** Write, idempotent. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `name` | string | yes | Exact property name, e.g. 'glide.ui.session_timeout'. |
| `value` | string | yes | New value (string). |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `mode` | string |  |
| `message` | string |  |
| `result` | any |  |
