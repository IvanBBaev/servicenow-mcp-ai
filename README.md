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

- Node.js 18+ (this project targets the version in `.nvmrc`).

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
| `SN_TOOL_PACKAGES`       |    no    | `core`          | Comma/space-separated tool packages or profiles to enable. Profiles: `core` (default) and `all`. Packages: `table`, `schema`, `aggregate`, `attachment`, `importset`, `batch`, `catalog`, `change`, `knowledge`, `cmdb`, `scripts`, `docs`. The admin tools are always on. |
| `SN_DOCS_DIR`            |    no    | `docs/instance` | Directory the `docs` package reads/writes Markdown in. Relative paths resolve against the working directory.                                                                                                                                                               |

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

| Tool                                 | Read-only | Description                                                  |
| ------------------------------------ | :-------: | ------------------------------------------------------------ |
| `servicenow_query_table`             |    yes    | Read records from a table (encoded query, fields, paging).   |
| `servicenow_get_record`              |    yes    | Read one record by `sys_id`.                                 |
| `servicenow_create_record`           |    no     | Create a record from field name/value pairs.                 |
| `servicenow_update_record`           |    no     | Update fields on a record by `sys_id`.                       |
| `servicenow_delete_record`           |    no     | Delete a record by `sys_id` (destructive).                   |
| `servicenow_aggregate`               |    yes    | Server-side count/avg/min/max/sum with grouping (Stats API). |
| `servicenow_list_tables`             |    yes    | List tables from `sys_db_object`.                            |
| `servicenow_describe_table`          |    yes    | List a table's columns from `sys_dictionary`.                |
| `servicenow_list_attachments`        |    yes    | List attachment metadata for a record.                       |
| `servicenow_get_attachment`          |    yes    | Read one attachment's metadata.                              |
| `servicenow_download_attachment`     |    yes    | Download attachment bytes as base64 (size-guarded).          |
| `servicenow_upload_attachment`       |    no     | Attach a base64 file to a record.                            |
| `servicenow_delete_attachment`       |    no     | Delete an attachment (destructive).                          |
| `servicenow_insert_import_set_row`   |    no     | Insert a row into a staging table and run its transform.     |
| `servicenow_get_import_set_row`      |    yes    | Read the transform outcome for a staging row.                |
| `servicenow_batch`                   |    no     | Run several REST calls in one request (Batch API).           |
| `servicenow_list_catalogs`           |    yes    | List service catalogs (Service Catalog API).                 |
| `servicenow_list_catalog_categories` |    yes    | List categories within a catalog.                            |
| `servicenow_list_catalog_items`      |    yes    | Search/list orderable catalog items.                         |
| `servicenow_get_catalog_item`        |    yes    | Get a catalog item and its order variables.                  |
| `servicenow_order_catalog_item`      |    no     | Order a catalog item ('order now').                          |
| `servicenow_list_changes`            |    yes    | List change requests (Change Management API).                |
| `servicenow_get_change`              |    yes    | Get a change request by `sys_id`.                            |
| `servicenow_create_change`           |    no     | Create a normal/standard/emergency change.                   |
| `servicenow_update_change`           |    no     | Update a change request.                                     |
| `servicenow_change_conflicts`        |    no     | Read or recalculate change schedule conflicts.               |
| `servicenow_search_knowledge`        |    yes    | Full-text search of knowledge articles.                      |
| `servicenow_get_knowledge_article`   |    yes    | Get a knowledge article by `sys_id`.                         |
| `servicenow_knowledge_highlights`    |    yes    | List featured or most-viewed articles.                       |
| `servicenow_list_cis`                |    yes    | List CIs of a CMDB class (CMDB Instance API).                |
| `servicenow_get_ci`                  |    yes    | Get a CI with attributes and relations.                      |
| `servicenow_create_ci`               |    no     | Create a CI through IRE.                                     |
| `servicenow_update_ci`               |    no     | Update a CI's attributes through IRE.                        |
| `servicenow_get_cmdb_meta`           |    yes    | Get a CMDB class's metadata/schema.                          |
| `servicenow_list_scripts`            |    yes    | List scripts of a type (business rule, include, etc.).       |
| `servicenow_get_script`              |    yes    | Read one script's source and execution context.              |
| `servicenow_search_code`             |    yes    | Search script source for a substring (snippet per match).    |
| `servicenow_table_logic`             |    yes    | Summarize the automation that runs on a table.               |
| `servicenow_docs_list`               |    yes    | List local instance-documentation Markdown files.            |
| `servicenow_docs_read`               |    yes    | Read one local documentation file.                           |
| `servicenow_docs_search`             |    yes    | Search the local documentation for a substring.              |
| `servicenow_docs_write`              |    no     | Write a doc and refresh the index (local files).             |
| `servicenow_generate_er_diagram`     |    yes    | Build a Mermaid ER diagram from table references.            |
| `servicenow_generate_table_flow`     |    yes    | Build a Mermaid flow of a table's business rules.            |
| `servicenow_set_credentials`         |    no     | Save/update instance, user and/or password.                  |
| `servicenow_get_status`              |    yes    | Show instance/user, auth mode and access policy.             |

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
