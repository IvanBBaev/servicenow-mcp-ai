---
applyTo: "test/**"
---

<!-- Generated from .github/agent-instructions/test.md by scripts/agent-instructions.mjs — edit the source, then run: npm run docs:instructions -->

# test — node:test against the compiled build

- Tests are plain ESM `test/*.test.js` using `node:test` and
  `node:assert/strict`. They import from `../build/...`, so run
  `npm run build` first (`npm run test:full` does both).
- **Isolation:** call `baselineEnv()` at the top of the file and
  `freshRuntime()` where state must start empty (it replaces the old
  `_reset*` hooks). Scope env changes with `withEnv(overrides, fn)`.
- **No network.** Stub HTTP with `withFetch`, `jsonResponse`,
  `createFetchDouble` / `withFetchDouble` (an unmatched route answers 501) or
  `withMetadataFetch` from `test/helpers.js`; MCP surface tests use the SDK's
  `InMemoryTransport`. Time-dependent code uses `fakeClock(t)` and
  `flushAsync()`.
- **Property tests** use fast-check with `fcParams()`; the seed is fixed
  (`SN_FC_SEED` overrides it), so a failure is reproducible.
- **Coverage ratchet** (`npm run test:coverage`, c8): lines 94, branches 82,
  functions 97 — scripts imported by tests count too.
- **Contracts:** `test/fixtures/tools-manifest.json` is the tools contract —
  regenerate it with `npm run gen:manifest`, never by hand. The `tools/list`
  byte budget lives in `test/output-schema.test.js`. Goldens are regenerated
  deliberately with `UPDATE_GOLDEN=1 npm test`.
- **Guards:** `test/harness-files.test.js` fails if a local-only AI harness
  file (`CLAUDE.md`, `WORKLOG.md`, `.claude/`, `docs/ai/`…) is tracked;
  generator guards (`docs-sync`, `env-docs-generated`, `agent-instructions`)
  fail on drift.
