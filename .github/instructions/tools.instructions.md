---
applyTo: "src/tools/**"
---

<!-- Generated from .github/agent-instructions/tools.md by scripts/agent-instructions.mjs — edit the source, then run: npm run docs:instructions -->

# src/tools — tool definitions as data

- Each file exports `specs: AnyToolSpec[]` built with `defineTool({...})`:
  `name`, `title`, `description`, `package`, `annotations`, `input`, and
  optionally `output` and `confirm`, plus the `handler`. Handlers stay thin;
  domain logic belongs in `src/api/`.
- **Layer rule (ESLint):** never import `core/http*` — go through `api/`.
- **Names** are typed as `ToolName`: a new tool first gets its
  `servicenow_<verb>_<noun>` entry in `TOOLS` (`src/mcp/naming.ts`).
- **Inputs:** zod raw shapes, every field with `.describe()` and a bound —
  reuse the `mcp/define.ts` helpers (`sysId()`, `tableName()`,
  `encodedQuery()`, `fieldList()`, `shortText()`, `longText()`…). Do not
  declare `instance` or `plan_token`; the registry adds them.
- **Annotations:** all four hints are explicit. `readOnlyHint` decides what
  survives a read-only package, so reads and writes are separate tools.
- **Writes** are plan-by-default: accept `apply: applyInput`, return
  `planPreview(...)` unless `shouldApply(apply)`, then write through
  `journaledWrite(...)` (`core/write-journal.ts`). A destructive apply declares
  `confirm`, and `DESTRUCTIVE_TOOLS` in `hooks/require-plan-token.mjs` follows.
- **Results:** `ok(...)` / `okStructured(...)` / `okQueryResult(...)`; throw
  `ServiceNowError` on failure.
- **Tool definitions are the public contract.** Names, descriptions and schemas
  count against the `tools/list` byte budget (`test/output-schema.test.js`,
  N-0 / O-10). After a deliberate change run `npm run gen:manifest`,
  `npm run docs:readme` and `npm run docs:sync`, and state the byte delta.
