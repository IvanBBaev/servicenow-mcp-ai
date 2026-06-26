# servicenow-mcp-ai — ServiceNow MCP Server

[![npm version](https://img.shields.io/npm/v/servicenow-mcp-ai?style=flat-square&logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/servicenow-mcp-ai)
[![npm downloads](https://img.shields.io/npm/dm/servicenow-mcp-ai?style=flat-square&logo=npm&logoColor=white&label=downloads)](https://www.npmjs.com/package/servicenow-mcp-ai)
[![node](https://img.shields.io/node/v/servicenow-mcp-ai?style=flat-square&logo=nodedotjs&logoColor=white&label=node)](https://www.npmjs.com/package/servicenow-mcp-ai)
[![tools](https://img.shields.io/badge/tools-67-blue?style=flat-square)](https://github.com/LeassTaTT/servicenow-mcp-ai#tools)
[![License: MIT](https://img.shields.io/npm/l/servicenow-mcp-ai?style=flat-square&color=blue&label=license)](LICENSE)

[![CI](https://img.shields.io/github/actions/workflow/status/LeassTaTT/servicenow-mcp-ai/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/LeassTaTT/servicenow-mcp-ai/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/codecov/c/github/LeassTaTT/servicenow-mcp-ai/main?style=flat-square&logo=codecov&logoColor=white&label=coverage)](https://codecov.io/gh/LeassTaTT/servicenow-mcp-ai)
[![last commit](https://img.shields.io/github/last-commit/LeassTaTT/servicenow-mcp-ai?style=flat-square&logo=git&logoColor=white&label=last%20commit)](https://github.com/LeassTaTT/servicenow-mcp-ai/commits/main)
[![MCP](https://img.shields.io/badge/MCP-server-orange?style=flat-square)](https://modelcontextprotocol.io)
[![Known Vulnerabilities](https://snyk.io/test/npm/servicenow-mcp-ai/badge.svg)](https://snyk.io/test/npm/servicenow-mcp-ai)

📖 **[Documentation site →](https://leasstatt.github.io/servicenow-mcp-ai/)**

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
MCP client (VS Code, Claude Desktop, etc.) run commands against a **ServiceNow**
instance through its REST APIs — Table, Aggregate, Attachment, Import Set, Batch
and CMDB, plus the Service Catalog, Change Management and Knowledge plugin APIs.
Credentials are kept in a local env file and can be updated at runtime through a tool.

> **Upgrading from 1.x?** v2.0 makes writes **plan-by-default**: `create`/`update`/`delete`
> and the other record-write tools return a non-mutating preview unless you pass
> `apply: true` (or set `SN_WRITE_MODE=apply` to restore the v1 "execute immediately"
> behaviour). See the [CHANGELOG](CHANGELOG.md) → 2.0.0 for the full migration note.

**Contents:** [Quick demo](#quick-demo) · [Features](#features) ·
[Requirements](#requirements) · [Setup](#setup) ·
[Configure credentials](#configure-credentials) · [Run / debug](#run--debug) ·
[Develop](#develop) · [Tools](#tools) · [Resources](#resources) ·
[Prompts](#prompts) · [Project structure](#project-structure) ·
[Security notes](#security-notes) · [Project documentation](#project-documentation)

## Quick demo

Three things the platform makes hard, one call each. Point your MCP client at an
instance ([Setup](#setup)) and ask:

**1. "Where is this field actually used?"** — every script, business rule, client
script, UI policy/action and ACL that touches it, as JSON or a Mermaid graph. The
IDE-grade _find usages_ ServiceNow has no button for:

```jsonc
// servicenow_where_used
{
  "kind": "field", // "table" | "field" | "script"
  "name": "u_cost_center",
  "mermaid": true, // also render a reference graph
}
```

**2. "What runs when I save this record?"** — the full automation chain in
execution order (display → before → after → async business rules, then flows,
workflows and notifications), each with its condition — a logical test that runs
**nothing**:

```jsonc
// servicenow_trace_table_event
{
  "table": "incident",
  "operation": "update", // insert | update | delete | query
}
```

**3. "What drifted between dev and prod?"** — a Markdown diff of tables, columns,
scripts (by SHA-256) and plugins between two configured profiles, with a CI-friendly
exit code so a pipeline can block a risky deploy:

```bash
servicenow-mcp-ai drift dev prod   # report on stdout; exit 1 on drift, 0 if clean
```

All three are **read-only** and work against any instance — including a free PDI —
with the model and client of your choice.

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
- **Flow tracing & code checking** (Phase 8): deterministically trace what a
  table operation runs (`flows` package — business rules, flows, workflows and
  notifications, in order, with a Mermaid flowchart), read Flow Designer flows
  and run history, and lint scripts against a local rule set with an aggregate
  code-health report (`codecheck`). Run ATF tests via the CI/CD API (`atf`,
  opt-in, non-default — the run tools execute on the instance).
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

From source (for development):

```bash
npm install
npm run build
```

Or run the published package directly, without cloning:

```bash
npx servicenow-mcp-ai
```

Register it with an MCP client (Claude Desktop, VS Code Chat, the Inspector…) by
pointing the server command at `npx`:

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": ["-y", "servicenow-mcp-ai"]
    }
  }
}
```

**Claude Code plugin** (zero-config — installs the server wired up):

```bash
/plugin marketplace add LeassTaTT/servicenow-mcp-ai
/plugin install servicenow-mcp-ai
```

**VS Code** — install the **ServiceNow MCP** extension from the Marketplace
(`code --install-extension leasstatt.servicenow-mcp-ai`); it registers the server
in Copilot Chat (agent mode) automatically, no manual `mcp.json`. Source:
[extension/](extension/).

Credentials are read from `~/.config/servicenow-mcp-ai/.env` (or real environment
variables) — see below.

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
`~/.config/servicenow-mcp-ai/.env` (XDG) if present, then the project-root `.env`.
A global/`npx` install therefore writes to your user config rather than into
`node_modules`. Real environment variables always take precedence over the file.

### OAuth 2.1 (Authorization Code + PKCE) — recommended

Register an **Authorization Code** OAuth API endpoint in ServiceNow with a
loopback redirect URL (e.g. `http://localhost:53682/callback`), set
`SN_OAUTH_CLIENT_ID` (and `SN_OAUTH_CLIENT_SECRET` for a confidential client),
then run the one-time interactive login:

```bash
npx servicenow-mcp-ai login
```

It opens the browser, you approve, and the obtained **refresh token** is stored
in your env file. The server then runs non-interactively (refresh_token grant) —
no password is ever stored. PKCE (S256) is always used.

> The OAuth 2.0 **password grant (ROPC) is deprecated** in OAuth 2.1 and disabled
> on many instances; prefer `login`. `client_credentials` and `refresh_token`
> grants remain supported for service accounts. See [.env.example](.env.example).

### Supported authentication methods

Every inbound REST auth method ServiceNow offers is covered:

| Method | `SN_AUTH` | Set | Notes |
| ------ | --------- | --- | ----- |
| Basic | `basic` | `SN_USER` / `SN_PASSWORD` | Default. |
| OAuth 2.1 — Authorization Code + PKCE | `oauth` | `npx servicenow-mcp-ai login` | **Recommended.** Interactive, stores a refresh token. |
| OAuth — Client Credentials | `oauth` | `SN_OAUTH_GRANT=client_credentials` | Service-to-service. |
| OAuth — Refresh Token | `oauth` | `SN_OAUTH_GRANT=refresh_token` + `SN_OAUTH_REFRESH_TOKEN` | Set by `login`. |
| OAuth — JWT Bearer | `oauth` | `SN_OAUTH_GRANT=jwt_bearer` + `SN_OAUTH_JWT_KEY` | RS256 assertion; no password. |
| OAuth — Password (ROPC) | `oauth` | `SN_OAUTH_GRANT=password` | **Deprecated.** |
| API Key | `apikey` | `SN_API_KEY` | `x-sn-apikey` header. |
| Bearer token | `token` | `SN_BEARER_TOKEN` | Pre-obtained token, used verbatim. |
| Mutual TLS (client cert) | `none` (or layered) | `SN_TLS_CLIENT_CERT` / `_KEY` | Cert maps to a user; needs optional `undici`. |

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
| `SN_ALLOWED_HOSTS`       |    no    | —               | Comma-separated allow-list of permitted hosts (for custom or sovereign-cloud domains). When set, only matching hosts are contacted. When unset, only `*.service-now.com` instances are allowed and internal/loopback hosts are blocked (SSRF guard).                        |
| `SN_AUTH`                |    no    | auto            | Auth method: `basic`, `oauth`, `apikey`, `token` or `none` (cert-only mTLS). Auto-detected from the keys present (API key → bearer → OAuth → Basic).                                                                                                                        |
| `SN_API_KEY`             |    no    | —               | ServiceNow Inbound API Key, sent as the `x-sn-apikey` header (enables `apikey` mode).                                                                                                                                                                                      |
| `SN_BEARER_TOKEN`        |    no    | —               | A pre-obtained bearer token, sent verbatim as `Authorization: Bearer …` (enables `token` mode).                                                                                                                                                                            |
| `SN_OAUTH_CLIENT_ID`     |    no    | —               | OAuth client id (its presence enables OAuth).                                                                                                                                                                                                                              |
| `SN_OAUTH_CLIENT_SECRET` |    no    | —               | OAuth client secret.                                                                                                                                                                                                                                                       |
| `SN_OAUTH_GRANT`         |    no    | `password`      | OAuth grant: `password` (**deprecated** — ROPC), `client_credentials`, `refresh_token` or `jwt_bearer`. The `login` command sets this to `refresh_token` for you.                                                                                                           |
| `SN_OAUTH_JWT_KEY`       |    no    | —               | PEM private key for the `jwt_bearer` grant (or `SN_OAUTH_JWT_KEY_FILE`). Optional claims: `SN_OAUTH_JWT_ISS` (default client id), `SN_OAUTH_JWT_SUB` (default `SN_USER`), `SN_OAUTH_JWT_AUD`, `SN_OAUTH_JWT_KID`, `SN_OAUTH_JWT_EXP_SEC` (default 300).                       |
| `SN_OAUTH_REFRESH_TOKEN` |    no    | —               | Refresh token for the `refresh_token` grant. Obtained automatically by `npx servicenow-mcp-ai login` (Authorization Code + PKCE).                                                                                                                                          |
| `SN_OAUTH_REDIRECT_URI`  |    no    | `http://localhost:53682/callback` | Loopback redirect URL for the PKCE `login` flow. Must match the redirect registered on the OAuth endpoint.                                                                                                                                               |
| `SN_OAUTH_SCOPE`         |    no    | —               | Optional OAuth scope requested during `login`.                                                                                                                                                                                                                             |
| `SN_TLS_CLIENT_CERT`     |    no    | —               | Client certificate (PEM) for **mutual TLS** (or `SN_TLS_CLIENT_CERT_FILE`). With `SN_TLS_CLIENT_KEY` it presents a client cert; ServiceNow's mutual-auth profile maps it to a user. Needs the optional `undici` package (`npm i undici`).                                    |
| `SN_TLS_CLIENT_KEY`      |    no    | —               | Private key (PEM) for the client certificate (or `SN_TLS_CLIENT_KEY_FILE`).                                                                                                                                                                                                |
| `SN_TLS_CA`              |    no    | —               | Optional CA bundle (PEM) to trust (or `SN_TLS_CA_FILE`). `SN_TLS_REJECT_UNAUTHORIZED=false` disables verification (not recommended).                                                                                                                                        |
| `SN_TABLES_ALLOW`        |    no    | —               | Comma-separated table allowlist; when set, only these tables are reachable.                                                                                                                                                                                                |
| `SN_TABLES_DENY`         |    no    | —               | Comma-separated table denylist; always wins over the allowlist.                                                                                                                                                                                                            |
| `SN_READONLY`            |    no    | `false`         | When truthy, refuse every create/update/delete.                                                                                                                                                                                                                            |
| `SN_WRITE_MODE` | no | `plan` | `plan` (default) previews a write as a before/after diff without mutating; `apply` executes; passing `apply:true` forces a single call. |
| `SN_REDACT_FIELDS` | no | — | DF-5: mask these field values before records reach the model (comma/space-separated). |
| `SN_REDACT_PII` | no | `false` | DF-5: also mask email/phone/national-id patterns inside string values. |
| `SN_TRANSPORT` | no | `stdio` | DF-6: `stdio` (default) or `http` (Streamable HTTP for remote/agent clients). |
| `SN_PORT` | no | `3000` | DF-6: TCP port for the http transport. |
| `SN_HTTP_HOST` | no | `127.0.0.1` | DF-6: bind address for the http transport (loopback by default). |
| `SN_HTTP_TOKEN` | no | — | DF-6: when set, http requests must send `Authorization: Bearer <token>`. |
| `SN_LOG_LEVEL`           |    no    | `info`          | Log verbosity on stderr: `error`, `warn`, `info`, `debug`.                                                                                                                                                                                                                 |
| `SN_ENV_FILE`            |    no    | —               | Explicit path to the env file to read/write.                                                                                                                                                                                                                               |
| `SN_TOOL_PACKAGES`       |    no    | `core`          | Comma/space-separated tool packages or profiles to enable. Profiles: `core` (default) and `all`. Packages: `table`, `schema`, `aggregate`, `attachment`, `importset`, `batch`, `catalog`, `change`, `knowledge`, `cmdb`, `scripts`, `flows`, `codecheck`, `docs`, `instance`, `email`, `atf`. The admin tools are always on. `atf` runs tests on the instance — enable it only on a non-production instance. |
| `SN_PACKAGES_DENY`       |    no    | —               | Comma/space-separated packages to exclude even if enabled by `SN_TOOL_PACKAGES`. The only way to block plugin APIs (catalog, change, knowledge…) — the table policy does not see them.                                                                                     |
| `SN_PACKAGES_READONLY`   |    no    | —               | Comma/space-separated packages whose write tools are not registered; their read tools stay. Per-package complement to the global `SN_READONLY`.                                                                                                                            |
| `SN_SCHEMA_CACHE_TTL_SEC` |   no    | `300`           | TTL for the near-static schema reads cache (`list_tables`, `describe_table`, `get_cmdb_meta`). `0` disables caching.                                                                                                                                                       |
| `SN_MAX_CONCURRENT`      |    no    | `4`             | Maximum parallel HTTP requests to the instance (simple in-process semaphore).                                                                                                                                                                                              |
| `SN_INCLUDE_REF_LINKS`   |    no    | `false`         | Reference fields come back without their `link` URLs by default (token savings). Set `true` to include them.                                                                                                                                                               |
| `SN_RESULT_PRETTY`       |    no    | `false`         | Tool results are compact JSON by default (pretty-printing ~doubles tokens). Set `true` for indented output.                                                                                                                                                                |
| `SN_DOCS_DIR`            |    no    | `docs/instance` | Directory the `docs` package reads/writes Markdown in. Relative paths resolve against the working directory.                                                                                                                                                               |
| `SN_CODESEARCH`          |    no    | `false`         | Opt in to the Code Search API (`sn_codesearch`) for `servicenow_search_code` (FT-7). When `true` and the plugin is active it replaces the LIKE iteration; falls back to LIKE on any failure.                                                                                |
| `SN_PROFILE_<NAME>_*`    |    no    | —               | Named connection profiles: `SN_PROFILE_DEV_INSTANCE` / `_USER` / `_PASSWORD` define profile `dev`. The bare `SN_INSTANCE`/`SN_USER`/`SN_PASSWORD` keys are the `default` profile.                                                                                          |
| `SN_ACTIVE_PROFILE`      |    no    | `default`       | Which profile tools use. Switch at runtime with `servicenow_use_instance` (persisted to the env file).                                                                                                                                                                     |

## Run / debug

- **VS Code**: open the Command Palette and start the server defined in
  [.vscode/mcp.json](.vscode/mcp.json), then use it from Chat.
- **MCP Inspector**: `npm run inspector`
- **Directly**: `npm start`

### Command-line interface

The published `servicenow-mcp-ai` binary (run it directly, or via
`npx servicenow-mcp-ai`) has three invocations. All connection settings come from
environment variables / the env file (see [Environment variables](#environment-variables));
only `drift` takes positional arguments.

| Command                                         | Positional parameters                                        | What it does                                                                                                                  | Exit codes                                          |
| ----------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `servicenow-mcp-ai`                             | _(none)_                                                    | Starts the MCP server. The transport (`stdio` default, or `http`) is chosen by `SN_TRANSPORT`; runs until `SIGINT`/`SIGTERM`. | `0` clean shutdown · `1` fatal startup error        |
| `servicenow-mcp-ai login`                       | _(none — operates on the active profile)_                   | One-time OAuth 2.1 Authorization Code + PKCE login: opens the browser, captures the loopback redirect, stores a refresh token. | `0` success · `1` login failed                      |
| `servicenow-mcp-ai drift <profileA> <profileB>` | `<profileA>`, `<profileB>` — two configured profile names   | DF-3 CI drift gate: compares the two instances and writes a Markdown diff report.                                            | `0` no drift · `1` drift found · `2` usage / error  |

**`login`** operates on the active profile (`SN_ACTIVE_PROFILE`, default
`default`) and reads, for that profile:

- `SN_INSTANCE` — **required**; the target instance.
- `SN_OAUTH_CLIENT_ID` — **required**; client id of an Authorization Code OAuth API endpoint.
- `SN_OAUTH_CLIENT_SECRET` — optional; for a confidential client.
- `SN_OAUTH_REDIRECT_URI` — optional; loopback URL, default `http://localhost:53682/callback`. Must match the redirect registered on the endpoint.
- `SN_OAUTH_SCOPE` — optional; requested OAuth scope.

On success it writes `SN_AUTH=oauth`, `SN_OAUTH_GRANT=refresh_token` and
`SN_OAUTH_REFRESH_TOKEN` back to the env file (profile-prefixed when the profile
is not `default`). The authorization URL is printed on stderr in case the browser
does not open automatically.

**`drift`** takes two positional profile names; each must resolve to a configured
profile (`SN_PROFILE_<NAME>_*`, or the bare `SN_INSTANCE` / `SN_USER` /
`SN_PASSWORD` keys for `default`). The Markdown report is written to **stdout**
(capture it as a CI artifact); a one-line drift summary goes to stderr.

### CI drift gate (DF-3)

Compare two configured profiles and **fail a pipeline on configuration drift**:

```bash
servicenow-mcp-ai drift dev prod   # report on stdout; exit 1 on drift, 0 if clean, 2 on error
```

## Develop

```bash
npm run check     # full gate: build, lint, format check, coverage-gated tests, prod audit
npm test          # unit tests only (node:test; needs a prior npm run build)
npm run lint      # ESLint (flat config + typescript-eslint)
npm run format    # format with Prettier
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions (one commit per
task, tests ship with the change, generated docs).

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
| `scripts` | `servicenow_where_used` | yes | Find where a table, field or script is referenced across the instance's code: textual references in every s… |
| `flows` | `servicenow_trace_table_event` | yes | Deterministically trace what ServiceNow would run for a table operation, in execution order: display/before… |
| `flows` | `servicenow_list_flows` | yes | List Flow Designer flows (sys_hub_flow) or legacy workflows (kind: 'workflow') as compact metadata |
| `flows` | `servicenow_get_flow` | yes | Get a structured view of one flow or workflow: its trigger (table/condition/when) and ordered steps |
| `flows` | `servicenow_get_flow_runs` | yes | Read flow execution evidence from sys_flow_context — by flow sys_id or by the record (document) it ran agai… |
| `codecheck` | `servicenow_lint_script` | yes | Run deterministic code-quality rules over one script artefact (hard-coded sys_ids/URLs, unbounded or in-loo… |
| `codecheck` | `servicenow_lint_table` | yes | Lint every active business rule, client script and UI policy of a table (via table_logic), returning per-sc… |
| `codecheck` | `servicenow_code_health` | no | Aggregate code-health picture: script counts by type, a security scan of the access-control layer (ACL scri… |
| `docs` | `servicenow_docs_list` | yes | List the Markdown documents in the local instance-documentation folder (SN_DOCS_DIR) |
| `docs` | `servicenow_docs_read` | yes | Read one Markdown document from the local instance-documentation folder |
| `docs` | `servicenow_docs_search` | yes | Search the local instance documentation for a substring; returns a snippet per match |
| `docs` | `servicenow_docs_write` | no | Create or overwrite a Markdown document in the local docs folder and refresh index.md |
| `docs` | `servicenow_generate_er_diagram` | yes | Build a Mermaid erDiagram from sys_dictionary: an entity per table plus a relationship for every reference … |
| `docs` | `servicenow_generate_table_flow` | yes | Build a Mermaid flowchart of a record's lifecycle on a table, grouping active business rules by phase (disp… |
| `instance` | `servicenow_snapshot_instance` | no | Download the instance's structural metadata into the local docs folder (SN_DOCS_DIR/<profile>/): tables.md+… |
| `instance` | `servicenow_compare_instances` | no | Diff two connection profiles: tables present in only one, common columns whose type/mandatory/reference dif… |
| `email` | `servicenow_send_email` | no | Send an email through the instance's Email API, optionally associated with a record (table + sys_id) |
| `email` | `servicenow_get_email` | yes | Read a sent/received email record by its sys_id (Email API) |
| `atf` | `servicenow_list_atf_tests` | yes | List Automated Test Framework tests (sys_atf_test) as metadata: name, active flag, description |
| `atf` | `servicenow_list_atf_suites` | yes | List Automated Test Framework test suites (sys_atf_test_suite) as metadata |
| `atf` | `servicenow_run_atf_test` | no | Run a single ATF test through the CI/CD API |
| `atf` | `servicenow_run_atf_suite` | no | Run an ATF test suite through the CI/CD API |
| `atf` | `servicenow_get_atf_result` | yes | Poll an ATF run by its execution id: status, percent complete and message (CI/CD progress API) |
| `admin` | `servicenow_set_credentials` | no | Save or update the ServiceNow connection credentials |
| `admin` | `servicenow_list_instances` | yes | List the configured ServiceNow connection profiles (instances): name, host, user, read-only flag and whethe… |
| `admin` | `servicenow_use_instance` | no | Switch the active ServiceNow connection profile (persisted to the env file) |
| `admin` | `servicenow_get_status` | yes | Show the configured instance, user, auth mode and access policy, and whether credentials are complete |
| `admin` | `servicenow_test_connection` | yes | Verify that the configured credentials actually work: reads one sys_user record and reports ok/status/latency |
| `admin` | `servicenow_check_capabilities` | yes | Preflight which admin-restricted sys_* tables the connected user can actually read, and report which higher… |

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
  `flows`, `codecheck`, `docs`, `instance`, `email`, `atf`.

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
├── .env                   # credentials (git-ignored; or ~/.config/servicenow-mcp-ai/.env)
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

> **Note on names:** the npm package and the GitHub repository are both
> [`servicenow-mcp-ai`](https://github.com/LeassTaTT/servicenow-mcp-ai) (the
> unscoped `servicenow-mcp` was already taken on npm); the local working folder
> is `servicenow-mcp`. The difference is cosmetic and does not affect the build
> or runtime.

## Security notes

- The env file is git-ignored — do not commit real credentials.
- The env file is written **owner-only (`0600`)** — it holds a plaintext password.
- The server uses the stdio transport and only logs to `stderr`; secrets and raw
  encoded queries are never logged.
- The password/token is never returned by any tool.
- Hosts are restricted: without `SN_ALLOWED_HOSTS`, only `*.service-now.com`
  instances are contacted (internal/loopback always blocked), so a redirected or
  mistyped host cannot silently receive credentials. Set `SN_ALLOWED_HOSTS` to
  opt in a custom or sovereign-cloud domain.
- Prefer **OAuth 2.0** over Basic where possible (`SN_OAUTH_CLIENT_ID`).
- Apply least privilege with `SN_TABLES_ALLOW` / `SN_TABLES_DENY` and
  `SN_READONLY=true` for read-only deployments.
- **Table policy does not cover plugin APIs.** `SN_TABLES_DENY=change_request`
  blocks the Table API path, but the Change Management API (`sn_chg_rest`) can
  still read/write changes. To restrict the plugin-backed surfaces use
  `SN_PACKAGES_DENY` (drop the whole package) or `SN_PACKAGES_READONLY`
  (register only its read tools). The Batch API obeys both axes too: a
  sub-request to a denied package's path is refused, and writes to a read-only
  package are blocked — a batch cannot be used to bypass the package policy.

## Project documentation

| Document | Contents |
| -------- | -------- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layered architecture, Mermaid diagrams (modules, request lifecycle, security model, auth, packages), condensed ADRs |
| [PRODUCT-STATE.md](PRODUCT-STATE.md) | Current product state: API coverage map, quality status, history timeline, roadmap |
| [ROADMAP.md](ROADMAP.md) | Forward plan: ship 1.0.0, Phase 8 (flow testing + code analysis), Phase 9 (competitive differentiators), optional and deferred items |
| [COMPETITIVE-ANALYSIS.md](COMPETITIVE-ANALYSIS.md) | Positioning vs the official ServiceNow MCP Server Console: comparison, where it structurally lags, the Phase 9 boost plan, and platform risks |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | Detailed specs for the upcoming phases (harness 2.0, multi-instance, flow testing) |
| [DONE.md](DONE.md) / [TODO.md](TODO.md) | Completed work with commit refs / remaining decisions |
| [WORKLOG.md](WORKLOG.md) / [CHANGELOG.md](CHANGELOG.md) | Detailed work journal / user-facing changelog |
| [CONTRIBUTING.md](CONTRIBUTING.md) / [SECURITY.md](SECURITY.md) | Dev setup, gates and conventions / security model and reporting |

## Trademark

`servicenow-mcp-ai` is an independent, community-built project. It is **not
affiliated with, endorsed by, or sponsored by ServiceNow, Inc.**

"ServiceNow", the ServiceNow logo, "Now", and related marks are trademarks or
registered trademarks of ServiceNow, Inc. in the United States and other
countries. They are used in this project's name and documentation **only
nominatively** — to identify the platform this software interoperates with — and
no affiliation or endorsement is implied. All other product names and marks are
the property of their respective owners.

This project is licensed under the [MIT License](LICENSE); that license covers
the source code and does not grant any rights to use the ServiceNow trademarks.
