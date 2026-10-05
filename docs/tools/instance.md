# `instance` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

2 tools (0 read-only, 2 write). Opt-in: add `instance` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_snapshot_instance`](#servicenow_snapshot_instance) | no | Snapshot instance metadata |
| [`servicenow_compare_instances`](#servicenow_compare_instances) | no | Compare two instances |

## servicenow_snapshot_instance

**Snapshot instance metadata.** Download structural metadata to SN_DOCS_DIR/<profile>/ as Markdown + JSON: tables, schemas, plugins, apps, script stats, properties (secrets redacted), choices, ACLs, flows, catalog, roles. resume:true resumes.

**Writes:** Write, idempotent.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `tables` | string[] | no | Tables to write as schema/<table>.md. |
| `sections` | "tables" \| "plugins" \| "apps" \| "automation" \| "properties" \| "choices" \| "acls" \| "notifications" \| "flows" \| "catalog" \| "roles"[] | no | Sections to collect (default all). |
| `resume` | boolean | no | Skip sections whose files carry the recorded source hash. |
| `types` | string[] | no | Registry types (with children) or ['all']; default none. |
| `scope` | string | no | Scope for types. |
| `format` | "json" \| "file" | no | 'json' (default) or 'file': write the full (redacted) JSON to <profile>/exports/, return { path, bytes, preview } + summary. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_compare_instances

**Compare two instances.** Diff two profiles: tables, column differences, scripts missing/renamed/changed (unified diff), plugin/app inventory, optional record sections. Writes _compare/<a>-vs-<b>.md.

**Writes:** Write, idempotent.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `a` | string | yes | First profile, e.g. 'dev'. |
| `b` | string | yes | Second profile, e.g. 'prod'. |
| `from_snapshot` | boolean | no | Prefer stored snapshot JSON over live reads (default false). |
| `sections` | "properties" \| "choices" \| "acls" \| "notifications" \| "flows" \| "catalog" \| "roles"[] | no | Snapshot record sections to compare too, matched by sys_id then name (default none). |
| `types` | string[] | no | Registry types (with children) or ['all']; default none. |
| `scope` | string | no | Scope for types. |
| `mermaid` | boolean | no | With types: diff changed flow/workflow/portal/experience diagrams as Mermaid (live). |
| `format` | "json" \| "file" | no | 'json' (default) or 'file': write the full (redacted) JSON to <profile>/exports/, return { path, bytes, preview } + summary. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).
