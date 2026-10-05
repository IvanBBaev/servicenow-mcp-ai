# `artifacts` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

6 tools (5 read-only, 1 write). Opt-in: add `artifacts` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_artifacts`](#servicenow_list_artifacts) | yes | List artifacts |
| [`servicenow_get_artifact`](#servicenow_get_artifact) | yes | Get artifact |
| [`servicenow_explain_artifact`](#servicenow_explain_artifact) | yes | Explain artifact |
| [`servicenow_get_artifact_dependencies`](#servicenow_get_artifact_dependencies) | yes | Artifact dependencies |
| [`servicenow_generate_fluent`](#servicenow_generate_fluent) | yes | Generate Fluent |
| [`servicenow_upsert_artifact`](#servicenow_upsert_artifact) | no | Upsert artifact |

## servicenow_list_artifacts

**List artifacts.** List records of any registry artifact type as summaries: sys_id, name, key, scope, active, SDK-managed verdict; no script bodies. verified:false types carry a caveat.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `artifactType` | string | yes | Registry type id, e.g. 'business_rule'; all types: servicenow://artifact-types. |
| `scope` | string | no | One scope: namespace (e.g. 'x_acme_app') or sys_id. |
| `query` | string | no | Encoded query ANDed with the type's filter. |
| `active` | boolean | no | Filter by active; refused for types without one. |
| `limit` | integer | no | Max records (default 50, max 1000). |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `artifactType` | string |  |
| `table` | string |  |
| `verified` | boolean |  |
| `caveat` | string |  |
| `count` | number |  |
| `total` | number |  |
| `artifacts` | record<any>[] |  |
| `missingFields` | string[] |  |
| `degraded` | object |  |
| `available` | boolean |  |

## servicenow_get_artifact

**Get artifact.** Read one artifact of any registry type in full: the record, its registry children (e.g. UI policy actions, page layout), scope and SDK-managed verdict. By sys_id or natural key; denied child tables show as redacted.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `artifactType` | string | yes | Registry type id, e.g. 'business_rule'; all types: servicenow://artifact-types. |
| `sys_id` | string | no | Record sys_id; this or 'key'. |
| `key` | string \| number \| boolean \| record<string \| number \| boolean> | no | Natural key (keyFields): a value for a single key field, else an object of every key field; this or 'sys_id'. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `artifactType` | string |  |
| `table` | string |  |
| `verified` | boolean |  |
| `caveat` | string |  |
| `sys_id` | string |  |
| `name` | string |  |
| `key` | record<string> |  |
| `scope` | object |  |
| `sdkManaged` | object |  |
| `record` | record<any> \| null |  |
| `children` | record<any>[] |  |
| `missingFields` | string[] |  |
| `degraded` | object |  |
| `available` | boolean |  |

## servicenow_explain_artifact

**Explain artifact.** Explain one artifact of any registry type: summary, trigger fields, non-empty fields, children, referenced records, decoded JSON fields and type-specific readings (state models, policy effects).

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `artifactType` | string | yes | Registry type id, e.g. 'business_rule'; all types: servicenow://artifact-types. |
| `sys_id` | string | no | Record sys_id; this or 'key'. |
| `key` | string \| number \| boolean \| record<string \| number \| boolean> | no | Natural key (keyFields): a value for a single key field, else an object of every key field; this or 'sys_id'. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `artifactType` | string |  |
| `table` | string |  |
| `verified` | boolean |  |
| `caveat` | string |  |
| `sys_id` | string |  |
| `name` | string |  |
| `key` | record<string> |  |
| `scope` | object |  |
| `sdkManaged` | object |  |
| `missingFields` | string[] |  |
| `summary` | string |  |
| `when` | record<any> \| null |  |
| `fields` | record<any> |  |
| `truncatedFields` | string[] |  |
| `explanation` | record<any> |  |
| `children` | record<any>[] |  |
| `references` | record<any>[] |  |
| `decoded` | record<any>[] |  |
| `degraded` | object |  |
| `available` | boolean |  |

## servicenow_get_artifact_dependencies

**Artifact dependencies.** Dependency graph of one artifact: outbound (references, decoded JSON, script calls, GlideRecord tables) and inbound (reverse references, script and flow-step callers). Depth-capped; JSON or Mermaid.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `artifactType` | string | yes | Registry type id, e.g. 'business_rule'; all types: servicenow://artifact-types. |
| `sys_id` | string | no | Record sys_id; this or 'key'. |
| `key` | string \| number \| boolean \| record<string \| number \| boolean> | no | Natural key (keyFields): a value for a single key field, else an object of every key field; this or 'sys_id'. |
| `direction` | "outbound" \| "inbound" \| "both" | no | outbound (uses), inbound (used by), both (default). |
| `depth` | integer | no | Levels to walk (default 1); cycles visited once. |
| `limit` | integer | no | Rows per inbound source (default 25). |
| `format` | "json" \| "mermaid" | no | json (default) nodes and edges, or mermaid. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `artifactType` | string |  |
| `table` | string |  |
| `verified` | boolean |  |
| `caveat` | string |  |
| `sys_id` | string |  |
| `name` | string |  |
| `root` | string \| null |  |
| `direction` | "outbound" \| "inbound" \| "both" |  |
| `depth` | number |  |
| `count` | object |  |
| `nodes` | record<any>[] |  |
| `edges` | record<any>[] |  |
| `truncated` | boolean |  |
| `unavailable` | object[] |  |
| `caveats` | string[] |  |
| `mermaid` | string |  |
| `mermaidTruncated` | number |  |
| `degraded` | object |  |
| `available` | boolean |  |

## servicenow_generate_fluent

**Generate Fluent.** Emit SDK Fluent source (.now.ts, sidecars, keys.ts fragment) for one artifact or a type in a scope. Secrets become placeholders; types without an emitter use Record() and are listed in unsupported. SDK target not type-checked.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `artifactType` | string | yes | Registry type id, e.g. 'business_rule'; all types: servicenow://artifact-types. |
| `sys_id` | string | no | Record sys_id; this or 'key'. |
| `key` | string \| number \| boolean \| record<string \| number \| boolean> | no | Natural key (keyFields): a value for a single key field, else an object of every key field; this or 'sys_id'. |
| `scope` | string | no | Instead of sys_id/key: every artifact of the type in a scope. |
| `limit` | integer | no | Scope mode cap (default 25). |
| `format` | "inline" \| "file" | no | 'inline' (default) or 'file' (<SN_DOCS_DIR>/<profile>/fluent/<scope>/). |
| `overwrite` | boolean | no | Replace hand-edited files. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `artifactType` | string |  |
| `sdkApi` | string |  |
| `emitter` | "dedicated" \| "record" |  |
| `count` | number |  |
| `keys` | record<any>[] |  |
| `unsupported` | record<any>[] |  |
| `files` | record<any>[] |  |

## servicenow_upsert_artifact

**Upsert artifact.** Create or update a registry artifact and its children (UI policy actions, portal page layout, catalog variables) as one journaled, revertible plan, parent first, with SDK pre-flight. Flows: {active} only (unverified, O-5).

**Writes:** Write, idempotent. Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`). Under `SN_DESTRUCTIVE_CONFIRM=token|elicit` an apply needs the `plan_token` of a matching preview.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `artifactType` | string | yes | Registry type id, e.g. 'business_rule'; all types: servicenow://artifact-types. |
| `key` | string \| number \| boolean \| record<string \| number \| boolean> | yes | Primary key: a value for a single key field, or every key field as pairs (sys_id-keyed types: identifying fields, e.g. {table, short_description}). Written on create. |
| `values` | record<string \| number \| boolean \| null> | yes | Primary-record fields (the type's descriptor fields; sys_scope on create only). |
| `children` | object[] | no | Child records, applied in order after the parent. |
| `expected_action` | "create" \| "update" | no | From the plan's apply_with; a changed decision gives STALE_RECORD. |
| `expected_sys_id` | string | no | From the plan's apply_with (parent sys_id). |
| `update_set` | string | no | Update set (sys_id or exact name, in progress) to record the write in; switched for it, then restored. Default SN_UPDATE_SET, else unchanged. Data-row tables are not captured. |
| `apply` | boolean | no | true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default). |
| `instance` | string | no | Profile (default active) |
| `plan_token` | string | no | Plan preview token (apply:true) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).
