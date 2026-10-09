# project/adr/ — decision records

An **architecture decision record (ADR)** is a short, dated note that captures one decision: the
context that forced it, what was decided, its status and its consequences. This folder is the
committed home for decisions that were previously spread over [`TODO.md`](../TODO.md), roadmap
rows and analyses (finding TK-20 in
[TOKEN-DOCS-ANALYSIS-2026-10.md](../TOKEN-DOCS-ANALYSIS-2026-10.md), roadmap item N-44).

## Conventions

- **File name:** `NNNN-kebab-title.md`. `NNNN` is a zero-padded, never-reused sequence number;
  the title is a few lowercase words joined by hyphens. Copy
  [`0000-template.md`](0000-template.md) to start a new record.
- **Statuses:**
  - **proposed** — written up, but the owner has not decided, or has explicitly deferred the
    decision. The record states what is in force until then.
  - **accepted** — decided by the owner; the record names the date and the source of the
    decision.
  - **superseded** — replaced by a later record. The old record keeps its text, gains a
    `Superseded by` link, and the new record links back with `Supersedes`.
- **Immutability:** an accepted record is not rewritten. A changed decision gets a new record that
  supersedes the old one. Fixing a typo or a broken link is fine.
- **Facts only:** every claim cites its source in the repository with a relative link.

## Relation to owner gates

The owner gates O-1 … O-22 are tracked in the "O — Owner gates" section of
[ROADMAP-V3.md](../ROADMAP-V3.md) (O-5 … O-9 are defined in [SDK-PARITY.md](../SDK-PARITY.md) §7),
and the open questions behind them wait in [TODO.md](../TODO.md).

- A gate gets an ADR **when it is decided**. Open gates do not get a record; their question stays
  in the roadmap and TODO.md.
- The roadmap gate line links to the ADR instead of restating the decision.
- The `ARCH-` decisions from [ARCHITECTURE.md](../ARCHITECTURE.md) and TODO.md are imported here
  as well. An `ARCH-` decision that is still open is recorded as **proposed**, with its current
  (deferred) state, because the interim rule is itself load-bearing.
- Owner decisions that are not numbered gates (for example S-12) may get a record too.

## Index

| ADR                                                         | Title                                                         | Status                          | Source                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- | ------------------------------------------- |
| [0001](0001-approve-breaking-change-register.md)            | Approve the 3.0 breaking-change register (O-4)                | accepted 2026-10-01             | ROADMAP-V3.md §O, TODO.md, DONE.md batch 17 |
| [0002](0002-servicenow-sdk-exact-dev-dependency.md)         | `@servicenow/sdk` 4.12.2 exact as a dev dependency (O-7)      | accepted 2026-10-01             | ROADMAP-V3.md §O, SDK-PARITY.md §7, P-29    |
| [0003](0003-acorn-runtime-parser.md)                        | `acorn` as a runtime parser dependency (S-12)                 | accepted 2026-10-01             | ROADMAP-V3.md §S-12, TODO.md, DONE.md       |
| [0004](0004-twin-http-clients.md)                           | Twin HTTP clients and the parity drift guard (ARCH-10)        | superseded by 0007             | TODO.md, ARCHITECTURE.md §11                |
| [0005](0005-jira-surface.md)                                | The dark Jira Cloud surface (ARCH-14, O-1)                    | superseded by 0007             | TODO.md, ARCHITECTURE.md §11, ROADMAP E-8   |
| [0006](0006-tools-list-budget-ratchet.md)                   | `tools/list` budgets as data; restated targets (O-10 (a)+(b)) | accepted 2026-10-06 (part)      | ROADMAP-V3.md §O, TOKEN-OPTIMIZATION-PLAN §7 |
| [0007](0007-delete-jira-scaffold.md) | Delete the dark Jira scaffold (O-1 NO-GO) | accepted 2026-10-09 | ROADMAP-V3.md §O, §E-8, B10 |
| [0008](0008-full-protocol-2026-07-28-conformance.md) | Full MCP 2026-07-28 conformance, dual protocol (O-19) | accepted 2026-10-10 (part) | ROADMAP-V3.md §O, PROTOCOL-BREAKING-REPORT |

Open gates without a record (as of 2026-10-10): O-2, O-3,
O-5, O-6, O-8, O-9, O-11 … O-22; O-10 (c) and (d) stay open under 0006; the rest of O-19 stays open under 0008.
