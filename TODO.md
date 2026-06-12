# TODO — status as of 2026-06-12 (evening)

> **The morning review (22/22) and all of Phase 6 (except the optional Х-8) are implemented** —
> summaries with commit references live in [DONE.md](DONE.md), the chronology in
> [WORKLOG.md](WORKLOG.md). Work not yet started lives in
> [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) (Phase 7 multi-instance, Phase 8 flow
> testing + code analysis, "Optional").
>
> Below: the evening triple analysis (what is MISSING going forward) + the release-readiness
> checklist (R-1…R-10) + the deliberate won't-fix decisions.

## Triple analysis 2026-06-12 (evening) — what is missing (backlog)

Context: 127/127 tests, Phase 6 complete, the evening best-practices batch landed
(Prettier in CI, `npm run verify`, crash handlers, cache invalidation on instance change).
This is a prioritized backlog — nothing here blocks current use.

### Senior dev (S2)

- [x] **S2-1 · zod schemas are not strict.** _(done, commit `e879321` — z.object(input).strict(); an argument typo is a validation error)_ An unknown argument in tools/call was silently ignored (SDK behaviour) — a model sending `tabel` instead of `table` got no signal. _Solution:_ build strict schemas in the registry (reject unknown keys) — verified how SDK 1.29 treats strict shapes.
- [x] **S2-2 · The semaphore and telemetry were global, not per host.** _(done, commit `13a2810` — per-host slots + perHost breakdown in status)_ Correct for one instance; with Phase 7 profiles the limit/counters would be shared across instances. _Solution:_ keyed by host (was pre-noted as MI-5 in the plan).
- [x] **S2-3 · `bin/servicenow-mcp.cjs` had no automated test** _(done, commit `ac14952` — CI job launcher-node12 in a node:12-alpine container)_ (requires an old Node in CI). Manually verified under 12.22.
- [ ] **S2-4 · No release process** ⏳ _waiting on the publish decision (= R-3); author + prepublishOnly are in_ — version was 1.0.0 from day one, CHANGELOG is manual. _Solution when publishing:_ changesets or release-please + `npm version` discipline.

### Architect (A2)

- [x] **A2-1 · The manifest covered only tools.** _(done, commit `5daad20` — PackageSpec: package = {name, tools, resources?}; declarative gating, invariant, the manual К-7 if deleted)_ Resources and prompts were registered imperatively. _The next step of modularity:_ `PackageSpec = { name, tools, resources?, prompts? }` — a package is one object, gating fully declarative. Pairs naturally with Phase 7.
- [ ] **A2-2 · ConfigStore covers only credentials.** ⏳ _trigger: MI-1 follow-up (Phase 7)_ Policy/settings read env per call — deliberate (see A-2); the profile store will unify them; until then new settings go through `settings.ts` only.
- [ ] **A2-3 · Global singletons** ⏳ _trigger: "when it hurts" — not earlier_ — the token/schema/plugin caches and telemetry have `clear*` hooks instead of injection. Fine for one process; if multiple servers ever share a process (tests do!), state is shared. _Solution:_ a container object created at bootstrap — when it hurts, not before.
- [ ] **A2-4 · Bootstrap will fork at Х-8** ⏳ _trigger: an Х-8 request_ (HTTP transport): extract the choice into `mcp/transport.ts` when Х-8 is requested; not pre-emptively.
- [ ] **A2-5 · Resource errors are JSON content** ⏳ _trigger: MCP protocol evolution_ (the protocol has no isError for resources) — a client cannot tell an error from data. Known; documented in ARCHITECTURE.

### QA (Q2)

- [x] **Q2-1 · Coverage was visibility only.** _(done, commit `b8b9216` — gates lines 85 / branches 72 from the real report 89.9/78.8)_
- [x] **Q2-2 · Property-based tests** _(done, commit `b8b9216` — fast-check: 500 env round-trips + 200 base64 buffers)_ for the two hand-written codecs: `formatEnvValue` round-trip and `decodeBase64Strict`.
- [x] **Q2-3 · Windows was not in the CI matrix.** _(done, commit `ac14952` — windows job with continue-on-error until the first green run; build script without unix chmod)_ The docs path traversal guard uses `path.resolve` — likely correct on win32, now verifiable in CI.
- [x] **Q2-4 · Perf regression test for `okQueryResult`** _(done, commit `9ef092b` — 10k records < 2 s)_ — the halving loop runs repeated `JSON.stringify` over large arrays; measured, with headroom for slow CI runners.
- [x] **Q2-5 · The elicitation accept path had no test** _(done, commit `9ef092b` — accept→saved to a temp env; decline was already covered)_.

## Release-readiness 2026-06-12 (evening) — what is missing for a release

Context: real verification on Node 22 — build/lint clean, 131/131 tests at the time, coverage ~89%
lines / ~78% branches, `npm audit --omit=dev` 0 vulnerabilities, `npm pack` clean (76 kB; only
build+bin+README). The code is release-grade; only packaging and process were missing (~½ day).
Details in WORKLOG.md.

### Blockers

- [x] **R-1 · LICENSE.** ✅ MIT (LICENSE file + `"license": "MIT"`) — commit `fc1f62c`.
- [ ] **R-2 · Git remote + the first real CI run.** Update 2026-06-12 (night): the remote is
      connected (`github.com/LeassTaTT/servicenow-mcp`) and main is pushed. _Remaining:_ check
      the first Actions run — the `gh` CLI is not on this machine, so verify in the browser —
      and if the Windows job is green, drop its `continue-on-error`.
- [x] **R-3 · Release process (= S2-4).** ✅ CHANGELOG cut to `[1.0.0] - 2026-06-12` + annotated
      tag `v1.0.0`. _Remaining when publishing:_ release-please or changesets + a publish workflow
      with `--provenance`.
- [x] **R-4 · package.json metadata.** ✅ `license`/`author`/`prepublishOnly` — commit `fc1f62c`;
      `repository`/`bugs`/`homepage` — commit `ac11df9` (2026-06-12).
- [ ] **R-10 · The npm package name is taken.** `servicenow-mcp` already exists on the registry
      (v1.2.0, unrelated maintainer `timschwarz`) — publishing under the current name is
      impossible. Decide: scope it (`@<scope>/servicenow-mcp`) or pick a new name; then update
      `package.json` `name`/`bin`, the README title and the XDG config dir name together.

### Before the first push

- [x] **R-5 · WIP formatted and committed** — commit `e879321` (S2-1).
- [x] **R-6 · Doc drift on the tool count.** ✅ 49 tools / 14 packages everywhere (pie + CHANGELOG,
      sourced from the manifest fixture); test count reconciled — commit `08b71cc` + release cut.

### Should-have (non-blocking; already in the backlog)

- [x] **R-7 · Coverage gate in CI (= Q2-1)** ✅ — commit `b8b9216` (lines 85 / branches 72).
- [x] **R-8 · Windows in CI + the Node 12 launcher test (= Q2-3, S2-3)** ✅ — commit `ac14952`;
      the Windows job stays `continue-on-error` until the first green run (needs the remote → R-2).
- [x] **R-9 · SECURITY.md + CONTRIBUTING.md.** ✅ added 2026-06-12 (repo-standard pass).
      _Remaining if the release goes public:_ revisit the two won't-fix decisions below — for
      third-party users the defaults should be the conservative ones (for personal use they
      remain OK).

## Decisions (won't-fix) — no code change

- [~] **`.env` is written with mode 0644 (readable by every local user).**
  Skipped — not a problem (owner's decision).
  `config.ts` — `writeFileSync` uses the default mode. The file contains a plaintext password.
  → If ever needed: `{ mode: 0o600 }` on write + `chmodSync` for an existing file.

- [~] **`servicenow_set_credentials` allows redirecting Basic auth to an arbitrary host.**
  Skipped — not a problem (owner's decision). The SSRF guard for internal/loopback hosts and
  `SN_ALLOWED_HOSTS` stay active; Х-2 (elicitation) adds client-side confirmation.
  → If ever needed: require the host to end in `.service-now.com` without an explicit opt-in.
