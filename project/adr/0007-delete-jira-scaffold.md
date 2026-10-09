# 0007 — Delete the dark Jira scaffold (O-1 NO-GO)

- **Status:** accepted
- **Date:** 2026-10-09
- **Owner gate / ID:** O-1 (ARCH-14, ARCH-10); implemented by E-8, breaking row B10
- **Supersedes:** [0004](0004-twin-http-clients.md), [0005](0005-jira-surface.md)
- **Superseded by:** —

## Context

The Jira Cloud client scaffold (HTTP client, config, host guard and ADF marshalling under
`src/core/jira/` and `src/api/jira/`) had been dark since 2026-07-03: no tools, no package and no
user documentation. O-1 was deferred on 2026-10-01 ([0005](0005-jira-surface.md)), which kept a
second copy of the request loop alive behind a parity test ([0004](0004-twin-http-clients.md))
and held E-8 and the `snRequest` part of E-7 open ([ROADMAP-V3.md](../ROADMAP-V3.md) §E-7, §E-8).

The business review had already rated "pause / cut" as acceptable: the business case is
ServiceNow-specific and Atlassian ships its own remote MCP server
([BUSINESS-REVIEW-2026-07.md](../archive/BUSINESS-REVIEW-2026-07.md) §5).

## Decision

**NO-GO**, decided by the owner on 2026-10-09: the scaffold is deleted. `src/core/jira/`,
`src/api/jira/`, the `JiraError` class and the Jira-only tests (including the twin parity test)
are removed. ServiceNow keeps the single client in [`src/core/http.ts`](../../src/core/http.ts);
there is no shared request engine to build.

## Consequences

- B10 joins the 3.0 breaking register. No user-visible surface changes: no tool, setting or
  documented export referred to Jira.
- ARCH-10 is closed without a shared engine; the E-7 `snRequest` item closes with it.
- ARCH-11b keeps the neutral `IntegrationError` base; `ServiceNowError` is its only subclass.
- ARCH-12b (per-system `JIRA_*` transport overrides) is moot.
- The tarball guards that exclude any `jira/` directory (`package.json` `files`,
  `scripts/pack-check.mjs`, `scripts/mcpb-pack.mjs`) stay in place as harmless tripwires.
- A future Jira integration starts from a new record and must ride the same safety rails as the
  ServiceNow tools.

## Links

- [ROADMAP-V3.md](../ROADMAP-V3.md) — O-1, §E-8, §E-7, B10.
- [TODO.md](../TODO.md) — "ARCH-10", "ARCH-11b", "ARCH-12b", "ARCH-14".
- [0004](0004-twin-http-clients.md), [0005](0005-jira-surface.md) — the superseded records.
