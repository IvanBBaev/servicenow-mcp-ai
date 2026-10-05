---
applyTo: "skills/**,hooks/**,.claude-plugin/**"
---

<!-- Generated from .github/agent-instructions/plugin.md by scripts/agent-instructions.mjs — edit the source, then run: npm run docs:instructions -->

# skills, hooks, .claude-plugin — the Claude Code plugin

- **Skills:** `skills/<name>/SKILL.md` with `name` and `description`
  frontmatter; the description says when to use the skill. A skill may name
  only tools that exist in `test/fixtures/tools-manifest.json`
  (`test/plugin-skills.test.js`).
- **Hook:** `hooks/hooks.json` runs `hooks/require-plan-token.mjs` before every
  `servicenow_*` tool call. It denies a destructive apply without a
  `plan_token` and passes through anything it does not recognise.
  `DESTRUCTIVE_TOOLS` mirrors the server's `confirm` specs and is pinned by
  `test/plugin-hook.test.js`.
- **`.claude-plugin/`:** the tool counts in `plugin.json` and
  `marketplace.json` are kept by `npm run docs:sync`, and the `plugin.json`
  version by `scripts/sync-version.mjs` — do not edit those numbers by hand.
