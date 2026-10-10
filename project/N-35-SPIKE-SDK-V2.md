# N-35 step 1 — spike: MCP SDK v2 packages

Date: 2026-10-10. Branch: `spike/n35-sdk-v2` (from `b8d146a`). Decision context:
O-19 / [ADR 0008](adr/0008-full-protocol-2026-07-28-conformance.md).

## Result

The server runs on `@modelcontextprotocol/server` 2.3.1 and
`@modelcontextprotocol/node` 2.1.1 with **legacy-wire parity**: the full gate is
green (2,303 tests, 0 failing), `tools/list` is byte-identical to `main`
(core 27,084 B, all 121,154 B, delta 0 B), the package is 2,678.4 KB unpacked
(limit 3,072 KB) and `npm audit` reports 0 vulnerabilities.

This step does **not** serve the 2026-07-28 revision yet; see "Era binding"
below. The v1 SDK (`@modelcontextprotocol/sdk`) moves to `devDependencies`:
the tests and `scripts/scan-surface.mjs` drive the v2 server with the v1
`Client` and `InMemoryTransport`, which pins the legacy (2025-11-25) wire.

## Import mapping

| v1                                                                   | v2                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `sdk/server/mcp.js` `McpServer`, `RegisteredTool`, `completable`     | `@modelcontextprotocol/server`                                   |
| `sdk/server/index.js` `Server`                                       | `@modelcontextprotocol/server`                                   |
| `sdk/types.js` types, `isInitializeRequest`, `RELATED_TASK_META_KEY` | `@modelcontextprotocol/server`                                   |
| `McpError`, `ErrorCode`                                              | `ProtocolError`, `ProtocolErrorCode`                             |
| `sdk/server/stdio.js` `StdioServerTransport`                         | `@modelcontextprotocol/server/stdio`                             |
| `sdk/server/streamableHttp.js` `StreamableHTTPServerTransport`       | `@modelcontextprotocol/node` `NodeStreamableHTTPServerTransport` |
| `setRequestHandler(XRequestSchema, h)`                               | `setRequestHandler("x/method", h)`                               |

The official codemod (`npx @modelcontextprotocol/codemod@latest v1-to-v2 .`)
covers most of the table; the items below are what it does not.

## API changes that needed code

1. **Handler context (silent break).** v2 passes `ctx` with the request data
   under `ctx.mcpReq` (`id`, `signal`, `_meta`, `notify`, …) where v1 passed a
   flat `extra` (`requestId`, `signal`, `_meta`, `sendNotification`). Nothing
   fails to compile: progress, cancellation and trace propagation simply stop.
   `callExtraFromContext` (`src/mcp/define.ts`) adapts `ctx` to our
   `CallExtra` at the one SDK boundary in `registry.ts`; tests and in-process
   callers keep the flat form.
2. **Tasks.** v2 has no task runtime: no `taskStore` server option, and the
   `tasks/*` methods are not in `RequestMethod`. `src/mcp/tasks.ts` now
   declares the `tasks` capability itself and installs hand-rolled
   `tasks/get`, `tasks/result`, `tasks/list` and `tasks/cancel` handlers
   (`installTaskHandlers`, a no-op unless `SN_EXPERIMENTAL_TASKS`), using the
   v2 custom-method form `setRequestHandler(method, {params}, handler)` with
   zod params. `requestTaskStore` binds `SnTaskStore` to one request the way
   the v1 request-scoped store did. This is the M-9 seed.
3. **JSON Schema target.** v2 converts with
   `~standard.jsonSchema[io]({target: "draft-2020-12"})`; v1 emitted draft-7.
   `toolSchemas` uses the same call, so the manifest and the wire agree. For
   our shapes the only difference is `$schema`, which the lean rule 1 already
   drops: 0 B on the wire.
4. **Undefined tool keys.** v2 lists `execution`, `icons` and `_meta` as
   `undefined` when unset. JSON never carries them, but in-memory transports
   do; `leanTool` drops undefined keys so rule 2 still holds.
5. **Unknown or disabled tool.** `tools/call` for a tool that is unknown or
   disabled is now a protocol error (-32602, "Tool X not found" /
   "Tool X disabled") instead of an `isError` result. Tests are adapted.
   Visible to clients; it follows the SDK and the spec, so no shim.
6. **`completable` nesting.** v2 unwraps one `optional` and then looks for
   the completer, so `completable(schema.optional(), cb)` silently completes
   nothing. Prompts now use `completable(schema, cb).optional()`.
7. **HTTP transport** moved to `@modelcontextprotocol/node` and was renamed;
   `onsessioninitialized` keeps its shape.
8. **Still in v2 and unchanged here:** `Server.elicitInput` (admin, confirm),
   `sendLoggingMessage` (deprecated; log bridge), `sendResourceUpdated`,
   `sendResourceListChanged`, `registerCapabilities`, and the private
   `_requestHandlers` map that `wireLeanToolsList` wraps.

## Era binding (the main finding for step 2)

In 2.3.1 the protocol era is fixed per server instance. `connect()` followed
by `initialize` binds an instance to the legacy era; `serveStdio` and
`createMcpHandler` mark it modern. The spike keeps `connect()` on stdio and
the per-session `NodeStreamableHTTPServerTransport`, so it serves the legacy
revisions only. Also, `ctx.mcpReq.elicitInput` throws on a modern request, so
the elicitation flows need the MRTR `input_required` path first.

## Step 2 recommendations

1. **Server factory and modern serving (H-7).** Build the server per instance
   (`buildMcpServer` is already a factory) and serve it through `serveStdio`
   on stdio and `createMcpHandler` on HTTP, both eras negotiated. Keep the
   factory options extensible (`inputRequired`, `requestState` for MRTR).
   Stateless HTTP replaces `Mcp-Session-Id`; `Mcp-Method` / `Mcp-Name`
   headers come with it.
   **Done:** stdio runs on `serveStdio` (both eras). HTTP routes by request:
   `initialize` or an `Mcp-Session-Id` stays on the sessionful 2025 manager
   (no breaking change), any other session-less POST goes to
   `createMcpHandler({ legacy: 'reject' })` with one server and one child
   runtime per request (`src/mcp/http-modern.ts`). `buildMcpServer(runtime,
serverOptions)` takes extra server options. tools/list is identical on both
   wires; the legacy byte budget is unchanged (delta 0).
2. **MRTR `input_required`** for the elicitation flows (credentials, confirm),
   on top of the factory.
3. **Log bridge (M-8)** off the deprecated logging API.
   **Done:** a line logged during a tool call goes out through the call's
   `ctx.mcpReq.log` on the response stream; a 2026-07-28 request gets it only
   at or above the `io.modelcontextprotocol/logLevel` in its `_meta` (none
   without one; an unknown level is -32602 from the SDK). Lines outside a call
   reach only a 2025 session after `initialize`, through the deprecated
   `sendLoggingMessage` (kept for the deprecation window). Token bucket and
   `logging/setLevel` unchanged for 2025 clients; tools/list delta 0.
4. **Tasks extension (M-9)** on top of the hand-rolled handlers.
   **Done:** behind `SN_EXPERIMENTAL_TASKS`, the server declares
   `extensions["io.modelcontextprotocol/tasks"]`. On the 2026-07-28 wire a
   task tool called by a client whose envelope declares the extension answers
   `{ resultType: "task", taskId, status, ttlMs, pollIntervalMs, … }` and runs
   in the background (`run_as_task` is stripped; `run_as_task:false` keeps a
   call synchronous, no declaration means synchronous). `tasks/get` returns the
   flat task with `result` (completed — a tool error included) or `error`
   (failed — JSON-RPC errors only); `tasks/update` and `tasks/cancel` answer
   `{}`; an unknown task is -32602, an undeclared client -32021;
   `tasks/list` / `tasks/result` are not on the modern wire. The background
   run sends no progress or log notifications. Modern tasks live in the
   process runtime's store, bound to the principal (bearer `clientId`), and a
   request runtime is disposed only once its task work has settled. The 2025
   `run_as_task` path is unchanged; tools/list delta 0 (flag off).
5. **N-38** `ttlMs` / `cacheScope` on list results on the modern wire.
6. A dual-protocol spawn test (legacy and 2026-07-28 against the built
   binary) and the conformance matrix gate each of the above.
7. Measure `tools/list` on the modern wire separately; the legacy budget in
   `test/output-schema.test.js` stays as is.
