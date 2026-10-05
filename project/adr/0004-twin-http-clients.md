# 0004 — Twin HTTP clients and the parity drift guard (ARCH-10)

- **Status:** proposed — not decided by the owner; the interim rule below applies. It resolves
  together with ARCH-14 / O-1 in E-8.
- **Date:** 2026-07-01 (raised in the architect review); recorded here 2026-10-05
- **Owner gate / ID:** ARCH-10; settled by O-1 through E-8
- **Supersedes:** —
- **Superseded by:** —

## Context

The ServiceNow client [`src/core/http.ts`](../../src/core/http.ts) and the dark Jira client
[`src/core/jira/http.ts`](../../src/core/jira/http.ts) each carry a copy of the ~120-line request
loop (transport catch → idempotence gate → status retry → error parse → telemetry → JSON / binary
tail). [`src/core/http-util.ts`](../../src/core/http-util.ts) shares only the policy primitives,
and its header documents the split as deliberate: the two callers differ in host resolution,
auth and error-body shape. Unifying them into a hook-parameterised engine (~7 hooks) would
reverse that documented choice, so the 2026-07-01 architect review left it as an **owner
decision** ([TODO.md](../TODO.md), "ARCH-10").

The loop had already drifted twice (the timeout signal created before the concurrency slot; a
double `?` in the query join), both fixed as DEV-8 / DEV-9 ([TODO.md](../TODO.md), "DEV REVIEW
(2026-07-01)"). The 2026-09 deep review measured the twins as ~55 % identical, with drift pinned
only by a test ([DEEP-REVIEW-2026-09.md](../archive/DEEP-REVIEW-2026-09.md), finding A1).

Two options are on record ([ARCHITECTURE.md](../ARCHITECTURE.md) §11):

- **Option L** — keep the twins and pin the behaviour that must stay identical with a parity
  test.
- **Option E** — a shared hook-parameterised HTTP engine for both clients.

## Decision

Not yet decided. **In force until the owner decides:** Option L. The parity test
[`test/http-twin-parity.test.js`](../../test/http-twin-parity.test.js) is the shipped drift
guard; it runs one scenario against both clients so a third divergence fails the gate. Option E
is built **only if ARCH-14 lands as "build"** — do not unify speculatively
([ARCHITECTURE.md](../ARCHITECTURE.md) §11).

E-8 records both outcomes ([ROADMAP-V3.md](../ROADMAP-V3.md) §E-8):

- **GO** (ARCH-14 = build) → extract `runRequestLoop(hooks)` into `http-util.ts` and delete the
  parity test.
- **NO-GO** → delete `src/core/jira/`, `src/api/jira/` and the parity test in the major (B10).

## Consequences

- The duplication stays, guarded by the parity test; the remaining part of E-7 code health
  (`snRequest`) waits for E-8 ([ROADMAP-V3.md](../ROADMAP-V3.md) §E-7).
- O-1 was deferred on 2026-10-01 ([0005](0005-jira-surface.md)), so this record stays proposed.
  When O-1 is decided, a new accepted record supersedes this one.

## Links

- [TODO.md](../TODO.md) — "ARCH-10 · The request/retry loop is duplicated between the twin HTTP
  clients."
- [ARCHITECTURE.md](../ARCHITECTURE.md) — §11 "What is next architecturally".
- [ROADMAP-V3.md](../ROADMAP-V3.md) — §E-8 "ARCH-14 / ARCH-10 resolution", O-1.
- [DEEP-REVIEW-2026-09.md](../archive/DEEP-REVIEW-2026-09.md) — finding A1.
- [`test/http-twin-parity.test.js`](../../test/http-twin-parity.test.js).
