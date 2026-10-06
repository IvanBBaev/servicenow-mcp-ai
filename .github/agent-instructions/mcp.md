---
applyTo:
  - "src/mcp/**"
  - "src/*.ts"
---

# src/mcp and the entry points — server wiring

- **Registry:** `PACKAGES` in `registry.ts` is the manifest (the one place that
  imports `tools/` specs); `effectivePackages()` feeds registration, the status
  payload and the generators.
- **Tool specs** (`define.ts`): `defineTool`, the shared zod helpers
  (`sysId()`, `tableName()`, `encodedQuery()`, `shortText()`, `longText()`…)
  and `runSpec()`, which wraps every handler with profile routing, call
  context, logging and error mapping — a handler may throw, `runSpec` returns
  `fail(error)`. The automatic `instance` argument and, for a `confirm` spec,
  `plan_token` are added here.
- **Results** (`result.ts`): `ok`, `okStructured`, `okQueryResult`, `fail` (the
  flat error contract). This is the one redaction boundary (`redact.ts`, rules
  in `core/redaction.ts`).
- **Untrusted text** reaches the model through `untrusted()` in `boundary.ts`.
- **Names:** `TOOLS` in `naming.ts` (`servicenow_<verb>_<noun>`); a rename adds
  a `TOOL_RENAMES` row and is breaking (owner register O-4).
- **Writes:** plan → apply via `write-mode.ts` (`applyInput`, `shouldApply`,
  `planPreview`); destructive applies are bound to a plan token
  (`plan-token.ts`, `confirm.ts`).
- **Resources** throw `McpError`, not `ServiceNowError`.
- **stdio:** never write to stdout outside the transport. `src/index.ts` is the
  entry point (stdio, or Streamable HTTP with `SN_TRANSPORT=http`,
  `http-sessions.ts`); `src/server.ts` builds the server; `src/cli.ts` holds
  the CLI subcommands, which may print to stdout.
- **Budgets:** any change to what `tools/list` returns (names, descriptions,
  schemas) is gated by N-0 / O-10: the per-profile limits are in
  `test/fixtures/token-budgets.json`, enforced by `test/output-schema.test.js`;
  measure with `npm run build && npm run tokens:budget` and state the byte
  delta. The `initialize` instructions (`server-info.ts`) are not part of
  `tools/list`: they have their own cap, `INSTRUCTIONS_MAX_BYTES`
  (`test/server-info.test.js`) — state that delta too.
