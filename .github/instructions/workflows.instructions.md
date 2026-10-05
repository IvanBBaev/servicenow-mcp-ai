---
applyTo: ".github/workflows/**"
---

<!-- Generated from .github/agent-instructions/workflows.md by scripts/agent-instructions.mjs — edit the source, then run: npm run docs:instructions -->

# .github/workflows — CI and publishing

- Pin every `uses:` to a full commit SHA with a `# vX.Y.Z` comment
  (`test/distribution.test.js`, H-9); Dependabot bumps them.
- Keep the top-level `permissions: contents: read` and grant more per job only
  where a job needs it; every job sets `timeout-minutes`.
- The `actionlint` job in `ci.yml` lints the workflows — keep it green.
