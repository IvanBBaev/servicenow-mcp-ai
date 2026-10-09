# 0008 — Full conformance with MCP protocol 2026-07-28, dual protocol (O-19)

- **Status:** accepted (the conformance target and sub-question (d); the N-9 fate and the end of
  the legacy window stay open)
- **Date:** 2026-10-10
- **Owner gate / ID:** O-19 (N-35; touches H-3, H-7, M-5, M-8, M-9, N-9, N-17, N-38, N-63)
- **Supersedes:** —
- **Superseded by:** —

## Context

MCP protocol revision 2026-07-28 introduces a stateless core (no `initialize`, no
`Mcp-Session-Id`), `server/discover`, `input_required` (MRTR), the `Mcp-Method` / `Mcp-Name`
headers, `ttlMs` / `cacheScope`, tasks as the `io.modelcontextprotocol/tasks` extension, CIMD in
place of DCR, and the rule that `tools/list` MUST NOT vary per connection. It deprecates Logging,
Sampling, Roots and HTTP+SSE ([PROTOCOL-BREAKING-REPORT-2026-10.md](../PROTOCOL-BREAKING-REPORT-2026-10.md)
§3, findings TK-01 … TK-05 in [TOKEN-DOCS-ANALYSIS-2026-10.md](../TOKEN-DOCS-ANALYSIS-2026-10.md)).

The server runs on `@modelcontextprotocol/sdk` 1.x, which stops at 2025-11-25 (TK-01). The open
risk in the report (§7) was whether the v2 split packages still negotiate the older revisions.
Checked on 2026-10-10 against `@modelcontextprotocol/server` / `core` 2.3.1 from npm: the README
states the package implements the 2026-07-28 spec, and `core` carries both
`SUPPORTED_PROTOCOL_VERSIONS` (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07) and
`FIRST_MODERN_PROTOCOL_VERSION = '2026-07-28'`. One dependency line can serve both wires.

The owner constraint from 2026-10-05 still holds: nothing breaks for an existing client
([PROTOCOL-BREAKING-REPORT-2026-10.md](../PROTOCOL-BREAKING-REPORT-2026-10.md) header).

## Decision

The owner decided on 2026-10-10 that **protocol 2026-07-28 is supported in full**. On a
connection that negotiates 2026-07-28 the server meets every MUST and SHOULD of that revision and
implements every feature in it that applies to a server: stateless request handling,
`server/discover`, `input_required` for confirmations, the `Mcp-Method` / `Mcp-Name` headers,
`ttlMs` / `cacheScope`, the tasks extension, and CIMD for HTTP authorization. It uses no
deprecated feature on that wire: no Logging notifications, no sampling, no roots.

**(d)** On the 2026-07-28 wire `tools/list` is fixed per server: packages come from
configuration (`SN_PACKAGES`, the profile), and `servicenow_find_tools` (N-36) finds tools without
changing the list. Runtime package toggles (M-5) stay for legacy connections only.

The legacy revisions (2025-11-25 and earlier) stay negotiated, with today's behaviour, under the
"nothing breaks" constraint. "Full support" is proven by tests, not claimed: N-35 adds a
conformance matrix that maps each normative requirement of the revision to a test.

Still open under O-19: the fate of N-9 (the report recommends dropping it) and when the legacy
revisions and the deprecated features end (a 4.0 breaking item at the earliest).

## Consequences

- N-35 is unblocked. Step 1 (the spike on a branch) now has the negotiation question answered by
  the package itself; it still has to show it with the spawn suite against both revisions.
- The migration replaces `@modelcontextprotocol/sdk` with `@modelcontextprotocol/server` /
  `core` 2.x. It is an import and API migration, not a version bump. It ships in a 3.x minor
  after 3.0, so 3.0 still carries B1–B13 only and no new breaking row.
- Every area that the report lists gets a dual path: HTTP (stateless + sessions, H-7),
  confirmations (MRTR + elicitation, H-3), logs (stderr and result `_meta` + the M-8 bridge),
  tasks (extension + experimental M-9), packages (configuration + M-5 toggles).
- N-17 is built on CIMD directly. N-38 cache hints follow the migration. N-63 is no longer
  gated on O-19 (d).
- The dual path costs code and test time until the legacy window closes; that removal is a
  future owner decision.

## Links

- [PROTOCOL-BREAKING-REPORT-2026-10.md](../PROTOCOL-BREAKING-REPORT-2026-10.md) — §3 impact per
  change, §4 the M-5 conflict, §6 order, §7 risks.
- [TOKEN-DOCS-ANALYSIS-2026-10.md](../TOKEN-DOCS-ANALYSIS-2026-10.md) — TK-01 … TK-05, N-35.
- [ROADMAP-V3.md](../ROADMAP-V3.md) — gate O-19; rows N-9, N-35, N-63.
- [TODO.md](../TODO.md) — round 9 owner decisions.
