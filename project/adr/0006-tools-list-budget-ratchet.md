# 0006 — `tools/list` budgets as data with a tightening ratchet; restated targets (O-10)

- **Status:** accepted (sub-questions (a) and (b); (c) and (d) stay open)
- **Date:** 2026-10-06
- **Owner gate / ID:** O-10 (N-0, N-57, N-58, N-63)
- **Supersedes:** —
- **Superseded by:** —

## Context

M-6 set `tools/list` targets of 45,000 B (`all`) and 14,000 B (`core`). The surface grew past them
batch by batch, and each batch raised hard-coded constants in the output-schema test
([TODO.md](../TODO.md), batch 10 decisions). The N-0 byte reclaim cut `all` from 150,916 to
135,881 B and `core` from 36,158 to 32,737 B through description text only, but the budget itself
waited for the owner ([ROADMAP-V3.md](../ROADMAP-V3.md) §O, O-10).

Round 9 ([TOKEN-OPTIMIZATION-PLAN-2026-10.md](../TOKEN-OPTIMIZATION-PLAN-2026-10.md) §6–§7) split
O-10 into four sub-questions:

- (a) budgets as data, with an automatic tightening ratchet;
- (b) restated targets, and the N-58 / N-63 wire changes;
- (c) shallow output schemas (N-60);
- (d) N-18 eval reference models and API budget.

Its §6 shows that the 45 KB `all` target would need more than 60 % further cuts through BREAKING
consolidation, while the lean serializer (N-58) alone takes `all` to about 119.5 KB.

## Decision

The owner decided **(a) and (b)** on 2026-10-06:

- **(a)** `tools/list` budgets are data in
  [`test/fixtures/token-budgets.json`](../../test/fixtures/token-budgets.json), one per surface
  profile. `npm run tokens:budget -- --write` only lowers them, and the ratchet test fails a budget
  that sits more than `slackPct` above its measurement. Raising a budget stays a hand edit and an
  owner decision.
- **(b)** The targets are restated: `discovery` (the default profile, N-63) ≤ 22 KB with a stretch
  of 14 KB; `all` ≤ 120 KB as a non-default profile, including N-54's output schemas. The 45 KB
  `all` target is retired. The N-58 lean serializer and the N-63 `discovery` profile may change
  the wire. N-58 lands first, and new opt-in tools then use the freed room within these targets.

Sub-questions **(c)** (shallow output schemas, N-60) and **(d)** (N-18 eval models and API
budget) are not decided and stay open under O-10.

## Consequences

- N-57 is settled in method: the budget file and ratchet that landed on 2026-10-05 are the
  accepted mechanism. Only `discovery` is left, and it joins with N-63.
- N-58 is unblocked: the lean serializer is wired into `tools/list`, the manifest and the schema
  description, and the budgets drop to the new measurements through the ratchet. Specs stay
  unchanged.
- The opt-in tools waiting for O-10 (N-1, N-2, N-5, N-7, N-15, N-16, N-22 and others) may land
  within the restated targets, each stating its byte delta. N-2 also still needs O-13.
- N-0 stops waiting for the budget restatement.
- Per-tool caps (N-57, `test/tool-size.test.js`) stay in force. With tool search in Claude Code the
  model pays per loaded tool, so they matter more than the profile totals.
- N-60 and N-18 stay gated on O-10 (c) and (d).

## Links

- [TOKEN-OPTIMIZATION-PLAN-2026-10.md](../TOKEN-OPTIMIZATION-PLAN-2026-10.md) — §6 projected
  budgets, §7 owner decisions.
- [ROADMAP-V3.md](../ROADMAP-V3.md) — gate O-10; rows N-0, N-57, N-58, N-63.
- [TODO.md](../TODO.md) — round 9 owner decisions.
- [`test/output-schema.test.js`](../../test/output-schema.test.js) and
  [`test/fixtures/token-budgets.json`](../../test/fixtures/token-budgets.json) — the budgets.
