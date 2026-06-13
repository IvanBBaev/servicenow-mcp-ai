# Contributing

A personal project, but the bar is the same as for a team one: every change
lands with its tests, behind the full gate, with the docs in sync.

## Dev setup

```bash
nvm use            # Node from .nvmrc (22); engines enforce >= 20 (engine-strict)
npm install
npm run build
```

Credentials live in a git-ignored `.env` (copy [.env.example](.env.example));
see the [README](README.md#configure-credentials) for the resolution order.

## Quality gates

```bash
npm run check      # the full gate: build, lint, format check, tests with
                   # coverage thresholds (lines 85 / branches 72), prod audit
npm run verify     # the same minus coverage/audit — the fast inner loop
npm test           # unit tests only (node:test; needs a prior build)
```

CI runs the same chain on Linux (Node 20/22/24) and macOS (Node 22), plus a
Windows visibility job and a Node 12 launcher probe. `prepublishOnly` runs
`npm run check`, so a publish cannot bypass the gates.

Coverage thresholds are a **ratchet**: they sit just under the measured
report. Raise them as tests are added; never lower them.

## Conventions

- One commit per task; English, imperative subject, a body that explains
  what + why.
- **Every behavioural change ships with a test in the same commit.** The
  guards are automatic: the README sync test, the core contract snapshot
  and the full suite.
- The README tools section is **generated** — edit the tool definitions, then
  run `npm run docs:readme`. A drift test fails CI when it is stale; the same
  applies to the tool/package counts in the `package.json` description.
- The `core` profile contract lives in
  [test/fixtures/tools-manifest.json](test/fixtures/tools-manifest.json);
  regenerate with `npm run gen:manifest` only when the change is deliberate.
- Docs move with the code: [CHANGELOG.md](CHANGELOG.md) (Unreleased section),
  [TODO.md](TODO.md)/[DONE.md](DONE.md) when an item closes,
  [PRODUCT-STATE.md](PRODUCT-STATE.md) on milestones.

## Where things live

See [ARCHITECTURE.md](ARCHITECTURE.md) for the layer model
(`core` → `api` → `mcp` → `tools`), the request lifecycle and the module
contract for adding a tool or a package.

## Releasing

The npm package is **`servicenow-mcp-ai`** (the unscoped `servicenow-mcp` was
taken). Publishing happens **from CI on a version tag**, never from a laptop.

1. Land the work; move the [CHANGELOG.md](CHANGELOG.md) `Unreleased` notes under
   a new `## [x.y.z]` heading.
2. Dry-run the tarball locally: `npm run release:dry` (runs the full gate, then
   `npm publish --dry-run` — confirm the file list is `build` + `bin` + README +
   LICENSE, no `.map`/`src`).
3. Bump + tag: `npm version <patch|minor|major>` then
   `git push --follow-tags`.
4. The [`publish.yml`](.github/workflows/publish.yml) workflow runs on the `v*`
   tag: it checks the tag matches `package.json`, runs `npm run check`, and
   publishes with `--provenance`. It needs an `NPM_TOKEN` repository secret
   (an automation/2FA token).

SemVer: patch = fixes, minor = new tools/back-compatible additions, major =
a breaking tool/contract change.
