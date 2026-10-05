# `flows` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

5 tools (5 read-only, 0 write). Opt-in: add `flows` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_trace_table_event`](#servicenow_trace_table_event) | yes | Trace a table event |
| [`servicenow_list_flows`](#servicenow_list_flows) | yes | List flows |
| [`servicenow_get_flow`](#servicenow_get_flow) | yes | Get flow detail |
| [`servicenow_get_flow_runs`](#servicenow_get_flow_runs) | yes | Get flow run history |
| [`servicenow_explain_flow`](#servicenow_explain_flow) | yes | Explain a flow or workflow |

## servicenow_trace_table_event

**Trace a table event.** Trace what would run for a table operation, in order, without executing: business rules by phase (inherited and global too), flows, workflows, notifications, with conditions and a Mermaid flowchart. 'lanes' adds more.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table to trace, e.g. 'incident'. |
| `operation` | "insert" \| "update" \| "delete" \| "query" | yes | Operation to simulate. |
| `lanes` | "transform_map" \| "scheduled_job" \| "client" \| "data_policy" \| "sla" \| "event_script"[] | no | Lanes beyond business rules, flows, workflows, notifications: transform_map, scheduled_job (text match), client (client scripts + UI policies), data_policy, sla, event_script. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `table` | string |  |
| `tables` | any[] |  |
| `chain` | any[] |  |
| `mermaid` | string |  |
| `warnings` | any[] |  |

## servicenow_list_flows

**List flows.** List flows (sys_hub_flow) or legacy workflows (kind: 'workflow') as metadata. Filter by table, active or name.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `kind` | "flow" \| "workflow" | no | 'flow' (default) or 'workflow' (legacy). |
| `table` | string | no | Only flows triggered on this table. |
| `active` | boolean | no | Filter by the active flag. |
| `name` | string | no | Case-insensitive name fragment. |
| `limit` | integer | no |  |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `kind` | string |  |
| `count` | number |  |
| `flows` | any[] |  |

## servicenow_get_flow

**Get flow detail.** Structured view of one flow or workflow: trigger (table/condition/when) and ordered steps; not a full decompilation.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Flow or workflow sys_id. |
| `kind` | "flow" \| "workflow" | no | 'flow' (default) or 'workflow'. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `kind` | string |  |
| `sys_id` | string |  |
| `name` | string |  |
| `steps` | any[] |  |

## servicenow_get_flow_runs

**Get flow run history.** Flow runs from sys_flow_context, by flow sys_id or by the record it ran against: start, state and outcome.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `flow` | string | no | Flow sys_id. |
| `record` | string | no | Record the flow ran against (document_id). |
| `limit` | integer | no |  |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `count` | number |  |
| `runs` | any[] |  |

## servicenow_explain_flow

**Explain a flow or workflow.** Explain a flow/subflow (trigger, step tree, decoded inputs and pills, calls expanded), a custom action (inputs, outputs, steps), a legacy workflow (activity graph, migration report) or a playbook (lanes). Opt-in runs.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | no | sys_id of the flow, action, workflow or playbook (per kind). Required unless kind:'workflow' with migration:true. |
| `kind` | "flow" \| "subflow" \| "action" \| "workflow" \| "playbook" | no | Default 'flow'; 'action' is a custom action, 'workflow' legacy, 'playbook' PAD. |
| `runs` | integer | no | Latest runs to include, with errors (default 0). |
| `depth` | integer | no | Flow/subflow: call levels to expand (default 1; 0 none). |
| `migration` | boolean | no | Workflow: migration report (catalog items, SLAs, running contexts). |
| `format` | "json" \| "markdown" \| "mermaid" \| "file" | no | json (default) tree; markdown report + Mermaid; mermaid only; file: JSON to exports/. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `kind` | string |  |
| `sys_id` | string |  |
| `verified` | boolean |  |
