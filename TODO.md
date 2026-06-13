# TODO — status as of 2026-06-12 (evening)

## FULL REVIEW 2026-06-13 (architect → dev → qa)

> A single `/full-review` pass. Each persona fanned out finders and adversarially
> verified every finding before recording it (refuted false positives are not listed).

### ARCHITECT REVIEW — findings `ARCH-<n>`

- [x] **ARCH-1 · Plugin availability cache was not instance-keyed.** _(fixed 2026-06-13 — `src/api/plugin.ts`)_
      `src/api/plugin.ts:31` keyed the namespace-404 availability cache by API
      label alone (`"Email"`), unlike every other cache (token by host, schema by
      instance, telemetry/semaphore by host). **Why it matters:** under concurrent
      multi-profile use (AsyncLocalStorage routing), a 404 cached for profile A's
      instance would fast-fail a concurrent call to the same API on profile B's
      different instance — for up to the 5-min TTL — even though the plugin is
      active there. The existing `clearPluginAvailability()` on credential/profile
      change only covered the _sequential_ switch, not the concurrent case.
      _Fix:_ key the cache by `${getCredentials().instance}|${apiLabel}` (the
      `api/meta.ts` `cacheKey` pattern); `pluginAvailability()` filters to the
      active instance, preserving the status-payload contract. Regression test in
      `test/plugin.test.js` (a 404 on instance A does not block instance B).
- Refuted by adversarial verification (recorded so they are not re-raised): plugin
  fallback "drift" between snapshot.ts/compare.ts (intentional — live vs snapshot
  completeness differ by design); resource-vs-tool error payload shape (the
  documented A2-5 decision — MCP has no structured error for resources); hardcoded
  package list in `readme-sync.test.js` (the description-count sync test is the real
  completeness guard); result truncation "loses total" (false — `total` is spread
  into the payload, `result.test.js:37` proves it); snapshot warnings "mask"
  failures (false — the failure path adds the warning).

### DEV REVIEW — findings `DEV-<n>`

- [x] **DEV-1 · Encoded-query injection in `listTables` filter.** _(fixed 2026-06-13 — `src/api/meta.ts`)_
      `listTablesUncached` embedded the `filter` straight into `nameLIKE${f}^ORlabelLIKE${f}`
      with no `^` guard, so `filter="incident^active=false"` injected an extra clause.
      K-5 (`assertNoCaret`, commit `ff3e826`) had fixed exactly this class — but only in
      `scripts.ts`; `meta.ts` was missed. _Fix:_ apply the guard. Regression test in
      `test/meta.test.js`.
- [x] **DEV-2 · Encoded-query injection in `listAttachments`.** _(fixed 2026-06-13 — `src/api/attachment.ts`)_
      `table`/`sysId` went into `table_name=…^table_sys_id=…` unvalidated; only the optional
      allow-list partially mitigated it (and not in the default config). _Fix:_ `assertNoCaret`
      on both args. Regression test in `test/attachment.test.js`.
- [x] **DEV-1/2 follow-up · de-duplicated the guard.** `assertNoCaret` moved from a private
      copy in `scripts.ts` to `api/shared.ts` (next to `expectResult`/`snString`) and reused in
      all three modules, so a future query builder cannot silently skip it — the drift that
      caused DEV-1/2 in the first place.
- [x] **DEV-3 · TOCTOU on `index.md` regeneration.** _(fixed 2026-06-13 — `src/api/docs.ts`)_
      Concurrent `docsWriteRaw()` calls (pipelined requests, or two profiles snapshotting at
      once) could interleave a `walk()` with another call's write; the last rebuild wins and
      drops the entries written in between. _Fix:_ serialize `regenerateIndex()` through a tail
      promise (the chain survives a failed rebuild). Regression test in `test/docs.test.js`
      (12 concurrent writes all appear in the index). Latent under stdio today; real once the
      HTTP transport (Х-8) or pipelined clients arrive.
- Refuted: `listAttachments` "ambiguous when sysId alone" — false (`sys_id` is a globally
  unique GUID, so a `table_sys_id` filter is unambiguous without `table_name`).

### QA REVIEW — findings `QA-<n>`

All findings are coverage/edge gaps — no correctness bugs (the code is right, the tests just
did not pin some paths). 17 confirmed, 10 refuted (incl. the suggestion to tighten lines/branches
— the headroom is intentional and tightening risks cross-Node flakiness). **All 16 actionable
findings are now fixed** (QA-17 was already covered); coverage rose to 93.1% lines / 80.1%
branches / 69.0% functions across 172 tests.

Fixed in the review pass:

- [x] **QA-2 · `invalidateToken(host)` per-host isolation untested.** _(test added — `test/auth.test.js`)_
      The 401 path drops one host's token; nothing proved another host's survived. Test primes
      two hosts, invalidates one, asserts only that host re-authenticates.
- [x] **QA-3 · 401 under Basic auth must NOT retry (was untested).** _(test added — `test/http-retry.test.js`)_
      The re-auth path is gated on OAuth mode; a regression dropping that guard would have made
      Basic 401s retry. Test asserts a single call.
- [x] **QA-4 · `retryAfterMs` invalid-date fallback untested.** _(test added — `test/http-retry.test.js`)_
      An unparseable `Retry-After` must fall back to backoff, not abort the retry.
- [x] **QA-9 · No `--functions` coverage gate.** _(fixed — `package.json` + `ci.yml`)_
      Functions coverage (~67%) had no floor; added `--functions 60` (same ratchet philosophy as
      lines/branches). Lines/branches left as-is per the refuted headroom findings.
- [x] **QA-10 · `listAttachments` had no happy-path test.** _(test added — `test/attachment.test.js`)_
- [x] **QA-12 · Import Set API had zero test coverage.** _(test file added — `test/importset.test.js`)_
      Happy-path insert + read, plus read-only and table-deny rejection.

Cleared from the backlog (2026-06-13, second batch):

- [x] **QA-1** `hasCredentials()` true + each-field-missing + named-profile — `test/config-store.test.js`.
- [x] **QA-5** Batch unserviced-error fallback chain (`error` arm + default message) — `test/batch.test.js`.
- [x] **QA-6** Snapshot warns and skips the plugins section when BOTH `v_plugin` and `sys_plugins` fail — `test/snapshot.test.js`.
- [x] **QA-7 / QA-8** `loadEnv()` reads `SN_ENV_FILE`, stays env-first (`override:false`), tolerates a missing file; `getEnvPath()` explicit branch — `test/config-store.test.js`.
- [x] **QA-11** `servicenow_aggregate` happy-path (count/avg/min/max/sum/groupBy params + result) + table-deny — new `test/aggregate.test.js`.
- [x] **QA-13 / QA-14** `getAttachmentMeta` direct happy-path + malformed-response error; `downloadAttachment` post-fetch size guard when `size_bytes` is absent — `test/attachment.test.js`.
- [x] **QA-15** Whitespace-only / empty document path → 400 — `test/docs.test.js`.
- [x] **QA-16** Catalog (`listCatalogCategories`/`listCatalogItems`/`getCatalogItem`) + `knowledgeHighlights` isolated tests — `test/phase3.test.js`.
- [~] **QA-17** changeConflicts read-vs-recalc — already covered (`phase3.test.js`: GET read + read-only block);
  only the calculate=true success POST stays unpinned (low value). Not actioned.

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
- [x] **S2-4 · Release process.** _(done 2026-06-13 — `.github/workflows/publish.yml` + `release:dry` + CONTRIBUTING "Releasing")_ Tag-driven publish from CI with `--provenance`, a tag↔version guard and the `npm run check` gate; `npm version` discipline documented. Needs an `NPM_TOKEN` repo secret before the first real publish.

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
- [x] **R-10 · The npm package name is taken.** _(resolved 2026-06-13 — renamed to `servicenow-mcp-ai`)_
      `servicenow-mcp` is held by an unrelated maintainer (v1.2.0). Ivan chose the free unscoped
      `servicenow-mcp-ai`. Renamed coherently: `package.json` `name`/`bin`, `bin/servicenow-mcp-ai.cjs`,
      the MCP server handshake name, the XDG config dir (`~/.config/servicenow-mcp-ai`), `.vscode/mcp.json`,
      the CI launcher path and the README. The GitHub repo URLs stay `LeassTaTT/servicenow-mcp` (the
      repo name is unchanged). `npm pack` → `servicenow-mcp-ai-1.0.0.tgz`.

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
