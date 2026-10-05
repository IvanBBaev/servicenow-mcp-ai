# Protocol 2026-07-28 and breaking changes — owner report

**Date:** 2026-10-05 · **Scope:** owner gate O-19 (protocol), the breaking register (B1–B13,
proposed B14), and every open item that could break a client · **Constraint set by the
owner:** nothing breaks. Every recommendation below is additive or opt-in, or is a decision
not to do something.

Sources: [`TOKEN-DOCS-ANALYSIS-2026-10.md`](TOKEN-DOCS-ANALYSIS-2026-10.md) §2.1 (TK-01…TK-05),
N-35, §6; [`TOKEN-OPTIMIZATION-PLAN-2026-10.md`](TOKEN-OPTIMIZATION-PLAN-2026-10.md) §4–§7;
[`ROADMAP-V3.md`](ROADMAP-V3.md) breaking register.

## 1. Summary

| Question                                              | Recommendation                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| Migrate to protocol 2026-07-28 (O-19)?                | Yes, as a **3.x minor**, dual-protocol. Spike first (N-35 step 1).             |
| Drop protocol versions before 2025-11-25?             | **No.** Keep them as long as the v2 SDK negotiates them.                       |
| Drop the deprecated features (logging, HTTP session)? | **No** during the spec's deprecation window. They stay for 2025-11-25 clients. |
| N-9 (sampling)?                                       | **Drop.** It never shipped, so dropping it breaks nobody.                      |
| New breaking items for 3.0?                           | **None.** The register stays at B1–B13 (B10 still conditional on ARCH-14).     |
| B14 (N-64 tool consolidation)?                        | **Reject.** Freeze the 3.0 tool names.                                         |
| N-61 `list_tables` default limit, N-63 profile flips  | **Do not change defaults.** Ship them as opt-in profiles and hints.            |

## 2. Where we are

- `@modelcontextprotocol/sdk` **^1.31.0**. It speaks protocol **2025-11-25** and earlier.
- Protocol 2026-07-28 is only implemented in the split v2 packages
  `@modelcontextprotocol/server` / `@modelcontextprotocol/core` (2.3.0 at the time of TK-01).
  Moving to them changes imports and some server APIs; it does not by itself change the wire
  for existing clients, provided the v2 packages still negotiate 2025-11-25 (to confirm in the
  spike).
- 3.0 is **not released**. B1–B13 are already on `main` and approved under O-4 (2026-10-01).

## 3. Protocol 2026-07-28 — impact per change

| Spec change                                            | Our code                                   | Breaks a client today?                                                      | Recommendation                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stateless core: no `initialize`, no `Mcp-Session-Id`   | H-7 HTTP transport, B6 per-session profile | Only if we remove the session path.                                         | Serve both: stateless for 2026-07-28 clients, sessions kept for 2025-11-25. Session-scoped state (active profile, plan tokens) is keyed by the journal / token, not by the transport. |
| `server/discover`                                      | none                                       | No (new method).                                                            | Add it. Additive.                                                                                                                                                                     |
| `input_required` (MRTR)                                | H-3 plan-token confirmations, elicitation  | No, if elicitation stays for old clients.                                   | Dual path: MRTR when negotiated 2026-07-28, elicitation otherwise. The plan → token → apply contract is unchanged.                                                                    |
| `Mcp-Method` / `Mcp-Name` headers                      | H-7                                        | No.                                                                         | Accept and emit them on the new protocol.                                                                                                                                             |
| `ttlMs` / `cacheScope`                                 | N-38 cache hints                           | No.                                                                         | Add after the migration. Additive.                                                                                                                                                    |
| Tasks become extension `io.modelcontextprotocol/tasks` | M-9 (experimental)                         | Only for clients using our experimental tasks; it was flagged experimental. | Move. An experimental surface is not in the breaking register by its own contract.                                                                                                    |
| CIMD replaces DCR                                      | N-17 (not built)                           | No.                                                                         | Build N-17 on CIMD directly.                                                                                                                                                          |
| Logging deprecated                                     | M-8 log bridge                             | Only if we remove the bridge.                                               | Keep the bridge behind its flag for the window; add stderr + result `_meta` warnings in parallel.                                                                                     |
| Sampling deprecated                                    | N-9 (not built)                            | No.                                                                         | Drop N-9.                                                                                                                                                                             |
| Roots deprecated                                       | not used                                   | No.                                                                         | Nothing to do.                                                                                                                                                                        |
| HTTP+SSE deprecated                                    | legacy transport if still enabled          | Only if removed.                                                            | Keep for the window; remove in 4.0 at the earliest.                                                                                                                                   |
| `tools/list` MUST NOT vary per connection              | **M-5 dynamic packages**                   | No — it is a spec-conformance gap, not a client break.                      | See §4.                                                                                                                                                                               |

### Answers to O-19

1. **Migration window:** start the N-35 spike now on a branch; ship the migration in a 3.x
   minor after 3.0 is out. Nothing in it needs 3.0 to wait.
2. **Dropping pre-2025-11-25 versions:** do not drop them. If the v2 SDK stops negotiating
   them, that is a 4.0 breaking item and goes to the owner then.
3. **N-9:** drop it.

## 4. The M-5 conflict (per-connection `tools/list`)

M-5 lets a session enable packages, so two connections to one server can see different
`tools/list` results. Protocol 2026-07-28 forbids that.

- **Today:** accept the deviation. On 2025-11-25 sessions it is legal behaviour, and
  `tools/list_changed` already covers it.
- **On the new protocol:** packages come from configuration (`SN_PACKAGES`, profile), so
  `tools/list` is fixed per server. The runtime toggle stays for 2025-11-25 clients only.
- **N-36 discovery** (`servicenow_find_tools`) returns matching tools without mutating the list;
  it is the conforming replacement for runtime enabling on the new protocol.

No current client loses anything.

## 5. The breaking register

### B1–B13 (approved, on `main`)

No change recommended. They ship together in 3.0 with the migration table in the changelog.
B10 stays conditional: ARCH-14 is deferred, the Jira scaffold is dark and already excluded from
the package (`!build/**/jira/**`), so E-8 can stay parked without cost.

### Items that would add a breaking entry — and how to avoid it

| Item                                                    | What would break                                                   | Non-breaking alternative                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **B14 / N-64** tool consolidation                       | Removes or merges tool names after B2 renamed them once.           | Reject. Freeze the 3.0 names. Token savings come from N-58 / N-60 / N-36 instead.                                      |
| **N-61** `list_tables` default limit 200                | Callers that rely on the full list get a truncated one.            | No default limit. Rely on the universal result cap (already shipped) plus a truncation hint and the `limit` parameter. |
| **N-63** discovery as the default profile               | Clients that call core tools directly lose them from `tools/list`. | Ship `discovery` as an **opt-in** profile.                                                                             |
| **N-63** `attachment` out of `core`                     | Attachment tools disappear for default installs.                   | Keep `attachment` in `core`.                                                                                           |
| **N-39** structured-only payloads                       | Clients that read only `content[].text` get nothing.               | Keep the dual wire by default; structured-only behind `SN_STRUCTURED=0` (opt-in).                                      |
| **N-40** `fields:"display"` / `format:"table"` defaults | Changes result shape for existing callers.                         | Opt-in parameters and profile defaults only.                                                                           |
| Dropping old protocol versions                          | Pre-2025-11-25 clients cannot connect.                             | Keep them (§3).                                                                                                        |

### Checked and found non-breaking

- **N-58** lean serializer: removes only annotation defaults the spec already implies, redundant
  `maxLength`, `±2^53−1` bounds and `$schema` (dialect guarded). Validation is equivalent.
- **N-60** shallow output schemas: a looser schema cannot reject a result the full one accepted;
  `additionalProperties: {}` stays. Keep the full schema for the always-loaded core tools.
- **N-65** `_meta` hints (`anthropic/maxResultSizeChars`, `alwaysLoad`): unknown `_meta` keys are
  ignored by clients.
- **Budget raise for N-26** (`all+tasks` 137,728 B, `all+legacy` 155,136 B, ≈ +190 B): a test
  fixture change, no wire effect.

## 6. Recommended order

1. Owner signs O-19 as in §3 and rejects B14.
2. N-35 step 1 spike on a branch: v2 packages, both protocol versions in the spawn suite.
3. 3.0 release with B1–B13 only.
4. N-35 step 2 in a 3.x minor: stateless HTTP, `server/discover`, MRTR dual path, tasks
   extension, config-scoped packages on the new protocol.
5. N-38 cache hints and N-17 on CIMD after step 2.

## 7. Risks

- **v2 SDK negotiation:** if the v2 packages drop 2025-11-25 support, step 2 must wait or we keep
  1.x for the old path. The spike answers this first.
- **Client lag:** most hosts will stay on 2025-11-25 for months; the dual path is the cost of not
  breaking them.
- **Deprecation window end:** removing logging bridge, HTTP sessions and HTTP+SSE becomes a 4.0
  register entry, decided by the owner at that time.
