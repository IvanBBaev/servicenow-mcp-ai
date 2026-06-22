# TODO — status as of 2026-06-19

> **No active/actionable dev work remains.** Everything completed is in [DONE.md](DONE.md) — the
> morning review (22/22), Phases 6–8, the four full-review passes, **Phase 8** (the `flows`,
> `codecheck` and `atf` packages — 65 tools / 18 packages) and **full ServiceNow authentication
> coverage** (OAuth 2.1 Authorization Code + PKCE login, JWT bearer, API key, bearer token, `none`,
> mutual TLS). Gate green at **236 tests**. What is left below is **not pending dev work**: a
> trigger-gated deferred backlog and one owner action.
>
> Marker key — ⏳ **deferred** (activates only when its trigger fires) · 👤 **owner action**
> (needs Ivan, not a dev task).
>
> Planned next: **Phase 9 — competitive differentiators (DF-0…DF-6)** in
> [ROADMAP.md](ROADMAP.md) (see [COMPETITIVE-ANALYSIS.md](COMPETITIVE-ANALYSIS.md) for the "why");
> "Optional" items (Export API, PDI e2e, vitest) on request. The work chronology is in
> [WORKLOG.md](WORKLOG.md).

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
  `io.github.LeassTaTT/servicenow-mcp-ai → 2.0.0`. Repo public, `NPM_TOKEN` bound.
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
