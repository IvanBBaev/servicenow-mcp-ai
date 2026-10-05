---
applyTo:
  - "extension/**"
---

# extension — the VS Code extension (separate package)

- Its own package, `tsconfig` (output in `out/`) and ESLint config; the root
  `npm run lint` skips it. Gate: `npm run lint` and `npm test` inside
  `extension/` (the CI `extension` job runs both).
- **CommonJS:** no `"type": "module"`, relative imports without an extension.
- **`vscode` is imported only in `extension.ts`.** `config.ts`, `doctor.ts` and
  `http-process.ts` stay free of it so they run under plain `node --test`
  (`src/test/*.test.ts`).
- `SERVER_SPEC` in `config.ts` pins the server's major version; the extension
  version is written by `scripts/sync-version.mjs` — do not bump it by hand.
- The `servicenowMcp.packages` enum in `package.json` must equal the server's
  package list plus the profiles; root `test/extension-manifest.test.js`
  enforces it.
