# TODO — status as of 2026-06-15

> **No active/actionable dev work remains.** Everything completed has been moved to
> [DONE.md](DONE.md) — the morning review (22/22), Phase 6, Phase 7 core, both full-review
> passes (2026-06-13), the QA backlog, the `servicenow-mcp-ai` rename and the release process.
> What is left below is **not pending dev work**: a trigger-gated deferred backlog, one owner
> action, and the standing won't-fix decisions.
>
> Marker key — ⏳ **deferred** (activates only when its trigger fires) · 👤 **owner action**
> (needs Ivan, not a dev task) · `[~]` **won't-fix** (decided, no code change).
>
> Not-yet-started feature work lives in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)
> (Phase 7 multi-instance follow-ups, Phase 8 flow testing + code analysis, "Optional");
> the work chronology is in [WORKLOG.md](WORKLOG.md).

## Owner action

- 👤 **R-2 · First real CI run + publish secret.** The remote is connected
  (`github.com/LeassTaTT/servicenow-mcp`); **4 local commits are not yet pushed.** _Needs Ivan:_
  push, then check the first Actions run in the browser (no `gh`/token on this machine) — if the
  Windows job is green, drop its `continue-on-error` — and add the `NPM_TOKEN` repo secret before
  the first publish.

## Deferred backlog (trigger-gated — not active work)

- ⏳ **A2-2 · ConfigStore covers only credentials.** _trigger: MI-1 follow-up (Phase 7)._
  Policy/settings read env per call — deliberate (see A-2); the profile store will unify them;
  until then new settings go through `settings.ts` only.
- ⏳ **A2-3 · Global singletons.** _trigger: "when it hurts" — not earlier._ The token/schema/plugin
  caches and telemetry have `clear*` hooks instead of injection. Fine for one process; if multiple
  servers ever share a process (tests do!), state is shared. _Solution:_ a container object created
  at bootstrap — when it hurts, not before.
- ⏳ **A2-4 · Bootstrap will fork at Х-8.** _trigger: an Х-8 request_ (HTTP transport) — extract the
  choice into `mcp/transport.ts` when Х-8 is requested; not pre-emptively.
- ⏳ **A2-5 · Resource errors are JSON content.** _trigger: MCP protocol evolution_ (the protocol has
  no `isError` for resources) — a client cannot tell an error from data. Known; documented in
  ARCHITECTURE.

## Decisions (won't-fix) — no code change

- [~] **`.env` is written with mode 0644 (readable by every local user).** Skipped — not a problem
  (owner's decision). `config.ts` `writeFileSync` uses the default mode; the file holds a plaintext
  password. → If ever needed: `{ mode: 0o600 }` on write + `chmodSync` for an existing file.
- [~] **`servicenow_set_credentials` allows redirecting Basic auth to an arbitrary host.** Skipped —
  not a problem (owner's decision). The SSRF guard for internal/loopback hosts and `SN_ALLOWED_HOSTS`
  stay active; Х-2 (elicitation) adds client-side confirmation. → If ever needed: require the host to
  end in `.service-now.com` without an explicit opt-in.

> Note (from R-9): if the release ever goes **public**, revisit the two won't-fix decisions above —
> for third-party users the conservative defaults should win; for personal use they remain OK.
