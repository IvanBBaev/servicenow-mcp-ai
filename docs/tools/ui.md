# `ui` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

2 tools (2 read-only, 0 write). Opt-in: add `ui` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_explain_portal`](#servicenow_explain_portal) | yes | Explain a Service Portal |
| [`servicenow_explain_ui_experience`](#servicenow_explain_ui_experience) | yes | Explain a UI Builder experience |

## servicenow_explain_portal

**Explain a Service Portal.** Explain a Service Portal (url_suffix or sys_id) or one page as a tree: theme, menu, pages, layout down to widgets and dependencies. Metadata only; unreadable tables become caveats.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `portal` | string | no | Portal url_suffix (e.g. 'esc') or sys_id; this or 'page'. |
| `page` | string | no | Page id (e.g. 'index') or sp_page sys_id, alone; this or 'portal'. |
| `depth` | integer | no | Nested-row levels to expand (default 3). |
| `format` | "json" \| "markdown" \| "mermaid" \| "file" | no | json (default) tree; markdown report + Mermaid; mermaid layout; file: JSON to exports/. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_explain_ui_experience

**Explain a UI Builder experience.** Explain a UI Builder experience/workspace (path or sys_id) as a page map: routes → screens → macroponents → data brokers and ACLs; plus landing, dashboards, lists, form actions. Metadata only.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | no | sys_ux_page_registry sys_id (or 'path'). |
| `path` | string | no | Experience path, e.g. 'now/sow' (or 'sys_id'). |
| `format` | "json" \| "markdown" \| "mermaid" \| "file" | no | json (default), markdown (report + diagram), mermaid (page map) or file (JSON to exports/). |
| `detail` | "elements" \| "bindings" \| "events" \| "scripts"[] | no | Depth: element props/components, bindings, event chains, script bodies. file default: all. |
| `as_user` | string | no | user_name or sys_id: which route variants this user sees. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `verified` | boolean |  |
| `counts` | record<number> |  |
