# 0001 — Approve the 3.0 breaking-change register (O-4)

- **Status:** accepted
- **Date:** 2026-10-01
- **Owner gate / ID:** O-4 (breaking-change register B1–B13)
- **Supersedes:** —
- **Superseded by:** —

## Context

The v3.0 plan collects every incompatible change in a breaking-change register (B1–B13; B11–B13
were added by the 2026-09-09 gap pass). Owner gate O-4 required the owner to approve the register
before the 3.0 branch opened, and every BREAKING item (H-3 first) waited for it — see the
"O — Owner gates" and "Breaking-change register" sections of
[ROADMAP-V3.md](../ROADMAP-V3.md) and the "Owner decisions that gate v3.0" entry in
[TODO.md](../TODO.md).

Several items carried their own default questions that only O-4 could close, for example the H-3
plan-token default (`token` or `elicit`), the H-11 protected-table defaults and the H-4
`SN_BATCH_UNMAPPED` default ([TODO.md](../TODO.md), the H-3, H-11 and H-4 entries).

## Decision

O-4 is **approved**: the register B1–B13 ships in 3.0, **except B10**. B10 (remove the dark Jira
scaffold) applies only if ARCH-14 is a NO-GO, and ARCH-14 was deferred the same day
([0005](0005-jira-surface.md)), so B10 stays out and O-1 stays open
([ROADMAP-V3.md](../ROADMAP-V3.md) §O; [TODO.md](../TODO.md) "Decided 2026-10-01";
[DONE.md](../DONE.md) batch 17).

The defaults resolved under O-4, as recorded in [TODO.md](../TODO.md):

- H-3 / B4: `SN_DESTRUCTIVE_CONFIRM` defaults to `token` (`off` opts out).
- H-11 / B11: `SN_PROTECTED_TABLES_WRITE=deny` and the related write caps ship as defaults.
- H-4 / B8: `SN_BATCH_UNMAPPED=deny` and `SN_BATCH_MAX_REQUESTS=50` are the defaults.

## Consequences

- The BREAKING items were unblocked and landed locally: E-1 (B1), H-3 (B4), H-4 (B8) and H-11
  (B11) in batch 17 on 2026-10-01, M-2 (B3) and M-7 (B2 + B13) in batch 18 on 2026-10-02/03
  ([DONE.md](../DONE.md)).
- B10 and the fate of the Jira scaffold remain tied to O-1 / E-8 ([0005](0005-jira-surface.md)).
- The register remains the source of the CHANGELOG migration table at ship time
  ([ROADMAP-V3.md](../ROADMAP-V3.md)). A new breaking row (for example the proposed B14 in
  [TOKEN-OPTIMIZATION-PLAN-2026-10.md](../TOKEN-OPTIMIZATION-PLAN-2026-10.md)) is not covered by
  this approval and needs its own owner decision.

## Links

- [ROADMAP-V3.md](../ROADMAP-V3.md) — "O — Owner gates" (O-4) and "Breaking-change register".
- [TODO.md](../TODO.md) — "Owner decisions that gate v3.0", "Decided 2026-10-01", and the
  "Resolved 2026-10-01 (O-4 approved)" notes on H-3, H-11 and H-4.
- [DONE.md](../DONE.md) — batch 17 (2026-10-01) and batch 18 (2026-10-02 / 03).
