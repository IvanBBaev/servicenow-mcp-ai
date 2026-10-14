# 0012 — Owner gate round 2026-10-14 (3.0.0 scope close: H-11b, N-0, N-54, P-2, blocked-external rows)

- **Status:** accepted
- **Date:** 2026-10-14
- **Owner gate / ID:** O-4 (H-11 TODO (b)–(f)), O-10 (N-0, N-54), O-5 / OD-4 (P-2), O-14 (N-11
  pre-flight), O-3 / O-22 (publication order), O-16 (N-20 EL-0)
- **Supersedes:** —
- **Superseded by:** —
- **Amended:** 2026-10-14 — P-2: `application` ships `verified:true` (owner, after a read-only
  analysis showed the `sys_store_app` rationale below did not apply).

## Context

After ADR 0011 the release progress stood at 98.9 %, with every remaining row either owner-gated
or waiting on an instance the project does not have. A read-only analysis of the code, the
release workflows and the trackers on 2026-10-14 found:

- **H-11b** (`SN_TABLE_POLICY_FILE`): no format was ever specified and no code exists. The
  "approved as JSON under O-4" note lived only in session journals; no ADR or TODO answer
  recorded it. Nothing in 3.0 depends on it; the 3.0 exit criterion for the policy model is met
  by the glob evaluator, `explain_policy` and `servicenow://policy`.
- **N-0**: the exit criterion "`all` has ≥ 15 KB of headroom" cannot be met since N-57 / ADR 0006:
  budgets are data with `slackPct: 2` and a tightening-only ratchet, so a budget more than 2 %
  above the measurement fails the gate (≈ 2.4 KB at most on `all`).
- **N-54**: 88 / 100 tools declare an `outputSchema`; the remaining 12 are the write tools, the
  five attachment tools, `explain_policy`, `set_credentials` and `use_instance`. Write tools return
  two shapes (plan preview and applied result) that one envelope must cover, or the SDK's
  server-side `structuredContent` validation turns a success into an error.
- **P-2**: `application` was still `verified:false` only because its `sys_scope_dependency`
  child names a table no instance has (OD-3); `risk_assessment` (plugin inactive on the PDI)
  and `uib_composite_definition` (not confirmed) are still `verified:false`. The first draft
  of this ADR cited a `sys_store_app` 403; that table is read only by the document and
  discovery collectors, which degrade on their own, not by the `application` type (`sys_app`
  plus `sys_package_dependency_m2m`).
- **P-25b, N-12b, N-20b** need a writable flow table, a non-domain-separated instance and full
  admin respectively; the PDI (ven03019) offers none of them.
- **N-11 pre-flight**: `publish.yml` passes the tag version to `scripts/release-notes.mjs`, which
  exits 1 when `CHANGELOG.md` has no section for that version — while CONTRIBUTING keeps beta
  notes under `## [Unreleased]`. On `v3.0.0-beta.1` npm would publish to `next` and the GitHub
  release job would then fail. CONTRIBUTING's `npm version premajor --preid beta` yields
  `3.0.0-beta.0`, not the `3.0.0-beta.1` every other document names.
- **Distribution**: the Marketplace extension is 2.0.0 and starts `npx -y servicenow-mcp-ai`
  unpinned, so its users would get 3.0.0 the moment `latest` moves. The pinned 2.0.1 extension
  (`SERVER_VERSION_RANGE = "2.x"`, B9) has never been published.

## Decision

The owner accepted the recommended option for each item on 2026-10-14.

| Item         | Decision                                                                                                                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-11b        | **Deferred to 3.x.** `SN_TABLE_POLICY_FILE` is not part of 3.0.0; a scope proposal may come back as a 3.x design. It is additive (a new optional variable), so it needs no breaking-register row. H-11 counts as done for 3.0.                                                                                    |
| H-11 (b)–(f) | Ratified as shipped: the protected list (with B22's two role tables), attachment writes meeting the parent table's policy (99b1ec1), `SN_ENV` for the default profile only, and `CONFIRM_REQUIRED` for destructive prod applies without elicitation even with `I_UNDERSTAND`.                                     |
| N-0          | **Closed, superseded by N-57 / ADR 0006.** The exit criterion is a green budget ratchet; every tool change still states its `tools/list` byte delta.                                                                                                                                                              |
| N-54         | **Frozen at 88 / 100 for 3.0.** The 12 registered tools keep their register entry; declaring them is additive and may land in 3.x.                                                                                                                                                                                |
| P-2          | **Closed for 3.0.** `application` ships `verified:true` once its absent `sys_scope_dependency` child is dropped (amended 2026-10-14); `risk_assessment` and `uib_composite_definition` ship `verified:false` (degrade, not fail); a later false → true flip per plugin is a behaviour change, not a breaking one. |
| P-25b        | Known limitation: the flow toggle's runtime effect on the trigger is unverified (Table API `PATCH sys_hub_flow` is ACL-refused on the PDI).                                                                                                                                                                       |
| N-12b        | Known limitation: on a non-separated instance a missing and an empty `sys_domain` are both read as "no domain"; unverified there.                                                                                                                                                                                 |
| N-20b        | Known limitation: the EL-0 spike waits for a PDI with full admin; elevation stays reported, never performed (O-16, ADR 0011).                                                                                                                                                                                     |
| N-11         | A prerelease version takes its GitHub release notes from `## [Unreleased]`; the first beta is cut with `npm version 3.0.0-beta.1`. The tag cut itself stays the owner's.                                                                                                                                          |
| O-3 / O-22   | Before the beta: publish the pinned 2.0.1 extension through `publish-vscode.yml` `workflow_dispatch` (also proves `VSCE_PAT`) and set `MCPB_RELEASE=true`. At GA: deprecate the two LeassTaTT registry entries, register Context7; Open VSX only with an `OVSX_PAT`.                                              |
| Housekeeping | Stale local branches and the abandoned `n18/baseline` worktree are removed; `backup-original` is kept as the tag `archive/backup-original`.                                                                                                                                                                       |

## Consequences

- No agent-workable row is left for 3.0.0 beyond release bookkeeping; the remaining hours are the
  owner's acts (beta tag, publication, `SN_*` secrets for the O-2 live smoke).
- The beta tag no longer needs a CHANGELOG section of its own; GA still moves `[Unreleased]` under
  `## [3.0.0]`.
- The 3.0.0 CHANGELOG lists P-25b, N-12b and N-20b as known limitations.
- H-11b, the 12 N-54 tools and the two remaining P-2 rows are 3.x candidates, not release blockers.

## Links

- [ADR 0006](0006-tools-list-budget-ratchet.md), [ADR 0011](0011-owner-gate-round-2026-10-13.md).
- [ROADMAP-V3.md](../ROADMAP-V3.md) — H-11, N-0, N-11, N-54, P-2, P-25, N-12, N-20, D-6.
- [TODO.md](../TODO.md) — H-11 owner questions.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — "Prereleases (betas)".
