# TODO — status as of 2026-07-02

> **No active/actionable dev work remains.** Everything completed is in [DONE.md](DONE.md) — the
> morning review (22/22), Phases 6–8, five full-review passes, **Phase 9 / v2.0** (DF-0…DF-6
> trust + depth + reach; published 2026-06-22 — npm `servicenow-mcp-ai` now at 2.0.1, MCP
> Registry, Claude Code plugin, VS Code extension 2.0.1), **full ServiceNow authentication
> coverage** (OAuth 2.1 Authorization Code + PKCE login, JWT bearer, API key, bearer token, `none`,
> mutual TLS) and the 2026-07-01 → 02 gap sweep (GA-1…GA-6). Gate green at **380 tests**
> (coverage 95.29/84.36/98.56, audit 0). What is left below is **not pending dev work**: deferred
> design decisions on the uncommitted Jira WIP (ARCH-10/11b/12b/14), a trigger-gated backlog and
> owner actions (GA-8 distribution, DX-3 GIF, GA-9 PDI e2e).
>
> Marker key — ⏳ **deferred** (activates only when its trigger fires) · 👤 **owner action**
> (needs Ivan, not a dev task).
>
> Next moves are owner decisions, not dev tasks — see
> [BUSINESS-REVIEW-2026-07.md](BUSINESS-REVIEW-2026-07.md) §7 + §8.4 (the two-week plan) and
> [UX-REVIEW-2026-07.md](UX-REVIEW-2026-07.md) §11 (the UX backlog); "Optional" items (Export
> API, PDI e2e, vitest) on request. The work chronology is in [WORKLOG.md](WORKLOG.md).

## Full review (2026-06-16 → 17) — architect → dev → qa

> Fresh `/full-review` pass over the whole tree on top of the 1.0.0 release, then a follow-up that
> closed **every** remaining finding. **All fixed and moved to [DONE.md](DONE.md):** ARCH-3
> (`fetchAll` truncation made visible in snapshot/compare), DEV-5 (stale cache comment),
> QA-18/QA-19 (tests locking the `truncated` contract), ARCH-4 (unified `result`-envelope unwrap
> across every API module), ARCH-5 (the Batch API now obeys the package axis — a batch can no longer
> reach a denied plugin API or write to a read-only package), and the two former "won't-fix"
> security decisions, now hardened: SEC-7 (`.env` written `0600`) and SEC-8 (a host must be
> `*.service-now.com` unless `SN_ALLOWED_HOSTS` is set). No deferred review items remain.

## Owner action

- ✅ **R-2 · Publish 2.0.0 — done (2026-06-22).** Tagged `v2.0.0` → `publish.yml` re-ran the gate
  (303 tests) and `npm publish --provenance --access public` → `publish-mcp.yml` registered the
  listing. Live: npm `servicenow-mcp-ai@2.0.0` (the `latest` tag) and MCP Registry
  `io.github.IvanBBaev/servicenow-mcp-ai → 2.0.0`. Repo public, `NPM_TOKEN` bound.
- 👤 **DX-3 · screen-capture GIF** — the only remaining manual piece; the demo scenario itself
  already ships in the README and the docs site (see [ROADMAP-V2.md](ROADMAP-V2.md)).

## Full review (2026-06-18) — architect → dev → qa (3 cycles)

> Fresh `/full-review 3` pass. **All findings fixed and moved to [DONE.md](DONE.md):** ARCH-6
> (Markdown render dedup; snapshot/compare `|`-escaping drift closed), ARCH-7 (per-profile auth — the
> MI-1 `_AUTH`/`_OAUTH_*` convention now actually works), ARCH-8 (the `fetchAll`/`SN_MAX_RECORDS`
> truncation signal now reaches `servicenow_query_table`), DEV-6 + DEV-7 (caret-injection guards on
> `describeTable` and `generateTableFlow`), QA-21 + QA-22 (change/cmdb read/update + meta-cache paths
> pinned) and QA-20 (the coverage gate now fails clearly on Node ≥ 25 via `scripts/coverage-guard.mjs`
> instead of a cryptic yargs crash; `npm run verify` is the coverage-free path there). No open items.

## Full review (2026-07-01) — architect → dev → qa (scope: the uncommitted Jira integration)

### ARCHITECT REVIEW (2026-07-01)

> **ARCH-9, ARCH-11, ARCH-12, ARCH-13 fixed and moved to [DONE.md](DONE.md)** (shared
> `resolveHostWithPolicy` SSRF guard, `JiraError`, shared-knob docstrings, `parseTotalCount` back in
> `http.ts`). Gate green: 358 tests, coverage 95.22/84.07/98.56, audit 0. What remains below are the
> deferred design decisions.

- 👤 **ARCH-10 · The request/retry loop is duplicated between the twin HTTP clients.**
  `src/core/http.ts:127-265` and `src/core/jira/http.ts:134-252` copy the ~120-line engine
  (transport catch → idempotence gate → status retry → error parse → telemetry → json/binary tail);
  `http-util.ts` shares only the policy primitives. The `http-util.ts` header documents the split
  as deliberate ("the two callers differ only in host resolution, auth and error-body shape").
  Unifying into a hook-parameterised engine (~7 hooks: per-attempt auth, 401-retry, dispatcher,
  error extractor, total-count, labels) reverses that documented choice — **owner decision**. The
  two concrete drifts already visible (SN builds `AbortSignal.timeout` before the semaphore slot;
  SN lacks the `?`-join guard) are handled as DEV findings in this review.
- 👤 **ARCH-11b · Fuller error-taxonomy rename.** `JiraError extends ServiceNowError` is in; a
  neutral base class (+ `snDetail` → a generic key in `mcp/result.ts`) is a public-contract change
  — **owner decision**.
- 👤 **ARCH-12b · Per-system `JIRA_*` transport overrides.** Jira currently rides
  `SN_TIMEOUT_MS`/`SN_MAX_RETRIES`/`SN_MAX_CONCURRENT` (now documented in `settings.ts`). Splitting
  the config surface per system is an owner decision.
- 👤 **ARCH-14 · The Jira surface is dark and the safety rails are undecided.** `api/jira/`
  contains only `shared.ts`; no domain modules, no tools, no `jira` package in the registry, no
  ARCHITECTURE.md/README mention. When Jira tools land they must ride the same rails as ServiceNow
  tools — the package axis (`SN_TOOL_PACKAGES`/`SN_PACKAGES_DENY`/`SN_PACKAGES_READONLY`),
  `SN_READONLY`, plan/apply (`SN_WRITE_MODE`), the write journal and DF-5 redaction — or the
  server's safety contract silently weakens for a whole system. Design decision for the owner
  before the tool layer is built; the docs update belongs to that change, not this review. The
  business framing (options matrix, the bridge-MVP case, the Atlassian comparator) is in
  [BUSINESS-REVIEW-2026-07.md](BUSINESS-REVIEW-2026-07.md) §5 and §8.2.

### DEV REVIEW (2026-07-01)

> **DEV-8, DEV-9, DEV-10 fixed and moved to [DONE.md](DONE.md)** (timeout signal now created
> inside the semaphore slot in `snRequest`; the `?`-join guard added to `snRequest`; `jiraRequest`
> rejects reserved headers in `extraHeaders`). The 503-retry tightening and the `Retry-After` cap
> that ship with this change were reviewed and confirmed correct (pinned by tests). Gate green:
> 358 tests, coverage 95.19/84.01/98.56, audit 0. Nothing deferred.

### QA REVIEW (2026-07-01)

> **QA-23, QA-24, QA-25, QA-26, QA-27 fixed and moved to [DONE.md](DONE.md)** — all five were test
> gaps, no product bugs: the `JiraError` contract pinned (name, inheritance, status/detail), the
> `snRequest` `?`-join guard tested, the reserved-`extraHeaders` rejection tested (was uncovered),
> the Jira per-host telemetry breakdown tested, and the `message` error-body fallback covered.
> Gate green — see the gate line in DONE.md. Nothing deferred.

## Gap analysis (2026-07-01) — ruthless sweep: product · code · CI/tests · docs

> Two parallel code sweeps plus a manual verification pass on top of the 2026-07-01 gate
> (358 tests, coverage 95.19/84.01/98.56, audit 0). The heavy code claims were **verified
> false** (probeTable error isolation, the flows caret guard, the OAuth login timeout and
> per-instance schema-cache keying are all fine) — the codebase itself is sound; the real
> gaps are product-side and in CI/test hygiene. Jira findings are already tracked as
> ARCH-10/11b/12b/14 above and are not duplicated here.

### Actionable

> **GA-1 … GA-6 fixed and moved to [DONE.md](DONE.md) (2026-07-02):** dependabot (npm root +
> `extension/` + github-actions, weekly), the CodeQL workflow, the extension 2.0.1 bump + the
> version-sync gate in `publish-vscode.yml`, lint/format on the Windows CI leg, dedicated unit
> tests for `core/policy.ts` / `core/write-journal.ts` (+ the missing `parseRedirect` edges in
> `oauth.test.js`), and the env-docs sync test (`test/env-docs-sync.test.js`, with an ARCH-14
> dark-surface exception that self-destructs once `JIRA_*` is documented). `.env.example`
> gained `SN_OAUTH_JWT_KID`, `SN_OAUTH_JWT_EXP_SEC`, `SN_CODESEARCH`. Gate green: **380 tests**
> (+17), coverage 95.29/84.36/98.56, audit 0. Nothing actionable remains from this sweep.

### Deferred (trigger-gated)

- ⏳ **GA-7 · Batch `PACKAGE_BY_PATH` is a static list.** _trigger: a new plugin API is
  added to any package._ An unknown `/api/...` sub-request path falls back to
  table-only policy (`api/batch.ts`); when a new plugin API lands, its path must be
  added to the map in the same change — add a manifest-vs-map pin test then.

### Owner actions

- 👤 **GA-8 · Distribution / adoption.** 1 star · 0 forks · 0 issues · 63 unique
  visitors in 2 weeks · ~939 npm downloads/month (mostly mirrors). The supply side
  (npm, registry, marketplace, docs site, badges) is done; the demand side is
  untouched: the DX-3 GIF (still the only open roadmap item), community posts (sndevs
  Slack, community.servicenow.com, r/servicenow, LinkedIn) and a comparison post
  distilled from COMPETITIVE-ANALYSIS.md. Also pending: the stale
  `io.github.LeassTaTT` registry duplicates.
- 👤 **GA-9 · PDI e2e nightly.** The whole suite is mock-fetch; nothing proves the
  server against a live instance. Listed as "on request" in ROADMAP; recommendation:
  promote it — it is the strongest missing evidence for a project whose thesis is
  "knows your instance". Needs a PDI + credentials (owner).

## Deferred backlog (trigger-gated — not active work)

- ⏳ **A2-2 · ConfigStore covers only credentials.** _trigger: MI-1 follow-up (Phase 7)._
  Policy/settings read env per call — deliberate (see A-2); the profile store will unify them;
  until then new settings go through `settings.ts` only.
- ⏳ **A2-3 · Global singletons.** _trigger: "when it hurts" — not earlier._ The token/schema/plugin
  caches and telemetry have `clear*` hooks instead of injection. Fine for one process; if multiple
  servers ever share a process (tests do!), state is shared. _Solution:_ a container object created
  at bootstrap — when it hurts, not before.
- ⏳ **A2-4 · Bootstrap will fork at X-8.** _trigger: an X-8 request_ (HTTP transport) — extract the
  choice into `mcp/transport.ts` when X-8 is requested; not pre-emptively.
- ⏳ **A2-5 · Resource errors are JSON content.** _trigger: MCP protocol evolution_ (the protocol has
  no `isError` for resources) — a client cannot tell an error from data. Known; documented in
  ARCHITECTURE.
