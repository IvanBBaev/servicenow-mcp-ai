# Sincronia — ServiceNow MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
MCP client (VS Code, Claude Desktop, etc.) run commands against a **ServiceNow**
instance through its REST APIs — Table, Aggregate, Attachment, Import Set, Batch
and CMDB, plus the Service Catalog, Change Management and Knowledge plugin APIs.
Credentials are kept in a local env file and can be updated at runtime through a tool.

## Features

- Full **Table API**: query, read, create, update and delete records on **any**
  table, with encoded queries, field selection and pagination.
- Extra ServiceNow APIs: **Aggregate** (Stats), **Attachment**
  (list/upload/download/delete), **Import Set**, **Batch** (many REST calls in a
  single request), plus table/column **metadata** (`sys_db_object`,
  `sys_dictionary`).
- Process & plugin APIs: **CMDB** (class-aware CI CRUD + meta via IRE),
  **Service Catalog** (browse/order items), **Change Management** (typed
  creation + conflict detection) and **Knowledge** (article search).
  Plugin-scoped APIs report clearly when not active on the instance.
- **Script intelligence**: read and search the instance's own code (business
  rules, script includes, client scripts, UI policies/actions, scheduled jobs,
  transform/REST scripts, ACLs) and get a table's full automation picture — all
  read-only over the Table API.
- **Self-documentation**: a local Markdown knowledge base (read/write/search) plus
  deterministic Mermaid generators (ER diagrams from references, record-lifecycle
  flowcharts from business rules) so the server builds durable, reusable context.
- **Prompts**: ready-made workflows (incident triage, change impact analysis,
  document a table) that orchestrate the tools.
- **Tool packages**: load only the tool groups you need via `SN_TOOL_PACKAGES`
  (default profile `core`; `all` enables everything).
- **Basic** or **OAuth 2.0** authentication over HTTPS; the password/token is
  never echoed back.
- Least-privilege controls: table allow/deny lists and a global read-only mode.
- Resilience: per-request timeout, retry with backoff and `Retry-After`, SSRF
  guard, and a result-size guard.
- MCP **tool annotations** and **resources**, structured error payloads, and
  structured logging on stderr.
- Credentials in an env file (project, `~/.config`, or `SN_ENV_FILE`), updatable
  at runtime via `servicenow_set_credentials`.

## Requirements

- Node.js 20+ (enforced: `engines` + a runtime guard with a clear message;
  the project targets the version in `.nvmrc`).

## Setup

```bash
npm install
npm run build
```

## Configure credentials

Credentials live in `.env` at the project root (git-ignored):

```dotenv
SN_INSTANCE=your-instance.service-now.com
SN_USER=your.username@example.com
SN_PASSWORD=your-password
```

`SN_INSTANCE` accepts `dev12345`, `dev12345.service-now.com` or a full `https://` URL.

You can also set or change them at runtime by calling the
`servicenow_set_credentials` tool — the new values are written straight back to the env file.

The env file is resolved in this order: `SN_ENV_FILE`, then
`~/.config/sincronia-mcp/.env` (XDG) if present, then the project-root `.env`.
A global/`npx` install therefore writes to your user config rather than into
`node_modules`. Real environment variables always take precedence over the file.

For **OAuth 2.0**, register an endpoint in ServiceNow and set `SN_OAUTH_CLIENT_ID`
(and usually `SN_OAUTH_CLIENT_SECRET`); see [.env.example](.env.example).

### Environment variables

All settings are read from `.env` (or the real process environment, which takes
precedence). Only the first three are required; the rest are optional tuning knobs.
See [.env.example](.env.example) for a template.

| Variable                 | Required | Default         | Description                                                                                                                                                                                                                                                                |
| ------------------------ | :------: | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SN_INSTANCE`            |   yes    | —               | Instance name, host, or `https://` URL (`dev12345`, `dev12345.service-now.com`).                                                                                                                                                                                           |
| `SN_USER`                |   yes    | —               | ServiceNow username for Basic auth.                                                                                                                                                                                                                                        |
| `SN_PASSWORD`            |   yes    | —               | ServiceNow password. Never logged or returned by any tool.                                                                                                                                                                                                                 |
| `SN_TIMEOUT_MS`          |    no    | `30000`         | Per-request timeout in milliseconds.                                                                                                                                                                                                                                       |
| `SN_MAX_RETRIES`         |    no    | `2`             | Retries for transient failures (429/5xx, network errors). Non-idempotent writes are only retried on connect errors.                                                                                                                                                        |
| `SN_MAX_RECORDS`         |    no    | `10000`         | Hard cap on records returned by a `fetchAll` query.                                                                                                                                                                                                                        |
| `SN_MAX_RESULT_CHARS`    |    no    | `100000`        | Character budget for a query result before it is truncated for the client.                                                                                                                                                                                                 |
| `SN_ALLOWED_HOSTS`       |    no    | —               | Comma-separated allow-list of permitted hosts. When set, only matching hosts are contacted; otherwise internal/loopback hosts are blocked (SSRF guard).                                                                                                                    |
| `SN_AUTH`                |    no    | auto            | Auth mode: `basic` or `oauth`. Defaults to `oauth` when `SN_OAUTH_CLIENT_ID` is set, else `basic`.                                                                                                                                                                         |
| `SN_OAUTH_CLIENT_ID`     |    no    | —               | OAuth client id (its presence enables OAuth).                                                                                                                                                                                                                              |
| `SN_OAUTH_CLIENT_SECRET` |    no    | —               | OAuth client secret.                                                                                                                                                                                                                                                       |
| `SN_OAUTH_GRANT`         |    no    | `password`      | OAuth grant: `password`, `client_credentials` or `refresh_token`.                                                                                                                                                                                                          |
| `SN_OAUTH_REFRESH_TOKEN` |    no    | —               | Refresh token, required only for the `refresh_token` grant.                                                                                                                                                                                                                |
| `SN_TABLES_ALLOW`        |    no    | —               | Comma-separated table allowlist; when set, only these tables are reachable.                                                                                                                                                                                                |
| `SN_TABLES_DENY`         |    no    | —               | Comma-separated table denylist; always wins over the allowlist.                                                                                                                                                                                                            |
| `SN_READONLY`            |    no    | `false`         | When truthy, refuse every create/update/delete.                                                                                                                                                                                                                            |
| `SN_LOG_LEVEL`           |    no    | `info`          | Log verbosity on stderr: `error`, `warn`, `info`, `debug`.                                                                                                                                                                                                                 |
| `SN_ENV_FILE`            |    no    | —               | Explicit path to the env file to read/write.                                                                                                                                                                                                                               |
| `SN_TOOL_PACKAGES`       |    no    | `core`          | Comma/space-separated tool packages or profiles to enable. Profiles: `core` (default) and `all`. Packages: `table`, `schema`, `aggregate`, `attachment`, `importset`, `batch`, `catalog`, `change`, `knowledge`, `cmdb`, `scripts`, `docs`, `email`. The admin tools are always on. |
| `SN_PACKAGES_DENY`       |    no    | —               | Comma/space-separated packages to exclude even if enabled by `SN_TOOL_PACKAGES`. The only way to block plugin APIs (catalog, change, knowledge…) — the table policy does not see them.                                                                                     |
| `SN_PACKAGES_READONLY`   |    no    | —               | Comma/space-separated packages whose write tools are not registered; their read tools stay. Per-package complement to the global `SN_READONLY`.                                                                                                                            |
| `SN_SCHEMA_CACHE_TTL_SEC` |   no    | `300`           | TTL for the near-static schema reads cache (`list_tables`, `describe_table`, `get_cmdb_meta`). `0` disables caching.                                                                                                                                                       |
| `SN_MAX_CONCURRENT`      |    no    | `4`             | Maximum parallel HTTP requests to the instance (simple in-process semaphore).                                                                                                                                                                                              |
| `SN_INCLUDE_REF_LINKS`   |    no    | `false`         | Reference fields come back without their `link` URLs by default (token savings). Set `true` to include them.                                                                                                                                                               |
| `SN_RESULT_PRETTY`       |    no    | `false`         | Tool results are compact JSON by default (pretty-printing ~doubles tokens). Set `true` for indented output.                                                                                                                                                                |
| `SN_DOCS_DIR`            |    no    | `docs/instance` | Directory the `docs` package reads/writes Markdown in. Relative paths resolve against the working directory.                                                                                                                                                               |
| `SN_PROFILE_<NAME>_*`    |    no    | —               | Named connection profiles: `SN_PROFILE_DEV_INSTANCE` / `_USER` / `_PASSWORD` define profile `dev`. The bare `SN_INSTANCE`/`SN_USER`/`SN_PASSWORD` keys are the `default` profile.                                                                                          |
| `SN_ACTIVE_PROFILE`      |    no    | `default`       | Which profile tools use. Switch at runtime with `servicenow_use_instance` (persisted to the env file).                                                                                                                                                                     |

## Run / debug

- **VS Code**: open the Command Palette and start the server defined in
  [.vscode/mcp.json](.vscode/mcp.json), then use it from Chat.
- **MCP Inspector**: `npm run inspector`
- **Directly**: `npm start`

## Develop

```bash
npm test          # build, then run unit tests (node:test)
npm run lint      # ESLint (flat config + typescript-eslint)
npm run format    # format with Prettier
```

## Tools

<!-- GENERATED:TOOLS:BEGIN (npm run docs:readme) -->

_This table is generated from the tool registrations — edit the tool
definitions in `src/tools/`, then run `npm run docs:readme`._

| Package | Tool | Read-only | Description |
| ------- | ---- | :-------: | ----------- |
| `table` | `servicenow_query_table` | yes | Read records from any ServiceNow table through the Table API |
| `table` | `servicenow_get_record` | yes | Read a single record from a table by its sys_id |
| `table` | `servicenow_create_record` | no | Create a new record in a table with the given field values |
| `table` | `servicenow_update_record` | no | Update fields on an existing record identified by its sys_id |
| `table` | `servicenow_delete_record` | no | Delete a record from a table by its sys_id |
| `schema` | `servicenow_list_tables` | yes | List tables from sys_db_object, optionally filtered by a name or label fragment |
| `schema` | `servicenow_describe_table` | yes | List a table's columns (name, label, type, mandatory, reference) from sys_dictionary |
| `aggregate` | `servicenow_aggregate` | yes | Compute server-side aggregates (count, avg, min, max, sum) over a table via the Stats API, with optional gr… |
| `attachment` | `servicenow_list_attachments` | yes | List attachment metadata, optionally scoped to a specific record (table + sys_id) |
| `attachment` | `servicenow_get_attachment` | yes | Read a single attachment's metadata by its sys_id |
| `attachment` | `servicenow_download_attachment` | yes | Download an attachment's bytes, returned as base64 |
| `attachment` | `servicenow_upload_attachment` | no | Attach a file (provided as base64) to a record identified by table + sys_id |
| `attachment` | `servicenow_delete_attachment` | no | Delete an attachment by its sys_id |
| `importset` | `servicenow_insert_import_set_row` | no | Insert a single row into a staging table and run its transform map |
| `importset` | `servicenow_get_import_set_row` | yes | Read the transform outcome for a previously inserted staging row by its sys_id |
| `batch` | `servicenow_batch` | no | Execute several ServiceNow REST sub-requests in a single HTTP round-trip via the Batch API |
| `catalog` | `servicenow_list_catalogs` | yes | List the Service Catalogs available on the instance (Service Catalog API) |
| `catalog` | `servicenow_list_catalog_categories` | yes | List the categories within a service catalog |
| `catalog` | `servicenow_list_catalog_items` | yes | Search/list orderable catalog items, optionally by text or category |
| `catalog` | `servicenow_get_catalog_item` | yes | Get a catalog item, including its order variables, by sys_id |
| `catalog` | `servicenow_order_catalog_item` | no | Order a catalog item directly ('order now') |
| `change` | `servicenow_list_changes` | yes | List change requests through the Change Management API |
| `change` | `servicenow_get_change` | yes | Get a single change request by sys_id |
| `change` | `servicenow_create_change` | no | Create a normal, standard or emergency change |
| `change` | `servicenow_update_change` | no | Update fields on a change request by sys_id |
| `change` | `servicenow_change_conflicts` | no | Read schedule conflicts for a change, or recalculate them (calculate=true) |
| `knowledge` | `servicenow_search_knowledge` | yes | Full-text search of knowledge articles (Knowledge API), with optional encoded query and paging |
| `knowledge` | `servicenow_get_knowledge_article` | yes | Get a knowledge article (content and metadata) by sys_id |
| `knowledge` | `servicenow_knowledge_highlights` | yes | List featured or most-viewed knowledge articles for the current user |
| `cmdb` | `servicenow_list_cis` | yes | List configuration items of a CMDB class through the class-aware CMDB Instance API |
| `cmdb` | `servicenow_get_ci` | yes | Get a CI with its attributes and inbound/outbound relations by class and sys_id |
| `cmdb` | `servicenow_create_ci` | no | Create a CI via the CMDB Instance API (routed through Identification & Reconciliation) |
| `cmdb` | `servicenow_update_ci` | no | Update a CI's attributes via the CMDB Instance API (IRE) |
| `cmdb` | `servicenow_get_cmdb_meta` | yes | Get the schema/metadata of a CMDB class (attributes, relationship rules) from the CMDB Meta API |
| `scripts` | `servicenow_list_scripts` | yes | List script artefacts of one type as compact metadata (no source code) |
| `scripts` | `servicenow_get_script` | yes | Read one script artefact in full, including its source code and execution context |
| `scripts` | `servicenow_search_code` | yes | Search script source for a literal substring across one or all script types |
| `scripts` | `servicenow_table_logic` | yes | Assemble the automation that runs on a table: business rules (ordered by when+order), client scripts, UI po… |
| `docs` | `servicenow_docs_list` | yes | List the Markdown documents in the local instance-documentation folder (SN_DOCS_DIR) |
| `docs` | `servicenow_docs_read` | yes | Read one Markdown document from the local instance-documentation folder |
| `docs` | `servicenow_docs_search` | yes | Search the local instance documentation for a substring; returns a snippet per match |
| `docs` | `servicenow_docs_write` | no | Create or overwrite a Markdown document in the local docs folder and refresh index.md |
| `docs` | `servicenow_generate_er_diagram` | yes | Build a Mermaid erDiagram from sys_dictionary: an entity per table plus a relationship for every reference … |
| `docs` | `servicenow_generate_table_flow` | yes | Build a Mermaid flowchart of a record's lifecycle on a table, grouping active business rules by phase (disp… |
| `email` | `servicenow_send_email` | no | Send an email through the instance's Email API, optionally associated with a record (table + sys_id) |
| `email` | `servicenow_get_email` | yes | Read a sent/received email record by its sys_id (Email API) |
| `admin` | `servicenow_set_credentials` | no | Save or update the ServiceNow connection credentials |
| `admin` | `servicenow_get_status` | yes | Show the configured instance, user, auth mode and access policy, and whether credentials are complete |
| `admin` | `servicenow_test_connection` | yes | Verify that the configured credentials actually work: reads one sys_user record and reports ok/status/latency |

<!-- GENERATED:TOOLS:END -->

All tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`) so clients can apply the right confirmation UX.

### Tool packages

Tools are grouped into packages so you can expose only what a given client needs
(fewer tools keep the model focused). Set `SN_TOOL_PACKAGES` to a comma/space
separated list of profiles or package names:

- `core` (default) — `table`, `schema`, `aggregate`, `attachment`.
- `all` — every package below.
- Individual packages: `table`, `schema`, `aggregate`, `attachment`,
  `importset`, `batch`, `catalog`, `change`, `knowledge`, `cmdb`, `scripts`,
  `docs`.

The admin tools (`servicenow_set_credentials`, `servicenow_get_status`) are
always registered, regardless of the active packages. Unknown names are ignored.
`servicenow_get_status` reports the resolved `enabledPackages`.

```dotenv
# Only table + batch tools (plus the always-on admin tools)
SN_TOOL_PACKAGES=table,batch
```

### Examples

Query the 5 most recent active incidents:

```jsonc
// servicenow_query_table
{
  "table": "incident",
  "query": "active=true^ORDERBYDESCsys_created_on",
  "fields": ["number", "short_description", "priority", "state"],
  "limit": 5,
}
```

Create an incident:

```jsonc
// servicenow_create_record
{
  "table": "incident",
  "fields": {
    "short_description": "Printer on 3rd floor is down",
    "urgency": "2",
    "impact": "2",
  },
}
```

Update credentials at runtime:

```jsonc
// servicenow_set_credentials
{
  "instance": "dev98765.service-now.com",
  "user": "admin",
  "password": "••••••",
}
```

## Resources

Read-only metadata is also exposed as MCP resources, so clients can attach it
declaratively instead of calling a tool:

| URI                           | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `servicenow://status`         | Connection status, auth mode, access policy.   |
| `servicenow://tables`         | List of tables from `sys_db_object`.           |
| `servicenow://schema/{table}` | Columns of a table from `sys_dictionary`.      |
| `servicenow://docs/{path}`    | A Markdown document from the local docs store. |

## Prompts

Ready-made workflows are exposed as MCP prompts; they orchestrate the tools and
insist on reading real values from the instance:

| Prompt                              | Argument   | Purpose                                                          |
| ----------------------------------- | ---------- | ---------------------------------------------------------------- |
| `servicenow_incident_triage`        | `incident` | Summarize, assess priority, categorize and recommend next steps. |
| `servicenow_change_impact_analysis` | `change`   | Affected CIs, schedule conflicts and a go/no-go call.            |
| `servicenow_document_table`         | `table`    | Schema + automation + diagrams → saved Markdown doc.             |

## Project structure

```
.
├── .env                   # credentials (git-ignored; or ~/.config/sincronia-mcp/.env)
├── .env.example           # template
├── .github/workflows/     # CI: build + lint + test
├── .vscode/mcp.json       # VS Code MCP server registration
├── eslint.config.js       # ESLint flat config
├── .prettierrc.json       # Prettier config
├── src/
│   ├── index.ts           # bootstrap: load env, register, connect stdio
│   ├── registry.ts        # registers all tool groups
│   ├── resources.ts       # MCP resources (status, tables, schema, docs)
│   ├── prompts.ts         # MCP prompts (triage, change impact, document table)
│   ├── http.ts            # shared REST client (auth, retry, SSRF)
│   ├── auth.ts            # Basic + OAuth 2.0 providers
│   ├── host.ts            # host resolution + SSRF guard
│   ├── policy.ts          # table allow/deny + read-only guards
│   ├── settings.ts        # numeric env settings
│   ├── logging.ts         # structured stderr logger
│   ├── result.ts          # tool results + structured errors
│   ├── servicenow.ts      # Table API client
│   ├── config.ts          # env file read/write + location
│   ├── api/               # aggregate, attachment, import set, batch, catalog, change, knowledge, cmdb, scripts, diagrams, docs, meta
│   └── tools/             # tool registration per API group
├── test/                  # node:test unit + mock-fetch tests
└── build/                 # compiled output (after npm run build)
```

> **Note:** the package is named `sincronia-mcp`, but the repository folder is
> `sincronia-mpc` (an `mpc`/`mcp` typo). This is cosmetic and does not affect the
> build; rename the folder manually if you want them to match.

## Security notes

- The env file is git-ignored — do not commit real credentials.
- The server uses the stdio transport and only logs to `stderr`; secrets and raw
  encoded queries are never logged.
- The password/token is never returned by any tool.
- Prefer **OAuth 2.0** over Basic where possible (`SN_OAUTH_CLIENT_ID`).
- Apply least privilege with `SN_TABLES_ALLOW` / `SN_TABLES_DENY` and
  `SN_READONLY=true` for read-only deployments.
- **Table policy does not cover plugin APIs.** `SN_TABLES_DENY=change_request`
  blocks the Table API path, but the Change Management API (`sn_chg_rest`) can
  still read/write changes. To restrict the plugin-backed surfaces use
  `SN_PACKAGES_DENY` (drop the whole package) or `SN_PACKAGES_READONLY`
  (register only its read tools).

## Project documentation

| Document | Contents (Bulgarian) |
| -------- | -------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layered architecture, Mermaid diagrams (modules, request lifecycle, security model, auth, packages), condensed ADRs |
| [PRODUCT-STATE.md](PRODUCT-STATE.md) | Current product state: API coverage map, quality status, history timeline, roadmap |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | Detailed specs for the upcoming phases (harness 2.0, multi-instance, flow testing) |
| [DONE.md](DONE.md) / [TODO.md](TODO.md) | Completed work with commit refs / remaining decisions |
| [WORKLOG.md](WORKLOG.md) / [CHANGELOG.md](CHANGELOG.md) | Detailed work journal / user-facing changelog |
