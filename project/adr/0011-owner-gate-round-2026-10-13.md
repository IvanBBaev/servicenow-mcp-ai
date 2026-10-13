# 0011 — Owner gate round 2026-10-13 (O-2, O-3, O-10, O-11, O-14, O-16 … O-22, OD-11)

- **Status:** accepted
- **Date:** 2026-10-13
- **Owner gate / ID:** O-2, O-3, O-10 (c)+(d), O-11, O-14, O-16, O-17, O-18, O-19 (legacy window),
  O-20, O-21, O-22, OD-11; new breaking rows B21 and B22
- **Supersedes:** —
- **Superseded by:** —

## Context

After N-63 (B20), N-64 (B14) and N-34b (B19) landed, the 3.0 release was blocked mostly on owner
gates. A verification pass over the code, the release workflows and the live registries on
2026-10-13 found:

- `tools/list` for `all` measures 119,543 B against a 119,552 B budget (9 B of room); the default
  `discovery` profile measures 23,689 B against the restated ≤ 22 KB target.
- `servicenow_batch` maps every `/api/sn_cicd` path except the instance scan to the `atf` package,
  so with `atf` enabled a batch can reach update-set commit, app install / publish and plugin
  activation. ATF runs carry "non-production only" in their description but no code check.
- `PROTECTED_TABLES` covers `sys_user_has_role` and `sys_user_role` but not `sys_group_has_role`
  (a role through a group) or `sys_user_role_contains` (what a role contains).
- The release workflows cannot ship a prerelease: `npm publish` has no dist-tag, the GitHub
  release is not marked prerelease, `publish-mcp.yml` and `publish-vscode.yml` run on every
  `v*` tag, `SERVER_VERSION_RANGE` is pinned to the 2.x major and the CHANGELOG has no version
  section or migration table. B5 (fail-fast settings, no cwd `.env`) is only behind the opt-in
  `SN_STRICT_SETTINGS`.
- No `SN_*` secrets exist, so the live PDI smoke has never run; the MCP Registry has two stale
  `io.github.LeassTaTT/servicenow-mcp-ai` entries; the Marketplace extension is at 2.0.0; Open VSX
  has none.

## Decision

The owner accepted the recommended option for each gate on 2026-10-13.

| Gate     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security | **B21:** `batch` maps only `/api/sn_cicd/testsuite` and `/api/sn_cicd/progress` to `atf`; every other `sn_cicd` path is unmapped (refused under the B8 default). ATF runs are refused on a production profile in code. **B22:** `sys_group_has_role` and `sys_user_role_contains` join `PROTECTED_TABLES`.                                                                                                                                                                                               |
| O-14     | Cut `3.0.0-beta.1` on `next`: the publish workflow derives the dist-tag from the version (a prerelease → `next`), marks the GitHub release as a prerelease, and the MCP Registry and VS Code jobs skip prerelease tags. The extension is not published before 3.0.0 GA. CHANGELOG gets a version section with a consolidated B1–B22 migration table. The `pack:check` ceiling stays at 3 MB.                                                                                                             |
| B5       | The fail-fast default flips in 3.0 as registered (a cwd `.env` is an error, not a warning).                                                                                                                                                                                                                                                                                                                                                                                                              |
| O-10 (c) | Shallow output schemas (N-60) are ratified as shipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| O-10 (d) | No paid eval in 3.x (N-18b, N-59b, N-37b were dropped the same day).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| OD-11    | Option (1): accept `discovery` at its measured size; the budgets in `test/fixtures/token-budgets.json` are the targets. The exit criteria cite that file instead of character counts.                                                                                                                                                                                                                                                                                                                    |
| O-2      | The owner provides a PDI and the `SN_*` repository secrets; the live smoke stays an exit criterion.                                                                                                                                                                                                                                                                                                                                                                                                      |
| O-3      | Deprecate the LeassTaTT registry entries, set up Open VSX (`OVSX_PAT`), refresh the Marketplace only at 3.0.0 GA, check the `VSCE_PAT` expiry. The next KPI checkpoint is 3.0.0 + 30 days.                                                                                                                                                                                                                                                                                                               |
| O-11     | Option B — update sets only: an opt-in `cicd` package with preview and commit; never `force_commit`; a preview with problems refuses the commit, the clean preview is bound into the `plan_token`; production profiles follow the usual prod-write rule; journalled `revertable:false`. App install / publish and plugin activation wait for a later gate. Endpoints: `POST /api/sn_cicd/update_set/preview/{sys_id}`, `POST /api/sn_cicd/update_set/commit/{sys_id}`, `GET /api/sn_cicd/progress/{id}`. |
| O-17     | Option B — limited grants: an opt-in `access` package with one tool; admin, `security_admin`, `maint`, every elevated role and every role that contains one are always refused; inherited roles are refused; revoking admin from the calling account is refused; the plan shows effective roles before and after. B22 is a precondition.                                                                                                                                                                 |
| O-16     | No-go for 3.0: elevation is reported (`ELEVATION_REQUIRED`), never performed. Re-open after the EL-0 spike on a PDI with full admin (O-2).                                                                                                                                                                                                                                                                                                                                                               |
| O-18     | Option C — UIB writes ship in 3.x after GA, off the 3.0 critical path: a non-Default update set is mandatory, its scope must match the page, `/api/now/uxf/*` and custom-component deployment stay out, and macroponent JSON becomes writable only after the N-25 round-trip and a byte-identical revert test on a PDI.                                                                                                                                                                                  |
| O-19     | The legacy protocol window (revisions ≤ 2025-11-25) ends in 4.0 and not earlier than six months after 3.0.0 GA.                                                                                                                                                                                                                                                                                                                                                                                          |
| O-20     | Go: a public `AGENTS.md` is the single source; `.github/copilot-instructions.md` is generated from it with a drift check.                                                                                                                                                                                                                                                                                                                                                                                |
| O-21     | (a)–(d) ratified as shipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| O-22     | `.mcpb` bundles attach to releases once prerelease handling lands (`MCPB_RELEASE=true`); Context7 is registered at GA, and `context7.json` names `discovery` as the default profile now.                                                                                                                                                                                                                                                                                                                 |

Each new tool states its `tools/list` byte delta and raises the `all` budget by hand in the same
commit (ADR 0006 allows raising only through an owner decision; this record is that decision for
the O-11 and O-17 tools).

## Consequences

- B21 and B22 join the breaking-change register; batches that reached the other `sn_cicd` paths
  and writes to the two role tables through `SN_TABLES_ALLOW` need the documented migration.
- The beta can be cut once the workflow changes and the CHANGELOG section land.
- N-20 stays partial (EL-1/EL-2 done); N-33 leaves the 3.0 cut.
- Open: the H-11b JSON policy file scope and the cleanup of stale local branches.

## Links

- [ROADMAP-V3.md](../ROADMAP-V3.md) — §O gates, the breaking-change register, exit criteria.
- [TODO.md](../TODO.md) — OD-11.
- [ADR 0006](0006-tools-list-budget-ratchet.md), [ADR 0008](0008-full-protocol-2026-07-28-conformance.md).
- [GAP-ANALYSIS-2026-10.md](../GAP-ANALYSIS-2026-10.md) — N-4, N-24 designs;
  [UIB-ANALYSIS-2026-10.md](../UIB-ANALYSIS-2026-10.md) — N-33 design.
