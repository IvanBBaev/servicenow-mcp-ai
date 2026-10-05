# Contributing

A personal project, but the bar is the same as for a team one: every change
lands with its tests, behind the full gate, with the docs in sync.

Before you start:

- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Questions, setup problems and what a good bug report contains
  (`doctor --json`, `support-bundle`) are covered in [SUPPORT.md](SUPPORT.md).
- **Security vulnerabilities are reported privately**, never in an issue or a
  pull request — see [SECURITY.md](SECURITY.md).
- Pull requests follow the checklist in the
  [pull request template](.github/pull_request_template.md); every path is
  owned by the maintainer ([CODEOWNERS](.github/CODEOWNERS)).

## Dev setup

```bash
nvm use            # Node from .nvmrc (22); engines enforce >= 22.12 (engine-strict)
npm install
npm run build
```

Credentials live in a git-ignored `.env` (copy [.env.example](.env.example));
see the [README](README.md#configure-credentials) for the resolution order.

## Quality gates

```bash
npm run check      # the full gate: build, lint, format check, tests with
                   # coverage thresholds (lines 94 / branches 82 / functions 97),
                   # Fluent action table check, tool-surface scan
                   # (scan:surface), tarball guard (pack:check), prod audit
npm run verify     # the same minus coverage/audit — the fast inner loop
npm test           # unit tests only (node:test; needs a prior build)
```

CI runs the same chain on Linux (Node 22/24/26) and macOS (Node 22), plus a
Windows job (Node 22), a Node 22.12.0 engines-floor job (build + tests), a Node 12 launcher probe and an `actionlint` job. `prepublishOnly` runs
`npm run check`, so a publish cannot bypass the gates.

Coverage thresholds are a **ratchet**: they sit just under the measured
report. Raise them as tests are added; never lower them.

`npm run sdk:drift` (P-4) checks the ServiceNow SDK for drift against the
artifact registry: npm dist-tags versus `SDK_BASELINE`, and the SDK docs index
versus the registry's `sdkApi` values. It needs the network, so it is **not**
part of `npm run check`; the weekly `sdk-drift` workflow runs it and keeps one
"SDK drift tracking" issue up to date.

`npm run scan:surface` (N-56) scans every text the server hands a model — the
tool, parameter, prompt and resource text of an in-process server with every
package on, the server instructions, and `skills/`, `agents/`, `hooks/` and
`.claude-plugin/` — for invisible or bidirectional Unicode, HTML comments,
hidden instructions, cross-tool directives (including a `servicenow_*` name
the server does not have, or a qualified `mcp__…` name other than the
plugin's own `mcp__plugin_servicenow-mcp-ai_servicenow__<tool>`) and URLs off the allowlist, and checks each tool
description against the manifest's `description_sha256`. It exits 1 on a
finding; `--json` prints the findings. An intended finding is excused in
`ALLOWLIST` in `scripts/scan-surface.mjs`, with a reason, as a reviewed edit.

`npm run fluent:verify` (P-29) is the Fluent round-trip oracle. It type-checks
every golden in `test/fixtures/fluent/` against the pinned `@servicenow/sdk`
dev dependency (exactly 4.12.2, owner gate O-7) and builds the goldens offline
with `now-sdk build`. Flags: `--no-build` (type check only), `--json`, `--keep`.
`test/fluent-sdk-oracle.test.js` runs it, so it is part of `npm test`; without
the SDK (`npm ci --omit=dev`) it is skipped. After an SDK bump, regenerate the
flow emitter's `action.core` input table with `npm run fluent:actions`.
`npm run check` runs `fluent:actions -- --check`, which fails while that table
is stale.

`npm run eval:skills` (N-49) runs the `claude plugin eval` suite in `evals/`:
for every plugin skill, one case whose prompt must load the skill and one whose
prompt must not, each with graders for the expected tool calls. It calls a
model, so it is **not** part of `npm run check`; it needs Claude Code
(≥ 2.1.283) on `PATH` and `ANTHROPIC_API_KEY`. Extra flags pass through, for
example `npm run eval:skills -- --model claude-sonnet-5 --max-cost-usd 5`.
Run output lands in `evals/results/`, which is git-ignored.

The suite never contacts a ServiceNow instance. Every MCP tool the skills call
answers from a fixed mock in `evals/mocks/servicenow/` (plus `_tools.json`, the
`tools/list` answer); a tool without a mock is unavailable to the model. The
mocks are recorded by `npm run eval:mocks`, which drives the built server
in-process against the fetch double in `test/evals/fake-instance.js`. That
double only serves the `*.eval-double.invalid` hosts and throws on any other
host, and it lives under `test/`, which is not in the published package.
`npm run eval:mocks -- --check` fails when the committed mocks are stale (for
example after a tool's output changes). `test/skill-evals.test.js` checks the
suite's structure, that every skill has a trigger and a negative case, and that
the mocks are current, without a model.

The `Skill evals` workflow runs the suite on demand (`workflow_dispatch` only)
with the model, judge model, threshold and spend ceiling as inputs. It needs the
`ANTHROPIC_API_KEY` repository secret and fails at once without it; the JSON
report goes to the job summary.

## Dependencies and the audit gate

The last step of `npm run check` is `npm audit --omit=dev --audit-level=high`:
a HIGH advisory anywhere in the **production** tree turns the gate red, even
when it is transitive and nothing in `src/` changed. Dev-only advisories are
outside the gate — Dependabot (weekly, minor + patch grouped) handles those.

Floors: `@modelcontextprotocol/sdk` is caret-pinned to the release the suite
was last verified against (`^1.30.0` since 2026-09-03); `zod` must stay inside
the SDK's peer range (`^3.25 || ^4.0` — the zod 4 move is a breaking item,
[ROADMAP-V3.md](project/ROADMAP-V3.md) E-2). When the audit step goes red:

1. Raise the floor(s) in `package.json` and `npm install`. This alone may not
   clear it — the lock keeps the old transitive versions.
2. `npm audit fix --omit=dev` — a lock-only fix. Never `--force`, and no
   `overrides` unless the SDK itself has no patched release.
3. **Run a plain `npm install` again.** `--omit=dev` prunes the dev
   dependencies from `node_modules`, so the next gate run fails with
   `tsc: command not found` (exit 127). The reinstall does not touch the lock.
4. `npm run check`, then a `### Security` entry under `[Unreleased]` in the
   CHANGELOG naming the new floors and the transitive packages that moved.

## Conventions

- One commit per task; English, imperative subject, a body that explains
  what + why.
- **Every behavioural change ships with a test in the same commit.** The
  guards are automatic: the README sync test, the core contract snapshot
  and the full suite.
- The README tools section is **generated** — edit the tool definitions, then
  run `npm run docs:readme`. A drift test fails CI when it is stale; the same
  applies to the tool/package counts in the `package.json` description.
- Tool names follow `servicenow_<verb>_<noun>` (M-7); add a new tool's name to
  `TOOLS` in `src/mcp/naming.ts` and reference tools through it (prompts, cross-tool
  hints). Renaming a shipped tool or parameter is breaking: add the old name to
  `TOOL_RENAMES` (served under `SN_LEGACY_TOOL_NAMES=1`) or the spec's
  `legacyParams`, and run `npm run docs:readme` for the generated old→new table.
- The `core` profile contract lives in
  [test/fixtures/tools-manifest.json](test/fixtures/tools-manifest.json);
  regenerate with `npm run gen:manifest` only when the change is deliberate.
- Docs move with the code: [CHANGELOG.md](CHANGELOG.md) (Unreleased section),
  [TODO.md](project/TODO.md)/[DONE.md](project/DONE.md) when an item closes,
  [PRODUCT-STATE.md](project/PRODUCT-STATE.md) on milestones.
- Prettier checks Markdown too (`project/*.md`, the CHANGELOG, this file).
  After editing a doc run `npx prettier --write <files>` **twice**, then
  `npx prettier --check .`: the formatter is not idempotent on an inline code
  span that crosses a line break, or on a bare `_`/`*` in a table cell outside
  a code span (it becomes emphasis) — keep those on one line / in backticks.

## Where things live

See [ARCHITECTURE.md](project/ARCHITECTURE.md) for the layer model
(`core` → `api` → `mcp` → `tools`), the request lifecycle and the module
contract for adding a tool or a package.

## Releasing

The npm package is **`servicenow-mcp-ai`** (the unscoped `servicenow-mcp` was
taken). Publishing happens **from CI on a version tag**, never from a laptop.

1. Land the work; move the [CHANGELOG.md](CHANGELOG.md) `Unreleased` notes under
   a new `## [x.y.z]` heading.
2. Dry-run the tarball locally: `npm run release:dry` (runs the full gate, then
   `npm publish --dry-run` — the file list must be `build` + `bin` + README +
   LICENSE; `npm run pack:check`, part of the gate, fails on a `.map`, `jira/`,
   `test/` or `docs/instance/` entry, an unexpected top-level file or an
   unpacked size above 800 KB).
3. Bump + tag: `npm version <patch|minor|major>` then
   `git push --follow-tags`.
4. The [`publish.yml`](.github/workflows/publish.yml) workflow runs on the `v*`
   tag: it checks the tag matches `package.json`, runs `npm run check`, and
   publishes with `--provenance`. It needs an `NPM_TOKEN` repository secret
   (an automation/2FA token).

5. MCP bundle (N-51): `npm run mcpb:pack` builds
   `dist/mcpb/servicenow-mcp-ai-<version>.mcpb` from `build/`, the production
   dependencies and the generated `mcpb/manifest.json` (`npm run mcpb:manifest`
   regenerates it after a settings or tool change; `--check` is part of the
   gate). Add `-- --validate` to run the official validator via `npx`. The
   `mcpb-asset` job in `publish.yml` attaches the bundle to the GitHub Release,
   but only when the repository variable `MCPB_RELEASE` is `true` (Settings →
   Secrets and variables → Actions → Variables). Until the owner enables
   publication (O-22), leave it unset and the job is skipped.

SemVer: patch = fixes, minor = new tools/back-compatible additions, major =
a breaking tool/contract change.

### Version bump

`npm version <patch|minor|major>` is the only way the version changes. Its
`version` lifecycle script runs [scripts/sync-version.mjs](scripts/sync-version.mjs),
which copies the new `package.json` version into every other file that carries
one — `package-lock.json`, `server.json`, `extension/package.json`,
`extension/package-lock.json`, `.claude-plugin/plugin.json`,
`mcpb/manifest.json` and `docs/index.html` — and stages them, so a single commit and tag carry a single
version. `test/version-sync.test.js` fails CI on any skew (by hand:
`node scripts/sync-version.mjs --check`; `npm run version:sync` rewrites). Never
edit a version field directly.

Per-profile credential files (`.env.<profile>`, `.env.tmp-*`) are git-ignored;
only `.env.example` is tracked, and CI fails when any other `.env*` file is.
