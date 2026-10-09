---
applyTo: "scripts/**,bin/**"
---

<!-- Generated from .github/agent-instructions/scripts.md by scripts/agent-instructions.mjs — edit the source, then run: npm run docs:instructions -->

# scripts and bin — generators, gates and the launcher

- **Script shape:** an `.mjs` file opens with a comment naming its roadmap
  item, what it writes, its usage (`npm run X`, `npm run X -- --check`) and the
  test that guards it. Logic lives in exported pure functions that tests import;
  the CLI part runs only when the file is invoked directly
  (`path.resolve(process.argv[1]) === import.meta.filename`), prints errors with
  `console.error` and exits 1.
- **Generators own their output.** Edit the source (`settings-manifest.ts`,
  the tool specs, `.github/agent-instructions/`…), then run the generator —
  `docs:env`, `docs:sync`, `docs:readme`, `docs:instructions`,
  `gen:manifest`. A `--check` mode never writes.
- Scripts that read TypeScript sources without a build run under
  `node --experimental-transform-types` (see `registry-from-source.mjs`,
  `ts-source-loader.mjs`).
- **Do not edit `pack-check.mjs`** — its size ceiling is an owner decision.
- **Versions** change only through `npm version`; `sync-version.mjs` copies the
  version into `server.json`, the extension, the plugin and the site.
- **`bin/servicenow-mcp-ai.cjs`** is CommonJS and must parse on ancient Node
  (no `?.`, `??` or ESM syntax; CI checks it on Node 12): it only guards the
  Node ≥ 22.12 floor and imports `../build/index.js`.
