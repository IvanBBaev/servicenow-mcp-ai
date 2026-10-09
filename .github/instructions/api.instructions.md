---
applyTo: "src/api/**"
---

<!-- Generated from .github/agent-instructions/api.md by scripts/agent-instructions.mjs — edit the source, then run: npm run docs:instructions -->

# src/api — layer 1, one module per ServiceNow REST area

- **Layer rule (ESLint, M-2):** import `core/` and other `api/` modules only —
  never `mcp/` or `tools/`. Domain logic lives here; tool files stay thin.
- **Requests:** Table API work goes through `table.ts` (`queryTable`,
  `updateRecord`…), plugin namespaces through `pluginCall()` in `plugin.ts`
  (tells an inactive plugin's namespace 404 from a missing record), anything
  else through `snRequest()` from `core/http.ts`. Use the `shared.ts` helpers:
  `snParams()`, `expectResult` / `expectResultArray`, `snString()`,
  `assertNoCaret()`.
- **Policy before the network:** `assertTableAllowed()` and, for writes,
  `assertWriteAllowed()` / `assertTableWriteAllowed()` from `core/policy.ts`.
- **Untyped JSON is `unknown`** and narrowed; type-checked ESLint forbids unsafe
  `any`. ServiceNow sends most values as strings — normalise with `snString()`.
- **Errors:** throw `ServiceNowError` (`core/errors.ts`) with a fixed `code`
  and a one-sentence `hint`; never return error objects.
- **Long loops** report progress through `core/progress.ts` (`trackProgress`,
  `fetchAllProgress`); a tick is also a cancellation point.
- Table and field names that no code reads yet are unverified until owner gate
  O-5 (a PDI check) — mark them as such instead of guessing.
- **Tests** run every module against a mock `fetch` (`createFetchDouble`,
  `withFetch` in `test/helpers.js`); nothing touches the network.
