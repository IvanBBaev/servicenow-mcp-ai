# ServiceNow MCP — VS Code extension

Drive a **ServiceNow** instance from VS Code **Copilot Chat (agent mode)**. This
extension registers the [`servicenow-mcp-ai`](https://www.npmjs.com/package/servicenow-mcp-ai)
MCP server automatically — install it and the ServiceNow tools appear in Chat,
with no manual `.vscode/mcp.json`.

## What you get

97 tools over the full ServiceNow REST surface (Table, Aggregate, Attachment,
Import Set, Batch, CMDB/IRE, Catalog, Change, Knowledge, Email), plus:

- **Plan-and-apply write safety** — writes preview a before/after diff by default
  (`SN_WRITE_MODE=plan`); execute only with `apply: true`. Every applied change is
  journalled locally.
- **Capability preflight** — reports which `sys_*` tables your user can actually
  read, so the script/code tools never return a silently empty result.
- **ACL security scan**, **where-used / impact graph**, **field redaction**,
  **CSV export**, and a **CI drift gate**.

## Setup

1. Install this extension. The **ServiceNow** MCP server is registered for Copilot
   Chat (it runs via `npx -y servicenow-mcp-ai@2.x` — pinned to the server major
   this extension was built for — so Node.js 22.12+ is required).
2. Open the **Get started with ServiceNow MCP** walkthrough (Command Palette →
   _Welcome: Open Walkthrough..._). It takes you through four steps: sign in,
   pick the tool packages, run the doctor, and try a first prompt.
3. Or do it by hand: run **ServiceNow MCP: Sign In**, then open Copilot Chat,
   switch to **agent mode**, and ask — e.g. _"Using ServiceNow, list the 5 most
   recent active incidents with their priority."_

Start read-only and safe: set `SN_READONLY=true` in your env file and keep the
default `core` package set until you trust the workflow.

## Credentials

- **Sign In** (recommended) — **ServiceNow MCP: Sign In** asks for the instance,
  the method (Basic, API key, OAuth client credentials or Bearer token) and the
  secret. They are kept in VS Code **SecretStorage** (the OS keychain), never in
  settings or on disk, and are handed to the server process through its
  environment only. A sign-in takes precedence over the env file's values.
  **ServiceNow MCP: Sign Out** clears it.
- **Env file** — `~/.config/servicenow-mcp-ai/.env` by default, or the file named
  in `servicenowMcp.envFile`:
  ```dotenv
  SN_INSTANCE=your-instance.service-now.com
  SN_USER=your.username
  SN_PASSWORD=your-password
  ```
- **Browser (PKCE) OAuth** — run `npx servicenow-mcp-ai login` once in a terminal;
  it stores the tokens in the env file.
- At runtime, ask Chat to run `servicenow_set_credentials`.

## Settings

| Setting                   | Default | Meaning                                                                                                                                                                                                  |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `servicenowMcp.envFile`   | _empty_ | Env file the server reads and writes (`SN_ENV_FILE`). Supports `~`, `${userHome}` and `${workspaceFolder}`; a relative path resolves against the first workspace folder. Empty = the server default.      |
| `servicenowMcp.packages`  | `[]`    | Tool packages or profiles (`SN_TOOL_PACKAGES`), e.g. `["core", "flows"]`. Empty = `core`. **ServiceNow MCP: Choose Tool Packages** picks them from a list.                                                |
| `servicenowMcp.transport` | `stdio` | `stdio` (recommended) or `http`: the extension starts the server's Streamable HTTP transport on a free `127.0.0.1` port with a random per-launch bearer token and VS Code connects to it.                  |

Changing a setting, signing in or signing out re-registers the server definition,
and VS Code offers to restart the server. In an untrusted workspace, the
workspace values of these settings are ignored.

## Doctor and status bar

**ServiceNow MCP: Run Doctor** runs `servicenow-mcp-ai doctor --json` through the
same launcher, settings and credentials as the server. The verdict (healthy,
degraded, not configured, or failed) shows in a notification and in the
**ServiceNow MCP** status-bar item; click the item to run it again. The full
report goes to the **ServiceNow MCP** output channel (**ServiceNow MCP: Show
Output**).

## Commands

| Command                                       | What it does                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ServiceNow MCP: Sign In                       | Store the instance and a secret in SecretStorage.                                                                                                      |
| ServiceNow MCP: Sign Out                      | Remove the stored secret.                                                                                                                              |
| ServiceNow MCP: Choose Tool Packages          | Pick packages and profiles for `servicenowMcp.packages`.                                                                                               |
| ServiceNow MCP: Run Doctor                    | Check configuration, connectivity and capabilities.                                                                                                    |
| ServiceNow MCP: Try a First Prompt            | Open Copilot Chat in agent mode with a read-only question.                                                                                             |
| ServiceNow MCP: Add Agent Skills to Workspace | Copy the `sn-*` workflow skills into `.agents/skills/`, `.github/skills/` or `.claude/skills/`; existing ones are kept unless you choose Replace. |
| ServiceNow MCP: Show Output                   | Show the extension's output channel.                                                                                                                   |

## After install

MCP tools are only surfaced in **agent mode**, so open Copilot Chat and switch
its mode selector to **Agent** — the `servicenow_*` tools become available there.
To confirm everything is wired up, ask the model to run a connection check,
e.g. _"Run servicenow_test_connection and show me the result."_

<!-- TODO(owner): capture a screenshot of the Copilot Chat agent-mode selector,
     add it to the extension package, and uncomment the line below:
![Copilot Chat mode selector switched to Agent](docs/agent-mode.png) -->


## Links

- Documentation: https://ivanbbaev.github.io/servicenow-mcp-ai/
- Source / issues: https://github.com/IvanBBaev/servicenow-mcp-ai
- npm package: https://www.npmjs.com/package/servicenow-mcp-ai

MIT licensed. Independent project — not affiliated with or endorsed by ServiceNow, Inc.
