# Role review — Principal QA / Test Architect (2026-10-29)

Reviewer role: a principal QA / test architect with 15+ years on integration products, the kind
of system whose real failure mode is "the code agrees with its own mocks and disagrees with the
vendor". I judge test strategy, not coverage numbers: where in the pyramid each behaviour is
proven, how much is proven against the real system (here, a ServiceNow instance), whether the test
doubles were recorded or invented, whether assertions would kill realistic mutants, and whether the
release process proves the shipped artefact works in the clients users run. Good looks like this:
fast offline unit and contract tests that use doubles recorded from the real system; a small live
tier that runs for real and goes red when it cannot run; a mutation-tested safety core; and a
release checklist that installs the real tarball.

Baseline: main @ dc29e9c · servicenow-mcp-ai 3.0.0 · scope: `test/` (238 suites, helpers,
fixtures), `.github/workflows/{ci,live-smoke,skill-evals,publish}.yml`, `scripts/pdi-verify.mjs`,
`scripts/record-pdi-fixtures.mjs`, `project/PDI-VERIFY-2026-10.md`, `evals/`, `coverage/lcov.info`,
CONTRIBUTING "Releasing", plus a throwaway mutation experiment on a scratch copy of `build/`.

## 1. Verdict

The offline engineering is excellent. It runs across a broad CI matrix in about 18 s, every bug
fix gets a regression test, the write-safety core holds up under mutation, and the protocol work
is test-pinned. The risk is in the tier above: **almost nothing is proven against a real instance
on a schedule**. The weekly live smoke has been green as a no-op for three weeks running, because
its secrets were never set. The recorded corpus covers 6 of 100 tools, and every write path is
proven only against hand-written mocks. The project's own PDI audit already showed what happens
then: 5 tables and 74 fields were wrong while the suite was green. **Score: 6/10.** Offline
quality is 8–9, real-instance assurance is about 3, and for a REST-integration product the
second number matters more.

- **Top risks:** (1) live smoke silently no-op green (O-2 open); (2) hand-written fetch handlers
  in 107 suites vs 9 recorded fixtures, name verification manual and 16 days stale; (3) write
  paths and real MCP clients never exercised end to end.
- **Top strengths:** (1) a regression test per fix (93 of 95 `fix` commits since 2026-09-01 touch
  `test/`); (2) the plan-token / policy core kills 11 of 14 sampled mutants; (3) a wide CI matrix
  (Node 22/24/26, macOS, Windows, 22.12.0 floor, Node 12 launcher probe, extension, actionlint).

## 2. What I examined

- `ls test | wc -l` → 248 entries (238 suites plus helpers, `fixtures/`, `live/`, `layout/`,
  `evals/`); per-file greps for `setTimeout`, `listen(0`, `mock.timers`, `fast-check`, `numRuns`,
  `withFetch(`, `createFetchDouble`, `fixtures/pdi`, `sys_certificate`, `skip`.
- Read: `test/helpers.js` (fetch doubles, `fcParams`, `FC_SEED`), `test/all-tools-smoke.test.js`,
  `test/coverage-extra.test.js`, `test/plan-token.test.js` (imports), `test/live/live-smoke.test.js`,
  `test/pdi-replay.test.js`, `test/fixtures/pdi/pdi.js`, `test/protocol-dual-spawn.test.js`,
  `test/protocol-conformance-matrix.test.js`, `test/protocol-wire.test.js` (`settle`), `.c8rc.json`.
- Workflows: `ci.yml`, `live-smoke.yml`, `skill-evals.yml`, `publish.yml`; CONTRIBUTING.md:240-272.
- `gh secret list` → `CODECOV_TOKEN`, `NPM_TOKEN`, `OVSX_PAT`, `VSCE_PAT` only.
- `gh run list --workflow live-smoke.yml` → 3 scheduled runs (10-13, 10-20, 10-27), all `success`
  in **7 s**. `gh run list --workflow skill-evals.yml` → no runs ever.
- `gh run view 40899232928 --log-failed` (Dependabot PR) → 20,563 log lines for one `not ok 531`.
- Timing: `node --test test/pdi-replay.test.js` 2.85 s / 8 tests; `protocol-wire` 16.8 s / 28 tests;
  `http-resilience` 1.46 s / 45 tests.
- `coverage/lcov.info` (2026-10-29 22:10): lines 98.07 %, branches 90.02 %; per layer branches
  api 87.9 % (1,564 uncovered), core 93.1 %, mcp 92.1 %, tools 95.3 %.
- **Mutation experiment** (scratchpad copy of `build/` + `test/`, `node_modules` symlinked, repo
  untouched): 14 hand-made mutants in `mcp/plan-token.js`, `core/policy.js`, and three reverted
  O-5 field fixes, each run against every suite that names the module.
- **All-tools smoke instrumentation** (scratch copy): counted which tools return `isError`.
- `project/PDI-VERIFY-2026-10.md` (40 passes), `project/roadmap.yaml` (E-6, N-88, N-89),
  `project/TODO.md` (O-2), `project/V3.5-ANALYSIS-2026-10.md` (F5-36, F5-40, F5-41, F5-44).
- `npm view @modelcontextprotocol/conformance` → 0.1.16, "testing MCP client and server
  implementations against the specification".

## 3. Strengths (keep doing)

1. **Regression test per fix, mechanically.** 93 of the 95 `fix` commits since 2026-09-01 change
   `test/`. The two that don't (890408a, 82df707) only reword caveat strings. (verified: `git log`
   loop)
2. **The O-5 fixes are locked in.** In the scratch copy I reverted three PDI-found field fixes:
   `sys_flow_context.source_table/source_record` → `table/document_id`, `sys_upgrade_history`
   `summary_complete_status` → `state`, client script `applies_extended` → `inherited`. Each one
   fails a test (F1–F3 killed). (verified)
3. **The write-safety core is mutation-resistant.** Plan-token: dropping the `wrong_profile`,
   `args_changed` or `wrong_tool` check, removing single-use `forget`, or keeping expired tokens
   is killed in 5 of 6 cases. Policy: skipping the exact-deny check fails 53 more tests; a wrong
   `?` glob is killed. (verified)
4. **Broad CI matrix.** Ubuntu on Node 22/24/26 with the coverage ratchet on every leg, macOS,
   Windows (lint + test), the exact engines floor 22.12.0, a Node 12 launcher probe, the
   extension typecheck/lint/unit job and actionlint (`ci.yml`). (verified)
5. **Good test-double design where it is used.** `createFetchDouble` records unmatched routes so
   they fail loudly (`test/helpers.js:544-608`). Fake clocks (`fakeClock`, `mock.timers` in 9
   suites). Ephemeral ports (`listen(0)` in 10 suites, no fixed ports). Fixed-seed fast-check
   (`FC_SEED`, `fcParams`) in 16 suites. (verified)
6. **Protocol conformance is executable.** A requirement-by-requirement matrix
   (`test/fixtures/protocol-2026-07-28-conformance.json`) is pinned by
   `protocol-conformance-matrix.test.js`, and the real stdio entry is spawned on both wires
   (`protocol-dual-spawn.test.js`). (verified)
7. **The PDI audit is unusually rigorous.** There are 40 documented passes, and the recorder
   refuses to write on any leak (`record-pdi-fixtures.mjs`, roadmap E-6 note). (verified)
8. **Fast feedback.** About 18 s wall for about 2.7k tests, and N-89 cut the schema suite from
   22.7 s to 5.3 s. (verified via V3.5 §2.4, timings above)

## 4. Findings

### RR-QA-01 — The live smoke has been green while doing nothing (severity: high · verified)

- **Evidence:** `live-smoke.yml:31-32` only prints a `::notice::` when `SN_INSTANCE` is empty.
  `gh secret list` shows no `SN_*` secret, and `gh run list --workflow live-smoke.yml` shows 3
  scheduled runs, all `success` in 7 s. The only real-instance tier in CI has never run. O-2 has
  been open since 2026-09-26 (`project/TODO.md:631`).
- **Why it matters:** a skipped check that reports success is worse than no check. Anyone looking
  at the Actions tab (owner, contributor, auditor) reads "live smoke green". A PDI that hibernates
  or an API that changes (Zurich → Australia) would go unnoticed.
- **Recommendation:** (a) the owner sets the three secrets (the PDI `ven03019` already works
  locally); (b) an unconfigured run must fail (or at least exit with a distinct non-success),
  never pass; (c) add a wake-up/retry step for hibernating PDIs, plus a step summary that names
  the instance release family (`glide.buildtag`) so drift can be attributed.
- **Existing roadmap link:** O-2 / E-6 (done). Missing from them: the green-while-skipped
  behaviour, PDI wake-up and release-family reporting.

### RR-QA-02 — Mock fidelity: hand-written mocks everywhere, recorded truth for 6 tools (severity: high · verified)

- **Evidence:** 107 suites use the permissive `withFetch(handler)` and only 6 use the strict
  `createFetchDouble`. The recorded corpus is 7 read-only scenarios over 6 tools (`test_connection`,
  `list_tables`, `describe_table`, `query_table` ×2, `get_record`, `aggregate`;
  `test/fixtures/pdi/pdi.js:94-137`) plus 2 UIB shape files. Just 2 suites consume real-instance
  data (`pdi-replay`, `uib-pdi-shapes`). The cost of invented mocks is on record:
  `PDI-VERIFY-2026-10.md:25-31` found **5 tables and 74 fields** missing on a real instance while
  the suite was green, and that file's reader-bug table (`:45-60`) lists wrong results that shipped.
- **Why it matters:** in a REST-integration product the mock is the specification. A hand-written
  handler encodes the author's belief about ServiceNow, so the test can only confirm that belief.
  98 % line coverage over invented responses says little about correctness against an instance.
- **Recommendation:** extend the recorder so each of the 28 packages has at least one recorded
  read scenario (metadata-only, the same redaction and leak refusal). Make suites for
  ServiceNow-shape-heavy modules (`api/flows*`, `api/ui-experience*`, `api/doc-*`, `api/upgrade`)
  replay recorded bodies instead of invented ones. Make `createFetchDouble` (strict, unmatched =
  fail) the default for new suites.
- **Existing roadmap link:** E-6 (corpus, done for 7 scenarios), O-2. Missing: corpus breadth
  target, strict-double policy.

### RR-QA-03 — Field-name verification is manual and stale; CI cannot catch a new wrong name (severity: high · verified)

- **Evidence:** `scripts/pdi-verify.mjs` needs a live instance. The last full run was the
  thirty-seventh pass on 2026-10-13 at e69969b (`PDI-VERIFY-2026-10.md:903-911`). Since then
  `git log --since=2026-10-13` has 84 commits, 13 of them touching `src/api`. No test or workflow
  runs the verifier (`grep pdi-verify test scripts package.json` hits only a comment in
  `test/helpers.js`).
- **Why it matters:** this verifier has found more real defects than any other tool in the repo.
  It runs only when someone remembers to, so the next mis-named column ships green.
- **Recommendation:** add `--record-snapshot` and `--offline <file>` modes. Commit a names-only
  snapshot: for the ~276 referenced tables, the `sys_db_object` name + `super_class` and the
  `sys_dictionary` element names (metadata, no record data, no secrets). Run
  `pdi-verify --offline` in `npm run check`, where a new unknown name fails unless it is listed in
  an allow-file with a reason (plugin-gated tables). Refresh the snapshot from the live-smoke job.
- **Existing roadmap link:** none — new.

### RR-QA-04 — Write paths have never had a real-instance end-to-end test (severity: high · verified)

- **Evidence:** the PDI corpus is "read-only scenarios" (`pdi.js:12-13`) and PDI-VERIFY is GET
  only. The single write probe ever run (thirty-ninth pass, `PDI-VERIFY-2026-10.md:955-975`)
  immediately found a real bug: `applyInUpdateSet` switched `sys_update_set` but not
  `updateSetForScopeglobal`, so a global write could land in a ticket's update set. Mocks had not
  caught it. Create/update/delete, plan-token apply, update-set binding, journal revert and
  `upsert_artifact` are proven only against hand-written handlers.
- **Why it matters:** the product's headline promise is write safety. The one time its writes met
  a real instance, a capture bug surfaced, which is exactly the class of defect mocks cannot show.
- **Recommendation:** add a manual, owner-run `npm run test:live:write` on a PDI. It creates a
  scratch scoped update set, runs create → update → plan-token delete → `revert_write`, binds
  `upsert_artifact` into the set, asserts `sys_update_xml` capture and journal entries, then
  deletes the scratch set. Make it a release-checklist step for any release touching `api/write*`,
  `mcp/write-mode`, journal or update-set code.
- **Existing roadmap link:** none — new (needs owner decision: instance writes, per memory rule).

### RR-QA-05 — Mutation survivors in the safety lists, and the "every tool" smoke is 36 % error-path (severity: medium · verified)

- **Evidence:** (a) removing `"sys_certificate"` from `PROTECTED_TABLES`
  (`build/core/policy.js:25-45`) leaves all 61 policy-related suites passing; the only test hits
  for `sys_certificate` are 0 (`grep -rl sys_certificate test/`), and the list exists only in
  `src/core/policy.ts` and the changelog. Removing `sys_rest_message*` is killed by one test, so
  coverage is per-entry luck. (b) Removing the `.toLowerCase()` normalisation in `evaluateTable`
  survives. If the instance resolves `SYS_USER` like `sys_user` (judgement, unverified), that is
  a deny-list bypass. (c) The plan-token expiry boundary `<=` → `<` survives (low impact).
  (d) Instrumented `all-tools-smoke`: of the 80 tool calls that logged, 29 ended in an argument or
  lookup error (`Update set "x" was not found`, `Unknown artifact type 'x'`, `Unknown profile`).
  The test accepts `isError` (`all-tools-smoke.test.js:107-112`), so for about 36 % of tools the
  "every tool works" smoke covers only validation.
- **Why it matters:** coverage says these lines run; mutation says nobody checks their content.
  Security allow/deny lists are the classic place where a typo or a merge loses an entry silently.
- **Recommendation:** pin `PROTECTED_TABLES` with an exact-list test plus a property test ("every
  entry and a random-case variant is refused under `deny`"). Add a case-folding property test for
  `evaluateTable`. Teach the smoke's `synth()` per-tool argument overrides so each tool reaches
  its success path, and assert `isError === false` for read tools. Run StrykerJS (manual or
  nightly) on `core/policy`, `mcp/plan-token`, `core/write-journal`, `core/redaction`,
  `mcp/redact` with a recorded score.
- **Existing roadmap link:** none — new.

### RR-QA-06 — Client compatibility is tested only with the same SDK family (severity: medium · verified/reported)

- **Evidence:** every protocol suite uses `@modelcontextprotocol/client` or `/sdk` clients
  (`protocol-dual-spawn.test.js:12-13`, `pdi.js:15-17`). There is no second-implementation client
  (Python `mcp`), no replay of real-client traffic (Claude Code, VS Code, Cursor), and no run of
  the official `@modelcontextprotocol/conformance` 0.1.16 (`npm view`, reported). A grep of
  roadmap/TODO/V3.5 for "conformance package", "python client" and "client matrix" finds nothing.
- **Why it matters:** when one SDK sits on both ends of the wire, the two can agree on a
  shared misreading of the spec. Real clients differ in schema handling, `structuredContent`,
  elicitation and the 2026-07-28 wire. Users hit those differences; this suite cannot.
- **Recommendation:** add a CI job that runs the conformance server scenarios against
  `build/index.js` (stdio and HTTP). Add a Python-client stdio smoke (initialize, `tools/list`,
  one `tools/call` against a fake instance). Commit captured `initialize`/`tools/list` request
  transcripts from Claude Code and VS Code and replay them as golden inputs.
- **Existing roadmap link:** none — new. Relates to the ADR 0008 conformance matrix.

### RR-QA-07 — No test installs the artefact users actually run (severity: medium · verified)

- **Evidence:** `publish.yml:32-45` runs `npm ci`, `npm run check` and then `npm publish`. The
  CONTRIBUTING release steps (`:245-272`) are dry-run, pack-check and footprint, all of which
  check file lists and sizes. No step installs the packed `.tgz` (or the `.mcpb`) into a clean
  directory and drives `bin/servicenow-mcp-ai.cjs` through initialize + `tools/list`, and there is
  no post-publish `npx servicenow-mcp-ai@<version>` check. (grep for `npm pack` in tests/scripts
  finds only `footprint.mjs`.)
- **Why it matters:** the classic GA failures (a missing runtime dep that was dev-only, a missing
  `files` entry, an ESM resolution difference outside the repo) are invisible to a suite that runs
  against `build/` inside the repository with dev dependencies installed.
- **Recommendation:** add a CI step on ubuntu/Node 22 that runs `npm pack`, installs into a temp
  dir with `--omit=dev`, spawns the bin and asserts `serverInfo.version` and the default-profile
  tool count. Do the same for the unpacked `.mcpb`. After `npm publish`, add a step in
  `publish.yml` that runs `npx -y servicenow-mcp-ai@$VERSION --version`.
- **Existing roadmap link:** none — new (F5-35 covers SBOM/Docker, not install smoke).

### RR-QA-08 — Model-facing evals barely run; the CI gate guards a lexical proxy (severity: medium · verified)

- **Evidence:** `skill-evals.yml` has never run (`gh run list` empty; no `ANTHROPIC_API_KEY`
  secret). The single local run (WORKLOG 2026-10-09) was 15 cases × 1 run, and its results were
  not committed. The CI eval (`ci.yml`, N-89) is `--max-drop 0` against the TF-IDF backend, whose
  baseline is top-1 34.2 % (all) / 16.1 % (discovery)
  (`evals/results/tool-selection/latest-offline.json`). That measures text overlap, not a model's
  tool choice.
- **Why it matters:** tool descriptions and skills are product surface that is tuned constantly
  under byte budgets (O-10). One n=1 run gives no variance estimate, so a regression in model
  behaviour has no signal at all.
- **Recommendation:** a fixed cadence (each minor release plus each change to `skills/` or a tool
  description over N bytes), ≥3 runs per case, and committed summary baselines (score, cost,
  model id) next to the offline one.
- **Existing roadmap link:** N-49 (done), N-89 / F5-44 (the recorded backend waits for owner
  answers). Missing: cadence, repeats, committed model baseline.

### RR-QA-09 — Sleep-based synchronisation in the slowest e2e suites (severity: medium · verified)

- **Evidence:** `protocol-wire.test.js:59` `settle = (ms = 30) => setTimeout(...)` (4 uses);
  `protocol-http-modern.test.js:432-447` sleeps of 10 ms and 100 ms plus a 2,000 ms race;
  `protocol-listen-e2e.test.js:276` 50 ms. `protocol-wire` takes 16.8 s for 28 tests (slowest
  single test 1.78 s). A timing flake was fixed this week (a5d6bcb, "start the graceful-shutdown
  race only once the call is on the server"). Nothing repeats tests to surface flakes.
- **Why it matters:** fixed sleeps are a known source of flakes on slower runners (the Windows and
  macOS legs). Each flake lowers trust in a red build.
- **Recommendation:** replace `settle()` with event-driven waits (await the notification or exit
  event with a timeout). Add a weekly `workflow_dispatch`/schedule job that runs the `protocol-*`,
  `http-*` and `cli-spawn` suites 20× on all three OSes and reports the flake rate.
- **Existing roadmap link:** none — new.

### RR-QA-10 — The branch-coverage gaps sit where the instance-shape bugs were (severity: medium · verified)

- **Evidence:** lcov branch coverage is lowest in exactly the modules O-5 found wrong:
  `src/api/flows-designer.ts` 66.3 % (63/95), `doc-catalog.ts` 58.1 %, `doc-table.ts` 67.4 %,
  `explain-flow-workflow.ts` 74.0 %. The security-relevant `src/core/user-tokens.ts` is at 76.7 %.
  The ratchet is global only (`.c8rc.json` 97 / 88 / 97), so 98 % overall hides 1,564 uncovered
  branches in `api/`.
- **Why it matters:** a global average lets risk concentrate. The modules with the most complex
  instance shapes have the fewest exercised branches, and their mocks are hand-written.
- **Recommendation:** per-directory floors (`core/` branches ≥ 95, `mcp/` ≥ 92) via c8 per-file
  checks or a small lcov script. Add a targeted pass over the ten lowest-branch files, using
  recorded fixtures from QA-I3 where possible.
- **Existing roadmap link:** N-87 (global ratchet, done). Missing: per-layer floors.

### RR-QA-11 — Property tests always explore the same space (severity: low · verified)

- **Evidence:** `FC_SEED = Number(process.env.SN_FC_SEED) || 0x5e6c0de` (`test/helpers.js:715`).
  No workflow sets `SN_FC_SEED`, so every CI run replays identical inputs.
- **Why it matters:** a fixed seed is right for PR gating (reproducible), but it turns property
  tests into a large fixed example set after the first run.
- **Recommendation:** the weekly job from RR-QA-09 also runs `property*` suites with a random
  seed, prints it, and opens an issue that names the seed on failure.
- **Existing roadmap link:** E-6 (property runs). Missing: seed rotation.

### RR-QA-12 — Test output is too noisy to triage (severity: low · verified)

- **Evidence:** the failing Dependabot run 40899232928 produced 20,563 log lines for a single
  `not ok 531` (a docs badge assertion). Tool and HTTP structured logs stream into the TAP output,
  and `baselineEnv()` sets no log level (`grep SN_LOG test/helpers.js` → none).
- **Why it matters:** mean time to diagnose a red build grows with noise, and so does the habit
  of re-running instead of reading.
- **Recommendation:** default the logger to silent in `baselineEnv()`. Suites that assert on logs
  opt in.
- **Existing roadmap link:** none — new.

### RR-QA-13 — Test files named after tracker ids (severity: low · verified)

- **Evidence:** 23 suites are named by planning id rather than behaviour: `h3-remainder`, `s10a`,
  `phase3`, `p18-…`, `p19-…`, `p20-…`, `policy-h4`, `policy-h11`, `naming-m7`, `table-s8`,
  `importset-n68`, `prompts-n69`, `resources-n80`, `*-o5` (7 files). N-88
  (`V3.5-ANALYSIS-2026-10.md:509`) moves files into layer folders but does not rename them.
- **Why it matters:** finding "the tests for policy" means reading three files whose names encode
  roadmap history. Ownership and gaps become invisible.
- **Recommendation:** during the N-88 move, rename by behaviour (`policy-h4` → `policy/
protected-tables`, …) and merge the fragments into their subject suites.
- **Existing roadmap link:** N-88. Missing: renaming and merging.

## 5. Proposed roadmap items

| Temp id | Title                                                                 | Findings   | Priority | Effort | tools/list | Breaking | Owner decision        |
| ------- | --------------------------------------------------------------------- | ---------- | -------- | ------ | ---------- | -------- | --------------------- |
| QA-I1   | Live smoke that really runs and fails when it cannot                  | 01         | P0       | S      | 0 B        | no       | yes (O-2 secrets)     |
| QA-I2   | Offline dictionary snapshot + `pdi-verify --offline` in the gate      | 03, 10     | P1       | M      | 0 B        | no       | no                    |
| QA-I3   | Recorded corpus per package + strict double by default                | 02, 10     | P1       | L      | 0 B        | no       | yes (O-2 recording)   |
| QA-I4   | Live write end-to-end on a PDI (owner-run, release step)              | 04         | P1       | M      | 0 B        | no       | yes (instance writes) |
| QA-I5   | Pin safety lists, case property, smoke happy paths, mutation run      | 05         | P1       | M      | 0 B        | no       | no                    |
| QA-I6   | Packed-tarball and `.mcpb` install smoke, post-publish `npx`          | 07         | P1       | S      | 0 B        | no       | no                    |
| QA-I7   | Second-client compatibility: conformance suite + Python client        | 06         | P2       | M      | 0 B        | no       | no                    |
| QA-I8   | Flake hardening: event waits, weekly repeat + random seed, quiet logs | 09, 11, 12 | P2       | M      | 0 B        | no       | no                    |
| QA-I9   | Model-eval cadence with repeats and committed baselines               | 08         | P2       | S      | 0 B        | no       | yes (API spend)       |
| QA-I10  | Rename tracker-id test files by behaviour (fold into N-88)            | 13         | P3       | S      | 0 B        | no       | no                    |

### QA-I1 — Live smoke that really runs and fails when it cannot

- **Scope:** owner sets `SN_INSTANCE`/`SN_USER`/`SN_PASSWORD`. `live-smoke.yml`: an unset secret
  is a failing step (`exit 1` with the notice); add a PDI wake-up probe (retry `test_connection`
  with back-off up to ~5 min); write `glide.buildtag` and per-scenario pass/fail to
  `$GITHUB_STEP_SUMMARY`.
- **Acceptance:** with no secrets the run is red. With secrets, the run takes longer than 7 s and
  the summary names the instance build. A hibernating PDI is woken or reported as "instance
  asleep", which is distinct from a shape regression.
- **Dependencies:** O-2.

### QA-I2 — Offline dictionary snapshot + `pdi-verify --offline`

- **Scope:** `scripts/pdi-verify.mjs --record-snapshot test/fixtures/pdi/dictionary.json` (table →
  super_class, element names; referenced tables only) and `--offline <file>`. An allow-file with
  a reason per entry covers plugin-gated or absent tables. Wire `--offline` into `npm run check`,
  and refresh the snapshot from the QA-I1 job (artifact upload; commit stays manual).
- **Acceptance:** re-introducing `sys_flow_context.table` in a reader fails `npm run check`
  offline. The snapshot holds no record values (a test asserts keys only). The run takes < 2 s.
- **Dependencies:** a one-time live recording (owner PDI).

### QA-I3 — Recorded corpus per package + strict double by default

- **Scope:** extend `test/fixtures/pdi/pdi.js` to ≥ 1 metadata-only scenario per package (28),
  prioritising flows, ui-experience, docs, upgrade, access, atf. Migrate the suites of the ten
  lowest-branch `api/` files to replay recorded bodies. Add a lint/test rule that new suites use
  `createFetchDouble` (strict).
- **Acceptance:** recorded scenarios cover ≥ 28 tools across all packages, and every replay is
  byte-stable offline. Branch coverage of `flows-designer.ts` ≥ 85 %. A `test/test-layout` check
  rejects new `withFetch` permissive handlers in `api/` suites.
- **Dependencies:** O-2 (recording needs instance access), QA-I2 helps.

### QA-I4 — Live write end-to-end on a PDI

- **Scope:** `test/live/live-write.test.js` behind `SN_LIVE_WRITE=1` and a named scratch scope.
  The flow: create a scratch update set → `create_record` / `update_record` → plan-token
  `delete_record` → `revert_write` → `upsert_artifact` into the set → assert `sys_update_xml` rows
  and journal → delete the set and restore preferences. Add a CONTRIBUTING release step for
  changes under write, journal or update-set code.
- **Acceptance:** zero residue on the instance (asserted). Re-introducing the
  `updateSetForScopeglobal` bug (pass 39) fails the run. Never runs in `npm run check` or on a
  schedule without the owner's opt-in.
- **Dependencies:** owner decision (instance writes are never implied by bypass mode).

### QA-I5 — Pin safety lists, case property, smoke happy paths, mutation run

- **Scope:** exact-list test for `PROTECTED_TABLES`, plus fast-check "entry or random-case
  variant refused under `deny`". Case-fold property for `evaluateTable` allow/deny.
  `all-tools-smoke` per-tool argument overrides (valid artifact type, profile, update set), with
  `isError === false` asserted for read tools. A `npm run mutation` (StrykerJS, devDependency,
  manual) scoped to `core/policy`, `mcp/plan-token`, `core/write-journal`, `core/redaction`,
  `mcp/redact`, with the score recorded in `project/`.
- **Acceptance:** the three surviving mutants from this review (P1, P3, M1) are killed. The smoke
  reaches the success path for ≥ 95 % of tools. Mutation score ≥ 85 % on the scoped modules.
- **Dependencies:** none (adds a devDependency; check `npm audit`).

### QA-I6 — Packed-tarball and `.mcpb` install smoke, post-publish `npx`

- **Scope:** `scripts/install-smoke.mjs`: `npm pack` → temp dir → `npm i --omit=dev <tgz>` →
  spawn the bin over stdio → `initialize` + `tools/list`. Do the same from the unpacked `.mcpb`.
  CI step on ubuntu/Node 22 and Windows. `publish.yml` post-publish
  `npx -y servicenow-mcp-ai@$VERSION --version`.
- **Acceptance:** a dev-only import in `src/` fails the step. `serverInfo.version` equals
  `package.json`. The default profile lists 20 tools.
- **Dependencies:** none.

### QA-I7 — Second-client compatibility

- **Scope:** CI job running `@modelcontextprotocol/conformance` server scenarios against stdio
  and HTTP. A Python `mcp` client stdio smoke against the fake instance (`test/evals/fake-instance.js`).
  Committed golden `initialize`/`tools/list` requests captured from Claude Code and VS Code,
  replayed by a test.
- **Acceptance:** conformance results are recorded per release, with deviations listed in the
  ADR 0008 matrix. The Python smoke passes on both wires.
- **Dependencies:** none; no `tools/list` change.

### QA-I8 — Flake hardening

- **Scope:** replace `settle()` and the fixed sleeps in `protocol-wire`, `protocol-http-modern`
  and `protocol-listen-e2e` with event waits. Weekly `flake-hunt.yml`: those suites + `http-*` +
  `cli-spawn` ×20 on 3 OSes, plus `property*` with a random printed seed. `baselineEnv()` silences
  the logger by default.
- **Acceptance:** 0 fixed sleeps under 1 s used as synchronisation in `test/protocol-*`. Flake
  rate is published per week. A failing CI log for one assertion is < 500 lines.
- **Dependencies:** none.

### QA-I9 — Model-eval cadence

- **Scope:** run `skill-evals.yml` per minor release and when `skills/` changes, with `--runs 3`.
  Commit `evals/results/skills-<version>.json` (score, variance, cost, model). Keep the lexical
  gate and label it as a proxy in its comment.
- **Acceptance:** each minor release has a committed model baseline, and a drop of more than one
  standard deviation is called out in the release notes.
- **Dependencies:** owner (API key, spend ceiling); N-89 recorded backend.

### QA-I10 — Rename tracker-id test files (fold into N-88)

- **Scope:** while N-88 moves files into layer folders, rename the 23 id-named suites by subject
  and merge the fragments.
- **Acceptance:** no `test/**` file name matches `-(o5|n\d+|h\d+|m\d+|s\d+)\.test\.js` or
  `^(phase|p\d+|s\d+)`.
- **Dependencies:** N-88.

## 6. Owner decisions needed

1. **O-2 — set the live-smoke secrets now?** Options: (a) set them for the existing PDI; (b) keep
   them unset but make the workflow red/disabled; (c) leave as is. **Recommend (a)**, and do
   (b)'s red-when-skipped regardless. Today's no-op green is misleading.
2. **Live write end-to-end (QA-I4) on the PDI?** Options: (a) owner-run before releases that touch
   write code; (b) scheduled with a dedicated scratch scope; (c) never. **Recommend (a)**: it is
   the only way to see capture/binding bugs like pass 39.
3. **Recording scope for QA-I3:** may the recorder read metadata from all 28 packages (flows, UIB,
   ATF results, upgrade history)? **Recommend yes, metadata only**, with the existing redaction and
   leak refusal.
4. **Mutation testing devDependency (StrykerJS) and an eval spend budget (QA-I9).** **Recommend**
   Stryker as manual-only, and about $10 per minor release for evals.

## 7. Metrics this role would track

| KPI                                            | Current (2026-10-29)             | Target                          |
| ---------------------------------------------- | -------------------------------- | ------------------------------- |
| Real live-smoke executions in the last 30 days | **0** (3 no-op greens)           | ≥ 4 (weekly), each > 7 s        |
| Tools with ≥ 1 recorded real-instance scenario | **6 / 100** (0 write tools)      | ≥ 28 (one per package)          |
| Days since the last field-name verification    | **16** (2026-10-13), manual      | 0 (offline check in every gate) |
| Mutation score, sampled safety core            | **79 %** (11 / 14 mutants)       | ≥ 85 % (Stryker, scoped)        |
| Branch coverage of the 10 weakest `api/` files | 58–77 %                          | ≥ 85 %                          |
| Model-backed skill-eval runs per minor release | **0** in CI (1 local run, n = 1) | 1 run × 3 repeats, committed    |
