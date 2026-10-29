# Role review — Principal Software Architect (TypeScript/Node) (2026-10-29)

Reviewer role: a principal architect with 15+ years of TypeScript/Node server work. This role
cares about whether the codebase can keep changing safely: layering that is enforced, not just
written down; modules that are small and cohesive; few and pinned dependencies on third-party
internals; a runtime with bounded state and predictable per-request cost; and design documents
and ADRs that describe the system as it is, so that a solo maintainer and AI agents can make
correct changes without archaeology. "Good" means that a structural regression fails the gate
before it reaches `main`, and that the expensive and risky paths are known, measured and owned.

Baseline: main @ dc29e9c · servicenow-mcp-ai 3.0.0 · scope: `src/` (254 files / 90.5k lines),
the import graph, function-level complexity, SDK coupling, runtime state, the write journal,
policy enforcement, `project/ARCHITECTURE.md`, `project/adr/`, the planning corpus and N-88.

## 1. Verdict

The macro-architecture is sound and is actually enforced: there are zero import cycles, the
layer direction (core ← api ← tools/mcp) is clean and gated by ESLint zones and a cycle test,
and the runtime-part container gives explicit process vs session scope. The problem is not the
shape but the **rate**. `src/` grew about 8× in two months (11k → 90.5k lines) with no size or
complexity ratchet, and the micro-level shows it: 49 functions of 120+ lines, 30 with cyclomatic
complexity ≥ 30, and a 117-file flat `api/` that is mostly analysis code, not REST access.
The design record has not kept up: ARCHITECTURE.md describes v2.0 and the ADRs record owner
gates, not the technical decisions an agent needs.

**Score: 7/10**: strong, enforced macro-structure and safety design. It loses points for
unratcheted growth, a per-request full server build on the modern wire, a journal that does
synchronous I/O and has no lock or retention, and stale architecture docs.

- Top risks: (1) unbounded growth and complexity hot spots with no gate; (2) the write journal
  (sync I/O per write, no cross-process lock, revert reads full history); (3) the modern
  stateless wire rebuilds the whole McpServer on every request.
- Top strengths: (1) 0 cycles plus enforced layer zones; (2) runtime-part container and a single
  HTTP choke point; (3) data-driven tool specs with generated docs and drift tests.

## 2. What I examined

- `src/server.ts`, `src/index.ts`, `src/mcp/registry.ts`, `src/mcp/define.ts`,
  `src/mcp/http-modern.ts`, `src/mcp/transport.ts`, `src/mcp/lean-list.ts`, `src/mcp/tasks.ts`,
  `src/mcp/log-bridge.ts`, `src/mcp/params-errors.ts`, `src/mcp/input.ts`, `src/mcp/context.ts`,
  `src/core/http.ts`, `src/core/http-util.ts`, `src/core/policy.ts`, `src/core/write-journal.ts`,
  `src/api/revert.ts`, `src/api/AGENTS.md` and the other per-layer AGENTS.md files.
- `eslint.config.js:107-150` (layer zones), `test/import-cycles.test.js`,
  `test/sdk-internals.test.js`, `test/policy-h4.test.js`, `test/plugin-hook.test.js`,
  `CONTRIBUTING.md` (tool checklist, line 208).
- Scratch scripts in the session scratchpad (read-only, nothing written to the repo):
  - `graph.mjs`: import graph from TS sources, Tarjan SCC, layer edges, fan-in/fan-out.
  - `fn.mjs`: TypeScript AST walk; per-function length and cyclomatic complexity.
  - `unused.mjs`: exports referenced only in their own file, only in tests/scripts, or nowhere.
  - `bench2.mjs` / `bench3.mjs`: timing of `buildMcpServer` and its phases, plus heap.
- Growth: `git log` / `git show <rev>:src` line counts for 2026-08-01, 09-01, 10-01, 10-15, HEAD.
- `npm view @modelcontextprotocol/server version` (2.4.0), `gh pr list` (10 open Dependabot
  PRs) and `gh pr view 30` (server 2.3.1 → 2.4.0, node 2.1.1 → 2.1.2, sdk 1.32.1 → 1.32.2).
- `project/ARCHITECTURE.md`, `project/adr/0001…0012` and the ADR README, `project/roadmap.yaml`
  (N-88 at line 1554, F5-42, F5-43, N-81, N-90), `project/V3.5-ANALYSIS-2026-10.md` §4,
  `project/TODO.md`; byte sizes of `project/`, `WORKLOG.md` and `docs/ai/HANDOFF.md`.

## 3. Strengths (keep doing)

1. **Enforced acyclic layering.** The graph has 0 runtime cycles. core imports only core, api
   imports api and core, and tools import api, core and mcp. This is gated by
   `test/import-cycles.test.js` and the ESLint zones in `eslint.config.js:107-150`. (verified)
2. **Small composition roots.** `src/index.ts` is 21 lines and `src/server.ts` is 155 lines.
   Wiring is readable in one screen. (verified)
3. **Explicit runtime scope.** There are 44 `defineRuntimePart` uses across 19 files, with
   process vs session scope chosen per part (E-3/H-7). Very little state is at module level,
   and what there is is mostly bounded (for example the nonce map in `mcp/input.ts:230`,
   capped by `INPUT_NONCE_MAX`). (verified)
4. **One HTTP choke point for transport concerns.** Every call goes `snRequest` → `rawRequest`.
   The transport concerns are already split into `core/http-*.ts`. (verified)
5. **Data-driven tools plus generated artefacts.** `defineTool`/`runSpec`, the generated
   manifest, README, mcpb and docs, and drift tests (for example `DESTRUCTIVE_TOOLS` in
   `test/plugin-hook.test.js`) keep the 6–8 touch points for a new tool honest. That is a
   reasonable cost for tool #101. (verified)
6. **SDK private hooks are pinned and fail loudly.** N-81 added `test/sdk-internals.test.js`
   for `_requestHandlers`, `_registeredTools` and `isMessageIgnored`. (verified; see RR-AR-07
   for the gap)
7. **Journal integrity design.** A hash chain, a head file and size-based rotation are the right
   primitives. RR-AR-03 is about how they are executed, not the design. (verified)

## 4. Findings

### RR-AR-01 — Unratcheted growth and function-level complexity hot spots (severity: high · verified)

- **Evidence:** `src/` line counts: 11,030 (2026-08-01), 11,030 (2026-09-01), 61,320
  (2026-10-01), 88,016 (2026-10-15), 90,541 (HEAD). That is 547 commits since 2026-09-29. The
  AST scan (`fn.mjs`) counts 4,501 functions: 49 with 120+ lines and 30 with CC ≥ 30. The worst:

  | Function              | Location                                              | Lines | CC  |
  | --------------------- | ----------------------------------------------------- | ----- | --- |
  | `explainUiExperience` | `src/api/ui-experience.ts:395`                        | 666   | 91  |
  | `securityScan`        | `src/api/security.ts:322`                             | 527   | 115 |
  | `snapshotInstance`    | —                                                     | 443   | —   |
  | `explainPortal`       | —                                                     | 441   | 35  |
  | `compareInstances`    | —                                                     | 387   | 63  |
  | `uibCompleteness`     | —                                                     | 382   | 47  |
  | `codeHealth`          | —                                                     | 347   | 67  |
  | `rawRequestInner`     | `src/core/http-util.ts:267` (hot path for every call) | 335   | 45  |
  | `queryTable`          | `src/api/table.ts:199`                                | 192   | 60  |

  11 files are over 1,000 lines (`api/document.ts` 1906, `api/ui-experience.ts` 1747,
  `mcp/tasks.ts` 1141, `api/ops.ts` 1103, `mcp/resources.ts` 1099, `cli.ts` 1076,
  `mcp/prompts.ts` 1071, …). `eslint.config.js` has no `complexity`, `max-lines`,
  `max-lines-per-function` or `max-statements` rule, and no test ratchets size.

- **Why it matters (to this role):** a 600-line function with CC 91 cannot be reviewed by a
  human or reliably edited by an agent inside one context window. Every edit then risks a
  regression the 98% line coverage will not catch, because branch combinations explode.
  `rawRequestInner` and `queryTable` sit on the path of every tool call. Without a ratchet,
  any split done under N-88 will regrow.
- **Recommendation:** add a ratchet test, not a hard lint limit. Record the current per-function
  CC/length and per-file lines in a baseline JSON, fail when a new function crosses
  CC 25 / 120 lines or a listed one grows, and allow only decreases. Then refactor the top five
  (`securityScan`, `explainUiExperience`, `rawRequestInner`, `queryTable`, `compareInstances`)
  into table-driven rule lists or phase functions.
- **Existing roadmap link:** N-88 (roadmap.yaml:1554; V3.5 §4 line 503) splits three files
  (`document.ts`, `ui-experience.ts`, `tasks.ts`) and mirrors `test/`. It **misses** function-level
  complexity, a regrowth ratchet, the other 8 files over 1,000 lines, and the hot-path
  functions in `core/`. F5-43 points at `src/api/http-util.ts`, but the file is
  `src/core/http-util.ts`.

### RR-AR-02 — Write journal: sync I/O per write, no cross-process lock, full-history reads, no retention (severity: high · verified)

- **Evidence:** `src/core/write-journal.ts`:
  - `appendWriteJournal` (lines 438-477) runs `mkdirSync`, `readHead`, `rotateIfNeeded`
    (`statSync` and `renameSync`), `appendFileSync`, `writeFileSync` of the head, then
    `renderMarkdown`. That last step re-reads up to 1 MiB of tail (`MARKDOWN_TAIL_BYTES`) and
    rewrites the 200-entry Markdown mirror. All of it happens synchronously on the event loop,
    for every applied write.
  - Nothing serialises head-read → append → head-write across processes. Claude Desktop and VS
    Code commonly run two server processes on the same profile and `SN_DOCS_DIR`; interleaving
    gives two entries with the same `prev` hash, so verification reports `broken@n`.
  - `readWriteJournal` (lines 557-611) synchronously reads **every rotated file** into memory.
    It is called from `src/api/revert.ts:334` and `:549`. Rotation is at 20 MiB
    (`SN_JOURNAL_MAX_BYTES`) and there is no retention cap, so revert cost grows without bound.
  - For v1 journals, `lastLine` reads the whole file.
- **Why it matters (to this role):** the journal is the backbone of the safety story (revert,
  audit). A false "chain broken" result after a normal two-client setup destroys trust in it.
  Sync I/O blocks the HTTP transport for every concurrent session during bulk writes (and O-23
  bulk writes will multiply the count). Unbounded history plus whole-file reads makes revert a
  latent memory problem.
- **Recommendation:** take an advisory lock (an `O_EXCL` lock file with stale-PID recovery, or
  one append per process plus a per-process chain id), or detect a concurrent writer and
  re-chain. Render the Markdown mirror lazily (debounced, or on read). Make `readWriteJournal`
  stream newest-first and stop at the first match, or keep a small sys_id → offset index.
  Add a retention policy (count or age of rotated files, `SN_JOURNAL_KEEP`).
- **Existing roadmap link:** none — new. The only retention mention is about `exports/`
  (TODO.md:505).

### RR-AR-03 — Modern stateless wire builds a full McpServer and runtime per request (severity: high · verified, timings noisy)

- **Evidence:** `src/mcp/http-modern.ts:73` and `:153` call
  `createMcpHandler((ctx) => this.build(ctx))` and `options.factory(runtime, ctx)`, with a
  fresh `createRuntime`, on every HTTP request. `buildMcpServer` (`src/server.ts`) runs
  `registerAllTools`. That builds the zod schemas for all ~100 tools, including disabled
  packages, through `PackageSession`. It also registers prompts and resources, builds the
  instructions, and calls `effectivePackages()` three times. Measured with `bench2.mjs`/`bench3.mjs`
  (load average was about 82 during the run, so the absolute numbers are inflated; the
  proportions hold):

  | Measurement           | Default profile | `all`       |
  | --------------------- | --------------- | ----------- |
  | `buildMcpServer` mean | about 64 ms     | about 48 ms |
  | `registerAllTools`    | 28.8 ms         | 22.5 ms     |
  | `registerPrompts`     | 7.6 ms          | 4.1 ms      |
  | instructions          | 2.6 ms          | 0.35 ms     |

  Heap went from about 33 MB after import to about 56 MB after the builds.

- **Why it matters (to this role):** on the modern wire, every `tools/call` pays tens of
  milliseconds of CPU and allocation before any ServiceNow I/O. That caps throughput per core
  and creates GC pressure under concurrent agents. It is the one place where the runtime scales
  with request count instead of session count. It also makes per-request state accidentally
  "fresh" in ways nobody designed (for example record-watch, F5-29).
- **Recommendation:** split the build into an immutable, cached part (tool definitions, JSON
  schemas, prompt and resource descriptors, keyed by the effective-package set plus the config
  hash) and a cheap per-request binding (runtime, auth context). Alternatively, pool one server
  per config key if the SDK's handler allows it. Add a benchmark test with a generous ceiling
  (for example a median below 5 ms per modern request on CI) so it cannot regress silently.
- **Existing roadmap link:** none — new. F5-42 (eager package loading) covers only import-time
  cost. F5-29 notes record-watch on the modern wire but not the build cost.

### RR-AR-04 — Policy is enforced per call site; there is no choke point and no read-side sweep (severity: medium · verified)

- **Evidence:** the code has 59 `assertTableAllowed`, 16 `assertTableWriteAllowed` and 28
  `assertWriteAllowed` calls, scattered across api modules. There is none in `snRequest` or
  `rawRequest`, and `api/diagnostics.ts` calls `snRequest` directly on purpose.
  `test/policy-h4.test.js:664-700` sweeps the **write** tools (readonly mode, denied target
  table). No generic test proves that a read tool never fetches a denied table. Read-side
  coverage is per-feature only.
- **Why it matters (to this role):** with 62 api files that make requests, and analysis modules
  that fan out to many tables (explain, docs, compare, snapshot), the opt-in model depends on
  every author remembering the guard. A new explainer that reads `sys_user` through a helper
  silently bypasses a deny-list. The write side has a sweep; the read side, where data
  exfiltration happens, has none.
- **Recommendation:** add a table-level guard at the `snRequest` layer. Parse `/api/now/table/<t>`
  and `/api/now/attachment` paths and check them against the read policy, with an explicit,
  greppable `bypassPolicy: "reason"` opt-out for diagnostics. Add a sweep test: deny a sentinel
  table, call every read tool with fixtures, and assert that no request path mentions it.
- **Existing roadmap link:** none — new. This extends H-4, which is done.

### RR-AR-05 — ARCHITECTURE.md describes v2.0, not 3.x (severity: medium · verified)

- **Evidence:** `project/ARCHITECTURE.md` (265 lines) has the header "2026-07-06 … v2.0 …
  406/406 tests" and was last touched 2026-10-10. Stale claims:
  - "stdio MCP server … 100 tools in 26 packages" (now 28 packages, plus HTTP)
  - "no runtime dependencies beyond `@modelcontextprotocol/sdk`" (now the v2
    `server`/`node` packages, zod and acorn)
  - "14 manifests" and "3 prompts" (now 16 prompts)
  - the dark Jira scaffold, §8 `JiraError`, `jira-http.test` and the twin parity test (all
    deleted by ADR 0007)
  - a `core` default profile with 24 tools and `all` = 97 (now `discovery`, 20 tools)
  - "a light residual cycle registry → tools/admin → status" (now 0 cycles)
  - §11 "all uncommitted", with E-4 and H-7 described as future work
  - "OAuth for the HTTP endpoint (not implemented)", while N-17 ships `src/mcp/http-auth.ts`
    (623 lines, RFC 9728, `SN_HTTP_OAUTH_*`)

  It says nothing about the modern stateless wire, tasks, the skills extension, MRTR, the
  artifact registry, log-bridge, OTel, or the SDK v2 migration. `src/api/AGENTS.md` still calls
  api "one module per ServiceNow REST area" (see RR-AR-08). CONTRIBUTING still links to it.

- **Why it matters (to this role):** agents read this file as ground truth. A document that is
  wrong in about ten load-bearing places is worse than none: it leads to designs against
  removed code (Jira) and a missed auth layer.
- **Recommendation:** rewrite it for 3.x. Generate the countable facts (packages, tools,
  prompts, profiles, dependencies, cycle count) from code, the same way `docs:sync` does, and
  add a drift check so the header version and counts cannot go stale again.
- **Existing roadmap link:** none — new. No item refreshes ARCHITECTURE.md.

### RR-AR-06 — ADRs record owner gates, not the technical decisions (severity: medium · verified)

- **Evidence:** `project/adr/0001…0012` are mostly gate rounds and product scope decisions.
  0002, 0004 and 0005 are superseded. No ADR records:
  - the runtime-part container and process vs session scope (E-3/H-7)
  - the SDK v2 migration and the policy for private hooks (N-35/N-81)
  - per-request server construction on the modern wire
  - the plan-token and hash-chained journal design
  - zod as the schema language and the budgeted `tools/list`
  - the data-driven artifact registry
  - AsyncLocalStorage request context
  - eager registration with `PackageSession` enable/disable

  The ADR README still lists gates O-1…O-22; the gates now go to O-25.

- **Why it matters (to this role):** these are exactly the decisions an agent will try to
  "improve" without knowing why they exist (for example "simplify" by moving session state to
  module level, or dropping the private-hook pins). ADRs are the cheapest defence.
- **Recommendation:** write short ADRs 0013–0020 for the decisions above (context, decision,
  consequences, revisit trigger; one page each). Update the README index.
- **Existing roadmap link:** none — new.

### RR-AR-07 — SDK coupling: `_wrapHandler` is unpinned, 2.4.0 is unadopted, and Dependabot PRs rot (severity: medium · verified)

- **Evidence:** the code reaches into four private SDK APIs:
  - `_requestHandlers` in `src/mcp/lean-list.ts:232`
  - `_requestHandlers` and `_registeredTools` in `src/mcp/tasks.ts:1080-1099`
  - `isMessageIgnored` in `src/mcp/log-bridge.ts:104`
  - `_wrapHandler`, monkey-patched in `src/mcp/params-errors.ts:19-20` and `:91`

  `test/sdk-internals.test.js` (N-81) pins the first three, but `_wrapHandler` does not appear
  in any test. Only the -32602 protocol tests cover it, indirectly. `@modelcontextprotocol/server`
  2.4.0 was released 2026-10-23; the repo pins 2.3.1 exactly, and node 2.1.2 and sdk 1.32.2 are
  also out (Dependabot PR #30). There are 10 open Dependabot PRs; the oldest (#10) dates from
  2026-07-03, and #12 is TypeScript 7 for the extension.

- **Why it matters (to this role):** exact pins are only safe if they are moved deliberately and
  often. With a backlog of four months, the eventual jump will be large, and the one private
  hook without a pin (`_wrapHandler`) is the one most likely to be silently renamed. The
  -32602 behaviour would then change without a clear failure.
- **Recommendation:** add `_wrapHandler` to `test/sdk-internals.test.js`. Take PR #30 (server
  2.4.0) through the gate now. Set a cadence: triage Dependabot each release, and close or merge
  within 14 days.
- **Existing roadmap link:** N-81 / F5-27 (done) covers three of the four hooks. It misses
  `_wrapHandler` and has no bump cadence.

### RR-AR-08 — `api/` is a flat 117-file layer that is mostly analysis code, with no internal boundaries (severity: medium · verified)

- **Evidence:** `src/api/` has 117 files and 49,009 lines in one folder. Grouping exists only as
  filename prefixes: doc-_ (10), explain-_ (8), uib-_ (7), domain-_ (7), dependencies-_ (6),
  docs-_ (5). 55 of the 117 files make no request at all (12.6k lines of pure logic). About 31k
  of the 49k lines are analysis or rendering (explain, doc, lint, rules, compare). Only 62 files
  call `snRequest`, `queryTable`, `getRecord`, `pluginCall` or `fetchAll`. The ESLint zones have
  no rule inside `api/` and none for `mcp/`. `src/api/AGENTS.md` describes the layer as "one
  module per ServiceNow REST area", which is no longer true.
- **Why it matters (to this role):** the layer name promises an I/O boundary that it doesn't
  provide. Pure analysis code can import request helpers freely, which is why policy checks
  (RR-AR-04) end up scattered. It also keeps analysis code from being tested or reused without
  REST mocks. For agents, a flat folder of 117 files is a poor map.
- **Recommendation:** split `api/` into `api/rest/` (thin REST access, the only place allowed to
  import `core/http`) and domain folders such as `analysis/explain`, `analysis/docs` and
  `analysis/uib`, with ESLint zones that forbid analysis → `core/http`. Do it with re-export
  shims in one move, behind an owner decision, because it touches every import.
- **Existing roadmap link:** N-88 splits files but not the folder or its boundaries. Missing:
  domain folders, the REST-vs-analysis split, intra-api zones and the AGENTS.md correction.

### RR-AR-09 — The planning and agent-context corpus is as big as the source (severity: low · verified)

- **Evidence:** sizes on disk:

  | File                       | Size                                            |
  | -------------------------- | ----------------------------------------------- |
  | `project/` total           | 2.5 MB (1.83 MB of it .md and .yaml)            |
  | `ROADMAP-V3.md`            | 860 KB                                          |
  | `roadmap.yaml`             | 141 KB, with notes that run to a paragraph each |
  | `PDI-VERIFY-2026-10.md`    | 134 KB                                          |
  | `SDK-PARITY.md`            | 116 KB                                          |
  | `DONE`                     | 105 KB                                          |
  | `TODO.md`                  | 96 KB                                           |
  | `V3.5-ANALYSIS-2026-10.md` | 82 KB                                           |
  | `WORKLOG.md`               | 528 KB                                          |
  | `docs/ai/HANDOFF.md`       | 58 KB                                           |
  | `src/` (for comparison)    | 3.4 MB                                          |

- **Why it matters (to this role):** for "one maintainer plus AI agents", context is the scarce
  resource. Agents that grep the planning corpus pull in long, superseded paragraphs, and 154
  of the 178 roadmap rows are done. Size alone makes the corpus hard to keep accurate, as
  RR-AR-05 shows.
- **Recommendation:** archive the done rows and closed analyses into `project/archive/` and keep
  `roadmap.yaml` notes to one line plus a link. Roll `WORKLOG.md` over each quarter. Set a size
  budget for the live corpus (for example under 400 KB), checked by a script.
- **Existing roadmap link:** none — new.

### RR-AR-10 — Over-exported surface and test-only exports (severity: low · verified)

- **Evidence:** `unused.mjs` finds 506 exports referenced only inside their own file, which
  could be private. One export is unused anywhere (`SKILL_SCHEME` in `src/mcp/skills.ts`).
  28 exports are used only by tests or scripts, for example `uploadAttachment` in
  `src/api/attachment.ts:442`, a test-only duplicate of `uploadPrepared`; also
  `documentSecurity`, `toCsv`, `sysIdList` and `renamedTo`. Neither knip nor ts-prune is used.
- **Why it matters (to this role):** every needless export is surface an agent may couple to, and
  test-only duplicates mean tests exercise a path production does not use.
- **Recommendation:** add knip, or a small `scripts/export-audit.mjs`, as a non-blocking report
  first and then a ratchet. Delete `uploadAttachment` and point its tests at `uploadPrepared`.
- **Existing roadmap link:** none — new. N-88's json-pick consolidation is adjacent but does
  not cover this.

### RR-AR-11 — Small runtime smells in server construction and module state (severity: low · verified)

- **Evidence:**
  - `buildMcpServer` calls `effectivePackages()` three times per build (0.1 ms each, but each
    call re-derives config).
  - `mcp/context.ts` keeps a `current` server as a session-aware service locator.
  - `core/policy.ts:127` has a `compiled` regex Map with no bound. It is keyed by config
    entries, so it is bounded in practice, but not by construction.
  - Module-level counters live in `core/http-util.ts:255`, `core/tracing.ts:57` and
    `mcp/resources.ts:598`; `transport.ts` has singletons; `skills.ts` caches the catalog.
- **Why it matters (to this role):** each item is minor alone. Together they are what will make
  RR-AR-03's caching subtle: state that is "per process" today has to be classified before a
  server is reused across requests.
- **Recommendation:** while doing AR-I1, compute `effectivePackages()` once per build. Move the
  counters into runtime parts or mark them process-scoped on purpose. Document the service
  locator in the runtime ADR (AR-I5).
- **Existing roadmap link:** none — new. Fold it into AR-I1.

## 5. Proposed roadmap items

| Temp id | Title                                                                | Findings           | Priority | Effort | tools/list   | Breaking         | Owner decision           |
| ------- | -------------------------------------------------------------------- | ------------------ | -------- | ------ | ------------ | ---------------- | ------------------------ |
| AR-I1   | Cache immutable server parts on the modern wire                      | RR-AR-03, RR-AR-11 | P1       | M      | 0 B          | no               | yes (isolation vs reuse) |
| AR-I2   | Size and complexity ratchet; refactor the top 5 functions            | RR-AR-01           | P1       | M      | 0 B          | no               | yes (thresholds)         |
| AR-I3   | Journal hardening: lock, lazy mirror, streaming reads, retention     | RR-AR-02           | P1       | M      | 0 B          | no (new env var) | yes (retention default)  |
| AR-I4   | Read-policy choke point in `snRequest` plus a read-tool sweep        | RR-AR-04           | P1       | M      | 0 B          | no               | no                       |
| AR-I5   | ARCHITECTURE.md 3.x rewrite with a drift check; technical ADRs 0013+ | RR-AR-05, RR-AR-06 | P1       | M      | 0 B          | no               | no                       |
| AR-I6   | SDK 2.4 bump, a `_wrapHandler` pin and a Dependabot cadence          | RR-AR-07           | P0       | S      | 0 B (verify) | no               | no                       |
| AR-I7   | Split `api/` into REST access and analysis domains, with zones       | RR-AR-08           | P2       | L      | 0 B          | no (internal)    | yes (big move)           |
| AR-I8   | Planning corpus compaction and a size budget                         | RR-AR-09           | P2       | S      | 0 B          | no               | yes (archive policy)     |
| AR-I9   | Export audit (knip) and pruning                                      | RR-AR-10           | P3       | S      | 0 B          | no               | no                       |

### AR-I1 — Cache immutable server parts on the modern wire

- **Scope:** `src/server.ts`, `src/mcp/registry.ts`, `src/mcp/http-modern.ts`,
  `src/mcp/prompts.ts`, `src/mcp/resources.ts`. Split `buildMcpServer` into
  `buildServerTemplate(configKey)`, which holds the tool definitions, JSON schemas, prompt and
  resource descriptors and the instructions in a memo keyed by the effective packages plus the
  config hash, and a per-request `bind(runtime, ctx)`. Call `effectivePackages()` once per build.
  Classify the module-level counters and singletons from RR-AR-11.
- **Acceptance criteria:**
  - A test shows the template is built once for N modern requests with the same config and is
    rebuilt when packages or config change.
  - A benchmark test shows the median per-request build is at least 5× below today's on the
    same machine.
  - All protocol, policy and `tools/list` byte tests stay green with an unchanged byte count.
  - No per-session or per-request state lives in the cached template (asserted by a test that
    runs two requests with different auth contexts).
- **Dependencies/gates:** owner decision 1. Do it before or together with any F5-29
  record-watch work on the modern wire.

### AR-I2 — Size and complexity ratchet; refactor the top 5 functions

- **Scope:** a new `scripts/complexity-report.mjs` (based on the TypeScript AST, like the review
  script), a `test/complexity-ratchet.test.js` and a committed baseline JSON. Refactor
  `securityScan`, `explainUiExperience`, `rawRequestInner`, `queryTable` and `compareInstances`
  into rule tables or phase functions. Extend N-88's file list with `api/ops.ts`,
  `mcp/resources.ts`, `mcp/prompts.ts` and `cli.ts`.
- **Acceptance criteria:**
  - The gate fails when a new function exceeds CC 25 or 120 lines, or a baselined one grows.
  - The baseline may only shrink, and the test prints the diff.
  - The five named functions each end at CC ≤ 30, with unchanged behaviour (existing tests
    green, no snapshot changes).
  - The count of files over 1,000 lines goes from 11 to ≤ 6.
- **Dependencies/gates:** merge into or sequence with N-88. Owner decision 5 sets the thresholds.
  Fix the F5-43 path (`src/core/http-util.ts`).

### AR-I3 — Journal hardening: lock, lazy mirror, streaming reads, retention

- **Scope:** `src/core/write-journal.ts`, `src/api/revert.ts`, and docs for a new
  `SN_JOURNAL_KEEP`. Add an advisory lock around head-read → append → head-write, with
  stale-lock recovery. Debounce the Markdown mirror or render it on read. Make reads stream
  newest-first with an early stop, and optionally keep an offset index. Add retention for
  rotated files. Move the append off the hot path or keep it sync but O(1) (no mirror rewrite).
- **Acceptance criteria:**
  - A two-process test (child processes appending concurrently to one journal) verifies an
    intact chain.
  - Append no longer reads the 1 MiB tail. A test asserts that the mirror is not rewritten on
    every append.
  - Reverting the newest entry in a journal with 10 rotated files reads only the current file
    (asserted by instrumenting fs).
  - Rotated files beyond `SN_JOURNAL_KEEP` are removed and the removal is itself journalled;
    chain verification treats the oldest kept file as the anchor.
- **Dependencies/gates:** owner decision 2 (retention default). Land it before O-23 bulk writes
  (N-67).

### AR-I4 — Read-policy choke point in `snRequest` plus a read-tool sweep

- **Scope:** `src/core/http.ts` (or a thin wrapper in `api/shared.ts`): derive the table from
  Table API and attachment paths and call `assertTableAllowed`. Add an explicit
  `bypassPolicy: "<reason>"` option, used only by `api/diagnostics.ts`. Add
  `test/policy-read-sweep.test.js`.
- **Acceptance criteria:**
  - Every read tool, called with fixtures under a policy that denies a sentinel table, makes no
    request whose path names that table.
  - A grep test lists every `bypassPolicy` use, and the list is reviewed (allow-list).
  - Existing per-site asserts stay in place (defence in depth), and error messages are
    unchanged.
- **Dependencies/gates:** none. 0 `tools/list` bytes.

### AR-I5 — ARCHITECTURE.md 3.x rewrite with a drift check; technical ADRs 0013+

- **Scope:** rewrite `project/ARCHITECTURE.md` (layers, runtime scopes, both HTTP wires, auth,
  tasks, skills, journal, policy, artifact registry, SDK hooks). Generate the countable facts
  through `docs:sync`. Write ADRs 0013–0020 for the decisions listed in RR-AR-06, and update the
  ADR README (O-1…O-25). Correct `src/api/AGENTS.md`.
- **Acceptance criteria:**
  - `npm run docs:sync -- --check` fails if the counts, version or package list in
    ARCHITECTURE.md drift.
  - The document no longer mentions Jira, "not implemented" OAuth or residual cycles.
  - Each new ADR has context, decision, consequences and a revisit trigger, and links to the
    code it governs.
- **Dependencies/gates:** none. After AR-I1, add its ADR.

### AR-I6 — SDK 2.4 bump, a `_wrapHandler` pin and a Dependabot cadence

- **Scope:** `package.json` (server 2.4.0, node 2.1.2, sdk 1.32.2, via Dependabot PR #30),
  `test/sdk-internals.test.js` (add `_wrapHandler`), CONTRIBUTING (cadence: triage Dependabot
  each release, merge or close within 14 days). Triage the other 9 open Dependabot PRs.
- **Acceptance criteria:**
  - The gate is green on 2.4.0 with an unchanged `tools/list` byte count (or a stated delta).
  - The pin test fails with a clear message if `_wrapHandler` disappears or changes arity.
  - No Dependabot PR older than 14 days remains open.
- **Dependencies/gates:** none. The bump itself is the risk check for all four private hooks.

### AR-I7 — Split `api/` into REST access and analysis domains, with zones

- **Scope:** move the files to `src/api/rest/*` and `src/analysis/{explain,docs,uib,domain,
dependencies,lint}/*`, using re-export shims for one release. Add ESLint zones:
  analysis may not import `core/http*` or `api/rest`, only injected readers. Update the layer
  AGENTS.md files and the cycle test.
- **Acceptance criteria:**
  - No file under `analysis/` imports a request helper (enforced by ESLint).
  - The import graph still has 0 cycles, and the public CLI and tool behaviour are unchanged.
  - Every folder has at most 25 files.
- **Dependencies/gates:** owner decision 3. Best done after AR-I2 and N-88, so that files move
  once.

### AR-I8 — Planning corpus compaction and a size budget

- **Scope:** move done roadmap rows and closed analyses into `project/archive/`. Keep
  `roadmap.yaml` notes to one line plus a link. Roll `WORKLOG.md` over each quarter (a
  local-only file). Add a script that reports the size of the live corpus.
- **Acceptance criteria:**
  - The live `project/` Markdown and YAML is under 400 KB.
  - `roadmap:status` output is unchanged.
  - The `project/README.md` index points to the archive.
- **Dependencies/gates:** owner decision 4.

### AR-I9 — Export audit (knip) and pruning

- **Scope:** add knip (dev-only) or `scripts/export-audit.mjs`. Remove `SKILL_SCHEME`. Delete
  `uploadAttachment` and move its tests to `uploadPrepared`. Un-export the clear
  own-file-only symbols in the top 20 files.
- **Acceptance criteria:**
  - The report runs in `check` and is a ratchet: the count can only fall.
  - The own-file-only count goes from 506 to ≤ 250.
  - There are 0 test-only duplicate implementations.
- **Dependencies/gates:** none. Watch `pack:check` (dev-only dependency, no effect).

## 6. Owner decisions needed

1. **Modern-wire server reuse (AR-I1).** Options:
   - (a) keep strict per-request construction
   - (b) cache the immutable template and bind per request
   - (c) pool whole servers per config key

   Recommendation: (b). It removes most of the cost while keeping per-request isolation of
   runtime and auth.

2. **Journal retention default (AR-I3).** Options:
   - (a) unlimited (today)
   - (b) keep N rotated files (for example 10, so about 200 MiB)
   - (c) keep by age (for example 90 days)

   Recommendation: (b), default 10, configurable, with the deletion recorded in the chain.

3. **Restructure `api/` (AR-I7).** Options:
   - (a) leave it flat and rely on N-88 splits
   - (b) a one-shot move with shims
   - (c) move gradually, folder by folder

   Recommendation: (b) after AR-I2, in a single batch with no feature work in parallel.

4. **Corpus archive policy (AR-I8).** Options:
   - (a) keep everything live
   - (b) archive done rows and closed analyses each release

   Recommendation: (b), with a 400 KB live budget.

5. **Complexity thresholds (AR-I2).** Options:
   - (a) CC 25 / 120 lines, ratchet only
   - (b) CC 20 / 80 lines
   - (c) report-only

   Recommendation: (a). It is strict enough to stop regrowth without forcing a big-bang
   refactor.

## 7. Metrics this role would track

| KPI                                                        | Current value                                              | Target                           |
| ---------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------- |
| Functions with 120+ lines / with CC ≥ 30                   | 49 / 30 (`fn.mjs`)                                         | ratchet down; ≤ 25 / ≤ 10 by 3.2 |
| Files over 1,000 lines                                     | 11                                                         | ≤ 6                              |
| Per-request build cost on the modern wire                  | about 48–64 ms (noisy, load average 82)                    | < 5 ms median                    |
| SDK lag behind the latest minor; oldest open Dependabot PR | 1 minor (2.3.1 vs 2.4.0); about 118 days                   | 0 minors; ≤ 14 days              |
| Architecture doc staleness                                 | ARCHITECTURE.md describes v2.0 (2026-07); 0 technical ADRs | drift-checked; ADRs 0013–0020    |
| Import cycles / layer-zone violations                      | 0 / 0                                                      | keep at 0                        |
