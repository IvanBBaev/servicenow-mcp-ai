# servicenow-mcp-ai — ServiceNow MCP Server

| [![npm version](https://img.shields.io/npm/v/servicenow-mcp-ai?style=flat-square&logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/servicenow-mcp-ai) | [![npm downloads](https://img.shields.io/npm/dm/servicenow-mcp-ai?style=flat-square&logo=npm&logoColor=white&label=downloads)](https://www.npmjs.com/package/servicenow-mcp-ai) | [![node](https://img.shields.io/node/v/servicenow-mcp-ai?style=flat-square&logo=nodedotjs&logoColor=white&label=node)](https://www.npmjs.com/package/servicenow-mcp-ai) | [![tools](https://img.shields.io/badge/tools-97-blue?style=flat-square)](https://github.com/IvanBBaev/servicenow-mcp-ai#tools) | [![License: MIT](https://img.shields.io/npm/l/servicenow-mcp-ai?style=flat-square&color=blue&label=license)](LICENSE) |
| :--: | :--: | :--: | :--: | :--: |
| [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/servicenow-mcp-ai/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/servicenow-mcp-ai/actions/workflows/ci.yml) | [![coverage](https://img.shields.io/codecov/c/github/IvanBBaev/servicenow-mcp-ai/main?style=flat-square&logo=codecov&logoColor=white&label=coverage)](https://codecov.io/gh/IvanBBaev/servicenow-mcp-ai) | [![last commit](https://img.shields.io/github/last-commit/IvanBBaev/servicenow-mcp-ai?style=flat-square&logo=git&logoColor=white&label=last%20commit)](https://github.com/IvanBBaev/servicenow-mcp-ai/commits/main) | [![MCP](https://img.shields.io/badge/MCP-server-orange?style=flat-square)](https://modelcontextprotocol.io) | [![Known Vulnerabilities](https://snyk.io/test/npm/servicenow-mcp-ai/badge.svg)](https://snyk.io/test/npm/servicenow-mcp-ai) |

📖 **[Documentation site →](https://ivanbbaev.github.io/servicenow-mcp-ai/)**

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
[Security notes](#security-notes) · [Project documentation](#project-documentation) ·
[Support](#support)

_Built and maintained in my own time — if it helps, a
[GitHub Sponsors](https://github.com/sponsors/IvanBBaev) tip keeps it going.
Full [Support](#support) options are near the end._

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
scripts (matched by sys_id then name, with a unified diff of every changed script)
and plugins between two configured profiles — plus, on request, properties, choices,
ACLs, notifications, flows, catalog items and roles — with a CI-friendly exit code
so a pipeline can block a risky deploy:

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
- Process & plugin APIs: **CMDB** (class-aware CI CRUD + meta, relationship
  reads from `cmdb_rel_ci`, IRE identify-and-reconcile with an identify-only
  plan),
  **Service Catalog** (browse/order items), **Change Management** (typed
  creation + conflict detection) and **Knowledge** (article search).
  Plugin-scoped APIs report clearly when not active on the instance.
- **Script intelligence**: read and search the instance's own code (business
  rules, script includes, client scripts, UI policies/actions, scheduled jobs,
  transform/REST scripts, ACLs — and, not yet verified on a live instance,
  Service Portal widgets, UI pages/scripts/macros, processors, email/fix/
  validation scripts, script actions, data sources, REST message functions,
  transform maps/entries, catalog client scripts and dictionary calculations /
  defaults) and get a table's full automation picture — all read-only over the
  Table API. `servicenow_search_code` returns every matching line per artefact
  (up to 20, with a line of context either side) and, like
  `servicenow_where_used`, takes an optional application `scope`.
  `servicenow_where_used` also finds structural references — dictionary
  reference fields, list and form layouts, catalog variables, flow inputs and
  reports — in a separate `structural` section.
- **Flow tracing & code checking** (Phase 8): deterministically trace what a
  table operation runs (`flows` package — business rules, flows, workflows and
  notifications, in order, with a Mermaid flowchart), read Flow Designer flows
  and run history, explain Process Automation Designer playbooks
  (`servicenow_explain_flow` with `kind: "playbook"` — lanes as Mermaid
  subgraphs, activities, triggers, variants), and lint scripts against a local rule set with an aggregate
  code-health report (`codecheck`; `domains: true` adds the flow, Service
  Portal and legacy-workflow analysers). Run ATF tests via the CI/CD API (`atf`,
  opt-in, non-default — the run tools execute on the instance).
- **Journal-based undo** (`revert`): list the local write journal and revert
  one applied create/update/delete — with a drift check against later edits.
- **Generic artifact reads** (`artifacts`, opt-in): list and read any
  registered artifact type — UI policies with their actions, portal pages with
  their layout, flows, catalog items and more — with scope and SDK-managed
  status.
- **Update-set awareness** (`updatesets`, opt-in): list update sets, summarise
  one set per artefact, compare it with another profile or a snapshot — and
  bind applied Table writes to a named update set (`update_set` /
  `SN_UPDATE_SET`), restoring the user's current set afterwards.
- **Operations and data health** (`ops`, opt-in): bounded "why is it slow"
  reads of the system log, the scheduler queue, the outbound email queue and
  semaphores, plus `servicenow_check_data_health` — duplicate keys, orphaned and
  stale references for one table, from Aggregate API counts.
- **Operations reads** (opt-in): a record's change history from `sys_audit` and
  `sys_journal_field` (`history` — including the comments and work notes the
  Table API reads back empty), system properties with masked secrets and a
  journaled, revertible set (`properties`), and user / group / role lookups
  with memberships (`directory`). ATF runs can wait for their result
  (`wait_seconds`), and Import Set inserts report the transform run and maps.
- **Self-documentation**: a local Markdown knowledge base (read/write/search) plus
  deterministic Mermaid generators (ER diagrams from references, record-lifecycle
  flowcharts from business rules) so the server builds durable, reusable context.
- **Prompts**: ready-made workflows (incident triage, change impact analysis,
  document a table, diagnose a slow instance) that orchestrate the tools.
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

- Node.js 22.12+ (enforced: `engines` + a runtime guard with a clear message;
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

### Install in your MCP client

Every client launches the same stdio command, `npx -y servicenow-mcp-ai` (Node.js 22.12+),
under the server name `servicenow`. The one-click links and snippets below carry **no
credentials**: keep them in the env file (`~/.config/servicenow-mcp-ai/.env`, see
[Configure credentials](#configure-credentials)), run the one-time
`npx servicenow-mcp-ai login` for OAuth, or ask the assistant to call
`servicenow_set_credentials` once the server is connected. A real environment variable
set in a client config **overrides** the env file, so only add an `env` block when you
mean it — and never put `SN_PASSWORD` or other secrets into a client config you share
or commit (see [SECURITY.md](SECURITY.md)).

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_ServiceNow_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522servicenow%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522servicenow-mcp-ai%2522%255D%257D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_ServiceNow_MCP-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522servicenow%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522servicenow-mcp-ai%2522%255D%257D)
[![Install in Cursor](https://img.shields.io/badge/Cursor-Install_ServiceNow_MCP-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=servicenow&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNlcnZpY2Vub3ctbWNwLWFpIl19)

| Client | One line | Config file |
| --- | --- | --- |
| VS Code (Copilot Chat) | Button above, or `code --add-mcp` (below) — or the **ServiceNow MCP** extension | `.vscode/mcp.json` (`servers`) |
| VS Code Insiders | Button above, or `code-insiders --add-mcp` (below) | `.vscode/mcp.json` (`servers`) |
| Claude Code | `claude mcp add servicenow -- npx -y servicenow-mcp-ai`, or the plugin | `.mcp.json` (`mcpServers`) |
| Claude Desktop | — (edit the config file) | `claude_desktop_config.json` (`mcpServers`) |
| Cursor | Button above, or the `cursor://` deeplink (below) | `~/.cursor/mcp.json` or `.cursor/mcp.json` (`mcpServers`) |
| Windsurf | — (edit the config file) | `~/.codeium/windsurf/mcp_config.json` (`mcpServers`) |
| Cline | — (MCP Servers → Configure MCP Servers) | `cline_mcp_settings.json` (`mcpServers`) |
| Zed | — (edit settings) | `settings.json` (`context_servers`) |
| JetBrains AI Assistant | — (Settings → Tools → AI Assistant → Model Context Protocol) | JSON dialog (`mcpServers`) |
| Gemini CLI | — (edit settings) | `~/.gemini/settings.json` (`mcpServers`) |
| Codex CLI | `codex mcp add servicenow -- npx -y servicenow-mcp-ai` | `~/.codex/config.toml` (`[mcp_servers.servicenow]`) |

<details>
<summary><strong>VS Code / VS Code Insiders</strong></summary>

The zero-config route is the **ServiceNow MCP** extension from the Marketplace
(`code --install-extension ivanbbaev.servicenow-mcp-ai`); it registers the server in
Copilot Chat (agent mode) automatically, no `mcp.json`. Source: [extension/](extension/).

Without the extension, add the server from a terminal (user profile):

```bash
code --add-mcp '{"name":"servicenow","command":"npx","args":["-y","servicenow-mcp-ai"]}'
code-insiders --add-mcp '{"name":"servicenow","command":"npx","args":["-y","servicenow-mcp-ai"]}'
```

The raw deeplinks behind the buttons (paste into a browser address bar):

```text
vscode:mcp/install?%7B%22name%22%3A%22servicenow%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22servicenow-mcp-ai%22%5D%7D
vscode-insiders:mcp/install?%7B%22name%22%3A%22servicenow%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22servicenow-mcp-ai%22%5D%7D
```

Or a workspace file, `.vscode/mcp.json`:

```json
{
  "servers": {
    "servicenow": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "servicenow-mcp-ai"]
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Code</strong></summary>

**Plugin** (zero-config — installs the server wired up):

```bash
/plugin marketplace add IvanBBaev/servicenow-mcp-ai
/plugin install servicenow-mcp-ai
```

The plugin also ships five workflow skills, two read-only subagents and three
hooks — see [Plugin skills](#plugin-skills).

**CLI** — `--scope user` makes it available in every project; `--env` sets a
non-secret variable (the instance host) and leaves the secrets in the env file. A value set
this way wins over the env file, so drop `--env` if you switch instances with
`servicenow_set_credentials`:

```bash
claude mcp add servicenow --scope user --env SN_INSTANCE=your-instance.service-now.com -- npx -y servicenow-mcp-ai
```

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

`claude_desktop_config.json` — macOS `~/Library/Application Support/Claude/`, Windows
`%APPDATA%\Claude\` (Settings → Developer → Edit Config):

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

Restart Claude Desktop after saving.

</details>

<details>
<summary><strong>Cursor</strong></summary>

Use the button above, or open the deeplink directly:

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=servicenow&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNlcnZpY2Vub3ctbWNwLWFpIl19
```

Or edit `~/.cursor/mcp.json` (global) / `.cursor/mcp.json` (project) with the same
`mcpServers` block as Claude Desktop.

</details>

<details>
<summary><strong>Windsurf, Cline, JetBrains AI Assistant</strong></summary>

All three take the Claude Desktop `mcpServers` block unchanged:

- **Windsurf** — `~/.codeium/windsurf/mcp_config.json` (Cascade → MCP servers → View raw
  config), then refresh the server list.
- **Cline** — MCP Servers icon → _Configure MCP Servers_ opens `cline_mcp_settings.json`.
- **JetBrains AI Assistant** — Settings → Tools → AI Assistant → Model Context Protocol
  (MCP) → Add → _As JSON_, paste the block.

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

</details>

<details>
<summary><strong>Zed</strong></summary>

In Zed's `settings.json` (Zed → Settings → Open Settings):

```json
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

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

`~/.gemini/settings.json` (user) or `.gemini/settings.json` (project):

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

Check it with `/mcp` inside a Gemini CLI session.

</details>

<details>
<summary><strong>Codex CLI</strong></summary>

```bash
codex mcp add servicenow --env SN_INSTANCE=your-instance.service-now.com -- npx -y servicenow-mcp-ai
```

Or `~/.codex/config.toml`:

```toml
[mcp_servers.servicenow]
command = "npx"
args = ["-y", "servicenow-mcp-ai"]
# Optional, non-secret only — secrets stay in ~/.config/servicenow-mcp-ai/.env:
# env = { SN_INSTANCE = "your-instance.service-now.com" }
```

</details>

Prefer a global install (`npm install -g servicenow-mcp-ai`)? Replace
`"command": "npx", "args": ["-y", "servicenow-mcp-ai"]` with
`"command": "servicenow-mcp-ai"` in any snippet. The
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) works the same way:
`npx @modelcontextprotocol/inspector npx -y servicenow-mcp-ai`.

The one-click links are generated from `package.json` by `scripts/install-links.mjs`
(`node scripts/install-links.mjs` prints them); `test/install-links.test.js` fails if
this README or the docs site drift from the generated strings.

### Install via MCP bundle (.mcpb)

An [MCP bundle](https://github.com/modelcontextprotocol/mcpb) is one `.mcpb` file with the
server and its dependencies; Claude Desktop (or any MCPB host) installs it in one click, with
no `npm` / `npx`. Its form asks for the connection keys (only `SN_INSTANCE` is required) and
`SN_TOOL_PACKAGES`; secrets are marked sensitive (kept in the OS keychain). An empty field
falls back to the env file. Not published yet (O-22) — build it with `npm run mcpb:pack`
(`dist/mcpb/`; `-- --validate` runs the official validator).

### Docker

The repository ships a multi-stage `Dockerfile` (distroless Node 22 runtime, non-root
uid 65532). The image contains exactly what `npm pack` publishes plus production
dependencies, and starts the **HTTP transport** on `0.0.0.0:3000` by default. No image
is published to a registry yet — build it locally:

```bash
docker build -t servicenow-mcp-ai .

# Secrets as files (Docker / Kubernetes secrets), mounted read-only
mkdir -p secrets && printf '%s' 'your-password' > secrets/sn_password
openssl rand -hex 32 > secrets/sn_http_token

docker run --rm -p 127.0.0.1:3000:3000 \
  -e SN_INSTANCE=your-instance.service-now.com -e SN_USER=your.user \
  -e SN_PASSWORD_FILE=/run/secrets/sn_password \
  -e SN_HTTP_TOKEN_FILE=/run/secrets/sn_http_token \
  -v "$PWD/secrets:/run/secrets:ro" -v sn-data:/data \
  servicenow-mcp-ai
```

- **`SN_HTTP_TOKEN` is required for any non-loopback bind.** The image binds `0.0.0.0`
  so the published port works; without a token every client that reaches the port
  drives your instance with the configured credentials (the server logs a warning).
  Clients send `Authorization: Bearer <token>`; terminate TLS in front of the container.
- `/data` holds the docs directory (`SN_DOCS_DIR=/data/docs`) and the env file
  (`SN_ENV_FILE=/data/.env`); mount a volume there to keep them.
- Every `<KEY>_FILE` secret source is described in [Secrets from files](#secrets-from-files).
- For an MCP client that spawns the container over stdio, pass `-i -e SN_TRANSPORT=stdio`
  (`docker run --rm -i -e SN_TRANSPORT=stdio -e SN_INSTANCE=… servicenow-mcp-ai`).
- The `HEALTHCHECK` is a TCP liveness probe. `GET /healthz` (liveness) and `GET /readyz`
  (credentials configured) answer without the token for orchestrator probes;
  `GET /readyz?probe=1` also calls the instance and sits behind the token, like every
  MCP route. Set `SN_HTTP_ALLOWED_HOSTS` to the name clients use so the Host header is
  checked on a `0.0.0.0` bind.
- `smithery.yaml` describes the same image for [Smithery](https://smithery.ai) (stdio,
  config keys mapped to the `SN_*` settings).

### HTTP transport: sessions, probes and shutdown

With `SN_TRANSPORT=http` every MCP session (one `initialize`) gets its own server:

- **Per-session state.** Enabled packages, the MCP logging level, list-changed
  notifications, plan tokens, tasks and write caps belong to the session. Connection
  pools, OAuth tokens and the schema cache are shared and keyed by profile + host.
- **`servicenow_use_instance` is session-scoped over HTTP.** It switches the profile of
  the calling session only; other sessions keep theirs and nothing is written. Pass
  `persist: true` to also write `SN_ACTIVE_PROFILE` to the env file (journaled) — that
  changes the default for sessions that have not switched. Over stdio the switch is
  persisted by default, as before (`persist: false` makes it process-only).
- **Lifetime.** A session ends on `DELETE` or after `SN_HTTP_SESSION_TTL_SEC` idle
  (default 30 min); a request with an ended session id gets 404 and the client
  re-initializes. At most `SN_HTTP_MAX_SESSIONS` (64) are open at once.
- **DNS-rebinding protection.** The `Host` header must match `SN_HTTP_ALLOWED_HOSTS`
  (default: the loopback names on a loopback bind) and a browser `Origin` must match
  `SN_HTTP_ALLOWED_ORIGINS` (default: loopback origins); otherwise 403.
- **Probes.** `GET /healthz` → `200 {"status":"ok"}` while serving. `GET /readyz` →
  200 when credentials are configured, 503 otherwise. Both answer without the token.
  `GET /readyz?probe=1` (behind the token) also reads one `sys_user` row and returns
  503 when the instance is unreachable; the result is cached for 5 s.
- **Shutdown.** On SIGTERM / SIGINT the listener stops accepting connections, new
  requests get 503, in-flight tool calls get up to 5 s to finish, then every session is
  closed and the process exits 0.
- **Keep-alive.** Open SSE streams get a comment every `SN_HTTP_KEEPALIVE_MS` (25 s).

### Quickstart

The fastest path is three lines of Basic auth — set these (in the env file or the
real environment) and you are connected:

```dotenv
SN_INSTANCE=dev12345.service-now.com
SN_USER=your.username
SN_PASSWORD=your-password
```

Everything else is optional tuning; see the full
[Environment variables](#environment-variables) reference for the rest.

> **Past a quick try, prefer OAuth over a stored password.** For anything shared or
> long-lived, run the one-time `npx servicenow-mcp-ai login` instead — it stores a
> refresh token, not your password. See
> [Configure credentials](#configure-credentials) → _OAuth 2.1_.

### Verify your setup

Once the three variables are set, confirm the connection before you start:

1. Run the `servicenow_test_connection` tool — it reads one `sys_user` record and
   reports `ok`, HTTP status and latency.
2. Run `servicenow_check_capabilities` — it previews which admin-restricted `sys_*`
   tables the connected user can actually read.

Or do both from the shell in one shot:

```bash
npx servicenow-mcp-ai doctor   # checks credentials, reachability and capabilities
```

Prefer to be asked? `npx servicenow-mcp-ai init` prompts for the instance, the
auth method and the credentials, writes the env file and runs `doctor` — see
[Command-line interface](#command-line-interface).

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
Moving a configured profile to a different instance requires `user` and `password` in the same
call (the stored secrets are never sent to another host), and the change must be confirmed by
the client — clients without elicitation support are refused unless
`SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1` is set.

The tool also sets the auth method (`auth`), the OAuth client id (`oauth_client_id`) and grant
(`oauth_grant`). Secrets — the API key and the OAuth client secret — are never tool arguments:
list them in `request_secrets` and the server asks for them through an elicitation prompt, so
they never appear in a logged tool call, the result or the write journal. A client without
elicitation support is refused (the opt-out above does not apply to secrets); set those keys in
the env file instead. The instance-change rule follows the resulting auth method: an API-key
profile needs a new API key, an OAuth `client_credentials` profile a new client secret, the
OAuth `password` grant user, password and client secret, Basic / `none` user and password;
bearer-token, `refresh_token` and `jwt_bearer` profiles cannot be moved with this tool.

`servicenow_get_status` (`authWarnings`), `servicenow_list_instances` and `doctor` evaluate each
profile against its own auth method — an API-key profile needs no password — and report the
method, the OAuth grant, the refresh-token state and the write mode, never a secret value. When
the refresh-token grant returns a rotated refresh token, it is written back to the env key it
was read from; if the env file cannot be written, the new token is kept in memory (lost on
restart) and a warning is logged and shown by `get_status` / `doctor`. Values the server writes
keep Windows paths literal (backslashes are single-quoted) and a CRLF env file stays CRLF. On
Windows the env file inherits its folder's ACL — restrict it yourself (for example
`icacls .env /inheritance:r /grant:r "%USERNAME%:F"`); the server only warns, it never runs
`icacls`.

The env file is resolved in this order: `SN_ENV_FILE`, then
`~/.config/servicenow-mcp-ai/.env` (XDG) if present, then the project-root `.env`.
A global/`npx` install therefore writes to your user config rather than into
`node_modules`. Real environment variables always take precedence over the file.

### First run: the model configures itself

At `initialize` the server sends `instructions` built from the live configuration: the enabled
packages and tool count, the write mode, the active profile and, when nothing is configured,
what is missing and how to fix it. Until then every instance tool fails with
`code: "NOT_CONFIGURED"` and a hint naming `servicenow_set_credentials`. A first session
with an empty env file looks like this (abridged):

```text
instructions  Credentials: NOT configured (missing instance, user, password). Instance tools
              fail with code NOT_CONFIGURED until fixed. To configure: ask the user for
              the instance and credentials, call servicenow_set_credentials, then
              servicenow_test_connection. Never guess or echo a password.
user          How many open P1 incidents do we have?
model         Which instance, user and password should I connect with?
user          dev12345, admin, ••••••
tool call     servicenow_set_credentials { instance: "dev12345", user: "admin", password: … }
tool result   { message: "Credentials saved", profile: "default", configured: true, password: "***" }
tool call     servicenow_test_connection {}
tool result   { ok: true, … }
tool call     servicenow_aggregate { table: "incident", query: "active=true^priority=1" }
model         There are 7 open P1 incidents.
```

`servicenow_get_status` then shows the live state: server version, uptime and transport,
`policy.summary`, limits, redaction, the docs directory, write counters, the profile source and
`profileDetails` (per-profile auth mode, write mode and missing keys) — never a secret value.

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
| Bearer token | `token` | `SN_BEARER_TOKEN` or `SN_TOKEN_FILE` | Pre-obtained token, used verbatim. A rejected token (401) re-reads `SN_TOKEN_FILE` once, else fails with `AUTH_EXPIRED`. |
| Mutual TLS (client cert) | `none` (or layered) | `SN_TLS_CLIENT_CERT` / `_KEY` | Cert maps to a user; needs optional `undici`. |

### Environment variables

All settings are read from the env file (`SN_ENV_FILE`, else
`~/.config/servicenow-mcp-ai/.env`) or the real process environment, which takes
precedence. Only the first three are required; the rest are optional tuning knobs.
See [.env.example](.env.example) for a template. Every value is validated at
startup: an invalid one is logged as a warning and the setting keeps its default,
or — with `SN_STRICT_SETTINGS=1` — stops the server with an error.

<!-- GENERATED:ENV:BEGIN (npm run docs:env) -->

_These tables are generated from the settings manifest
(`src/core/settings-manifest.ts`) — edit the manifest, then run
`npm run docs:env`._

#### Connection and authentication

The instance and its credentials. Only SN_INSTANCE is always required; the auth method is auto-detected from the keys present (API key -> bearer token -> OAuth -> Basic) unless SN_AUTH names it.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_INSTANCE` | yes | — | 1.0.0 | Instance name, host, or `https://` URL (`dev12345`, `dev12345.service-now.com`). |
| `SN_USER` | yes | — | 1.0.0 | ServiceNow username for Basic auth. |
| `SN_PASSWORD` | yes | — | 1.0.0 | ServiceNow password. Never logged or returned by any tool. |
| `SN_AUTH` | no | auto | 1.1.0 | Auth method: `basic`, `oauth`, `apikey`, `token` or `none` (cert-only mTLS). Auto-detected from the keys present (API key → bearer → OAuth → Basic). |
| `SN_API_KEY` | no | — | 1.1.0 | ServiceNow Inbound API Key, sent as the `x-sn-apikey` header (enables `apikey` mode). |
| `SN_BEARER_TOKEN` | no | — | 1.1.0 | A pre-obtained bearer token, sent verbatim as `Authorization: Bearer …` (enables `token` mode). |
| `SN_TOKEN_FILE` | no | — | next | File holding the bearer token (enables `token` mode; wins over `SN_BEARER_TOKEN`). Re-read once when the instance rejects the token with 401, so an external issuer can rotate it; otherwise the call fails with `AUTH_EXPIRED`. |
| `SN_TOKEN_EXPIRES_AT` | no | — | next | ISO 8601 expiry of the bearer token. `get_status` / `doctor` warn when less than 24 h remain, when it has passed, or when it cannot be parsed. |
| `SN_OAUTH_CLIENT_ID` | no | — | 1.1.0 | OAuth client id (its presence enables OAuth). |
| `SN_OAUTH_CLIENT_SECRET` | no | — | 1.1.0 | OAuth client secret. |
| `SN_OAUTH_GRANT` | no | `password` | 1.1.0 | OAuth grant: `password` (**deprecated** — ROPC), `client_credentials`, `refresh_token` or `jwt_bearer`. The `login` command sets this to `refresh_token` for you. Any other value fails every OAuth request. |
| `SN_OAUTH_REFRESH_TOKEN` | no | — | 1.1.0 | Refresh token for the `refresh_token` grant. Obtained automatically by `npx servicenow-mcp-ai login` (Authorization Code + PKCE). |
| `SN_OAUTH_REDIRECT_URI` | no | http://localhost:53682/callback | 1.1.0 | Loopback redirect URL for the PKCE `login` flow. Must match the redirect registered on the OAuth endpoint. |
| `SN_OAUTH_SCOPE` | no | — | 1.1.0 | Optional OAuth scope requested during `login`. |
| `SN_OAUTH_JWT_KEY` | no | — | 1.1.0 | PEM private key for the `jwt_bearer` grant (or `SN_OAUTH_JWT_KEY_FILE`); the public certificate is registered on the ServiceNow JWT provider. |
| `SN_OAUTH_JWT_KEY_FILE` | no | — | 1.1.0 | Path to the PEM private key for the `jwt_bearer` grant. |
| `SN_OAUTH_JWT_ISS` | no | client id | 1.1.0 | `iss` claim of the JWT-bearer assertion. |
| `SN_OAUTH_JWT_SUB` | no | `SN_USER` | 1.1.0 | `sub` claim (the user) of the JWT-bearer assertion. |
| `SN_OAUTH_JWT_AUD` | no | `https://<host>/oauth_token.do` | 1.1.0 | `aud` claim of the JWT-bearer assertion. |
| `SN_OAUTH_JWT_KID` | no | — | 1.1.0 | `kid` header of the JWT-bearer assertion, when the provider requires one. |
| `SN_OAUTH_JWT_EXP_SEC` | no | `300` | 1.1.0 | Lifetime of the JWT-bearer assertion in seconds. |
| `SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE` | no | `false` | next | H-2: operator opt-out — lets `servicenow_set_credentials` proceed on MCP clients without elicitation support (no confirmation prompt, no live server). An explicit decline is still refused. Off by default. |

#### Secrets from files

Container secrets (D-5): <KEY>_FILE=/path loads <KEY> from that file at startup (one trailing newline is trimmed). Setting both <KEY> and <KEY>_FILE is a startup error; so is an unreadable or empty file. A value loaded this way is never written back to the env file. Per profile: SN_PROFILE_<NAME>_<KEY>_FILE for the ServiceNow secrets.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_PASSWORD_FILE` | no | — | next | D-5: read `SN_PASSWORD` from this file (Docker / Kubernetes secrets). |
| `SN_API_KEY_FILE` | no | — | next | D-5: read `SN_API_KEY` from this file (Docker / Kubernetes secrets). |
| `SN_BEARER_TOKEN_FILE` | no | — | next | D-5: read `SN_BEARER_TOKEN` from this file (Docker / Kubernetes secrets). Read once at startup (`SN_TOKEN_FILE`, re-read on a 401, still wins). |
| `SN_OAUTH_CLIENT_SECRET_FILE` | no | — | next | D-5: read `SN_OAUTH_CLIENT_SECRET` from this file (Docker / Kubernetes secrets). |
| `SN_OAUTH_REFRESH_TOKEN_FILE` | no | — | next | D-5: read `SN_OAUTH_REFRESH_TOKEN` from this file (Docker / Kubernetes secrets). A rotated refresh token is then kept in memory only (update the file yourself). |
| `SN_HTTP_TOKEN_FILE` | no | — | next | D-5: read `SN_HTTP_TOKEN` from this file (Docker / Kubernetes secrets). |

#### Profiles and the env file

The bare SN_INSTANCE / SN_USER / SN_PASSWORD keys are the 'default' profile. More instances live under SN_PROFILE_<NAME>_* keys; switch with SN_ACTIVE_PROFILE or the servicenow_use_instance tool.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_PROFILE_<NAME>_*` | no | — | 1.1.0 | Named connection profiles: `SN_PROFILE_DEV_INSTANCE` / `_USER` / `_PASSWORD` define profile `dev`. The bare `SN_INSTANCE`/`SN_USER`/`SN_PASSWORD` keys are the `default` profile. The auth, policy, write-mode, `ENV`, `PROD_WRITES` and `UPDATE_SET` settings take the same prefix. Example: `SN_PROFILE_DEV_INSTANCE=dev12345.service-now.com`, `SN_PROFILE_DEV_USER=admin`, `SN_PROFILE_DEV_PASSWORD=dev-password`. |
| `SN_ACTIVE_PROFILE` | no | `default` | 1.1.0 | Which profile tools use. Switch at runtime with `servicenow_use_instance` (persisted to the env file). |
| `SN_ENV_FILE` | no | `~/.config/servicenow-mcp-ai/.env` | 1.1.0 | Explicit path to the env file to read/write. Otherwise the server uses `$XDG_CONFIG_HOME/servicenow-mcp-ai/.env` (`~/.config/…`); a project-root `.env` next to the installed package is still read when the XDG file is missing, with a deprecation warning — that fallback is removed in 3.0. `doctor` prints the chosen file and why. |

#### Network, TLS and resilience

Timeouts, retries, the host allow-list, the outbound proxy, mutual TLS and the per-host queue and circuit breaker. They govern every REST client of the server. The proxy and mutual TLS need the optional undici package.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_TIMEOUT_MS` | no | `30000` | 1.1.0 | Per-request timeout in milliseconds. |
| `SN_MAX_RETRIES` | no | `2` | 1.1.0 | Retries for transient failures (429/5xx, network errors). Non-idempotent writes are only retried on connect errors. |
| `SN_RETRY_AFTER_MAX_MS` | no | `60000` | next | Upper bound honoured for a `Retry-After` header on 429/503; a larger value is clamped so a misbehaving upstream cannot park the client for minutes. |
| `SN_DEADLINE_MS` | no | max(120000, 2 × `SN_TIMEOUT_MS`) | next | Total wall-clock budget for one logical request across retries, backoff, queue wait and OAuth re-auth. A retry that cannot fit into the remaining budget is not attempted — the call fails with code `DEADLINE_EXCEEDED`. |
| `SN_ALLOWED_HOSTS` | no | — | 1.1.0 | Comma-separated allow-list of permitted hosts (for custom or sovereign-cloud domains). When set, only matching hosts are contacted. When unset, only `*.service-now.com` instances are allowed and internal/loopback hosts are blocked (SSRF guard). An entry may carry a port (`host:8443`) or be a bracketed IPv6 literal (`[2001:db8::1]`); an explicit non-443 port or an IPv6 literal in the instance value is accepted only when such an entry matches it — never under the default policy. |
| `SN_MAX_BODY_BYTES` | no | `52428800` | next | Largest response body (bytes) read into memory; a larger declared or streamed body fails with `RESPONSE_TOO_LARGE`. Redirects are never followed — a 3xx fails with `REDIRECT_BLOCKED` naming the target host. |
| `SN_HTTPS_PROXY` | no | — | next | Outbound HTTPS proxy URL (`http://user:pass@proxy:3128`) for all ServiceNow and OAuth traffic; needs the optional `undici` package. When unset, the ambient `HTTPS_PROXY` / `HTTP_PROXY` variables are honoured together with `NO_PROXY`; `SN_HTTPS_PROXY` itself is explicit and ignores `NO_PROXY`. Proxy credentials are never logged. |
| `SN_USER_AGENT_SUFFIX` | no | — | next | Extra token appended to the `User-Agent` sent on every request (`servicenow-mcp-ai/<version> (node/<major>; <transport>; <client>)`), e.g. a team or ticket id for correlation in the instance's transaction log. Printable ASCII, up to 80 characters. |
| `SN_TLS_CLIENT_CERT` | no | — | 1.1.0 | Client certificate (PEM) for **mutual TLS** (or `SN_TLS_CLIENT_CERT_FILE`). With `SN_TLS_CLIENT_KEY` it presents a client cert; ServiceNow's mutual-auth profile maps it to a user. Needs the optional `undici` package (`npm i undici`). Cert and key must be set together — only one of them is a configuration error. |
| `SN_TLS_CLIENT_CERT_FILE` | no | — | 1.1.0 | Path to the client certificate (PEM) for mutual TLS. |
| `SN_TLS_CLIENT_KEY` | no | — | 1.1.0 | Private key (PEM) for the client certificate (or `SN_TLS_CLIENT_KEY_FILE`). |
| `SN_TLS_CLIENT_KEY_FILE` | no | — | 1.1.0 | Path to the private key (PEM) for the client certificate. |
| `SN_TLS_CA` | no | — | 1.1.0 | Optional CA bundle (PEM) to trust (or `SN_TLS_CA_FILE`) — applied with or without a client certificate; needs the optional `undici` package. |
| `SN_TLS_CA_FILE` | no | — | 1.1.0 | Path to the CA bundle (PEM) to trust. |
| `SN_TLS_REJECT_UNAUTHORIZED` | no | `true` | 1.1.0 | `false` disables TLS certificate verification (not recommended; warned once at startup). |
| `SN_MAX_CONCURRENT` | no | `4` | 1.1.0 | Maximum parallel HTTP requests to the instance (simple in-process semaphore). |
| `SN_MAX_QUEUE` | no | `64` | next | Maximum requests waiting per host for a free slot beyond `SN_MAX_CONCURRENT`. Overflow fails immediately with code `BUSY` instead of piling up. Diagnostics (`servicenow_test_connection`, `doctor`) bypass the queue so they still answer while it is stalled. |
| `SN_QUEUE_TIMEOUT_MS` | no | `SN_TIMEOUT_MS` | next | Longest a request waits for a slot before failing with code `BUSY`. Wait time is not billed to the per-attempt timeout, only to `SN_DEADLINE_MS`. |
| `SN_BREAKER_THRESHOLD` | no | `0` (off) | next | Opt-in per-host circuit breaker: after this many consecutive failed requests (transport error, deadline, 5xx) further requests fail fast with code `CIRCUIT_OPEN` until `SN_BREAKER_RESET_MS` passes. Diagnostics are never blocked. |
| `SN_BREAKER_RESET_MS` | no | `30000` | next | How long an open circuit breaker rejects requests before letting a trial request through; the first failure re-opens it, the first success closes it. |

#### Tool packages

Which tools are registered. The admin tools (set_credentials, get_status, use_instance) are always on.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_TOOL_PACKAGES` | no | `core` | 1.0.0 | Comma/space-separated tool packages or profiles to enable. Profiles: `core` (default), `all` and the presets `reader` \\| `developer` \\| `admin` (see [Presets](#presets)). Packages: `table`, `schema`, `aggregate`, `attachment`, `importset`, `batch`, `catalog`, `change`, `knowledge`, `cmdb`, `scripts`, `flows`, `codecheck`, `docs`, `instance`, `email`, `atf`, `revert`, `artifacts`, `updatesets`, `ops`, `history`, `properties`, `directory`, `ui`. The admin tools are always on. `atf` runs tests on the instance — enable it only on a non-production instance. |
| `SN_PACKAGES_DENY` | no | — | 1.0.0 | Comma/space-separated packages to exclude even if enabled by `SN_TOOL_PACKAGES`. The only way to block plugin APIs (catalog, change, knowledge…) — the table policy does not see them. |
| `SN_PACKAGES_READONLY` | no | — | 1.0.0 | Comma/space-separated packages whose write tools are not registered; their read tools stay. Per-package complement to the global `SN_READONLY`. |
| `SN_CODESEARCH` | no | `false` | 1.1.0 | Opt in to the Code Search API (`sn_codesearch`) for `servicenow_search_code` (FT-7). When `true` and the plugin is active it replaces the LIKE iteration; falls back to LIKE on any failure. |
| `SN_EXPERIMENTAL_TASKS` | no | `0` | next | M-9, **experimental**: `1` adds an optional `run_as_task:true` argument to `snapshot_instance`, `compare_instances`, `run_atf_test`, `run_atf_suite`, `check_code_health` and `query_table` (`format:"file"` only). Such a call returns an MCP task handle at once (`_meta["io.modelcontextprotocol/related-task"]`); the client polls `tasks/get`, reads `tasks/result` (kept 1 h, redacted) or stops it with `tasks/cancel`. Off: schemas unchanged. Built on the SDK's experimental task API. |
| `SN_MCP_APPS` | no | `0` | next | N-50, MCP Apps (SEP-1865): `1` registers four self-contained `ui://servicenow-mcp/…` HTML views (`text/html;profile=mcp-app`: plan diff, Mermaid diagram, flow explainer, UI Builder page tree) and links the write tools with `apply`, the Mermaid generators, `explain_flow` and `explain_ui_experience` to them through `_meta.ui.resourceUri` — only for a client that advertises the `io.modelcontextprotocol/ui` extension. The views render the tool's own result (no network, strict CSP). Off: `tools/list`, resources and every result unchanged. |
| `SN_LEGACY_TOOL_NAMES` | no | `0` | next | M-7 (B2), **deprecated bridge for one minor cycle**: `1` registers every tool name and parameter name renamed by the v3 naming convention as an alias of its new name (the alias dispatches to the new tool and logs a one-time deprecation warning). Off: the old names do not exist and are absent from `tools/list`. See the rename table in the README. |

#### Access policy and write safety

Least-privilege table policy, plan-and-apply writes, destructive-write confirmation, per-session caps, prod profiles, update-set binding and the upload / email / SDK-managed-scope guards.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_TABLES_ALLOW` | no | — | 1.1.0 | Comma-separated table allowlist; when set, only these tables are reachable. |
| `SN_TABLES_DENY` | no | — | 1.1.0 | Comma-separated table denylist; always wins over the allowlist. |
| `SN_READONLY` | no | `false` | 1.1.0 | When truthy, refuse every create/update/delete. |
| `SN_WRITE_MODE` | no | `plan` | 2.0.0 | `plan` (default) previews a write as a before/after diff without mutating; `apply` executes; passing `apply:true` forces a single call. |
| `SN_DESTRUCTIVE_CONFIRM` | no | `token` | next | H-3: confirmation for a destructive `apply:true` (`delete_record`, `delete_attachment`, a writing `batch`, `send_email`, `order_catalog_item`, `revert_write`, `upsert_artifact`, `check_change_conflicts` with `calculate:true`) in plan mode. `token` (the 3.0 default, B4): the plan preview returns a single-use `plan_token` and the apply must pass it back with the same arguments, else `PLAN_REQUIRED`; `elicit`: `token` plus a confirmation prompt on clients with elicitation (a decline is `CONFIRM_DECLINED`, journaled as refused). `SN_WRITE_MODE=apply` bypasses it, except on a profile marked `prod` (`SN_ENV`), which is always at least `elicit` and is confirmed in apply mode too. `off` is the explicit opt-out (the pre-3.0 behaviour). |
| `SN_PLAN_TOKEN_TTL_SEC` | no | `600` | next | H-3: lifetime of a `plan_token` in seconds (30–86400). Tokens live only in the server process and are used up by the apply. |
| `SN_BATCH_UNMAPPED` | no | `deny` | next | H-4: a `servicenow_batch` sub-request whose REST path no tool package owns: `deny` (the 3.0 default, B8) refuses it (so a new plugin API cannot pass `SN_PACKAGES_DENY` / `SN_PACKAGES_READONLY` inside a batch); `allow` is the opt-out and checks it against the table and read-only axes only. A nested batch is always refused. |
| `SN_BATCH_MAX_REQUESTS` | no | `50` | next | H-4: most sub-requests one `servicenow_batch` call may carry (1–1000; 50 since 3.0), checked before anything is sent. |
| `SN_PROTECTED_TABLES_WRITE` | no | `deny` | next | H-11: `deny` (the 3.0 default, B11) refuses writes to the built-in protected tables (identity, roles, ACLs, `sys_properties`, OAuth, scripts, LDAP, certificates, data sources, REST messages — `servicenow_explain_policy` lists them) with `POLICY_DENIED`; an exact `SN_TABLES_ALLOW` entry re-enables one; `allow` is the opt-out for all of them. Reads are unaffected. |
| `SN_IMPORT_SET_TABLES` | no | `u_*,imp_*` | next | H-11: patterns (`*`, `?`) the import-set staging table must match (3.0 default `u_*,imp_*`); `*` is the opt-out (any table the table policy allows). |
| `SN_MAX_WRITES_PER_SESSION` | no | 500 per HTTP session, none on stdio | next | H-11: most applied instance writes per session (the process on stdio, one MCP session over HTTP; a batch counts its write sub-requests). Past it, writes fail with `WRITE_CAP` before any request; `get_status.writes.caps` shows the usage. Unset = 500 per HTTP session and no cap on stdio (3.0 default); `0` = no cap. |
| `SN_MAX_DELETES_PER_SESSION` | no | `100` | next | H-11: most applied deletes per session (`WRITE_CAP`; 100 since 3.0). `0` = no cap. |
| `SN_MAX_BATCH_WRITES` | no | `50` | next | H-11: most write (non-GET) sub-requests in one `servicenow_batch` (`WRITE_CAP`; 50 since 3.0). `0` = no cap. |
| `SN_ENV` | no | — | next | H-11: marks the default profile `prod`, `test` or `dev` (`SN_PROFILE_<NAME>_ENV` for others). A `prod` profile stays in plan mode even when apply is configured unless `SN_PROD_WRITES` (`SN_PROFILE_<NAME>_PROD_WRITES`) is `I_UNDERSTAND`; its destructive applies are always confirmed (at least `SN_DESTRUCTIVE_CONFIRM=elicit`, also in apply mode — `CONFIRM_REQUIRED` for a client without elicitation); results carry `_meta.environment`; `use_instance` warns. `SN_PROFILE_<NAME>_WRITE_MODE` sets the write mode per profile. |
| `SN_PROD_WRITES` | no | — | next | H-11: `I_UNDERSTAND` lets a `prod` default profile run in apply mode. |
| `SN_UPDATE_SET` | no | — | next | S-6: update set (sys_id or exact name) that applied Table-tool writes (create / update / upsert / delete) land in; a per-call `update_set` overrides it. The plan names the set; the user's current update set is switched for the write and restored after it. Data-row tables are written unchanged. |
| `SN_EMAIL_ALLOWED_DOMAINS` | no | — | next | Recipient domains `servicenow_send_email` may address (to/cc/bcc; a domain covers its subdomains, `*` allows any). When unset, every recipient must be the email of a user in the instance's own `sys_user` table; anything else fails with `RECIPIENT_NOT_ALLOWED`. |
| `SN_MAX_UPLOAD_BYTES` | no | `10485760` | next | Largest decoded attachment upload, checked on the base64 length before decoding (`PAYLOAD_TOO_LARGE`). |
| `SN_UPLOAD_MIME_ALLOW` | no | — | next | Optional allow-list of upload content types (exact, or `type/*`); others fail with `MIME_NOT_ALLOWED`. |
| `SN_SDK_MANAGED_SCOPES` | no | — | next | P-3: comma/space-separated application scopes (namespace such as `x_acme_app`, or the `sys_scope` sys_id) you declare as managed by a ServiceNow SDK (Fluent) project. The highest source of authority for SDK-managed detection; listed in `get_status` / `check_capabilities` under `sdkManaged`. |
| `SN_SDK_MANAGED_WRITES` | no | `warn` | next | P-22: writes into an SDK-managed scope (a record whose `sys_scope` P-3 detects as SDK-managed) from `create_record`, `update_record`, `upsert_record`, `delete_record`, `set_property`, `revert_write`, `upsert_artifact` (every record of the plan) and the Table API write sub-requests of `batch`; a create without `sys_scope` on a `sys_metadata` table is judged by the session's current application (`apps.current_app` preference; unreadable = a `sdkScopeWarning`, never a crash): `warn` previews and applies with an `sdkManaged` block naming the Fluent alternative; `deny` refuses the apply with `SDK_MANAGED_SCOPE` (the plan says `would_refuse`); `allow` skips the check. Runs after the table policy and costs nothing unless `SN_SDK_MANAGED_SCOPES` or `SN_SDK_PROJECT_DIRS` is set. |
| `SN_SDK_PROJECT_DIRS` | no | — | next | P-3: directories (separated by commas or the platform path delimiter) scanned read-only for SDK projects: each `now.config.json` declares its `scope` / `scopeId` as SDK-managed. Bounded (depth 4, 2000 directories, 100 config files, 256 KiB per file), never follows symbolic links, skips hidden, `node_modules` and build folders, and reads nothing but `now.config.json`. |

#### Results, redaction and exports

Result size budgets, output shaping, redaction of record values, the write journal and CSV export safety.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_MAX_RECORDS` | no | `10000` | 1.1.0 | Hard cap on records returned by a `fetchAll` query. |
| `SN_MAX_RESULT_CHARS` | no | `100000` | 1.1.0 | Character budget for a query result before it is truncated for the client; the truncation note names `format:"file"`. A snapshot, compare or diagram result over the budget is returned in full with a `note`. |
| `SN_OVERSIZE_TO_FILE` | no | `false` | next | S-11: write a snapshot, compare or diagram result over `SN_MAX_RESULT_CHARS` to a file under `SN_DOCS_DIR` (`<profile>/exports/`, `<profile>/diagrams/`) and return `{path, bytes, preview}` instead. |
| `SN_INCLUDE_REF_LINKS` | no | `false` | 1.1.0 | Reference fields come back without their `link` URLs by default (token savings). Set `true` to include them. |
| `SN_RESULT_PRETTY` | no | `false` | 1.1.0 | Tool results are compact JSON by default (pretty-printing ~doubles tokens). Set `true` for indented output. |
| `SN_REDACT_FIELDS` | no | — | 2.0.0 | DF-5: mask these field values before records reach the model (comma/space-separated). |
| `SN_REDACT_PII` | no | `false` | 2.0.0 | DF-5: also mask email/phone/national-id patterns inside string values. Since H-5 both redaction settings apply deeply to every tool result (success and error) and to the write journal. |
| `SN_JOURNAL_MAX_BYTES` | no | `20971520` | next | H-5: size (bytes, default 20 MiB) at which `write-journal.jsonl` rotates to `write-journal.<ISO-time>.jsonl`; the hash chain continues across files. |
| `SN_CSV_FORMULA_GUARD` | no | `true` | next | H-5: prefix CSV text cells that start with `=`, `+`, `-`, `@`, tab or CR with `'` so spreadsheets never evaluate them (a text `-5` exports as `'-5`). `0` opts out. |
| `SN_CSV_BOM` | no | `true` | next | H-5: prepend a UTF-8 BOM to `format:"csv"` exports so Excel decodes non-ASCII text. `0` opts out. |

#### Caching

The schema reads cache and the capability / plugin-API probes.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_SCHEMA_CACHE_TTL_SEC` | no | `300` | 1.1.0 | TTL for the near-static schema reads cache (`list_tables`, `describe_table`, `get_cmdb_meta`). `0` disables caching. |
| `SN_SCHEMA_CACHE_MAX` | no | `256` | next | Maximum entries in the schema reads cache; when full, the least-recently-used entry is evicted. Counters (`size`, `hits`, `misses`, `evictions`) appear in `get_status` under `schemaCache`. |
| `SN_CAPABILITY_TTL_MS` | no | `600000` | next | How long a successful capability probe is cached — the `servicenow_check_capabilities` matrix and the plugin-API availability (CI/CD, Code Search, Batch…). Pass `refresh: true` to re-probe sooner. |
| `SN_PLUGIN_NEGATIVE_TTL_MS` | no | `60000` | next | How long a failed capability probe (HTTP 401/403/404/5xx) or a missing plugin API is cached before it is tried again. Transport errors are never cached. |

#### Docs store and diagrams

The local Markdown docs store (also home of the write journal — keep it out of version control) and the generated Mermaid diagrams.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_DOCS_DIR` | no | `docs/instance` | 1.0.0 | Directory the `docs` package reads/writes Markdown in. Relative paths resolve against the working directory. It also holds the per-profile write journal — add `docs/instance/` to `.gitignore` in any repository you run the server from. |
| `SN_DOCS_MAX_FILE_BYTES` | no | `5242880` | next | Per-file size cap for the docs tools: larger writes are refused, reads return the first bytes with `truncated: true`, search skips the file. |
| `SN_DOCS_STALE_DAYS` | no | `30` | next | `servicenow_list_docs` flags a generated document `stale` when its `sn_generated_at` is older than this many days. |
| `SN_DOCS_SEARCH_MAX` | no | `200` | next | Most matches `servicenow_search_docs` returns; past it the result carries `truncated: true`. |
| `SN_DIAGRAM_MAX_NODES` | no | `200` | next | Node cap for the generated Mermaid diagrams (table flow, event trace, where-used; tables in a detailed ER diagram). Nodes past it fold into one `+N more` node. |

#### HTTP transport

stdio (default, one local client) or Streamable HTTP for remote and agent clients. Securing the HTTP endpoint (TLS, auth, network) is the operator's job.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_TRANSPORT` | no | `stdio` | 2.0.0 | DF-6: `stdio` (default) or `http` (Streamable HTTP for remote/agent clients). |
| `SN_PORT` | no | `3000` | 2.0.0 | DF-6: TCP port for the http transport. |
| `SN_HTTP_HOST` | no | `127.0.0.1` | 2.0.0 | DF-6: bind address for the http transport (loopback by default). |
| `SN_HTTP_TOKEN` | no | — | 2.0.0 | DF-6: when set, http requests must send `Authorization: Bearer <token>`. **Required** whenever `SN_HTTP_HOST` is not loopback (e.g. `0.0.0.0` in the Docker image) — without it every client that reaches the port is accepted, and a warning is logged. |
| `SN_HTTP_REQUIRE_TOKEN` | no | off | next | H-7: refuse to start the http transport on a non-loopback `SN_HTTP_HOST` without `SN_HTTP_TOKEN` (instead of logging a warning). |
| `SN_HTTP_SESSION_TTL_SEC` | no | `1800` | next | H-7: idle TTL of an http session in seconds; an idle session is closed and its runtime disposed. `0` keeps sessions until the client sends DELETE. |
| `SN_HTTP_MAX_SESSIONS` | no | `64` | next | H-7: cap on concurrent http sessions; a new session beyond it is refused with 503. |
| `SN_HTTP_KEEPALIVE_MS` | no | `25000` | next | H-7: interval of the SSE keep-alive comment on an open stream (below common proxy idle timeouts). `0` disables it. |
| `SN_HTTP_ALLOWED_HOSTS` | no | — | next | H-7: `Host` header values the http transport accepts (DNS-rebinding guard); an entry without a port matches any port. Unset = loopback names on a loopback bind, no check otherwise (warned). |
| `SN_HTTP_ALLOWED_ORIGINS` | no | — | next | H-7: browser `Origin` values the http transport accepts (`*` = any). Unset = loopback origins only; a request without an Origin header is never refused by this check. |
| `SN_METRICS` | no | off | next | E-5: HTTP transport only — serve Prometheus metrics at `GET /metrics`, behind `SN_HTTP_TOKEN` (disabled when no token is set). |

#### Logging

The stderr log, the optional log file and the log lines mirrored to the MCP client.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_LOG_LEVEL` | no | `info` | 1.1.0 | Log verbosity on stderr: `error`, `warn`, `info`, `debug`. The legacy `LOG_LEVEL` is read when this is unset. Also read as `LOG_LEVEL`. |
| `SN_LOG_FORMAT` | no | `json` | next | E-5: stderr log line format — `json` (one object per line) or `text` (`HH:MM:SS level message key=value`). |
| `SN_LOG_FILE` | no | — | next | E-5: also append every log line (JSON Lines, redacted, mode 0600) to this file, with size-based rotation (`<file>.1` … `<file>.5`). Stderr keeps working. |
| `SN_LOG_FILE_MAX_BYTES` | no | `10485760` | next | E-5: rotation threshold for `SN_LOG_FILE` (bytes). |
| `SN_LOG_NOTIFY_RATE` | no | `20` | next | M-8: log notifications per second and client session over the MCP logging capability (burst 50, or the rate if larger). Lines over it are counted and reported in one "N log messages suppressed" warning per minute; stderr is never throttled. `0` = no limit. |
| `SN_OTEL` | no | off | next | N-55: map the tool-call and HTTP `diagnostics_channel` events to OpenTelemetry spans (MCP / GenAI semantic conventions). Needs the optional peer dependency `@opentelemetry/api` and an OpenTelemetry SDK registered in the process (e.g. `node --import`); without the package one warning is logged and nothing else changes. |
| `SN_OTEL_PROPAGATE` | no | off | next | N-55: send W3C `traceparent` / `tracestate` headers on outbound ServiceNow REST requests — the HTTP client span's context when `SN_OTEL` is on, otherwise the context the client sent in `params._meta`. Off: trace ids never leave the server. |

#### Settings validation

Every setting is validated at startup. An invalid value is logged as a warning and the setting keeps its default; strict mode makes it a startup error instead.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `SN_STRICT_SETTINGS` | no | `false` | next | E-4: make an invalid setting value (a non-number, an unknown enum value, an out-of-range port…) a startup error that names every offending key, instead of a warning plus the default. Unknown `SN_*` keys stay warnings. Planned to default on in 3.0 (owner decision O-4). |

#### Standard variables

Conventional variables outside the SN_ namespace that the server also honours.

| Variable | Required | Default | Since | Description |
| -------- | :------: | ------- | ----- | ----------- |
| `HTTPS_PROXY` | no | — | next | Standard proxy for HTTPS traffic, honoured when `SN_HTTPS_PROXY` is unset (with `NO_PROXY`). Also read as `https_proxy`. |
| `HTTP_PROXY` | no | — | next | Fallback proxy when `HTTPS_PROXY` is unset. Also read as `http_proxy`. |
| `NO_PROXY` | no | — | next | Hosts that bypass `HTTPS_PROXY` / `HTTP_PROXY` (never `SN_HTTPS_PROXY`). Also read as `no_proxy`. |
| `XDG_CONFIG_HOME` | no | `~/.config` | 1.1.0 | Base directory of the default env file (`$XDG_CONFIG_HOME/servicenow-mcp-ai/.env`). |

<!-- GENERATED:ENV:END -->

### Secrets from files

Every secret setting can be read from a file, the convention of Docker, Compose / Swarm and Kubernetes secrets: set `<KEY>_FILE` to a path and the server loads `<KEY>` from it at startup. This covers `SN_PASSWORD`, `SN_API_KEY`, `SN_BEARER_TOKEN`, `SN_OAUTH_CLIENT_SECRET`, `SN_OAUTH_REFRESH_TOKEN` and `SN_HTTP_TOKEN`, plus the per-profile forms (`SN_PROFILE_PROD_PASSWORD_FILE`, `SN_PROFILE_PROD_API_KEY_FILE`, …).

- One trailing newline is trimmed, so `echo secret > file` works; other whitespace is kept.
- Setting both `<KEY>` and `<KEY>_FILE` is a startup error that names the pair — the server never picks one silently.
- An unreadable or empty file is a startup error that names the setting and the reason, never the content.
- A value loaded from a file is never written back to the env file: `servicenow_set_credentials` and OAuth refresh-token rotation refuse to persist it (a rotated refresh token stays in memory with a warning) — update the file.
- The existing file settings keep their meaning: `SN_TOKEN_FILE` (bearer token re-read on a 401), `SN_OAUTH_JWT_KEY_FILE` and the `SN_TLS_*_FILE` PEM paths are paths the server reads itself, not `<KEY>_FILE` sources.

### Two-axis access policy

Access is controlled on **two independent axes**: tables and tool packages.

| Axis         | Enable / deny / read-only                                | Example                                                                       |
| ------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Tables**   | `SN_TABLES_ALLOW` / `SN_TABLES_DENY` / `SN_READONLY`     | `SN_TABLES_DENY=change_request` blocks the Table API **and** (since H-4) the Change tools, which check their backing table. |
| **Packages** | `SN_TOOL_PACKAGES` / `SN_PACKAGES_DENY` / `SN_PACKAGES_READONLY` | `SN_PACKAGES_DENY=change` removes the Change Management tools and blocks the `sn_chg_rest` plugin API, also inside a batch. |

Since H-4 the plugin-backed tools (Change, Catalog, Knowledge, Email, ATF) and
attachments (through the parent record's table) obey the table axis too; the
package axis still removes whole surfaces. See [Security notes](#security-notes)
for the full model (including how the Batch API obeys both axes).

**List syntax:** table lists (`SN_TABLES_ALLOW` / `SN_TABLES_DENY`) are
comma-separated; package lists (`SN_TOOL_PACKAGES`, `SN_PACKAGES_DENY`,
`SN_PACKAGES_READONLY`) accept commas **or** whitespace. Surrounding spaces are
trimmed in both, and table matching is case-insensitive — so
`SN_TABLES_DENY=Change_Request, sys_user` works. Since H-11 a table entry may be
a pattern (`*` any run, `?` one character): `SN_TABLES_DENY=sys_*` blocks
`sys_user` and leaves `incident` alone. The order is: an exact deny, an exact
allow, a pattern deny, the protected tables (writes; denied by default since
3.0, `SN_PROTECTED_TABLES_WRITE=allow` lifts it), then the allowlist's
patterns. Ask
`servicenow_explain_policy({table, action})` which rule decides, or read
`servicenow://policy`.

## Run / debug

- **VS Code**: open the Command Palette and start the server defined in
  [.vscode/mcp.json](.vscode/mcp.json), then use it from Chat.
- **MCP Inspector**: `npm run inspector`
- **Directly**: `npm start`

### Observability

- **Status.** `servicenow_get_status` carries an `observability` block: per-tool
  `{count, errors, p50, p95, totalMs}` (percentiles in ms over each tool's last 256
  calls — memory stays bounded) plus result sizes `{bytesTotal, textBytes,
  structuredBytes, bytesP50, bytesP95}` (UTF-8 bytes of the text blocks and of
  `structuredContent`, the wire cost of each tool), schema-cache hits/misses, per-host retry counters,
  queue limits and occupancy, circuit-breaker state and the last `X-RateLimit-*`
  headers each host sent. It never calls the instance.
- **Logs.** Logs go to stderr only (stdout is the MCP protocol). `SN_LOG_FORMAT=text`
  switches from JSON lines to a human-readable format; `SN_LOG_FILE` also appends
  JSON lines to a size-rotated file. Credential-named fields (`password`, `token`,
  `authorization`, …) are masked in every sink, and the `SN_REDACT_FIELDS` /
  `SN_REDACT_PII` rules and the secret-column masking apply on top.
- **Tracing hooks.** Every tool call and the request loop publish on
  [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html), so an
  OpenTelemetry (or any) subscriber can attach without a dependency on this server.
  Messages are built only while a channel has a subscriber:

  | Channel                             | When                                           | Message fields                                                                                                        |
  | ----------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
  | `servicenow-mcp:mcp.tool.call.start` | a tool call begins | `id`, `tool`, `package`, `requestId`, and `sessionId` / `traceparent` / `tracestate` when known |
  | `servicenow-mcp:mcp.tool.call.end` | it returned a successful result | the start fields plus `profile`, `outcome` (`ok`), `ms`, `resultBytes` |
  | `servicenow-mcp:mcp.tool.call.error` | it returned an error result or threw | the start fields plus `profile`, `outcome` (`error` / `cancelled`), `ms`, and `code` / `resultBytes` or `errorName` |
  | `servicenow-mcp:http.request.start` | a logical request begins                       | `id`, `system`, `method`, `host`, `telemetryKey`, `url`, and `profile` / `requestId` / `sessionId` / `tool` / `callId` / `traceparent` / `tracestate` in a call |
  | `servicenow-mcp:http.request.end`   | it resolved with an OK response                | the start fields plus `status`, `attempts`, `ms`                                                                      |
  | `servicenow-mcp:http.request.error` | it failed                                      | the start fields plus `attempts`, `ms`, `status`, `code`, `errorName`, `errorMessage`                                 |
  | `servicenow-mcp:http.request.retry` | an attempt is replayed (backoff, 401 re-auth) | `id`, `system`, `method`, `host`, `url`, `attempt`, `reason`, `waitMs`                                               |

  `url` never includes the query string; headers, bodies and credentials are never
  published, and `errorMessage` passes through the redaction rules.

  Tool arguments and results are never published (only the result's byte count).
  `callId` on an HTTP message is the `id` of the tool call that made it.
  `traceparent` / `tracestate` are the W3C Trace Context the client sent in the call's
  `params._meta`; a malformed value is dropped.

- **OpenTelemetry spans.** `SN_OTEL=1` maps those channels to spans through
  [`@opentelemetry/api`](https://www.npmjs.com/package/@opentelemetry/api), an optional
  peer dependency (`npm install @opentelemetry/api` next to the server, plus your SDK
  and exporter registered with `node --import`). Without the package the server logs one
  warning and runs without spans; with `SN_OTEL` off the package is never loaded.
  - Each tool call is a `SERVER` span named `tools/call <tool>`, a child of the client's
    `traceparent` when it sent one. Attributes: `mcp.method.name`,
    `gen_ai.operation.name` (`execute_tool`), `gen_ai.tool.name`, `jsonrpc.request.id`,
    `mcp.session.id`, `network.transport`, `error.type`, plus `servicenow_mcp.package`
    / `.profile` / `.outcome` / `.result.bytes`.
  - Each outbound request is a `CLIENT` span named after the method, a child of its tool
    span: `http.request.method`, `server.address`, `url.full` (no query string),
    `http.response.status_code`, `http.request.resend_count`, `error.type`, and one
    `retry` event per replay.
  - The MCP and GenAI semantic conventions are still in development, so these names
    are provisional and may follow the spec when it changes.
  - `SN_OTEL_PROPAGATE=1` (off by default) also sends `traceparent` / `tracestate`
    headers on requests to the ServiceNow instance: the HTTP span's context when
    `SN_OTEL` is on, otherwise the client's context unchanged. It is opt-in because it
    hands trace ids to the instance; the OAuth token endpoint never gets them.

- **Prometheus.** With the HTTP transport, `SN_METRICS=1` and `SN_HTTP_TOKEN` set,
  `GET /metrics` (same bearer token) serves the same figures in the Prometheus text
  format (`servicenow_mcp_*` families, labelled by `tool` / `host` only). Without a
  token the endpoint stays off and a warning is logged.

### Command-line interface

The published `servicenow-mcp-ai` binary (run it directly, or via
`npx servicenow-mcp-ai`) starts the MCP server when it is given no command, and
otherwise runs one of the commands below and exits. Connection settings come from
environment variables / the env file (see [Environment variables](#environment-variables)).
`servicenow-mcp-ai --help` lists everything; `--version` prints the version. An
unknown command or option prints the usage on stderr and exits `2` — it never
starts the server.

| Command                                         | Options                                  | What it does                                                                                                                         | Exit codes                                                  |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `servicenow-mcp-ai`                             | _(none)_                                 | Starts the MCP server. The transport (`stdio` default, or `http`) is chosen by `SN_TRANSPORT`; runs until `SIGINT`/`SIGTERM`. stdout is the protocol channel. | `0` clean shutdown · `1` fatal startup error                |
| `servicenow-mcp-ai init`                        | `--profile <name>`, `--skip-doctor`      | Interactive setup: asks for the instance, the auth method and its credentials (secrets through a hidden prompt), writes the env file, then runs `doctor`. | the `doctor` exit code · `0` with `--skip-doctor` · `2` refused / invalid answers |
| `servicenow-mcp-ai doctor`                      | `--json`, `--ascii`, `--profile <name>`  | Health check: credentials, a live connectivity probe and the capability preflight. The first line names the env file that was used. | `0` healthy · `1` degraded or unreachable · `2` not configured |
| `servicenow-mcp-ai login`                       | `--profile <name>`                       | One-time OAuth 2.1 Authorization Code + PKCE login: opens the browser, captures the loopback redirect, stores a refresh token.      | `0` success · `1` login failed                              |
| `servicenow-mcp-ai drift <profileA> <profileB>` | _(none)_                                 | DF-3 CI drift gate: compares the two instances and writes a Markdown diff report.                                                  | `0` no drift · `1` drift found · `2` usage / error          |
| `servicenow-mcp-ai support-bundle`              | `--out <file>`, `--profile <name>`       | Writes one JSON file for a bug report and prints its path on stdout.                                                               | `0` written · `1` write failed                              |

**`init`** writes through the same atomic, owner-only (`0600`) env-file writer as
`servicenow_set_credentials`, to the file `doctor` names (by default
`~/.config/servicenow-mcp-ai/.env`). It asks, in order: the instance (`dev12345`
or a full host; a custom domain needs `SN_ALLOWED_HOSTS`), the auth method
(`basic` / `oauth` / `apikey` / `token`), then that method's settings — for
`oauth` the grant (`client_credentials`, `password`, or `authorization_code`,
which ends with a hint to run `login`). Secrets are never echoed or logged; the
summary lists key names only. With `--profile qa` the keys are written as
`SN_PROFILE_QA_*`. An existing profile is overwritten only after a `y`. The
answers can be piped, one per line, which is how CI and tests drive it:

```bash
printf 'dev12345\nbasic\nalice\n%s\n' "$SN_PASSWORD" | npx servicenow-mcp-ai init
```

Without a terminal and without piped answers, `init` refuses (exit `2`) and
writes nothing.

**`doctor`** prints plain ASCII (`[ok]` / `[x]` instead of check marks) with
`--ascii`, when stdout is not a terminal, and on Windows outside Windows Terminal.
`--json` prints one JSON document instead: `envFile`, `status`, `summary`,
`checks[]` (`name`, `ok`, `detail`), `config`, `connection`, `capabilities` and
`serverStatus` (the `servicenow_get_status` payload) — for example
`servicenow-mcp-ai doctor --json | jq .checks`. The exit codes are the same.

**`support-bundle`** collects the `doctor --json` payload, every `SN_*` setting
with secrets masked as `***`, `npm ls --omit=dev` (best effort), the tool
manifest summary (version, tool and package counts, active tools) and the last
200 lines of `SN_LOG_FILE` when one is set. Every masked value is also scrubbed
from the whole file. The default path is
`./servicenow-mcp-ai-support-<timestamp>.json` (mode `0600`). Instance and user
names are **not** masked — review the file before you attach it to an issue.

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

The report shows each changed script as a `diff` block. The CLI compares tables,
columns, scripts, plugins and apps; record sections (`sections` on
`servicenow_compare_instances`) are opt-in, so the exit codes are unchanged.

`servicenow_snapshot_instance` writes the same material to the docs folder, one
file per section, at most four sections at a time. An interrupted run is marked
`partial` in `index.json`; rerun it with `resume: true` to skip every section whose
files are unchanged.

## Develop

```bash
npm run check     # full gate: build, lint, format check, coverage-gated tests, tarball guard, prod audit
npm test          # unit tests only (node:test; needs a prior npm run build)
npm run lint      # ESLint (flat config + typescript-eslint)
npm run format    # format with Prettier
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions (one commit per
task, tests ship with the change, generated docs).

## Tools

The full reference — every parameter, the output fields, how each tool writes, and the error codes — is in [docs/tools/](docs/tools/README.md), one page per package. [docs/llms-full.txt](docs/llms-full.txt) bundles this README, SECURITY.md and that reference in one file for LLM context.

<!-- GENERATED:TOOLS:BEGIN (npm run docs:readme) -->

_This table is generated from the tool registrations — edit the tool
definitions in `src/tools/`, then run `npm run docs:readme`._

| Package | Tool | Read-only | Description |
| ------- | ---- | :-------: | ----------- |
| `table` | `servicenow_query_table` | yes | Read records from any table (Table API): encoded query, fields, paging, fetchAll |
| `table` | `servicenow_get_record` | yes | Read a single record from a table by its sys_id |
| `table` | `servicenow_create_record` | no | Create a new record in a table with the given field values |
| `table` | `servicenow_update_record` | no | Update fields on an existing record identified by its sys_id |
| `table` | `servicenow_upsert_record` | no | Create or update one record matched by an exact key of field/value pairs: no match creates, one updates, se… |
| `table` | `servicenow_delete_record` | no | Delete a record from a table by its sys_id |
| `schema` | `servicenow_list_tables` | yes | List tables from sys_db_object, optionally filtered by a name or label fragment |
| `schema` | `servicenow_describe_table` | yes | List a table's columns from sys_dictionary (name, label, type, mandatory, reference, default, flags) |
| `aggregate` | `servicenow_aggregate` | yes | Server-side aggregates (count, avg, min, max, sum) over a table via the Stats API, optionally grouped |
| `attachment` | `servicenow_list_attachments` | yes | List attachment metadata, optionally for one record (table + sys_id) |
| `attachment` | `servicenow_get_attachment` | yes | Read a single attachment's metadata by its sys_id |
| `attachment` | `servicenow_download_attachment` | yes | Download an attachment's bytes, returned as base64 |
| `attachment` | `servicenow_upload_attachment` | no | Attach a file (provided as base64) to a record identified by table + sys_id |
| `attachment` | `servicenow_delete_attachment` | no | Delete an attachment by its sys_id |
| `importset` | `servicenow_insert_import_set_row` | no | Insert one row into a staging table and run its transform map |
| `importset` | `servicenow_get_import_set_row` | yes | Read the transform outcome of a staging row |
| `batch` | `servicenow_batch` | no | Run several REST sub-requests in one round-trip (Batch API) |
| `catalog` | `servicenow_list_catalogs` | yes | List the Service Catalogs available on the instance (Service Catalog API) |
| `catalog` | `servicenow_list_catalog_categories` | yes | List the categories within a service catalog |
| `catalog` | `servicenow_list_catalog_items` | yes | Search/list orderable catalog items, optionally by text or category |
| `catalog` | `servicenow_get_catalog_item` | yes | Get a catalog item, including its order variables, by sys_id |
| `catalog` | `servicenow_order_catalog_item` | no | Order a catalog item directly ('order now') |
| `change` | `servicenow_list_changes` | yes | List change requests (Change Management API) with an encoded query, fields and paging |
| `change` | `servicenow_get_change` | yes | Get a single change request by sys_id |
| `change` | `servicenow_create_change` | no | Create a normal, standard or emergency change |
| `change` | `servicenow_update_change` | no | Update fields on a change request by sys_id |
| `change` | `servicenow_check_change_conflicts` | no | Read schedule conflicts for a change, or recalculate them (calculate=true) |
| `knowledge` | `servicenow_search_knowledge` | yes | Full-text search of knowledge articles (Knowledge API), with optional encoded query and paging |
| `knowledge` | `servicenow_get_knowledge_article` | yes | Get a knowledge article (content and metadata) by sys_id |
| `knowledge` | `servicenow_get_knowledge_highlights` | yes | List featured or most-viewed knowledge articles for the current user |
| `cmdb` | `servicenow_list_cis` | yes | List configuration items of a CMDB class through the class-aware CMDB Instance API |
| `cmdb` | `servicenow_get_ci` | yes | Get a CI with its attributes and inbound/outbound relations by class and sys_id |
| `cmdb` | `servicenow_create_ci` | no | Create a CI via the CMDB Instance API (routed through Identification & Reconciliation) |
| `cmdb` | `servicenow_update_ci` | no | Update a CI's attributes via the CMDB Instance API (IRE) |
| `cmdb` | `servicenow_get_cmdb_meta` | yes | Schema of a CMDB class (attributes, relationship rules) from the CMDB Meta API |
| `cmdb` | `servicenow_list_ci_relations` | yes | List one CI's relationships (cmdb_rel_ci), outbound = parent, inbound = child, with the related CI's name a… |
| `cmdb` | `servicenow_identify_reconcile` | no | Send CIs and relationships through the Identification & Reconciliation Engine: matched by identification ru… |
| `scripts` | `servicenow_list_scripts` | yes | List script artefacts of one type as metadata (no source) |
| `scripts` | `servicenow_get_script` | yes | Read one script artefact in full: source code and execution context |
| `scripts` | `servicenow_search_code` | yes | Search script source for a literal substring across one or all script types |
| `scripts` | `servicenow_describe_table_logic` | yes | The automation on a table: business rules (by when+order), client scripts, UI policies, UI actions, ACLs |
| `scripts` | `servicenow_where_used` | yes | Find references to a table, field (table.field) or script: matching script lines, rules/ACLs on a table, st… |
| `flows` | `servicenow_trace_table_event` | yes | Trace what would run for a table operation, in order, without executing: business rules by phase (inherited… |
| `flows` | `servicenow_list_flows` | yes | List flows (sys_hub_flow) or legacy workflows (kind: 'workflow') as metadata |
| `flows` | `servicenow_get_flow` | yes | Structured view of one flow or workflow: trigger (table/condition/when) and ordered steps; not a full decom… |
| `flows` | `servicenow_get_flow_runs` | yes | Flow runs from sys_flow_context, by flow sys_id or by the record it ran against: start, state and outcome |
| `flows` | `servicenow_explain_flow` | yes | Explain a flow/subflow (trigger, step tree, decoded inputs and pills, calls expanded), a custom action (inp… |
| `codecheck` | `servicenow_lint_script` | yes | Run deterministic code-quality rules on one script (hard-coded sys_ids, unbounded or in-loop GlideRecord, e… |
| `codecheck` | `servicenow_lint_table` | yes | Lint every active business rule, client script and UI policy of a table: per-script findings and a severity… |
| `codecheck` | `servicenow_check_code_health` | no | Code-health report: script counts by type, ACL security scan (open, public, scripted, elevated ACLs; public… |
| `docs` | `servicenow_list_docs` | yes | List the Markdown docs in SN_DOCS_DIR with metadata: generated or hand-written, generator, generated_at, pr… |
| `docs` | `servicenow_read_doc` | yes | Read one local Markdown doc or its .json companion; the result carries its mimeType |
| `docs` | `servicenow_search_docs` | yes | Search the local docs for a substring: a snippet and nearest heading per match (max SN_DOCS_SEARCH_MAX, the… |
| `docs` | `servicenow_write_doc` | no | Create or overwrite a local Markdown doc and refresh index.md |
| `docs` | `servicenow_generate_er_diagram` | yes | Mermaid erDiagram from sys_dictionary: an entity per table, a relationship per reference field |
| `docs` | `servicenow_generate_table_flow` | yes | Mermaid flowchart of a record's lifecycle: active business rules by phase, inherited and global rules in ow… |
| `docs` | `servicenow_document_table` | no | Write <profile>/tables/<table>.md + .json from metadata: inheritance, columns, references, ER and flow diag… |
| `docs` | `servicenow_document_app` | no | Write <profile>/apps/<scope>.md + .json for one scoped app: record, tables with an ER diagram, roles, cross… |
| `docs` | `servicenow_document_instance` | no | Write <profile>/README.md (version, counts, apps, plugins, automation, update sets) and artifact-types.md, … |
| `instance` | `servicenow_snapshot_instance` | no | Download structural metadata to SN_DOCS_DIR/<profile>/ as Markdown + JSON: tables, schemas, plugins, apps, … |
| `instance` | `servicenow_compare_instances` | no | Diff two profiles: tables, column differences, scripts missing/renamed/changed (unified diff), plugin/app i… |
| `email` | `servicenow_send_email` | no | Send an email (Email API plugin), optionally tied to a record (table + sys_id) |
| `email` | `servicenow_get_email` | yes | Read a sent/received email record by its sys_id (Email API) |
| `atf` | `servicenow_list_atf_tests` | yes | List ATF tests (sys_atf_test) as metadata: name, active, description |
| `atf` | `servicenow_list_atf_suites` | yes | List ATF test suites (sys_atf_test_suite) as metadata |
| `atf` | `servicenow_run_atf_test` | no | Run one ATF test through the CI/CD API |
| `atf` | `servicenow_run_atf_suite` | no | Run an ATF test suite through the CI/CD API |
| `atf` | `servicenow_get_atf_result` | yes | Poll an ATF run by its execution id: status, percent complete and message (CI/CD progress API) |
| `revert` | `servicenow_list_writes` | yes | List the local write journal (newest first): every write this server made, with entry id, outcome and wheth… |
| `revert` | `servicenow_revert_write` | no | Undo one applied write from the local journal: an update restores its before values, a create is deleted, a… |
| `artifacts` | `servicenow_list_artifacts` | yes | List records of any registry artifact type as summaries: sys_id, name, key, scope, active, SDK-managed verd… |
| `artifacts` | `servicenow_get_artifact` | yes | Read one artifact of any registry type in full: the record, its registry children (e.g |
| `artifacts` | `servicenow_explain_artifact` | yes | Explain one artifact of any registry type: summary, trigger fields, non-empty fields, children, referenced … |
| `artifacts` | `servicenow_get_artifact_dependencies` | yes | Dependency graph of one artifact: outbound (references, decoded JSON, script calls, GlideRecord tables) and… |
| `artifacts` | `servicenow_generate_fluent` | yes | Emit SDK Fluent source (.now.ts, sidecars, keys.ts fragment) for one artifact or a type in a scope |
| `artifacts` | `servicenow_upsert_artifact` | no | Create or update a registry artifact and its children (UI policy actions, portal page layout, catalog varia… |
| `updatesets` | `servicenow_list_update_sets` | yes | List update sets, newest first, with state, scope and whether each is the user's current one |
| `updatesets` | `servicenow_get_update_set` | yes | Summarise one update set: its customer updates (sys_update_xml) per artefact — type, target, action, table … |
| `updatesets` | `servicenow_compare_update_set` | yes | Compare an update set's artefacts with another profile (live) or a stored snapshot: a status per artefact (… |
| `ops` | `servicenow_read_ops` | yes | Bounded ops views for 'why is it slow' triage: overview, syslog, jobs (sys_trigger), email_queue, semaphore… |
| `ops` | `servicenow_check_data_health` | yes | Data-quality counts for one table: duplicate groups over key_fields, orphaned or stale references per field… |
| `history` | `servicenow_get_record_history` | yes | Read a record's history: sys_audit changes and journal entries (comments, work_notes), newest first — journ… |
| `properties` | `servicenow_get_properties` | yes | Read system properties (sys_properties) by name or prefix: value, type, description, roles, scope, last update |
| `properties` | `servicenow_set_property` | no | Set one existing system property by name |
| `directory` | `servicenow_lookup_directory` | yes | Find users, groups or roles by search term or sys_id |
| `ui` | `servicenow_explain_portal` | yes | Explain a Service Portal (url_suffix or sys_id) or one page as a tree: theme, menu, pages, layout down to w… |
| `ui` | `servicenow_explain_ui_experience` | yes | Explain a UI Builder experience/workspace (path or sys_id) as a page map: routes → screens → macroponents →… |
| `admin` | `servicenow_set_credentials` | no | Save connection credentials to the env file for later requests (any subset; auth / oauth_client_id / oauth_… |
| `admin` | `servicenow_list_instances` | yes | List the connection profiles: name, host, user, auth method (and OAuth grant), refresh-token state, read-on… |
| `admin` | `servicenow_use_instance` | no | Switch the connection profile (over HTTP: this session only unless persist) |
| `admin` | `servicenow_explain_policy` | yes | Say whether a table may be read or written under the active policy and which rule decides, or, without a ta… |
| `admin` | `servicenow_get_status` | yes | Show instance, auth, missing credentials, per-profile write mode, policy, limits, TLS, queue, write counter… |
| `admin` | `servicenow_test_connection` | yes | Verify the credentials work: reads one sys_user record, reports ok/status/latency |
| `admin` | `servicenow_check_capabilities` | yes | Preflight which sys_* tables are readable and which capabilities work — run it before scripts/flows/codeche… |
| `admin` | `servicenow_list_packages` | yes | List tool packages with their session state: enabled, configured, denied, read-only, tool count |
| `admin` | `servicenow_enable_package` | no | Enable a tool package for this session (list_changed is sent) |
| `admin` | `servicenow_disable_package` | no | Disable a tool package for this session: its tools, resources and prompts are withdrawn (list_changed is sent) |

<!-- GENERATED:TOOLS:END -->

All tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`) so clients can apply the right confirmation UX.

### Tool names (v3)

Every tool is named `servicenow_<verb>_<noun>`. Parameters follow one
vocabulary: `sys_id` is a record id, `table` is a table name (the CMDB tools
still accept `class_name` as a deprecated alias), `fields` is the list of
columns to return, and `values` is a write payload. Version 3.0 renamed these
tools:

<!-- GENERATED:TOOL-RENAMES:BEGIN (npm run docs:readme) -->

_Generated from `TOOL_RENAMES` in `src/mcp/naming.ts` — run
`npm run docs:readme` after changing it._

| v2 name                            | v3 name                                | Why                                   |
| ---------------------------------- | -------------------------------------- | ------------------------------------- |
| `servicenow_artifact_dependencies` | `servicenow_get_artifact_dependencies` | No verb.                              |
| `servicenow_change_conflicts`      | `servicenow_check_change_conflicts`    | No verb.                              |
| `servicenow_code_health`           | `servicenow_check_code_health`         | No verb.                              |
| `servicenow_data_health`           | `servicenow_check_data_health`         | No verb; parallels check_code_health. |
| `servicenow_docs_list`             | `servicenow_list_docs`                 | Noun before verb.                     |
| `servicenow_docs_read`             | `servicenow_read_doc`                  | Noun before verb.                     |
| `servicenow_docs_search`           | `servicenow_search_docs`               | Noun before verb.                     |
| `servicenow_docs_write`            | `servicenow_write_doc`                 | Noun before verb.                     |
| `servicenow_knowledge_highlights`  | `servicenow_get_knowledge_highlights`  | No verb.                              |
| `servicenow_ops_read`              | `servicenow_read_ops`                  | Noun before verb.                     |
| `servicenow_table_logic`           | `servicenow_describe_table_logic`      | No verb.                              |

<!-- GENERATED:TOOL-RENAMES:END -->

Set `SN_LEGACY_TOOL_NAMES=1` to keep a 2.x client working for one minor
release: the old names are registered as deprecated aliases of the new tools,
and the old parameter names (`attachment_sys_id`, `item_sys_id`,
`catalog_sys_id`, `test_sys_id`, `suite_sys_id`, `staging_table`, `fields` as
a write payload, `attributes`) are accepted. Each use logs one deprecation
warning. The tool manifest lists the renames (`toolRenames`) and each tool's
accepted aliases.

### Tool packages

Tools are grouped into packages so you can expose only what a given client needs
(fewer tools keep the model focused). Set `SN_TOOL_PACKAGES` to a comma/space
separated list of profiles or package names:

- `core` (default) — `table`, `schema`, `aggregate`, `attachment`.
- `all` — every package below.
- Individual packages: `table`, `schema`, `aggregate`, `attachment`,
  `importset`, `batch`, `catalog`, `change`, `knowledge`, `cmdb`, `scripts`,
  `flows`, `codecheck`, `docs`, `instance`, `email`, `atf`, `revert`,
  `artifacts`, `updatesets`, `ops`, `history`, `properties`, `directory`, `ui`.

The admin tools (`servicenow_set_credentials`, `servicenow_get_status`,
`servicenow_enable_package` and the rest of the admin package) are always
registered, regardless of the active packages. Unknown names are ignored.
`servicenow_get_status` reports the resolved `enabledPackages`.

```dotenv
# Only table + batch tools (plus the always-on admin tools)
SN_TOOL_PACKAGES=table,batch
```

#### Presets

If you would rather not curate the list yourself, three named presets cover the
common roles. The admin tools are always on, so they are not listed. Each preset
also has a one-word alias — `SN_TOOL_PACKAGES=reader|developer|admin` — that
expands to the same package set.

| Preset      | `SN_TOOL_PACKAGES=…`                                   | For whom                                                        |
| ----------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `reader`    | `table,schema,aggregate`                              | First contact, analysts, a PDI play — read and query only.     |
| `developer` | `table,schema,aggregate,scripts,flows,codecheck,docs` | The core segment: script intelligence, flow tracing, linting, docs and diagrams. |
| `admin`     | `all`                                                 | Everything, including the plugin and write-heavy packages.     |

The `developer` preset builds on the `reader` set; the `docs` package includes the
Mermaid diagram generators. Use the alias for brevity or spell the packages out to
add or drop one.

#### Switching packages at runtime

A client can widen or narrow its surface without a restart:
`servicenow_list_packages` shows every package with its state for this
session (enabled, configured, denied, read-only, tool count), and
`servicenow_enable_package` / `servicenow_disable_package` toggle one. The
server announces the change with `notifications/tools/list_changed` (and the
prompts / resources equivalents when those change too), one per list per toggle.
A toggle never exceeds the policy axes: a package in `SN_PACKAGES_DENY` is
refused (`PACKAGE_DENIED`), a package in `SN_PACKAGES_READONLY` brings only its
read tools, and the admin tools cannot be disabled. Toggles last for the
session; an HTTP session that closes returns to `SN_TOOL_PACKAGES`. Nothing
changes unless a client calls these tools.

The server also declares `resources.subscribe`: after `servicenow_use_instance`
or `servicenow_set_credentials` it sends `notifications/resources/list_changed`
and, to subscribers, `notifications/resources/updated` for
`servicenow://status`.

### Upsert by key

`servicenow_upsert_record({table, key, fields})` creates or updates one record
matched by `key`, an exact match on one or more field/value pairs (for example
`{"u_external_id": "A-17"}`; an empty string matches an empty field). No match
creates a record with the key and the fields, exactly one match updates it, and
more than one match is refused with `AMBIGUOUS_KEY` — so is a match the user
cannot read, since creating another would duplicate it.

The action is decided in the plan: without `apply:true` the tool returns
`create` or `update` (with the `sys_id` and the `before` values) plus
`apply_with: {expected_action, expected_sys_id}`. Pass those back with
`apply:true`; if the key now resolves differently (the record appeared, went
away or is another one) the call fails with `STALE_RECORD` and writes nothing.
The applied write is journaled as a create or an update, so
`servicenow_revert_write` undoes it like a direct `create_record` /
`update_record`.

### Undo a write (journal-based revert)

Every applied write is recorded in the local, hash-chained write journal
(`<SN_DOCS_DIR>/<profile>/write-journal.jsonl`). The opt-in `revert` package
turns it into an undo:

- `servicenow_list_writes` — the journal newest first, filtered by `profile`,
  `table`, `since` (ISO date/time), `result` and `action`. Each row carries the
  entry `id` and whether the line alone allows a revert (`revertible` +
  `reason`).
- `servicenow_revert_write` — `entry_id` → the inverse write through the Table
  API: an **update** writes its journaled `before` values back, a **create** is
  deleted, a **delete** is re-created from its `before` record (system fields
  dropped, the original `sys_id` requested; the result reports
  `sys_id_preserved`). It follows plan/apply like every write tool: without
  `apply:true` it returns the inverse, the record's current state and the drift
  check, and changes nothing.

Safety rules:

- **Drift check.** The record's `sys_mod_count` is compared with the value the
  journaled write left (`after_mod_count`, or `before.sys_mod_count + 1`); when
  no count is available, the written field values are compared instead. If the
  record changed since — or nothing could be compared — the revert is refused
  with `STALE_RECORD`; pass `force:true` to overwrite anyway (the revert's
  journal line then records `force: true`).
- **`NOT_REVERTIBLE`, with the reason**, when the entry is unknown, the journal
  chain is broken, the write was not `applied`, the line has no `before` state,
  a `before` value was redacted (`SN_REDACT_FIELDS` / `SN_REDACT_PII`), the
  entry was already reverted, or its origin has no safe inverse: attachment
  upload/delete, `send_email`, import set rows, catalog orders, Batch API
  sub-requests, ATF runs, CMDB creates (IRE may have matched an existing CI) and
  local/config entries. **A redacted value is never restored as `[redacted]`**:
  the whole entry is refused, with no partial revert — restore those fields by
  hand.
- The revert is itself journaled (`reverts: <entry_id>`, `tool:
  servicenow_revert_write`), so reverting the revert is a redo. Policy applies as
  for a direct write: `SN_READONLY`, the table allow/deny lists and the package
  axes of both the original package and `table`. Put `revert` in
  `SN_PACKAGES_READONLY` to keep `list_writes` without the undo.

### Update sets

The opt-in `updatesets` package reads update sets (all three tools are
read-only and go through the table policy and redaction like every reader):

- `servicenow_list_update_sets` — optional `state`, `name` fragment,
  `application` (scope namespace, `global` or sys_id), `query`, `limit` /
  `offset` → sets newest first, with the user's current set marked.
- `servicenow_get_update_set` — `update_set` (sys_id or exact name) → its
  customer updates (`sys_update_xml`) per artefact: type, target name,
  action, table, plus counts `by_type` / `by_action`. Payloads are omitted
  unless `include_payload: true`; they are then parsed into field values,
  each capped at `payload_max_chars` (default 500), with secret-looking
  fields masked.
- `servicenow_compare_update_set` — `update_set` plus `with_profile` (read
  live) or `with_snapshot` (a `servicenow_snapshot_instance` snapshot) → per
  artefact `same` / `different` (differing field names only) / `missing` /
  `not_comparable` / `not_covered` / `unknown`. Only fields in the update
  payload are compared; audit columns are ignored.

Writes: `servicenow_create_record`, `servicenow_update_record`,
`servicenow_upsert_record` and `servicenow_delete_record` take an optional
`update_set` (sys_id or exact name; default `SN_UPDATE_SET`). The plan
preview names the target set; applying switches the user's `sys_update_set`
preference (and the scope's `updateSetForScope<scope>` preference for a
scoped set), runs the write, and restores the previous value — the result
reports `update_set: { bound, previous, restored }` and the journal entry
records `update_set`. A set that is not `in progress` is refused
(`UPDATE_SET_NOT_IN_PROGRESS`); a data-row table (anything not extending
`sys_metadata` and without the `update_synch` attribute) is written without
switching, and the plan says so. Without the argument or the setting nothing
changes. Other write tools (batch, catalog, change…) are not bound.

### Operations and data health

The opt-in `ops` package holds two read-only tools for "the instance is slow"
triage and data quality. Every section reads its own table; an unreadable
table (ACL, table policy, missing table) reports `available: false` with the
reason instead of failing the call, so a blank section never reads as healthy.

- `servicenow_read_ops` — `kind`:
  - `overview` — the counts of every section below in one call.
  - `syslog` — entries of the last `minutes` (default 60, max 1440) at or
    above `level` (default `warning`), optional `source` fragment: counts by
    level, top sources and the newest rows (messages capped at 500 chars).
  - `jobs` — the scheduler queue (`sys_trigger`) by state, the number of
    ready jobs more than `overdue_minutes` past their next action, and the
    `overdue` (default), `running` or `queued` jobs with their claiming node.
  - `email_queue` — outbound `sys_email`: the send-ready backlog and its
    oldest entry, counts by type in the window and the recent send failures.
  - `semaphores` — `sys_semaphore` rows, newest first.

  Rows are capped by `limit` (default 25, max 200).

- `servicenow_check_data_health` — the data twin of `servicenow_check_code_health` for one
  `table`, optionally scoped by `query` (no `^NQ` / `ORDERBY`): duplicate
  groups over `key_fields` (Aggregate API grouping, count > 1, capped by
  `limit`), and per reference field (`reference_fields`, default the first 10
  non-system ones) the orphaned references (target row missing) and — when
  the target has an `active` column and `stale` is not `false` — the stale
  references (target inactive), each with the encoded query that lists the
  rows. Field names are checked against the dictionary first. A target row
  the user cannot read also counts as orphaned.

The `servicenow_why_is_it_slow` prompt walks through these reads and, with a
`table`, the logic that runs on its writes.
### Record history, properties and directory

Three opt-in packages cover day-to-day operations questions. Every read goes
through the table policy and redaction like every other reader.

- `servicenow_get_record_history` (`history`) — `table` + `sys_id` → field
  changes from `sys_audit` and journal entries (comments, work notes) from
  `sys_journal_field`, merged newest first. `source` (`all` / `audit` /
  `journal`), `fields`, `since` (`YYYY-MM-DD[ HH:MM:SS]`), `limit` (default
  100) and `value_max_chars` (default 2000) narrow it. Audit rows that repeat
  a journal entry are skipped. If a source cannot be read (ACL or policy), it
  is reported under `sources` and the other one is still returned.
- `servicenow_get_properties` (`properties`) — an exact `name` or a name
  `prefix` → `sys_properties` rows. Password-type or secret-looking properties
  come back as `[redacted]`, and long values are truncated.
- `servicenow_set_property` (`properties`) — sets the value of one existing
  property. It runs as plan/apply: the plan shows the current and the new
  value, and apply is journaled. `servicenow_revert_write` can undo it,
  except for secret properties, which are never journaled in clear. It honours
  `SN_READONLY` and `SN_PACKAGES_READONLY=properties`. A missing property is
  `PROPERTY_NOT_FOUND`; the tool never creates one.
- `servicenow_lookup_directory` (`directory`) — `kind` (`user` / `group` /
  `role`) plus a search `term` or a `sys_id`. With `include_details` and
  exactly one match, the result adds:
  - for a user, its roles and groups;
  - for a group, its members and roles;
  - for a role, its contained roles and the groups that grant it.

  A detail table that cannot be read is listed in `details_unavailable`. Put
  `directory` in `SN_PACKAGES_DENY` to remove the user-data surface.

### Instance discovery

`servicenow_document_instance` (`docs`) takes an optional `depth` that adds a
discovery folder, `<SN_DOCS_DIR>/<profile>/discovery/`, next to `README.md`.
The tiers are cumulative:

| `depth` | Files |
| --- | --- |
| `overview` | `overview.md` — version, counts, automation, the files written |
| `apps` | + `apps.md` and one `tables-<scope>.md` per scope (tables and their dictionary) |
| `artefacts` | + one `artifacts-<scope>.md` per scope |

The scopes are the named `apps`, else every non-global `sys_app` scope, up to
the per-run target cap (the rest are listed as skipped). `artifacts-<scope>.md`
lists every artefact type with a **Collected / not collected and why** column:
collected (with a count), capped, unverified (the table is not readable here),
no such table, unreadable for this user, package off, or no records in this
scope. Every read goes through the same policy, redaction, capability preflight
and write journal as the other generators. Without `depth` the tool behaves as
before.

### Plugin skills

The Claude Code plugin (`/plugin install servicenow-mcp-ai`) ships five skills
under `skills/`. Each one only orchestrates this server's tools; none holds
credentials or calls ServiceNow on its own.

| Skill | Use it to |
| --- | --- |
| `sn-discover` | Map an instance or its custom apps with `servicenow_document_instance({depth})` |
| `sn-triage` | Investigate a failing record, flow or script (status, history, logic, logs) |
| `sn-impact` | Assess what a change to a table, field or script would touch (where-used, table logic) |
| `sn-drift` | Compare two instances or a saved snapshot, or review an update set |
| `sn-safe-write` | Make a record change with plan-and-apply, the write journal and a revert path |

A test (`test/plugin-skills.test.js`) checks that every `servicenow_*` name in a
skill exists in the tool manifest. The skills are not part of the npm package.

#### Subagents

Two read-only subagents ship under `agents/`. Their `tools` allowlist names
only this server's read-only tools (`readOnlyHint`), so neither can plan,
apply, revert or switch the instance; `test/plugin-agents.test.js` enforces it.

| Agent | Use it to |
| --- | --- |
| `sn-investigator` | Answer a question about the instance (a record, a table's automation, where something is used, a failed flow) and return a short report with its evidence instead of raw records |
| `sn-change-reviewer` | Review a plan preview or an update set before it is applied — target records, table logic, where-used, lint, policy, history — and return a go / hold verdict |

The change reviewer has no `servicenow_check_code_health` (it writes a local
report); it recommends the scan when a change touches ACLs.

#### Hooks

`hooks/hooks.json` registers three plain Node scripts (no dependencies):

| Event | Script | What it does |
| --- | --- | --- |
| `SessionStart` | `session-context.mjs` | Adds the active profile, its instance host, the write mode (plan / apply, read-only, a held prod profile), the tool packages and the other profile names to the session. It reads only the environment and the local env file (`SN_ENV_FILE` or `~/.config/servicenow-mcp-ai/.env`) — no network call, no credential in the output — and prints nothing when either is missing or unreadable. The server the client launches may see a different environment, so `servicenow_get_status` stays authoritative. |
| `PreToolUse` | `require-plan-token.mjs` | Refuses a destructive `apply:true` without a `plan_token` (D-8). |
| `PostToolUse` | `truncation-hint.mjs` | When a ServiceNow result says `truncated: true`, adds one line naming the knobs that tool has (`fields`, `offset`, `limit`, `format: "file"`). Silent otherwise. |

#### Using the skills with other agents

The five skills are portable [Agent Skills](https://agentskills.io): their
`SKILL.md` frontmatter uses only `name` and `description`, and they name tools
by their bare MCP name (`servicenow_query_table`), so any client that has this
server configured can run them. Copy or symlink the folders under `skills/`
into a directory the client scans:

| Client | Project | Personal |
| --- | --- | --- |
| VS Code (GitHub Copilot) | `.github/skills/`, `.agents/skills/` or `.claude/skills/` | `~/.copilot/skills/`, `~/.agents/skills/` or `~/.claude/skills/` |
| OpenAI Codex | `.agents/skills/` (in the working directory or any parent up to the repository root) | `~/.agents/skills/` |
| Cursor | `.agents/skills/` or `.cursor/skills/` | `~/.agents/skills/` or `~/.cursor/skills/` |

`.agents/skills/` works in all three. For example, from a clone of this
repository:

```bash
mkdir -p ~/.agents/skills
cp -R skills/sn-* ~/.agents/skills/   # or: ln -s "$PWD"/skills/sn-* ~/.agents/skills/
```

The subagents and hooks are Claude Code plugin features and do not carry over.

### Service Portal tree

`servicenow_explain_portal` (`ui`, opt-in) explains a Service Portal (`portal`:
`url_suffix` or sys_id) or one page (`page`: page `id` or sys_id) as a tree.
The tree runs page → container → row → column → widget instance → widget. Instance
`widget_parameters` are mapped onto the widget's `option_schema`, and each widget
lists its dependencies, JS / CSS includes, Angular providers and templates. The
theme, menu, header / footer and route maps are included. Nested rows are
followed to `depth` (default 3, max 6), and the layout is read for the first 5
pages. `format` is `json`, `markdown`, `mermaid` (layout tree) or `file`. A
Service Portal table that cannot be read becomes a caveat, not a failure.

### UI Builder experience map

`servicenow_explain_ui_experience` (`ui`, opt-in) explains a UI Builder
experience or workspace (`sys_id` or `path` of `sys_ux_page_registry`) as a
page map. It reads the page properties, app config, routes, screens (with their
applicability) and each screen's macroponent. The macroponent's composition,
data resources, client state and event wiring are decoded with the
`uib-composition` decoder, and the tool lists its client scripts and its
transform / scriptlet data brokers, each with its `ux_data_broker` ACLs. It
also covers the workspace landing page, dashboards, list menus (categories,
lists, applicability) and form action layouts. Reads are bounded, the call
reports progress and can be cancelled. `format` is `json`, `markdown`,
`mermaid` (page map) or `file`. Every UI Builder table and field name, and
every macroponent JSON shape, is unverified (U) until it is checked on a live
instance, so results carry `verified: false`. A table that cannot be read
becomes a caveat, not a failure.

The `cmdb` package also has `servicenow_list_ci_relations` (a CI's
`cmdb_rel_ci` relationships in either direction, with the related CI's name and
class) and `servicenow_identify_reconcile`, which sends an IRE payload of items
and relations. In plan mode, `servicenow_identify_reconcile` calls the
identify-only endpoint and shows what IRE would match; when the endpoint is
missing, the plan is marked `degraded`. Apply is journaled but not revertible,
because IRE decides per item.

`servicenow_run_atf_test` and `servicenow_run_atf_suite` take `wait_seconds`
(0–300). The tool polls the CI/CD progress endpoint with progress
notifications, and cancelling the request stops the wait. A run that is still
going when the time is up returns `wait.state: "running"` with a `tracker`
for `servicenow_get_atf_result`.

`servicenow_insert_import_set_row` also returns `import_set_run` (the
`sys_import_set_run` row of the import set) and `transform_maps` (the staging
table's maps, the ones this row used marked `used: true`). If either follow-up
read fails, you get `warnings` instead of an error.

### Generic artifact reads

The opt-in `artifacts` package reads any type in the artifact registry (the
`servicenow://artifact-types` resource lists them, with their tables, key
fields and child tables):

- `servicenow_list_artifacts` — `artifactType` plus optional `scope`
  (namespace or sys_id), `active`, `query` and `limit` → summaries: sys_id,
  name, natural key, scope, active flag, SDK-managed verdict and the type's
  metadata. No script bodies.
- `servicenow_get_artifact` — `artifactType` plus `sys_id` or the natural
  `key` → the full record, its child records in registry order (a UI policy's
  actions; a portal page's containers, rows, columns and widget instances; a
  flow's action instances), its scope and whether that scope is SDK-managed.
- `servicenow_explain_artifact` — same identification → a structured
  explanation: a one-line `summary`, `when` it runs (the trigger fields that
  are set), its non-empty `fields`, its child records as compact `items`, the
  records it `references`, and its encoded JSON fields `decoded` (widget
  parameters, UI Builder props and data, flow label caches). A value that
  cannot be decoded comes back raw with `decoded: false` and a `reason` — one
  bad field never fails the call. Long values are capped against
  `SN_MAX_RESULT_CHARS` (a value gets at most a twentieth of it, the whole
  explanation four fifths); `truncatedFields`, `truncated` / `preview` and
  a child's `omitted` count say what was cut. Flow action values and UI
  Builder compositions are read with the plain JSON decoder until their
  dedicated decoders ship (`via: "json"`).
  Some types also get an `explanation` with `lines` of prose: a state model
  lists its states and `from -> to` transitions with their conditions, a
  choice set or table its choices per element in sequence order, and a UI
  policy or data policy the effect on each field when its condition holds
  (and, with reverse-if-false, when it does not).
- `servicenow_get_artifact_dependencies` — same identification plus `direction`
  (`outbound` / `inbound` / `both`, default), `depth` (1–3, default 1),
  `limit` (rows per inbound source, 1–100) and `format` (`json` or
  `mermaid`) → a dependency graph of `nodes` and `edges` (`from` depends on
  `to`, with `via` and `field`). Outbound edges come from registry reference
  fields on the record and its children, decoded JSON (flow step values,
  widget options, UI Builder data) and script text (script-include calls,
  `GlideAjax` classes, literal `GlideRecord` tables). Inbound edges come from
  reverse reference queries and — for a script include — script callers,
  flow steps whose values call it and the structural pass of the where-used
  graph. The walk visits each node once (cycles are safe), stops at 150
  nodes (`truncated`), and turns an unreadable source into an `unavailable`
  entry instead of an error.

Every table read obeys `SN_TABLES_ALLOW` / `SN_TABLES_DENY`; a denied child
table comes back as `redacted: true` instead of failing the read, and
`SN_REDACT_FIELDS` / `SN_REDACT_PII` apply as everywhere. Types whose tables
are not yet confirmed on a live instance carry `verified: false` and a
`caveat`; when the instance rejects such a table the result is empty with a
`degraded` reason instead of an error, plus `available: false` when
`sys_db_object` shows that the table does not exist on the instance.

### Artifact writes

`servicenow_upsert_artifact({artifactType, key, fields, children?})` plans a
primary record and its child records as one unit (S-8 `create` / `update` /
`noop` per record), then applies them parent first, each journaled with one
shared `artifact_write` id so `servicenow_revert_write` undoes every line. The
H-11 table policy, the P-22 SDK guard and the H-3 plan token cover every
record of the plan.

- **Nested children.** A child that hangs off another child names it by
  position with `parent` (an earlier index in `children`): a portal page's
  `sp_container` → `sp_row` → `sp_column` → `sp_instance` tree, a catalog
  variable's `question_choice` rows, a catalog UI policy's actions. A child
  key may be `{sys_id}`, so a `servicenow_get_artifact` result round-trips
  unchanged. A wrong or missing `parent` is `CHILD_PARENT_INVALID`.
- **SDK pre-flight.** Portal widgets, pages, templates, dependencies, providers,
  headers / footers and portals, and catalog items, record producers,
  variables, variable sets and categories are checked at plan time the way
  the ServiceNow SDK checks them: `sp_widget.id` (across every table
  extending it), `sp_page.id`, `sp_portal.url_suffix`, `sp_dependency` name /
  module and `sp_ng_template.id` must be unique on the instance and within
  the plan (`DUPLICATE_UNIQUE_FIELD`, 409); a catalog variable name must be a
  valid identifier (`PREFLIGHT_INVALID`); a create into a scoped application
  whose id lacks the `<scope>_` prefix gets a `SCOPE_PREFIX` warning.
- **Flows.** A `flow` accepts only `{active}` on an existing flow — any
  other field, a child or a create is `FLOW_ACTIVE_ONLY`. This is
  **unverified until O-5**: that toggling `active` through the Table API
  leaves `master_snapshot` unchanged has not been confirmed on a live
  instance, and every flow plan carries an `UNVERIFIED` warning.

The portal and catalog write fields are unverified until O-5 (`verified:
false` in the registry).

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
  "values": {
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

| URI                                     | Description                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `servicenow://status`                   | Connection status, auth mode, access policy (never includes the password).                          |
| `servicenow://capabilities`             | Capability preflight: which admin-restricted `sys_*` reads (schema, script intelligence, ACL audit) the connected user can actually achieve, plus the per-group capability matrix. |
| `servicenow://tables`                   | List of tables from `sys_db_object`.                                                                |
| `servicenow://schema/{table}`           | Columns of a table from `sys_dictionary` (bound to the active profile).                             |
| `servicenow://instances`                | Configured connection profiles: name, host, user, read-only flag, credential completeness.          |
| `servicenow://profiles/{profile}/schema/{table}` | Columns of a table read through a specific named connection profile. The v2 URI `servicenow://{profile}/schema/{table}` still works until the next minor release (deprecated). |
| `servicenow://docs/{+path}`             | A Markdown document from the local docs store (nested paths allowed), wrapped in an untrusted-content block. |
| `servicenow://artifact-types`           | Artifact types the generic artifact tools accept: table, name / key / scope fields, child tables, SDK API, verified flag (`artifacts` package). |
| `servicenow://reference/encoded-query`  | Encoded-query reference: syntax, `javascript:` values, limits (no `^` escaping, URL length, silently ignored fields, ACL-hidden rows) and how `fetchAll` pages. |
| `servicenow://reference/tools`          | The tool manifest as Markdown: every tool by package, read / write, and whether this session registered it under the package policy. |
| `servicenow://reference/tools/{name}`   | One tool in full: description, annotations, the published input and output schema, package and registration state. |

Resources are package-gated like tools: `status`, `capabilities` and the tool
reference are always on; `encoded-query` comes with the `table` package, `tables`/`schema` with the `schema` package, `instances`/per-profile
schema with `instance`, and `docs` with the `docs` package.

The three templates support completion and listing: `{table}` completes from
the tables already in the schema cache plus a short seed list of common
tables, `{profile}` from the configured profiles, and `{path}` from the docs
manifest (`index.json`) by prefix and under the active profile's folder.
`resources/list` shows the cached tables and the documents (generated ones
first, titled from the manifest; at most 100 per template, with the docs
`index.md` always last). Lists and completions never call the instance.

## Prompts

Ready-made workflows are exposed as MCP prompts; they orchestrate the tools and
insist on reading real values from the instance. `table` and `profile`
arguments complete like the resource templates. Arguments (at most 200
characters) reach the model inside an untrusted-content block, and every prompt
tells the model to treat instance data as data, not instructions. A prompt is
listed only when the packages its tools live in are enabled (triage: `table`;
change impact: `change` or `table`; document table: `docs` and `scripts`;
why is it slow: `ops`; the instance overview uses admin tools only and is
always listed). The list follows `servicenow_enable_package` /
`servicenow_disable_package` live, with `notifications/prompts/list_changed`:

| Prompt                              | Argument   | Purpose                                                          |
| ----------------------------------- | ---------- | ---------------------------------------------------------------- |
| `servicenow_incident_triage`        | `incident` | Summarize, assess priority, categorize and recommend next steps. |
| `servicenow_change_impact_analysis` | `change`   | Affected CIs, schedule conflicts and a go/no-go call.            |
| `servicenow_document_table`         | `table`, `profile` | Runs `servicenow_document_table`, then fills the manual Purpose block of `<profile>/tables/<table>.md`; attaches the encoded-query reference. |
| `servicenow_why_is_it_slow`         | `symptom`, `table` (both optional) | System log, scheduler backlog, email queue and semaphores (`ops`), then the logic on a table → ranked causes. |
| `servicenow_instance_overview`      | `goal` (optional) | Capability matrix (`servicenow_check_capabilities`), status and the session's packages; treats the profile as production until H-11 adds an environment marker. |

## Project structure

```
.
├── .env                   # credentials (git-ignored; or ~/.config/servicenow-mcp-ai/.env)
├── .env.example           # template
├── .github/workflows/     # CI matrix, CodeQL, npm / MCP Registry / Marketplace publishing
├── .vscode/mcp.json       # VS Code MCP server registration
├── bin/                   # CLI launcher (servicenow-mcp-ai.cjs, incl. the doctor command)
├── extension/             # VS Code extension (thin wrapper that registers the server)
├── docs/                  # GitHub Pages site
├── scripts/               # generators + guards (README tools table, tool manifest, coverage guard)
├── src/
│   ├── index.ts           # bootstrap: load env, register, connect transport
│   ├── core/              # HTTP client (auth, retry, SSRF guard), OAuth/JWT/mTLS, policy,
│   │                      # settings, logging, config store, write journal, request
│   │                      # context (profiles); jira/ is a dark scaffold — no tools (ARCH-14)
│   ├── api/               # one module per REST area: table, aggregate, attachment,
│   │                      # importset, batch, catalog, change, knowledge, cmdb, scripts,
│   │                      # flows, codecheck, atf, email, docs, diagrams, meta, doctor,
│   │                      # history, properties, directory, portal…
│   ├── mcp/               # MCP surface: package registry/manifest, tool definition,
│   │                      # resources, prompts, result envelopes, redaction, write mode
│   │                      # (plan/apply), CSV export, stdio + HTTP transports
│   └── tools/             # tool registrations, one file per package (26 packages)
├── test/                  # node:test suite (406 tests): unit, mock-fetch api, MCP smoke, doc guards
└── build/                 # compiled output (after npm run build)
```

> **Note on names:** the npm package and the GitHub repository are both
> [`servicenow-mcp-ai`](https://github.com/IvanBBaev/servicenow-mcp-ai) (the
> unscoped `servicenow-mcp` was already taken on npm); the local working folder
> is `servicenow-mcp`. The difference is cosmetic and does not affect the build
> or runtime.

## Security notes

- The env file is git-ignored — do not commit real credentials.
- The env file is written **owner-only (`0600`)** — it holds a plaintext password.
- The server uses the stdio transport and only logs to `stderr`; secrets and raw
  encoded queries are never logged.
- The password/token is never returned by any tool.
- **Secret columns are always masked.** A column whose dictionary type is
  `password`, `password2` or `glide_encrypted` comes back as `[redacted]` from
  every record-returning tool (`query_table`, `get_record`, batch, compare,
  exports, …) and is never stored in the write journal, whatever
  `SN_REDACT_FIELDS` says. The types are read once per profile from
  `sys_dictionary` and cached like other schema (`SN_SCHEMA_CACHE_TTL_SEC`);
  when the dictionary is not readable, a list of OOTB secret column names
  (`password`, `user_password`, `client_secret`, …) applies instead, and the
  read goes on. This masking cannot be turned off.
- Hosts are restricted: without `SN_ALLOWED_HOSTS`, only `*.service-now.com`
  instances are contacted (internal/loopback blocked unless an allow-list entry
  names the host exactly), so a mistyped host cannot silently receive
  credentials. Redirects are never followed (`REDIRECT_BLOCKED`) and response
  bodies are capped by `SN_MAX_BODY_BYTES`. Set `SN_ALLOWED_HOSTS` to
  opt in a custom or sovereign-cloud domain. An explicit non-443 port or an
  IPv6 literal in the instance value is accepted only when an allow-list entry
  names it (`host:8443`, `[2001:db8::1]`).
- Every request — including OAuth token requests — carries the identifying
  `User-Agent: servicenow-mcp-ai/<version> (node/<major>; <transport>; <client>)`
  so the instance's transaction log can attribute the traffic; extend it with
  `SN_USER_AGENT_SUFFIX`. Proxy URLs (`SN_HTTPS_PROXY`, `HTTPS_PROXY`) are
  honoured for every request but their credentials are never logged.
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
| [ARCHITECTURE.md](project/ARCHITECTURE.md) | Layered architecture, Mermaid diagrams (modules, request lifecycle, security model, auth, packages), condensed ADRs |
| [PRODUCT-STATE.md](project/archive/PRODUCT-STATE.md) | Current product state: API coverage map, quality status, history timeline, roadmap |
| [ROADMAP.md](project/ROADMAP.md) | Forward plan: the shipped phases, the 2.x hardening line, the proposed 3.0 milestone, optional and deferred items |
| [ROADMAP-V3.md](project/ROADMAP-V3.md) / [DEEP-REVIEW-2026-09.md](project/archive/DEEP-REVIEW-2026-09.md) | The proposed v3.0 execution tracker (correctness, governance, reach at scale) / the five-lens review its items are built on |
| [GAP-ANALYSIS-2026-09.md](project/archive/GAP-ANALYSIS-2026-09.md) | The 2026-09-09 second pass over the v3.0 plan: nine narrower lenses, 67 findings each with design, acceptance criteria and tests, mapped to tracker items |
| [INSTANCE-DOCS-ANALYSIS-2026-09.md](project/archive/INSTANCE-DOCS-ANALYSIS-2026-09.md) | The 2026-09-23 pass on instance documentation: the docs store, the Mermaid generators, the `document_table` prompt and the missing document kinds — 17 findings with design, acceptance criteria and tests, mapped to S-14 … S-16 |
| [INSTANCE-DOCS-ANALYSIS-2026-09-25.md](project/archive/INSTANCE-DOCS-ANALYSIS-2026-09-25.md) | The 2026-09-25 second pass on instance documentation: dispositions of the first 17 findings after the docs store, artefact registry, artefact readers and security scan landed, plus 12 new findings (ID-18 … ID-29) with design, acceptance criteria and tests, mapped to S-15, S-16, M-4, M-8, S-7, E-6, E-7 |
| [COMPETITIVE-ANALYSIS.md](project/COMPETITIVE-ANALYSIS.md) | Positioning vs the official ServiceNow MCP Server Console: comparison, where it structurally lags, the Phase 9 boost plan, and platform risks |
| [IMPLEMENTATION-PLAN.md](project/archive/IMPLEMENTATION-PLAN.md) | Detailed specs for the upcoming phases (harness 2.0, multi-instance, flow testing) |
| [DONE.md](project/DONE.md) / [TODO.md](project/TODO.md) | Completed work with commit refs / remaining decisions |
| [WORKLOG.md](WORKLOG.md) / [CHANGELOG.md](CHANGELOG.md) | Detailed work journal / user-facing changelog |
| [CONTRIBUTING.md](CONTRIBUTING.md) / [SECURITY.md](SECURITY.md) | Dev setup, gates and conventions / security model and reporting |

## Support

This project is built and maintained in my own time. If it saves you or your team
time, please consider supporting its continued development — sponsorship directly
funds new tools, bug fixes and keeping pace with ServiceNow's REST surface.

- **[GitHub Sponsors](https://github.com/sponsors/IvanBBaev)** — one-off or
  recurring, with no platform fee taken out (the preferred option).
- **[Ko-fi](https://ko-fi.com/ivanbbaev)** — quick one-off support; it also
  accepts **PayPal**, so it's the fallback for anyone without a GitHub account.
- **[Donate (Donatree)](https://donatr.ee/ivanbbaev/)** — a no-account donation
  page (card, PayPal and more) for a one-off tip.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/IvanBBaev)
[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/ivanbbaev)
[![Donate via Donatree](https://img.shields.io/badge/Donate-Donatree-22c55e?style=flat-square&logo=liberapay&logoColor=white)](https://donatr.ee/ivanbbaev/)

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
