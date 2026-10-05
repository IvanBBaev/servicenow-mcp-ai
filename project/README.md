# project/ — planning corpus index

This folder holds the planning and analysis documents behind servicenow-mcp. It is the map of
the folder: what each document is for, whether it is still live, and which ID ranges it owns.
When you add a document, add a row here. When you mint a new ID prefix, check the table first
so that the prefix is not already taken.

**Start here:** [`ROADMAP-V3.md`](ROADMAP-V3.md) is the single tracker. Every live analysis
feeds items into it, and owner decisions wait in [`TODO.md`](TODO.md).

Status legend:

- **live** — kept current and referenced by the tracker.
- **reference** — stable background. Read it for context; it is not updated batch by batch.
- **historical** — superseded or completed. Every finding has been folded into the tracker.
  Kept for provenance only.

## Live documents

| Document                                                                     | Purpose                                                                                                                                 | IDs it owns                                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`ROADMAP-V3.md`](ROADMAP-V3.md)                                             | The tracker: pillars, the sequencing table, owner gates and the breaking register.                                                      | Pillar items `H-`, `M-`, `S-`, `D-`, `E-`, `P-`, `N-`; owner gates O-1…O-22; breaking B1–B13    |
| [`roadmap.yaml`](roadmap.yaml)                                               | Machine-readable rows of the ROADMAP-V3.md sequencing table (see [below](#roadmapyaml)).                                                | — (mirrors ROADMAP-V3.md)                                                                        |
| [`TODO.md`](TODO.md)                                                         | Open owner decisions and their context.                                                                                                 | —                                                                                                |
| [`GAP-ANALYSIS-2026-10.md`](GAP-ANALYSIS-2026-10.md)                         | Gap analysis, October 2026 (round 1 onwards): new capabilities beyond the 3.0 roadmap.                                                  | Findings NX-01…NX-35; items N-0…N-24; elevation EL-0…EL-5                                        |
| [`UIB-ANALYSIS-2026-10.md`](UIB-ANALYSIS-2026-10.md)                         | UI Builder / Next Experience analysis.                                                                                                  | Findings UX-01…UX-24; items N-25…N-34; gate O-18                                                 |
| [`TOKEN-DOCS-ANALYSIS-2026-10.md`](TOKEN-DOCS-ANALYSIS-2026-10.md)           | Token economy, docs pipeline and agent-harness analysis.                                                                                | Findings TK-01…TK-33; items N-35…N-56; gates O-19…O-22                                           |
| [`TOKEN-OPTIMIZATION-PLAN-2026-10.md`](TOKEN-OPTIMIZATION-PLAN-2026-10.md)   | Implementation-ready token optimisation plan (proposes breaking item B14).                                                              | Findings TK-34…TK-51; items N-57…N-65                                                            |
| [`PROTOCOL-BREAKING-REPORT-2026-10.md`](PROTOCOL-BREAKING-REPORT-2026-10.md) | Owner report: protocol 2026-07-28 impact (O-19) and the breaking register, non-breaking options. | — |
| [`SDK-PARITY.md`](SDK-PARITY.md)                                             | The ServiceNow SDK / Fluent parity epic: detailed plan behind the `P-` pillar.                                                          | P-1…P-29 (detail); gates O-5…O-9                                                                 |
| [`adr/`](adr/README.md) | Architecture decision records: one per decided owner gate, plus the imported `ARCH-10` / `ARCH-14` (N-44). | ADR numbers `0001`… (`NNNN-kebab-title.md`) |

## Reference documents

| Document                                                 | Purpose                                                                                                          | IDs it owns                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                     | Architecture description and decisions (dated 2026-07-06; the code has moved on since).                          | `ARCH-` decisions (e.g. ARCH-14) |
| [`FOOTPRINT.md`](FOOTPRINT.md)                           | Package and install footprint measurements behind D-5.                                                           | —                                 |
| [`COMPETITIVE-ANALYSIS.md`](COMPETITIVE-ANALYSIS.md)     | Competitor landscape and differentiators.                                                                        | DF-1…DF-6; risks R1–R7            |
| [`ROADMAP.md`](ROADMAP.md)                               | Original forward view built on the differentiators.                                                              | DF-0…DF-6 (plan view)             |
| [`DONE.md`](DONE.md)                                     | Completion log: what shipped, batch by batch. Append-only history, so it never goes to the archive.             | —                                 |

## Historical documents

| Document                                                                        | Purpose                                                                     | IDs it owns                                                     |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`ROADMAP-V2.md`](archive/ROADMAP-V2.md)                                                | Second roadmap; fully shipped and superseded by ROADMAP-V3.md.              | DX-1…DX-3 (and DF- references)                                  |
| [`IMPLEMENTATION-PLAN.md`](archive/IMPLEMENTATION-PLAN.md)                              | Early implementation plan (carries a frozen HISTORICAL banner).             | X-1…X-8, FT-1…FT-7, K-1…K-8, MI-1…MI-8                          |
| [`BUSINESS-ANALYSIS-V2.md`](archive/BUSINESS-ANALYSIS-V2.md)                            | Business analysis, second pass.                                             | Risks B1–B7 (**clash**: not the breaking register B1–B13)      |
| [`BUSINESS-REVIEW-2026-07.md`](archive/BUSINESS-REVIEW-2026-07.md)                      | Business review, July 2026.                                                 | GA-1…GA-9                                                       |
| [`UX-REVIEW-2026-07.md`](archive/UX-REVIEW-2026-07.md)                                  | Developer-experience review, July 2026.                                     | DX backlog entries                                              |
| [`DEEP-REVIEW-2026-09.md`](archive/DEEP-REVIEW-2026-09.md)                              | Deep code and security review, September 2026; §8 maps findings to items.   | SEC-01…SEC-24, C-1…C-12, F-1…F-6                                |
| [`GAP-ANALYSIS-2026-09.md`](archive/GAP-ANALYSIS-2026-09.md)                            | Layered gap analysis, September 2026.                                       | L1-01…L9-12                                                     |
| [`INSTANCE-DOCS-ANALYSIS-2026-09.md`](archive/INSTANCE-DOCS-ANALYSIS-2026-09.md)        | Instance documentation analysis, first pass.                                | ID-01…ID-17                                                     |
| [`INSTANCE-DOCS-ANALYSIS-2026-09-25.md`](archive/INSTANCE-DOCS-ANALYSIS-2026-09-25.md)  | Instance documentation analysis, second pass (2026-09-25).                  | ID-18…ID-29                                                     |
| [`PRODUCT-STATE.md`](archive/PRODUCT-STATE.md) | Product snapshot dated 2026-07-06; stale, superseded by ROADMAP-V3.md and DONE.md. | — |

### ID prefix clashes

- `B` — risks B1–B7 in BUSINESS-ANALYSIS-V2.md and the breaking register B1–B13 (B14 is
  proposed) in ROADMAP-V3.md. Inside the tracker, `B` always means the breaking register.
- `UX-` — findings UX-01…UX-24 in UIB-ANALYSIS-2026-10.md and the older DX/UX review
  vocabulary. Qualify the document when you cite one outside UIB-ANALYSIS.
- `DF-` — the differentiators are defined in COMPETITIVE-ANALYSIS.md and re-planned in
  ROADMAP.md. Both use the same numbering.

## Archive

Every historical document lives in [`archive/`](archive/) (moved 2026-10-05, owner decision).
They are kept, not deleted: their IDs are still cited by tracker rows, and
DEEP-REVIEW-2026-09.md §8 is the finding → item index. Links into them use the
`archive/` path; a document moved there later updates its inbound links in the same change.

## roadmap.yaml

[`roadmap.yaml`](roadmap.yaml) holds the rows of the "Sequencing (must-haves first)" table in
ROADMAP-V3.md as data. Each row stores `id`, `title`, `pillar`, `effort`, `status`
(`done` / `partial` / `open`) and `notes`, plus three fields derived at import: `phase`, `done`
(date) and `gates` (the owner gates the notes reference). Release-cut rows are stored as
`marker` entries. The `#` column is not stored: the renderer numbers rows by position.
[`scripts/roadmap.mjs`](../scripts/roadmap.mjs) documents the restricted YAML subset it reads
and writes (no new dependency).

```sh
npm run roadmap:status                   # counts by pillar and status, open items by phase, open owner gates
npm run roadmap:status -- --json         # the same report as JSON
npm run roadmap:status -- --from-table   # report from the live table instead of the YAML
npm run roadmap:sync -- --check          # exit 1 if the table and roadmap.yaml disagree
npm run roadmap:sync -- --import         # rebuild roadmap.yaml from the current table
npm run roadmap:sync -- --adopt          # one-time: wrap the table in GENERATED markers and render it
npm run roadmap:sync                     # render the table between the markers from roadmap.yaml
```

**Current mode: generated (adopted 2026-10-05).** `roadmap.yaml` is the source of truth. Edit a
row there, run `npm run roadmap:sync`, and never edit the table between the GENERATED markers
by hand. `npm run check` runs `roadmap:sync -- --check`, so drift fails the gate.
