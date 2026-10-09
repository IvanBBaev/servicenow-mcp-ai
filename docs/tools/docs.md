# `docs` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

9 tools (5 read-only, 4 write). Opt-in: add `docs` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_list_docs`](#servicenow_list_docs) | yes | List instance docs |
| [`servicenow_read_doc`](#servicenow_read_doc) | yes | Read instance doc |
| [`servicenow_search_docs`](#servicenow_search_docs) | yes | Search instance docs |
| [`servicenow_write_doc`](#servicenow_write_doc) | no | Write instance doc |
| [`servicenow_generate_er_diagram`](#servicenow_generate_er_diagram) | yes | Generate ER diagram |
| [`servicenow_generate_table_flow`](#servicenow_generate_table_flow) | yes | Generate table flow |
| [`servicenow_document_table`](#servicenow_document_table) | no | Document a table |
| [`servicenow_document_app`](#servicenow_document_app) | no | Document an application |
| [`servicenow_document_instance`](#servicenow_document_instance) | no | Document the instance |

## servicenow_list_docs

**List instance docs.** List the Markdown docs in SN_DOCS_DIR with metadata: generated or hand-written, generator, generated_at, profile, kind, bytes, stale (older than SN_DOCS_STALE_DAYS).

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `profile` | string | no | Profile folder: 'current' or a name; omit for all. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `count` | number |  |
| `entries` | any[] |  |

## servicenow_read_doc

**Read instance doc.** Read one local Markdown doc or its .json companion; the result carries its mimeType.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `path` | string | yes | Path relative to the docs (or 'profile') folder, e.g. 'tables/incident.md'. |
| `profile` | string | no | Profile folder: 'current' or a name; omit for all. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `path` | string |  |
| `content` | string |  |
| `mimeType` | string |  |

## servicenow_search_docs

**Search instance docs.** Search the local docs for a substring: a snippet and nearest heading per match (max SN_DOCS_SEARCH_MAX, then 'truncated').

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `text` | string | yes | Substring to search for. |
| `profile` | string | no | Profile folder: 'current' or a name; omit for all. |
| `kind` | string | no | Only generated documents of this kind, e.g. 'tables'. |
| `generated` | boolean | no | true: only generated; false: only hand-written. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `count` | number |  |
| `matches` | any[] |  |

## servicenow_write_doc

**Write instance doc.** Create or overwrite a local Markdown doc and refresh index.md. A generated document (sn_generated) is refused with DOC_GENERATED unless overwrite:true; annotate one inside <!-- sn:manual:start --> … <!-- sn:manual:end -->.

**Writes:** Destructive write, idempotent.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `path` | string | yes | Path relative to the docs folder, e.g. 'tables/incident.md'. |
| `content` | string | yes | Full Markdown content. |
| `profile` | string | no | Profile folder: 'current' or a name; omit for all. |
| `overwrite` | boolean | no | Replace a generated document. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `path` | string |  |
| `bytes` | number |  |

## servicenow_generate_er_diagram

**Generate ER diagram.** Mermaid erDiagram from sys_dictionary: an entity per table, a relationship per reference field. columns / max_columns / depth give a detailed view: PK/FK and required markers, extends edges, referenced tables.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `tables` | string[] | yes | Tables to include, e.g. ['incident', 'problem']. |
| `columns` | "all" \| "own" \| "keys" | no | all: whole chain; own: the table's own; keys: sys_id, references, mandatory. |
| `max_columns` | integer | no | Columns per entity before '+N' folding (40). |
| `depth` | 0 \| 1 \| 2 | no | Reference levels to follow, adding targets (0). |
| `format` | "inline" \| "file" | no | 'inline' (default) or 'file': write <profile>/diagrams/<name>.mmd, return { path, bytes, preview }. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_generate_table_flow

**Generate table flow.** Mermaid flowchart of a record's lifecycle: active business rules by phase, inherited and global rules in own lanes. 'operation' adds the event trace (flows, workflows, notifications); 'lanes' adds opt-in lanes.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table to diagram, e.g. 'incident'. |
| `operation` | "insert" \| "update" \| "delete" \| "query" | no | One operation, with flows, workflows and notifications. |
| `lanes` | "transform_map" \| "scheduled_job" \| "client" \| "data_policy" \| "sla" \| "event_script"[] | no | Lanes beyond business rules, flows, workflows, notifications: transform_map, scheduled_job (text match), client (client scripts + UI policies), data_policy, sla, event_script. |
| `format` | "inline" \| "file" | no | 'inline' (default) or 'file': write <profile>/diagrams/<name>.mmd, return { path, bytes, preview }. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_document_table

**Document a table.** Write <profile>/tables/<table>.md + .json from metadata: inheritance, columns, references, ER and flow diagrams, rules, client scripts, UI policies/actions, ACLs, caveats. A Purpose manual block survives re-runs.

**Writes:** Write, idempotent.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `table` | string | yes | Table to document, e.g. 'incident'. |
| `profile` | string | no | Profile: 'current' (default) or a name; writes to its docs folder. |
| `write` | boolean | no | false returns the Markdown, writing nothing. |
| `diagrams` | boolean | no | ER and table-flow diagrams (default true). |
| `columns` | "all" \| "own" \| "keys" | no | Columns the ER entity shows (default 'own'). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_document_app

**Document an application.** Write <profile>/apps/<scope>.md + .json for one scoped app: record, tables with an ER diagram, roles, cross-scope privileges, artefacts by type group, caveats. Not for 'global'. write:false returns the Markdown instead.

**Writes:** Write, idempotent.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `scope` | string | yes | Scope namespace (e.g. 'x_acme_app') or sys_id. |
| `profile` | string | no | Profile: 'current' (default) or a name; writes to its docs folder. |
| `write` | boolean | no | false returns the Markdown, writing nothing. |
| `detail` | boolean | no | Add a Mermaid diagram per flow/subflow/workflow/portal/UIB experience, a dependency graph and a lint summary (bounded). |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).

## servicenow_document_instance

**Document the instance.** Write <profile>/README.md (version, counts, apps, plugins, automation, update sets) and artifact-types.md, plus one document per named table, app and kind (security, catalog, integrations); depth adds discovery/. A cancel keeps finished files.

**Writes:** Write, idempotent.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `profile` | string | no | Profile: 'current' (default) or a name; writes to its docs folder. |
| `tables` | string[] | no | Tables to write as tables/<name>.md. |
| `apps` | string[] | no | Scopes to write as apps/<scope>.md. |
| `kinds` | "security" \| "catalog" \| "integrations" \| "access_review"[] | no | Instance-wide documents to add, each as <kind>.md. |
| `depth` | "overview" \| "apps" \| "artefacts" | no | Discovery tier under discovery/: overview, apps (+ per-scope tables), artefacts (+ per-scope artefacts); for 'apps', else every scope. |
| `write` | boolean | no | false returns the Markdown, writing nothing. |
| `format` | "json" \| "file" | no | 'json' (default) or 'file': write the result JSON to <SN_DOCS_DIR>/<profile>/exports/ and return { path, bytes, preview }. |
| `instance` | string | no | Profile (default active) |

### Output

Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).
