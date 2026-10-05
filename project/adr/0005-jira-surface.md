# 0005 — The dark Jira Cloud surface (ARCH-14, O-1)

- **Status:** proposed — **deferred by the owner on 2026-10-01**; O-1 stays open.
- **Date:** 2026-10-01 (deferral); raised 2026-07-01
- **Owner gate / ID:** ARCH-14, owner gate O-1; implemented by E-8 (breaking row B10)
- **Supersedes:** —
- **Superseded by:** —

## Context

A Jira Cloud client scaffold was committed on 2026-07-03 (`ad2799c`): an HTTP client, config,
host guard and ADF marshalling under `src/core/jira/` and `src/api/jira/`, with no tools, no
package in the registry and no user documentation ([TODO.md](../TODO.md), "ARCH-14";
[ARCHITECTURE.md](../ARCHITECTURE.md) header).

The architect review framed it as a safety-rails question: Jira tools must ride the same rails
as the ServiceNow tools — the package axis (`SN_TOOL_PACKAGES` / `SN_PACKAGES_DENY` /
`SN_PACKAGES_READONLY`), `SN_READONLY`, plan / apply (`SN_WRITE_MODE`), the write journal and
DF-5 redaction — or the server's safety contract silently weakens for a whole system
([TODO.md](../TODO.md), "ARCH-14").

The business review framed it as a positioning decision: the business case is
ServiceNow-specific, Atlassian ships an official remote MCP server free for Cloud customers, and
finishing Jira costs the single maintainer weeks. It listed three options: **A** a separate
package on a shared core (preferred if Jira proceeds at all), **B** pause / cut (acceptable),
**C** fold into the main package (not recommended)
([BUSINESS-REVIEW-2026-07.md](../archive/BUSINESS-REVIEW-2026-07.md) §5).

## Decision

**Deferred** on 2026-10-01: no go / no-go yet. Until the owner decides, the Jira scaffold
**stays dark and untouched**, E-8 stays blocked and B10 stays out of the 3.0 register
([TODO.md](../TODO.md) "Decided 2026-10-01"; [DONE.md](../DONE.md) batch 17;
[0001](0001-approve-breaking-change-register.md)).

The rules that hold meanwhile ([ARCHITECTURE.md](../ARCHITECTURE.md) §11;
[ROADMAP-V3.md](../ROADMAP-V3.md) §E-8 and "Explicitly NOT in 3.0"):

- No Jira tools are exposed before ARCH-14 lands.
- If the answer is "go", Jira becomes a separate subordinate surface that reuses the same safety
  rails (package axis, plan / apply, write journal, redaction).
- The Jira build output is excluded from the published tarball (H-9's `files` negation, L9-04),
  and the twin clients are pinned by the parity test ([0004](0004-twin-http-clients.md)).

## Consequences

- O-1 remains an open owner gate in [ROADMAP-V3.md](../ROADMAP-V3.md) §O; E-8 and the shared
  engine of [0004](0004-twin-http-clients.md) wait for it.
- Breaking row B10 (remove the scaffold, only on NO-GO) is not part of the approved 3.0 register.
- The neutral `IntegrationError` base with `ServiceNowError` / `JiraError` siblings (ARCH-11b)
  shipped with M-2 regardless ([DONE.md](../DONE.md) batch 18).
- When O-1 is decided, a new accepted record supersedes this one and the decision moves to the
  roadmap gate line as a link.

## Links

- [TODO.md](../TODO.md) — "ARCH-14 · The Jira surface is dark and the safety rails are
  undecided" and "Decided 2026-10-01".
- [ARCHITECTURE.md](../ARCHITECTURE.md) — §11 "What is next architecturally".
- [ROADMAP-V3.md](../ROADMAP-V3.md) — O-1, §E-8, B10, "Explicitly NOT in 3.0".
- [BUSINESS-REVIEW-2026-07.md](../archive/BUSINESS-REVIEW-2026-07.md) — §5 "The Jira decision".
