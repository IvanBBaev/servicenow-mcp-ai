# 0009 — Drop N-9 sampling summaries (O-19, O-12 moot)

- **Status:** accepted
- **Date:** 2026-10-10
- **Owner gate / ID:** O-19 (the N-9 fate left open by ADR 0008); O-12
- **Supersedes:** —
- **Superseded by:** —

## Context

N-9 planned server-side summaries of large results through `sampling/createMessage`, behind
`SN_SAMPLING=1` and owner gate O-12 ([GAP-ANALYSIS-2026-10.md](../GAP-ANALYSIS-2026-10.md) N-9).
It was never built. MCP 2026-07-28 deprecates Sampling (TK-02 in
[TOKEN-DOCS-ANALYSIS-2026-10.md](../TOKEN-DOCS-ANALYSIS-2026-10.md)), and
[ADR 0008](0008-full-protocol-2026-07-28-conformance.md) rules out deprecated features on the
2026-07-28 wire. The protocol report recommends dropping it
([PROTOCOL-BREAKING-REPORT-2026-10.md](../PROTOCOL-BREAKING-REPORT-2026-10.md) §1, §3).

## Decision

The owner dropped N-9 on 2026-10-10. The server does not initiate sampling on any protocol
revision. O-12, which only asked how N-9 should behave, is moot.

## Consequences

- No client loses anything: nothing shipped.
- The N-9 row stays in the roadmap with the `dropped` status (⚫), so the row numbers and the
  history stay stable.
- Large results keep the existing paths: the result cap, file delivery (S-11, N-61) and the
  compact read options (N-62). A summary, if wanted, is the client model's job.
- Of O-19 only the end of the legacy protocol window stays open.

## Links

- [ROADMAP-V3.md](../ROADMAP-V3.md) — gates O-12 and O-19; row N-9; "Explicitly NOT in 3.0".
- [GAP-ANALYSIS-2026-10.md](../GAP-ANALYSIS-2026-10.md) — N-9 (kept for the record).
- [ADR 0008](0008-full-protocol-2026-07-28-conformance.md) — the conformance decision.
