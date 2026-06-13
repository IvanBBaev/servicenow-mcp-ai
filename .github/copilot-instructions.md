# Copilot instructions — servicenow-mcp-ai server

This is a **Model Context Protocol (MCP) server** written in **TypeScript** that
executes commands against a **ServiceNow** instance through the **Table API**.

## Architecture

- `src/index.ts` — MCP server entry point. Registers the tools and connects over
  the stdio transport.
- `src/servicenow.ts` — Thin ServiceNow Table API client (`fetch` + Basic auth).
  All HTTP logic and error handling lives here.
- `src/config.ts` — Reads credentials from `.env` and writes them back when the
  `servicenow_set_credentials` tool is used. Preserves comments and unrelated keys.

## Credentials

- Stored in `.env` at the project root (git-ignored). Keys: `SN_INSTANCE`,
  `SN_USER`, `SN_PASSWORD`.
- Loaded into `process.env` at startup via `loadEnv()`.
- Never log or echo `SN_PASSWORD`.

## Conventions

- This is a **stdio** server: **never** write to `stdout` (no `console.log`).
  Use `console.error` for diagnostics.
- Use ES modules with `.js` import specifiers (Node16 module resolution).
- Tool input schemas are defined with `zod` raw shapes passed to `server.registerTool`.
- Tool handlers must not throw: catch errors and return `{ isError: true }` results.

## Build & run

- `npm install` then `npm run build` (outputs to `build/`).
- Debug locally: `npm run inspector` (MCP Inspector) or run via the VS Code
  config in `.vscode/mcp.json`.

## SDK references

- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Concepts & guides: https://modelcontextprotocol.io/docs
- ServiceNow Table API: https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI
