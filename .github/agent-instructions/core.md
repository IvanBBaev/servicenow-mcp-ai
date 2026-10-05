---
applyTo:
  - "src/core/**"
---

# src/core — layer 0, instance-agnostic plumbing

- **Layer rule (ESLint, M-2):** nothing here imports `api/`, `mcp/` or `tools/`.
- **One HTTP client.** Every ServiceNow call goes through `snRequest()` in
  `http.ts`, so auth, the host guard, deadlines, retry and error mapping happen
  once. Retry: 429/503 for every method; 502/504 for idempotent methods only
  (`shouldRetryStatus` in `http-util.ts`) — a write is never retried on a
  gateway error. `http-util.ts` also holds the per-host slots and telemetry.
- **Settings:** every environment variable is declared once in
  `settings-manifest.ts` (`SETTINGS`; new entries use `since: UNRELEASED`) and
  read through `readSetting` / `readString` / `readInt` / `readBool` /
  `readEnum` — live on every call, never cached in a module variable. Then run
  `npm run docs:env` (README env tables, `.env.example`, `server.json`).
- **Errors:** throw `ServiceNowError(message, status?, detail?, { code, hint })`
  from `errors.ts`. A new code joins the `ServiceNowErrorCode` union and the
  `ERROR_CODES` table; the tools manifest publishes that table, so regenerate it
  with `npm run gen:manifest`.
- **State:** module state is a runtime part —
  `defineRuntimePart(name, create, dispose?, { scope })` in `runtime.ts`,
  resolved through `currentRuntime()`.
  The default scope is `"session"`; `"process"` is only for state that is safe
  to share across HTTP sessions.
- **Per-call context** (`request-context.ts`, AsyncLocalStorage):
  `runWithProfile`, `runWithCall`, `runInSession`, `currentSignal()` — resolve
  the active profile and cancellation signal at call time instead of threading
  them through signatures.
- **Logging:** `logging.ts` writes structured JSON to **stderr**. Never write to
  stdout (stdio MCP transport); never log a secret — redaction rules live in
  `redaction.ts`.
- **Writes** are journaled through `journaledWrite()` in `write-journal.ts`.
- `jira/` is the dark Jira Cloud scaffold (ARCH-14): keep it compiling, expose
  nothing. `test/http-twin-parity.test.js` keeps its client in step with
  `http.ts`.
