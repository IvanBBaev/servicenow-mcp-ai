> The servicenow-mcp-ai documentation site (https://ivanbbaev.github.io/servicenow-mcp-ai/) as Markdown, generated from `docs/index.html` by `npm run docs:sync`. The tool reference is https://ivanbbaev.github.io/servicenow-mcp-ai/llms-full.txt.

Model Context Protocol · ServiceNow

# Drive ServiceNow from your AI assistant.

**servicenow-mcp-ai** is an MCP server that turns any MCP-capable AI client — Claude Desktop, Claude Code, VS Code Chat — into a ServiceNow power user. It reads and writes across the full REST surface, understands the instance's own code, and keeps least-privilege guardrails between the model and your data.

Get started → [View on GitHub](https://github.com/IvanBBaev/servicenow-mcp-ai) See use cases

- MIT licensed
- Node.js 22.12+
- TypeScript · ESM
- MCP SDK 1.29
- OAuth 2.1 PKCE

- **101** tools
- **26** packages
- **6** MCP resources
- **3** prompts
- **10+** ServiceNow APIs

Quick demo

## Three things the platform makes hard.

One call each — all read-only, against any instance (a free PDI included). The IDE-grade answers ServiceNow has no button for.

### Find usages, instance-wide.

Every script, business rule, client script, UI policy/action and ACL that touches a field — as JSON or a Mermaid graph. The IDE-grade *find usages* ServiceNow has no button for.

read `servicenow_where_used`

// "Where is u_cost_center used? Draw the graph."

```
{ "kind": "field", "name": "u_cost_center", "mermaid": true }
```

### Trace the automation chain.

The full chain in execution order — display → before → after → async business rules, then flows, workflows and notifications — each with its condition. A logical test that runs **nothing**.

read `servicenow_trace_table_event`

// "Trace what runs when an incident is updated."

```
{ "table": "incident", "operation": "update" }
```

### Diff two instances.

A Markdown diff of tables, columns, scripts (by SHA-256) and plugins between two configured profiles, with a CI-friendly exit code so a pipeline can block a risky deploy.

read `servicenow-mcp-ai drift`

# report on stdout; exit 1 on drift, 0 if clean

```
servicenow-mcp-ai drift dev prod
```

## What is this, exactly?

The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is an open standard that lets an AI assistant call external *tools* and read external *resources*. This project is an MCP **server** for ServiceNow: you register it with your MCP client once, and from then on the assistant can run real actions against your instance — query a table, create a change, inspect a business rule, compare two environments — instead of just talking about them.

You never call the tools by hand. You talk to your AI assistant in natural language; it picks the right `servicenow_*` tool, fills in the arguments, and shows you the result. The server's job is to make that safe and accurate.

## Capabilities

Breadth of the platform, plus three things a generic CRUD connector doesn't give you.

### Full REST surface

Table (CRUD + encoded queries + pagination), Aggregate, Attachment, Import Set, Batch, CMDB/IRE, plus the Catalog, Change, Knowledge and Email plugin APIs.

### Script intelligence

Read and search the instance's own code — business rules, script includes, client scripts, UI policies/actions, ACLs, and (not yet verified live) portal widgets, UI pages/scripts/macros, processors, fix/email/validation scripts, transform maps and dictionary calculations — and get a table's full automation picture. Read-only.

### Flow & code checking

Trace what a table operation would run (ordered, with a Mermaid flowchart), read Flow Designer flows and run history, lint scripts against a local rule set, and run ATF tests via the CI/CD API.

### Multi-instance

Named profiles (dev / test / prod) with per-call routing, per-profile policy, plus `snapshot_instance` and `compare_instances` to catch environment drift.

### Self-documentation

A local Markdown knowledge base and deterministic Mermaid generators (ER diagrams, record-lifecycle flowcharts) so the assistant builds durable, reusable context.

### Governance by design

Two-axis policy (tables + packages), global read-only mode, SSRF guard, host allow-list, and an elicitation confirm before credentials change.

### Resilience

Per-request timeout, retry with backoff and `Retry-After`, a concurrency semaphore, schema caching, and a result-size guard against oversized payloads.

Quick start

## Connected in under a minute.

Install once, point it at your instance, and add it to any MCP client. You need **Node.js 22.12+** and a ServiceNow instance you can reach (a free [Personal Developer Instance](https://developer.servicenow.com/) works great).

1 Install the server

```
npm install -g servicenow-mcp-ai
```

2 Point it at your instance

```
export SN_INSTANCE=dev12345.service-now.com
export SN_USER=admin
export SN_PASSWORD=••••••
```

3 Verify the connection

```
servicenow_test_connection
```

// ~/Library/Application Support/Claude/claude_desktop_config.json

```
{
  "mcpServers": {
    "servicenow": {
      "command": "servicenow-mcp-ai"
    }
  }
}
```

**VS Code users:** skip the manual config — install the [ServiceNow MCP](https://marketplace.visualstudio.com/items?itemName=ivanbbaev.servicenow-mcp-ai) extension (`code --install-extension ivanbbaev.servicenow-mcp-ai`). It registers the server in GitHub Copilot Chat (agent mode) automatically — no `.vscode/mcp.json` needed.

`SN_INSTANCE` accepts `dev12345`, `dev12345.service-now.com` or a full `https://` URL. Credentials can also live in a `.env` file (`~/.config/servicenow-mcp-ai/.env` or the project root) and be rotated at runtime via `servicenow_set_credentials`. Step 3 isn't a shell command — it's the `servicenow_test_connection` tool; ask your assistant to call it once the server is wired up.

Don't want a global install? Use `"command": "npx", "args": ["-y", "servicenow-mcp-ai"]` instead. On the Claude Code CLI it's a one-liner: `claude mcp add servicenow -- npx -y servicenow-mcp-ai`.

### Talk to your assistant

That's it. Try something like:

You → assistant "Using ServiceNow, list the 5 most recent active incidents with their number, short description and priority."

The assistant calls `servicenow_query_table` with the right encoded query and returns the rows.

**First time? Start safe.** Set `SN_READONLY=true` so the assistant can read and explore but never writes, and keep the default `SN_TOOL_PACKAGES=core` to expose a small tool set. Loosen both once you trust the workflow.

Developing from source instead? `npm install && npm run build`, then `npm run inspector` to drive it from the MCP Inspector, or `npm start` to run it directly.

## Install in your client

Every client runs the same stdio command, `npx -y servicenow-mcp-ai`, under the server name `servicenow`. The links and snippets carry **no credentials** — keep those in `~/.config/servicenow-mcp-ai/.env`, run `npx servicenow-mcp-ai login` for OAuth, or call `servicenow_set_credentials` once connected.

One click: [Install in VS Code](vscode:mcp/install?%7B%22name%22%3A%22servicenow%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22servicenow-mcp-ai%22%5D%7D) · [Install in VS Code Insiders](vscode-insiders:mcp/install?%7B%22name%22%3A%22servicenow%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22servicenow-mcp-ai%22%5D%7D) · [Install in Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=servicenow&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNlcnZpY2Vub3ctbWNwLWFpIl19) (via the web: [VS Code](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522servicenow%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522servicenow-mcp-ai%2522%255D%257D), [Insiders](https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522servicenow%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522servicenow-mcp-ai%2522%255D%257D), [Cursor](https://cursor.com/en/install-mcp?name=servicenow&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNlcnZpY2Vub3ctbWNwLWFpIl19)).

| Client | One line | Config file |
| --- | --- | --- |
| VS Code (Copilot Chat) | `code --add-mcp '{"name":"servicenow","command":"npx","args":["-y","servicenow-mcp-ai"]}'` — or the [ServiceNow MCP extension](https://marketplace.visualstudio.com/items?itemName=ivanbbaev.servicenow-mcp-ai) (zero-config) | `.vscode/mcp.json` (`servers`) |
| VS Code Insiders | `code-insiders --add-mcp '{"name":"servicenow","command":"npx","args":["-y","servicenow-mcp-ai"]}'` | `.vscode/mcp.json` (`servers`) |
| Claude Code | `claude mcp add servicenow --scope user -- npx -y servicenow-mcp-ai` — or the plugin: `/plugin marketplace add IvanBBaev/servicenow-mcp-ai` then `/plugin install servicenow-mcp-ai` | `.mcp.json` (`mcpServers`) |
| Claude Desktop | — (Settings → Developer → Edit Config) | `claude_desktop_config.json` (`mcpServers`) |
| Cursor | the one-click link above | `~/.cursor/mcp.json` / `.cursor/mcp.json` (`mcpServers`) |
| Windsurf | — | `~/.codeium/windsurf/mcp_config.json` (`mcpServers`) |
| Cline | — (MCP Servers → Configure MCP Servers) | `cline_mcp_settings.json` (`mcpServers`) |
| Zed | — | `settings.json` (`context_servers`) |
| JetBrains AI Assistant | — (Settings → Tools → AI Assistant → Model Context Protocol → Add → As JSON) | JSON dialog (`mcpServers`) |
| Gemini CLI | — | `~/.gemini/settings.json` (`mcpServers`) |
| Codex CLI | `codex mcp add servicenow -- npx -y servicenow-mcp-ai` | `~/.codex/config.toml` (`[mcp_servers.servicenow]`) |

### The `mcpServers` block

Claude Desktop, Cursor, Windsurf, Cline, JetBrains AI Assistant and Gemini CLI all take this block unchanged (VS Code's `mcp.json` uses `"servers"` instead of `"mcpServers"`):

```
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": ["-y", "servicenow-mcp-ai"]
    }
  }
}
```

### Zed and Codex CLI

```
// Zed settings.json
{
  "context_servers": {
    "servicenow": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "servicenow-mcp-ai"],
      "env": {}
    }
  }
}
```

```
# ~/.codex/config.toml
[mcp_servers.servicenow]
command = "npx"
args = ["-y", "servicenow-mcp-ai"]
```

**Keep secrets out of client configs.** A variable set in a client's `env` block (or via `claude mcp add --env` / `codex mcp add --env`) overrides the env file. Put at most non-secret values there, such as `SN_INSTANCE=your-instance.service-now.com`; never `SN_PASSWORD` or a token in a config you share or commit. The links are generated from `package.json` by `scripts/install-links.mjs` and checked by a test.

## Credentials & where they live

The env file is resolved in this order:

1. `SN_ENV_FILE` — an explicit path, if set.
2. `~/.config/servicenow-mcp-ai/.env` (XDG) — if it exists. A global / `npx` install writes here, not into `node_modules`.
3. The project-root `.env` (local development).

Real environment variables always win over the file. The file is written **owner-only (`0600`)** because it holds a plaintext password, and it is git-ignored — never commit real credentials.

The password / token is **never** logged and never returned by any tool. `servicenow_get_status` reports only whether a password is set.

## Authentication

Basic auth works out of the box from the three required variables. For OAuth the recommended path is **OAuth 2.1 — Authorization Code + PKCE** via a one-time interactive login (no password is ever stored):

```
# 1) Register an "Authorization Code" OAuth endpoint in ServiceNow with a
#    loopback redirect, e.g. http://localhost:53682/callback
# 2) Set the client id (and secret for a confidential client):
SN_OAUTH_CLIENT_ID=your-client-id
SN_OAUTH_CLIENT_SECRET=your-client-secret
# 3) Log in once — opens the browser, captures the redirect, stores a refresh token:
npx servicenow-mcp-ai login
```

PKCE (S256) is always used, the loopback listener captures the redirect automatically, and the obtained **refresh token** is persisted — the server then runs non-interactively (refresh_token grant). The OAuth 2.0 **password grant (ROPC) is deprecated** and disabled on many instances; `client_credentials` and `refresh_token` remain available for service accounts.

Tokens are cached per host until just before expiry and are dropped automatically on a credential change or a server-side `401` (one transparent re-auth, then a real error). With named profiles you can even mix modes — `prod` on OAuth, `dev` on Basic — via the `SN_PROFILE_<NAME>_AUTH` / `_OAUTH_*` keys.

### Every method ServiceNow supports

| Method | `SN_AUTH` | How |
| --- | --- | --- |
| Basic | `basic` | `SN_USER` / `SN_PASSWORD` (default). |
| OAuth 2.1 — Auth Code + PKCE | `oauth` | `login` (recommended). |
| OAuth — Client Credentials | `oauth` | `SN_OAUTH_GRANT=client_credentials`. |
| OAuth — Refresh Token | `oauth` | `refresh_token` + `SN_OAUTH_REFRESH_TOKEN`. |
| OAuth — JWT Bearer | `oauth` | `jwt_bearer` + `SN_OAUTH_JWT_KEY` (RS256). |
| OAuth — Password (ROPC) | `oauth` | `password` — deprecated. |
| API Key | `apikey` | `SN_API_KEY` → `x-sn-apikey`. |
| Bearer token | `token` | `SN_BEARER_TOKEN`, used verbatim. |
| Mutual TLS (client cert) | `none` | `SN_TLS_CLIENT_CERT` / `_KEY` (optional `undici`). |

### Multiple instances (dev + prod)

Define a profile per environment. A great default is a **read-only prod and a full-access dev** in one server:

```
# dev — full access (the default profile)
SN_PROFILE_DEV_INSTANCE=dev12345.service-now.com
SN_PROFILE_DEV_USER=admin
SN_PROFILE_DEV_PASSWORD=••••••

# prod — read-only
SN_PROFILE_PROD_INSTANCE=acme.service-now.com
SN_PROFILE_PROD_USER=svc.readonly
SN_PROFILE_PROD_PASSWORD=••••••
SN_PROFILE_PROD_READONLY=true

SN_ACTIVE_PROFILE=dev
```

Switch the active one with `servicenow_use_instance`, or target a single call by passing the automatic `instance` argument — every tool accepts it.

## Command-line interface

The published `servicenow-mcp-ai` binary — run it directly or via `npx servicenow-mcp-ai` — has three invocations. All connection settings come from environment variables (see Environment variables); only `drift` takes positional arguments.

| Command | Positional parameters | What it does | Exit codes |
| --- | --- | --- | --- |
| `servicenow-mcp-ai` | *none* | Starts the MCP server; the transport (`stdio` default, or `http`) is chosen by `SN_TRANSPORT`. Runs until `SIGINT`/`SIGTERM`. | `0` clean shutdown · `1` fatal startup error |
| `servicenow-mcp-ai login` | *none* — the active profile | One-time OAuth 2.1 Authorization Code + PKCE login: opens the browser, captures the loopback redirect, stores a refresh token. | `0` success · `1` login failed |
| `servicenow-mcp-ai drift <profileA> <profileB>` | two configured profile names | DF-3 CI drift gate: compares the two instances and writes a Markdown diff report to stdout. | `0` no drift · `1` drift found · `2` usage / error |

### `login` — interactive OAuth

Operates on the active profile (`SN_ACTIVE_PROFILE`, default `default`) and reads, for that profile:

- `SN_INSTANCE` — **required**; the target instance.
- `SN_OAUTH_CLIENT_ID` — **required**; client id of an Authorization Code OAuth API endpoint.
- `SN_OAUTH_CLIENT_SECRET` — optional; for a confidential client.
- `SN_OAUTH_REDIRECT_URI` — optional; loopback URL, default `http://localhost:53682/callback`. Must match the redirect registered on the endpoint.
- `SN_OAUTH_SCOPE` — optional; requested OAuth scope.

On success it writes `SN_AUTH=oauth`, `SN_OAUTH_GRANT=refresh_token` and `SN_OAUTH_REFRESH_TOKEN` back to the env file (profile-prefixed when the profile is not `default`). The authorization URL is printed on stderr in case the browser does not open automatically.

```
npx servicenow-mcp-ai login
```

### `drift` — CI drift gate (DF-3)

Takes two positional profile names; each must resolve to a configured profile (`SN_PROFILE_<NAME>_*`, or the bare `SN_INSTANCE` / `SN_USER` / `SN_PASSWORD` keys for `default`). The Markdown report goes to **stdout** (capture it as a CI artifact); a one-line drift summary goes to stderr — so a pipeline can block a deploy on configuration drift.

```
servicenow-mcp-ai drift dev prod   # report on stdout; exit 1 on drift, 0 if clean, 2 on error
```

## Environment variables

Only the first three are required; the rest are optional tuning knobs. See [.env.example](https://github.com/IvanBBaev/servicenow-mcp-ai/blob/main/.env.example) for a template.

| Variable | Default | Description |
| --- | --- | --- |
| `SN_INSTANCE` * | — | Instance name, host, or `https://` URL. |
| `SN_USER` * | — | ServiceNow username for Basic auth. |
| `SN_PASSWORD` * | — | Password. Never logged or returned. |
| `SN_TIMEOUT_MS` | `30000` | Per-request timeout (ms). |
| `SN_MAX_RETRIES` | `2` | Retries for transient failures (429/5xx, network). Writes retried only on connect errors. |
| `SN_MAX_RECORDS` | `10000` | Hard cap on a `fetchAll` query. |
| `SN_MAX_RESULT_CHARS` | `100000` | Character budget before a query result is truncated (the note names `format:"file"`); other results over it gain a note. |
| `SN_OVERSIZE_TO_FILE` | `false` | Write snapshot, compare and diagram results over the budget to a file under `SN_DOCS_DIR` and return `{path, bytes, preview}`. |
| `SN_ALLOWED_HOSTS` | — | Allow-list of hosts. Unset → only `*.service-now.com` is reachable (SSRF guard). |
| `SN_AUTH` | auto | `basic` or `oauth`. |
| `SN_OAUTH_CLIENT_ID` | — | OAuth client id (its presence enables OAuth). |
| `SN_OAUTH_CLIENT_SECRET` | — | OAuth client secret. |
| `SN_OAUTH_GRANT` | `password` | `password` · `client_credentials` · `refresh_token`. |
| `SN_OAUTH_REFRESH_TOKEN` | — | Required only for the refresh_token grant. |
| `SN_TABLES_ALLOW` | — | Allowlist; when set, only these tables are reachable. |
| `SN_TABLES_DENY` | — | Denylist; always wins over the allowlist. |
| `SN_READONLY` | `false` | When truthy, refuse every create/update/delete. |
| `SN_WRITE_MODE` | `plan` | `plan` (default) previews a write as a before/after diff without mutating; `apply` executes. A tool's `apply:true` forces one call. |
| `SN_UPDATE_SET` | — | Update set (sys_id or exact name) that applied Table-tool writes land in; a per-call `update_set` overrides it. The plan names the set; the user's current update set is restored after the write. |
| `SN_LOG_LEVEL` | `info` | `error` · `warn` · `info` · `debug` (stderr). |
| `SN_LOG_FORMAT` | `json` | `json` · `text` (stderr line format). |
| `SN_LOG_FILE` | — | Also write JSON log lines to this size-rotated file. |
| `SN_LOG_NOTIFY_RATE` | `20` | Log notifications per second and client session (burst 50); the excess is summarised once a minute. `0` = no limit. |
| `SN_ENV_FILE` | — | Explicit path to the env file. |
| `SN_TOOL_PACKAGES` | `core` | Packages/profiles to enable (see below). |
| `SN_PACKAGES_DENY` | — | Drop whole packages — the only way to block plugin APIs. |
| `SN_PACKAGES_READONLY` | — | Register only a package's read tools. |
| `SN_SCHEMA_CACHE_TTL_SEC` | `300` | TTL for the schema-read cache. `0` disables. |
| `SN_MAX_CONCURRENT` | `4` | Max parallel HTTP requests to the instance. |
| `SN_INCLUDE_REF_LINKS` | `false` | Include reference-field `link` URLs (token cost). |
| `SN_RESULT_PRETTY` | `false` | Pretty-print results (≈2× tokens). |
| `SN_DOCS_DIR` | `docs/instance` | Where the `docs` package reads/writes Markdown. |
| `SN_CODESEARCH` | `false` | Use the Code Search API for `search_code` when `true` (FT-7); falls back to the LIKE search. |
| `SN_PROFILE_<NAME>_*` | — | Named profiles: `SN_PROFILE_DEV_INSTANCE` / `_USER` / `_PASSWORD` (+ optional `_AUTH` / `_OAUTH_*` / `_READONLY` / `_TABLES_*`). |
| `SN_ACTIVE_PROFILE` | `default` | Which profile tools use; switch with `servicenow_use_instance`. |

* required.

## Tool packages

Tools are grouped into packages so you expose only what a given client needs — fewer tools keep the model focused. Set `SN_TOOL_PACKAGES` to a comma/space-separated list of profiles or package names:

- `core` (default) — `table`, `schema`, `aggregate`, `attachment`.
- `all` — every package.
- Individual: `table`, `schema`, `aggregate`, `attachment`, `importset`, `batch`, `catalog`, `change`, `knowledge`, `cmdb`, `scripts`, `flows`, `codecheck`, `docs`, `instance`, `email`, `atf`, `revert`, `artifacts`, `updatesets`, `ops`, `history`, `properties`, `directory`, `ui`.

```
# Only table + batch tools (the admin tools are always on)
SN_TOOL_PACKAGES=table,batch
```

The admin tools are always registered regardless of packages. Unknown names are ignored, and `servicenow_get_status` reports the resolved `enabledPackages`.

## Tools reference

101 tools across 26 packages. read tools never mutate the instance; write tools respect the read-only and policy guards. **Click any tool** to expand its full parameter list — name, type, whether it is required and any allowed values.

No tools match that search.

### table — Record CRUD and upsert over the Table API. *(6 tools)*

`servicenow_query_table` read Read records from any ServiceNow table through the Table API. Supports encoded queries, field selection and pagination.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table name, e.g. 'incident', 'sys_user', 'change_request'. |
| `query` | string | optional |  |
| `fields` | array | optional |  |
| `limit` | number | optional |  |
| `offset` | number | optional |  |
| `displayValue` | enum | optional | one of: `true` · `false` · `all` |
| `fetchAll` | boolean | optional |  |
| `view` | string | optional | sysparm_view — UI view that defines the returned fields. |
| `queryCategory` | string | optional | sysparm_query_category — query category (index / read replica routing). |
| `noCount` | boolean | optional | sysparm_no_count — skip the COUNT(*) behind X-Total-Count. |
| `queryNoDomain` | boolean | optional | sysparm_query_no_domain — query across domains (domain-separated instances, when permitted). |
| `suppressPaginationHeader` | boolean | optional | sysparm_suppress_pagination_header — omit the Link header. |

`servicenow_get_record` read Read a single record from a table by its sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table name, e.g. 'incident'. |
| `sys_id` | string | required | The sys_id of the record to read. |
| `fields` | array | optional |  |

`servicenow_create_record` write Create a new record in a table with the given field values.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table name, e.g. 'incident'. |
| `values` | object | required | Field name/value pairs for the new record, e.g. { "short_description": "Printer down", "urgency": "2" }. |

`servicenow_update_record` write Update fields on an existing record identified by its sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table name, e.g. 'incident'. |
| `sys_id` | string | required | The sys_id of the record to update. |
| `values` | object | required | Field name/value pairs to change on the record. |

`servicenow_upsert_record` write Create or update one record matched by a key of field/value pairs; more than one match is refused.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table name, e.g. 'cmdb_ci_server'. |
| `key` | object | required | Exact-match field/value pairs that identify the record, e.g. { "u_external_id": "A-17" }. |
| `values` | object | required | Field values to set; on a create the key fields are added. |
| `expected_action` | enum | optional | one of: `create` · `update` — from the plan's apply_with. |
| `expected_sys_id` | string | optional | From the plan's apply_with; STALE_RECORD if the key now resolves elsewhere. |
| `inputDisplayValue` | boolean | optional | sysparm_input_display_value — values are display values. |

`servicenow_delete_record` write Delete a record from a table by its sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table name, e.g. 'incident'. |
| `sys_id` | string | required | The sys_id of the record to delete. |

### schema — Table & column metadata, including the inherited super_class chain. *(2 tools)*

`servicenow_list_tables` read List tables from sys_db_object, optionally filtered by a name or label fragment.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `filter` | string | optional |  |

`servicenow_describe_table` read List a table's columns (name, label, type, mandatory, reference) from sys_dictionary.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table name to describe, e.g. 'incident'. |
| `details` | boolean | optional | Also read choice lists (sys_choice) and dictionary overrides; unreadable ones become warnings. |

### aggregate — Server-side statistics (count / avg / min / max / sum) via the Stats API. *(1 tool)*

`servicenow_aggregate` read Compute server-side aggregates (count, avg, min, max, sum) over a table via the Stats API, with optional grouping. Avoids pulling individual rows.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table name, e.g. 'incident'. |
| `query` | string | optional |  |
| `count` | boolean | optional |  |
| `avg_fields` | array | optional |  |
| `min_fields` | array | optional |  |
| `max_fields` | array | optional |  |
| `sum_fields` | array | optional |  |
| `group_by` | array | optional |  |
| `having` | string | optional |  |

### attachment — File attachments — list, read, download, upload and delete. *(5 tools)*

`servicenow_list_attachments` read List attachment metadata, optionally scoped to a specific record (table + sys_id).

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | optional |  |
| `sys_id` | string | optional |  |

`servicenow_get_attachment` read Read a single attachment's metadata by its sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | The sys_id of the attachment record. |

`servicenow_download_attachment` read Download an attachment's bytes, returned as base64. Large files are refused (see SN_MAX_RESULT_CHARS).

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | The sys_id of the attachment to download. |

`servicenow_upload_attachment` write Attach a file (provided as base64) to a record identified by table + sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table the record belongs to. |
| `sys_id` | string | required | sys_id of the record to attach to. |
| `file_name` | string | required | File name to store, e.g. 'log.txt'. |
| `content_base64` | string | required | File contents, base64-encoded. |
| `content_type` | string | optional |  |

`servicenow_delete_attachment` write Delete an attachment by its sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | The sys_id of the attachment to delete. |

### importset — Import Set staging inserts and their transform outcome. *(2 tools)*

`servicenow_insert_import_set_row` write Insert a single row into a staging table and run its transform map. Returns the transform result.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Import staging table, e.g. 'u_imp_incident'. |
| `values` | object | required | Column name/value pairs for the staging row. |

`servicenow_get_import_set_row` read Read the transform outcome for a previously inserted staging row by its sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Import staging table name. |
| `sys_id` | string | required | sys_id of the staging row. |

### batch — Several REST sub-requests in a single round-trip; policy is enforced per sub-request. *(1 tool)*

`servicenow_batch` write Execute several ServiceNow REST sub-requests in a single HTTP round-trip via the Batch API. Each sub-request runs through the same read-only and table-access policy as a direct call.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `requests` | array | required | The sub-requests to run together. |

### catalog — Service Catalog — browse catalogs, categories and items, then order. *(5 tools)*

`servicenow_list_catalogs` read List the Service Catalogs available on the instance (Service Catalog API).

No parameters.

`servicenow_list_catalog_categories` read List the categories within a service catalog.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | sys_id of the catalog. |

`servicenow_list_catalog_items` read Search/list orderable catalog items, optionally by text or category.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `text` | string | optional |  |
| `category` | string | optional |  |
| `limit` | number | optional |  |
| `offset` | number | optional |  |

`servicenow_get_catalog_item` read Get a catalog item, including its order variables, by sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | sys_id of the catalog item. |

`servicenow_order_catalog_item` write Order a catalog item directly ('order now'). Creates a request/RITM. Provide variable values keyed by their names.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | sys_id of the catalog item. |
| `quantity` | number | optional |  |
| `variables` | object | optional |  |

### change — Change Management — typed create (normal / standard / emergency), conflicts, update. *(5 tools)*

`servicenow_list_changes` read List change requests through the Change Management API. Supports an encoded query, field selection and paging.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `query` | string | optional |  |
| `fields` | array | optional |  |
| `limit` | number | optional |  |
| `offset` | number | optional |  |

`servicenow_get_change` read Get a single change request by sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | sys_id of the change request. |

`servicenow_create_change` write Create a normal, standard or emergency change. Standard changes require a template_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `type` | enum | required | Change type. — one of: `normal` · `standard` · `emergency` |
| `template_id` | string | optional |  |
| `values` | object | optional | Change field name/value pairs, e.g. { "short_description": "Patch DB", "risk": "low" }. |

`servicenow_update_change` write Update fields on a change request by sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | sys_id of the change request. |
| `values` | object | required | Change field name/value pairs, e.g. { "short_description": "Patch DB", "risk": "low" }. |

`servicenow_check_change_conflicts` write Read schedule conflicts for a change, or recalculate them (calculate=true). Recalculation is a write and is blocked in read-only mode.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | sys_id of the change request. |
| `calculate` | boolean | optional |  |

### knowledge — Knowledge Base — relevance search and article retrieval. *(3 tools)*

`servicenow_search_knowledge` read Full-text search of knowledge articles (Knowledge API), with optional encoded query and paging.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `search` | string | optional |  |
| `query` | string | optional |  |
| `fields` | array | optional |  |
| `limit` | number | optional |  |
| `offset` | number | optional |  |

`servicenow_get_knowledge_article` read Get a knowledge article (content and metadata) by sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | sys_id of the knowledge article. |

`servicenow_get_knowledge_highlights` read List featured or most-viewed knowledge articles for the current user.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `mode` | enum | required | Which highlight list to return. — one of: `featured` · `most_viewed` |
| `limit` | number | optional |  |

### cmdb — Class-aware configuration items through Identification & Reconciliation (IRE). *(5 tools)*

`servicenow_list_cis` read List configuration items of a CMDB class through the class-aware CMDB Instance API.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | CMDB class/table, e.g. 'cmdb_ci_server'. Deprecated alias: `class_name`. |
| `query` | string | optional |  |
| `limit` | number | optional |  |
| `offset` | number | optional |  |

`servicenow_get_ci` read Get a CI with its attributes and inbound/outbound relations by class and sys_id.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | CMDB class, e.g. 'cmdb_ci_server'. Deprecated alias: `class_name`. |
| `sys_id` | string | required | sys_id of the CI. |

`servicenow_create_ci` write Create a CI via the CMDB Instance API (routed through Identification & Reconciliation).

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | CMDB class, e.g. 'cmdb_ci_server'. Deprecated alias: `class_name`. |
| `values` | object | required | CI attribute name/value pairs. |
| `source` | string | optional |  |

`servicenow_update_ci` write Update a CI's attributes via the CMDB Instance API (IRE).

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | CMDB class, e.g. 'cmdb_ci_server'. Deprecated alias: `class_name`. |
| `sys_id` | string | required | sys_id of the CI. |
| `values` | object | required | CI attribute name/value pairs. |
| `source` | string | optional |  |

`servicenow_get_cmdb_meta` read Get the schema/metadata of a CMDB class (attributes, relationship rules) from the CMDB Meta API.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | CMDB class, e.g. 'cmdb_ci_server'. Deprecated alias: `class_name`. |

### scripts — Read-only code intelligence over server-side script artefacts. *(5 tools)*

`servicenow_list_scripts` read List script artefacts of one type as compact metadata (no source code). Types: business_rule, script_include, client_script, ui_policy, ui_action, scheduled_job, transform, rest_operation, acl. Filter by applied table, name fragment, active flag, or a raw encoded query.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `type` | enum | required | Script type. One of: business_rule, script_include, client_script, ui_policy, ui_action, scheduled_job, transform, rest_operation, acl. — one of: `business_rule` · `script_include` · `client_script` · `ui_policy` · `ui_action` · `scheduled_job` · `transform` · `rest_operation` · `acl` · `script_action` · `transform_map` · `transform_entry` · `fix_script` · `email_script` · `processor` · `data_source` · `rest_message_fn` · `ui_script` · `ui_page` · `ui_macro` · `validation_script` · `sp_widget` · `catalog_client_script` · `dictionary_script` |
| `table` | string | optional |  |
| `name` | string | optional |  |
| `active` | boolean | optional |  |
| `query` | string | optional |  |
| `limit` | number | optional |  |
| `offset` | number | optional |  |

`servicenow_get_script` read Read one script artefact in full, including its source code and execution context.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `type` | enum | required | Script type. One of: business_rule, script_include, client_script, ui_policy, ui_action, scheduled_job, transform, rest_operation, acl. — one of: `business_rule` · `script_include` · `client_script` · `ui_policy` · `ui_action` · `scheduled_job` · `transform` · `rest_operation` · `acl` · `script_action` · `transform_map` · `transform_entry` · `fix_script` · `email_script` · `processor` · `data_source` · `rest_message_fn` · `ui_script` · `ui_page` · `ui_macro` · `validation_script` · `sp_widget` · `catalog_client_script` · `dictionary_script` |
| `sys_id` | string | required | sys_id of the script record. |

`servicenow_search_code` read Search script source for a literal substring across one or all script types. Returns one entry per artefact with a short snippet of the first hit plus every matching line with one line of context either side (hits, capped at 20 per artefact; hitCount has the full total) — not whole scripts. Answers 'where is X used?'.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `text` | string | required | Substring to search for in script source. |
| `type` | enum | optional | one of: `business_rule` · `script_include` · `client_script` · `ui_policy` · `ui_action` · `scheduled_job` · `transform` · `rest_operation` · `acl` · `script_action` · `transform_map` · `transform_entry` · `fix_script` · `email_script` · `processor` · `data_source` · `rest_message_fn` · `ui_script` · `ui_page` · `ui_macro` · `validation_script` · `sp_widget` · `catalog_client_script` · `dictionary_script` |
| `table` | string | optional |  |
| `scope` | string | optional | Application scope: namespace (e.g. `x_acme_app`, `global`) or `sys_scope` sys_id. |
| `limit` | number | optional |  |

`servicenow_describe_table_logic` read Assemble the automation that runs on a table: business rules (ordered by when+order), client scripts, UI policies, UI actions and ACLs. Metadata only.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table to analyse, e.g. 'incident'. |

`servicenow_where_used` read Find where a table, field or script is referenced across the instance's code: textual references in every script source, plus (for a table) the business rules, client scripts, UI policies/actions and ACLs attached to it. Each textual reference lists its matching lines (up to 5 per artefact, hitCount has the total). Optionally restricted to one application scope. Read-only; optionally renders a Mermaid reference graph.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `kind` | enum | required | What to look up: one of `table` · `field` · `script`. |
| `name` | string | required | The table/field/script name to find usages of. |
| `mermaid` | boolean | optional | Also render a Mermaid reference graph. |
| `scope` | string | optional | Application scope: namespace or `sys_scope` sys_id. |

### flows — Flow & automation intelligence (read-only) — event tracing, Flow Designer, run history. *(5 tools)*

`servicenow_trace_table_event` read Deterministically trace what ServiceNow would run for a table operation, in execution order: display/before/after/async business rules, then flows, workflows and notifications — each with its condition, plus a Mermaid flowchart. A logical test without executing anything. Opt into more lanes with `lanes`: client scripts / UI policies, data policies, SLA definitions, event script actions, transform maps and scheduled jobs.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table to trace, e.g. 'incident'. |
| `operation` | enum | required | The database operation to simulate. — one of: `insert` · `update` · `delete` · `query` |
| `lanes` | array | optional | Opt-in extra lanes — any of: `transform_map` · `scheduled_job` · `client` · `data_policy` · `sla` · `event_script` |

`servicenow_list_flows` read List Flow Designer flows (sys_hub_flow) or legacy workflows (kind: 'workflow') as compact metadata. Filter by applied table, active flag or a name fragment.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `kind` | enum | optional | one of: `flow` · `workflow` |
| `table` | string | optional |  |
| `active` | boolean | optional |  |
| `name` | string | optional |  |
| `limit` | number | optional |  |

`servicenow_get_flow` read Get a structured view of one flow or workflow: its trigger (table/condition/when) and ordered steps. Not a full decompilation — enough to reason about the logic.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | sys_id of the flow or workflow. |
| `kind` | enum | optional | one of: `flow` · `workflow` |

`servicenow_get_flow_runs` read Read flow execution evidence from sys_flow_context — by flow sys_id or by the record (document) it ran against: when it started, its state and the outcome.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `flow` | string | optional |  |
| `record` | string | optional |  |
| `limit` | number | optional |  |

`servicenow_explain_flow` read Explain a flow/subflow (trigger, nested step tree with decoded inputs and pills, draft vs published) or a legacy workflow (activity graph, stages, migration report). Opt-in runs. Unreadable tables become caveats.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | optional | sys_id of the sys_hub_flow or wf_workflow record. |
| `kind` | enum | optional | one of: `flow` · `subflow` · `workflow` |
| `runs` | number | optional | Latest runs to include (0–20). |
| `migration` | boolean | optional | kind:'workflow' only: migration report. |
| `format` | enum | optional | one of: `json` · `markdown` · `mermaid` · `file` |

### codecheck — Local static analysis of instance scripts — no code is executed on the instance. *(3 tools)*

`servicenow_lint_script` read Run deterministic code-quality rules over one script artefact (hard-coded sys_ids/URLs, unbounded or in-loop GlideRecord queries, eval, gs.sleep, setWorkflow(false), client-side GlideRecord, sync getReference, …). Returns findings with rule, severity, line and a fix hint.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `type` | enum | required | Script type. One of: business_rule, script_include, client_script, ui_policy, ui_action, scheduled_job, transform, rest_operation, acl. — one of: `business_rule` · `script_include` · `client_script` · `ui_policy` · `ui_action` · `scheduled_job` · `transform` · `rest_operation` · `acl` · `script_action` · `transform_map` · `transform_entry` · `fix_script` · `email_script` · `processor` · `data_source` · `rest_message_fn` · `ui_script` · `ui_page` · `ui_macro` · `validation_script` · `sp_widget` · `catalog_client_script` · `dictionary_script` |
| `sys_id` | string | required | sys_id of the script record. |

`servicenow_lint_table` read Lint every active business rule, client script and UI policy of a table (via describe_table_logic), returning per-script findings and a severity summary.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table to lint, e.g. 'incident'. |

`servicenow_check_code_health` write Aggregate code-health picture: script counts by type, and (when a table scope is given) the lint findings by severity with the top offenders. Writes a Markdown report to SN_DOCS_DIR/<profile>/code-health.md.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `scope` | string | optional |  |

### docs — Local Markdown self-documentation store and Mermaid diagram generators. *(6 tools)*

`servicenow_list_docs` read List the Markdown documents in the local instance-documentation folder (SN_DOCS_DIR).

No parameters.

`servicenow_read_doc` read Read one Markdown document from the local instance-documentation folder.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `path` | string | required | Document path relative to the docs folder, e.g. 'tables/incident.md'. |

`servicenow_search_docs` read Search the local instance documentation for a substring; returns a snippet per match.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `text` | string | required | Substring to search for across all documents. |

`servicenow_write_doc` write Create or overwrite a Markdown document in the local docs folder and refresh index.md. Use this to record durable knowledge (descriptions, Mermaid diagrams, instance quirks).

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `path` | string | required | Target document path relative to the docs folder, e.g. 'tables/incident.md'. |
| `content` | string | required | Full Markdown content to write. |

`servicenow_generate_er_diagram` read Build a Mermaid erDiagram from sys_dictionary: an entity per table plus a relationship for every reference field. Returns Mermaid markup ready to embed in Markdown.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `tables` | array | required | Tables to include, e.g. ['incident', 'problem']. |

`servicenow_generate_table_flow` read Build a Mermaid flowchart of a record's lifecycle on a table, grouping active business rules by phase (display/before/after/async) in execution order. `lanes` adds the opt-in trace lanes as their own subgraphs.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `table` | string | required | Table to diagram, e.g. 'incident'. |
| `lanes` | array | optional | Opt-in extra lanes — any of: `transform_map` · `scheduled_job` · `client` · `data_policy` · `sla` · `event_script` |

### instance — Cross-instance structural snapshots and comparison. *(2 tools)*

`servicenow_snapshot_instance` write Download the instance's structural metadata into the local docs folder (SN_DOCS_DIR/<profile>/): tables.md+json, schema/<table>.md for the given tables, plugins, installed apps and script-automation statistics, plus an index.md. Markdown is for humans/LLMs, the JSON companions feed instance comparison. Idempotent: re-running overwrites the previous snapshot of the same profile.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `tables` | array | optional |  |
| `sections` | array | optional | Sections to collect (tables, plugins, apps, automation, properties, choices, acls, notifications, flows, catalog, roles); default all. |
| `resume` | boolean | optional | Finish an interrupted snapshot: units whose files still carry the recorded source hash are skipped. |

`servicenow_compare_instances` write Diff two connection profiles: tables present in only one, common columns whose type/mandatory/reference differ, scripts (per type+name) missing or with different source (compared by SHA-256, always live), and plugin/app inventory differences. Writes a Markdown report to _compare/<a>-vs-<b>.md in the docs folder and returns the structured summary. With from_snapshot, tables/plugins/apps are read from the profiles' stored snapshots when available.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `a` | string | required | First connection profile, e.g. 'dev'. |
| `b` | string | required | Second connection profile, e.g. 'prod'. |
| `from_snapshot` | boolean | optional |  |
| `sections` | array | optional | Record sections to diff too (properties, choices, acls, notifications, flows, catalog, roles); opt-in, counted as drift. |

### email — Email — send and read. *(2 tools)*

`servicenow_send_email` write Send an email through the instance's Email API, optionally associated with a record (table + sys_id). Requires the Email API plugin to be active.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `to` | array | required | Recipient email addresses. |
| `subject` | string | required | Email subject. |
| `body` | string | required | Plain-text email body. |
| `cc` | array | optional |  |
| `bcc` | array | optional |  |
| `table` | string | optional |  |
| `sys_id` | string | optional |  |

`servicenow_get_email` read Read a sent/received email record by its sys_id (Email API).

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | sys_id of the email record. |

### atf — Automated Test Framework via the CI/CD API (opt-in, non-default — runs on the instance). *(5 tools)*

`servicenow_list_atf_tests` read List Automated Test Framework tests (sys_atf_test) as metadata: name, active flag, description.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `active` | boolean | optional |  |
| `query` | string | optional |  |
| `limit` | number | optional |  |

`servicenow_list_atf_suites` read List Automated Test Framework test suites (sys_atf_test_suite) as metadata.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `active` | boolean | optional |  |
| `query` | string | optional |  |
| `limit` | number | optional |  |

`servicenow_run_atf_test` write Run a single ATF test through the CI/CD API. EXECUTES CODE on the instance — use only on a non-production instance with the sn_cicd plugin active. Returns an execution id to poll with servicenow_get_atf_result.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | sys_id of the ATF test (sys_atf_test). |

`servicenow_run_atf_suite` write Run an ATF test suite through the CI/CD API. EXECUTES CODE on the instance. Returns an execution id to poll with servicenow_get_atf_result.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `sys_id` | string | required | sys_id of the ATF test suite (sys_atf_test_suite). |

`servicenow_get_atf_result` read Poll an ATF run by its execution id: status, percent complete and message (CI/CD progress API).

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `execution_id` | string | required | The execution/progress id returned by a run tool. |

### admin — Always-on connection, profile and status tools. *(9 tools)*

`servicenow_set_credentials` write Save or update the ServiceNow connection credentials. Values are persisted to the env file and used for all subsequent requests. Provide any subset of fields.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `instance` | string | optional |  |
| `user` | string | optional |  |
| `password` | string | optional |  |
| `profile` | string | optional |  |

`servicenow_list_instances` read List the configured ServiceNow connection profiles (instances): name, host, user, read-only flag and whether credentials are complete. Passwords are never included.

No parameters.

`servicenow_use_instance` write Switch the active ServiceNow connection profile (persisted to the env file). All identity-scoped caches (OAuth tokens, schema, plugin availability) are cleared.

| Parameter | Type |  | Notes |
| --- | --- | --- | --- |
| `name` | string | required | Profile to activate, e.g. 'default' or 'dev'. |

`servicenow_get_status` read Show the configured instance, user, auth mode and access policy, and whether credentials are complete. The password is never revealed.

No parameters.

`servicenow_test_connection` read Verify that the configured credentials actually work: reads one sys_user record and reports ok/status/latency. Auth and connectivity problems are returned structurally (ok:false), not as errors.

No parameters.

`servicenow_check_capabilities` read Preflight which admin-restricted sys_* tables the connected user can actually read, and report which higher-level capabilities (schema reads, script intelligence, ACL audit) are achievable. Run this before relying on the scripts/flows/codecheck tools on a governed instance — on a least-privilege account those reads may be silently empty.

No parameters.

## Use cases

What you'd actually ask your assistant to do. Each example is plain English — the server maps it to the right tools.

### 🚨 Incident triage

Service desk · platform team

Summarise an incident, sanity-check its priority/urgency/impact, suggest a category and assignment group, find similar resolved incidents and recommend next steps — in one shot via the built-in `servicenow_incident_triage` prompt.

Prompt "Triage incident INC0012345 and tell me if its priority looks right."

Tools `servicenow_get_record` → `servicenow_query_table` → `servicenow_search_knowledge`

### 🔁 Change impact analysis

Change manager · CAB

Pull a change, identify affected CIs, check schedule conflicts, list overlapping changes in the same window and produce a go/no-go call with mitigations — the `servicenow_change_impact_analysis` prompt.

Prompt "Run an impact analysis on CHG0030001 and give me a go/no-go."

Tools `servicenow_get_change` → `servicenow_check_change_conflicts` → `servicenow_list_changes`

### 🧭 Catch dev → prod drift

ServiceNow consultancy · release team

Configure two profiles and let `servicenow_compare_instances` diff them: tables present in only one, columns whose type/mandatory/reference differ, scripts that are missing or changed (compared by SHA-256), and plugin/app inventory. It writes a Markdown report you can attach to a release.

Prompt "Compare the dev and prod ServiceNow instances and summarise what drifted."

Tools `servicenow_list_instances` → `servicenow_compare_instances`

### 📚 Document a table

New joiner · platform owner

Combine schema, automation and diagrams into a durable Markdown page saved to the local docs store — via the `servicenow_document_table` prompt (uses `describe_table`, `describe_table_logic` and both Mermaid generators).

Prompt "Document the incident table: schema, automation, an ER diagram and the record lifecycle, then save it."

Tools `servicenow_describe_table` → `servicenow_describe_table_logic` → `servicenow_generate_er_diagram` → `servicenow_generate_table_flow` → `servicenow_write_doc`

### 🔎 "Where is this used?"

Developer

Search the instance's own code for a function, table or API call with `servicenow_search_code`, or get the full automation picture for a table with `servicenow_describe_table_logic` — without opening Studio.

Prompt "Find every business rule or script include that references `GlideRecordSecure`."

Tools `servicenow_search_code` → `servicenow_describe_table_logic`

### 🛒 Order from the catalog

End user · automation

Browse catalogs and categories, inspect an item's variables, and place an order — the Service Catalog API, plugin-aware so it tells you clearly if the plugin isn't active.

Prompt "Find the 'New laptop' catalog item and order one for me."

Tools `servicenow_list_catalogs` → `servicenow_list_catalog_items` → `servicenow_get_catalog_item` → `servicenow_order_catalog_item`

## How it compares

ServiceNow now ships its own **MCP Server Console** — a governed, on-instance service for production AI agents. This project is a different tool for a different job: an external, self-run server for developers and consultants who need to *understand and safely change* an instance — any instance, with the model and client they choose.

| Dimension | servicenow-mcp-ai (this) | Official MCP Server Console |
| --- | --- | --- |
| Where it runs | Locally, next to your MCP client | Remote, hosted on the instance |
| Requirements | Just credentials — **any instance, incl. a free PDI** | Paid Now Assist SKU + a recent release |
| AI model | **Bring your own** — any client, any model incl. local | Inside ServiceNow's governed AI layer |
| Cost | **Free** (MIT), plain REST calls | Metered via Assist currency |
| Surface | Raw REST breadth + script intelligence + cross-instance diff | Curated Now Assist skills, flows, scripted REST |
| Governance | Client-side policy, read-only, SSRF guard | Native ACLs + AI Control Tower (enterprise audit) |

### Choose this when…

You're developing, consulting or exploring; you work against PDIs or many instances; you want code-level insight — what runs on save, where a field is used, dev↔prod drift — or you want your own model (cloud or local) at no licence cost.

### Choose the official when…

You're running production enterprise agents that need native ACL enforcement, approval workflows, enterprise audit and metering, and vendor support for governed catalog/approval/playbook actions.

**Not affiliated with ServiceNow, Inc.** This is an independent, community-built project; “ServiceNow” is a trademark of ServiceNow, Inc., used here only to indicate compatibility.

## Resources & prompts

### MCP resources

Read-only metadata is also exposed as resources, so clients can attach it declaratively instead of calling a tool.

| URI | Description |
| --- | --- |
| `servicenow://status` | Connection status, auth mode, access policy. |
| `servicenow://tables` | Tables from sys_db_object. |
| `servicenow://schema/{table}` | Columns of a table from sys_dictionary. |
| `servicenow://instances` | Configured connection profiles (no passwords). |
| `servicenow://profiles/{profile}/schema/{table}` | A table's schema read through a named profile (the v2 URI `servicenow://{profile}/schema/{table}` is deprecated). |
| `servicenow://docs/{+path}` | A Markdown document from the local docs store, wrapped in an untrusted-content block. |
| `servicenow://reference/encoded-query` | Encoded-query syntax, javascript: values and limits, and how fetchAll pages. |
| `servicenow://reference/tools` | The tool manifest as Markdown, with this session's package policy. |
| `servicenow://reference/tools/{name}` | One tool in full: description, annotations, the published input and output schema and an example call. |
| `servicenow://artifact-types` | Artifact types the generic artifact tools accept, with tables, keys and child tables (`artifacts` package). |

### Prompts

| Prompt | Argument | Purpose |
| --- | --- | --- |
| `servicenow_incident_triage` | `incident` | Summarise, assess priority, categorise, recommend. |
| `servicenow_change_impact_analysis` | `change` | Affected CIs, conflicts, go/no-go. |
| `servicenow_document_table` | `table`, `profile` | Schema + automation + diagrams → saved Markdown. |
| `servicenow_why_is_it_slow` | `symptom`, `table` (optional) | Syslog, scheduler, email queue, semaphores, then a table's logic → ranked causes. |
| `servicenow_uib_page_review` | `experience`, `page` (optional) | UI Builder page map, impact, data broker security, page weight. |

## MCP Apps views

With `SN_MCP_APPS=1` the server implements the MCP Apps extension (`io.modelcontextprotocol/ui`, SEP-1865): a host that supports it renders an interactive view next to the tool call instead of only the JSON text. The text and structured result of every tool stay exactly the same, and with the flag off (the default) nothing changes — not even `tools/list`.

| View (`text/html;profile=mcp-app`) | Linked tools | Shows |
| --- | --- | --- |
| `ui://servicenow-mcp/plan-diff` | Every write tool with `apply` (record CRUD, attachments, batch, change, CMDB, catalog order, email, ATF runs, revert, artifacts, properties) | The plan: action, target, per-field before/after (added / changed / removed) and the plan token. |
| `ui://servicenow-mcp/mermaid` | `servicenow_generate_er_diagram`, `servicenow_generate_table_flow`, `servicenow_trace_table_event`, `servicenow_get_artifact_dependencies`, `servicenow_explain_portal` | Entities with their columns, the labelled edge list, and the Mermaid source. |
| `ui://servicenow-mcp/flow` | `servicenow_explain_flow` | Trigger, the nested step tree (with called subflows), inputs/outputs, legacy activities and transitions, playbook lanes, runs. |
| `ui://servicenow-mcp/uib-tree` | `servicenow_explain_ui_experience` | Shell, routes → screens → macroponent composition tree, data resources, data brokers. |

The link (`_meta.ui.resourceUri` on the tool) is only published to a client whose `initialize` declares the extension with that MIME type; the four `ui://` resources are listed whenever the flag is on. Each view is one static, self-contained HTML document (inline script and style, a few kilobytes): it loads nothing from the network, receives the tool result from the host over the `ui/*` postMessage channel, and treats every value as untrusted — all data is HTML-escaped into text nodes. Its own Content-Security-Policy (`default-src 'none'`, script and style pinned by hash, `connect-src 'none'`, no eval) applies on top of the host's sandbox. Mermaid diagrams are shown as tables plus source, not drawn, so no diagram library is shipped.

## Security & governance

An AI with write access to ServiceNow is high-stakes by definition. The server is built to keep that safe and auditable.

### Two-axis policy

`SN_TABLES_ALLOW`/`_DENY` guard the Table API; `SN_PACKAGES_DENY`/`_READONLY` guard the plugin APIs the table policy can't see. The Batch API obeys both — a batch can't be used to bypass either.

### Read-only deployments

`SN_READONLY=true` refuses every write globally; per-package read-only registers only the read tools. Ideal for a prod profile.

### Host & SSRF guard

Without an allow-list, only `*.service-now.com` hosts are contacted; internal/loopback are always blocked. A redirected or mistyped host can't silently receive credentials.

### Confirm before change

When the client supports it, a credential change asks for explicit confirmation (MCP elicitation) before anything is written.

### Secret columns masked

Columns whose dictionary type is `password`, `password2` or `glide_encrypted` are masked in every tool result and in the write journal, whatever the redaction settings.

### Scanned tool surface

Every tool description, prompt, skill and hook is scanned in CI for invisible Unicode, hidden instructions, cross-tool directives and unlisted URLs; SECURITY.md maps the server to the OWASP MCP Top 10.

**Denying a table does not stop the plugin APIs.** `SN_TABLES_DENY=change_request` blocks the Table API path, but the Change Management API (`sn_chg_rest`) can still read/write changes. Use `SN_PACKAGES_DENY` or `SN_PACKAGES_READONLY` to restrict the plugin-backed surfaces.

Full details — including the reporting channel — are in [SECURITY.md](https://github.com/IvanBBaev/servicenow-mcp-ai/blob/main/SECURITY.md).

## Architecture

A small, layered TypeScript codebase with **one-way dependencies** (enforced at lint time), so each concern stays testable in isolation. Each layer may use only the layers beneath it:

Layers and one-way dependencies — a deliberate `api → mcp` import fails the lint.

Tools are *data*: a declarative manifest drives MCP registration, the generated docs and the contract snapshot tests, so adding a package touches exactly one list. A single tool call then flows through the same guards every time:

The lifecycle of one tool call — every request passes the same policy, auth and resilience layers.

Tools are *data*: a declarative manifest drives MCP registration, the generated docs and the contract snapshot tests, so adding a package touches exactly one list. Quality is enforced by a single gate — `npm run check` (build, type-checked lint, format, coverage-gated tests, prod audit) — and a CI matrix across Node 22/24/26 + macOS and Windows. See [ARCHITECTURE.md](https://github.com/IvanBBaev/servicenow-mcp-ai/blob/main/project/ARCHITECTURE.md) for the diagrams and ADRs.

## Troubleshooting

Errors come back **structured** (with an HTTP status), so your assistant can usually explain them — but here are the common ones and their fix.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `401` Unauthorized | Wrong username/password, or an expired OAuth token. | Re-check `SN_USER`/`SN_PASSWORD`; run `servicenow_test_connection`. Update with `servicenow_set_credentials`. |
| `403` Forbidden | A ServiceNow ACL, or the table is blocked by `SN_TABLES_DENY` / not in `SN_TABLES_ALLOW`, or read-only mode. | Check the user's roles; review the policy in `servicenow_get_status`; relax the allow/deny list or `SN_READONLY`. |
| "…API/plugin may not be active" | A plugin-scoped API (Catalog/Change/Knowledge/Email) is not installed on the instance. | Activate the plugin in ServiceNow, or remove that package from `SN_TOOL_PACKAGES`. |
| "not a `*.service-now.com` instance" | A custom or sovereign-cloud host, blocked by the SSRF guard. | Add it to `SN_ALLOWED_HOSTS` (comma-separated). |
| A tool is missing from the client | Its package isn't enabled, or it's a write tool in a read-only package. | Add the package to `SN_TOOL_PACKAGES` (or use `all`); check `enabledPackages` in `servicenow_get_status`. |
| Result says `truncated` | The read hit `SN_MAX_RECORDS` or `SN_MAX_RESULT_CHARS`. | Narrow the query / select fewer fields, or raise the cap. |

Set `SN_LOG_LEVEL=debug` for verbose `stderr` logging (no secrets, no raw queries), and ask for `servicenow_get_status` to see the live config, policy and per-host telemetry.

Every tool call and ServiceNow request is published on `node:diagnostics_channel` (`servicenow-mcp:mcp.tool.call.*`). Set `SN_OTEL=1` and install `@opentelemetry/api` to turn them into OpenTelemetry spans; `SN_OTEL_PROPAGATE=1` also sends `traceparent` to the instance.

## FAQ

### How is this different from ServiceNow's own MCP Server?

ServiceNow's **MCP Server Console** is a governed, on-instance service for production agents (paid Now Assist SKU, metered). This is an external, self-run server for developers and consultants: it works against **any** instance — incl. a free PDI — with the model and client you choose, at no licence cost, and adds code intelligence and cross-instance diffing the platform service doesn't. See How it compares.

### Does the AI run code on my instance?

No arbitrary code execution. There is no background-script evaluation; everything goes through documented REST APIs, and writes obey the policy and read-only guards. The one exception is the opt-in, non-default `atf` package, which runs your own existing Automated Test Framework tests through the official CI/CD API — it executes code on the instance by design, so it is meant for non-production environments.

### Why is the npm package `servicenow-mcp-ai`?

The unscoped `servicenow-mcp` name was already taken on npm, so the package ships as `servicenow-mcp-ai`. The GitHub repository is [`IvanBBaev/servicenow-mcp-ai`](https://github.com/IvanBBaev/servicenow-mcp-ai). The difference is cosmetic. This is an independent project, not affiliated with or endorsed by ServiceNow, Inc.; "ServiceNow" is a trademark of ServiceNow, Inc., used here only to indicate compatibility.

### Can I run prod and dev from one server?

Yes — that's what named profiles are for. Define `SN_PROFILE_PROD_*` and `SN_PROFILE_DEV_*`, make prod read-only, and route a single call to a specific instance with the automatic `instance` argument, or switch the active one with `servicenow_use_instance`.

### Which clients work?

Any MCP client over stdio — Claude Desktop, Claude Code, VS Code Chat, the MCP Inspector, and others. The server declares tool annotations so clients can apply the right confirmation UX for destructive actions.

### Is it production-ready?

The engineering is: clean gates, ~200 tests, type-checked lint, a CI matrix and a security model. It is an open-source project under the MIT license — review the security model for your own deployment.

**servicenow-mcp-ai** is an independent, community-built project and is **not affiliated with, endorsed by, or sponsored by ServiceNow, Inc.** "ServiceNow", the ServiceNow logo, "Now", and related marks are trademarks or registered trademarks of ServiceNow, Inc., used here only nominatively to indicate compatibility with the ServiceNow platform.
