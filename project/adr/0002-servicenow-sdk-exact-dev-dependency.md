# 0002 — `@servicenow/sdk` 4.12.2 exact as a dev dependency (O-7)

- **Status:** accepted
- **Date:** 2026-10-01
- **Owner gate / ID:** O-7 (SDK parity epic; the P-29 oracle)
- **Supersedes:** —
- **Superseded by:** —

## Context

The SDK parity epic generates Fluent (`.now.ts`) source from instance records (P-26 … P-28). To
claim that the output is correct, P-29 needs an oracle that type-checks and builds the generated
code with the real ServiceNow SDK. Gate O-7 asked: may the repo take `@servicenow/sdk` as a dev
dependency (types and round-trip builds in CI), and which SDK major does generated code target
([SDK-PARITY.md](../SDK-PARITY.md) §7, O-7)? Until then the emitters treated SDK 4.12.2 header
names as an assumption, and P-26 … P-28 were "done bar the O-7 oracle"
([DONE.md](../DONE.md) batches 15 and 16).

## Decision

O-7 is **approved**: `@servicenow/sdk` **4.12.2, pinned exactly**, is a **dev dependency** and
serves as the P-29 type-check oracle ([ROADMAP-V3.md](../ROADMAP-V3.md) §O;
[TODO.md](../TODO.md) "Decided 2026-10-01"; [DONE.md](../DONE.md) batch 17). It is recorded in
[`package.json`](../../package.json) as `"@servicenow/sdk": "4.12.2"` under `devDependencies`.

## Consequences

- P-29 landed in part on 2026-10-01: [`scripts/fluent-verify.mjs`](../../scripts/fluent-verify.mjs)
  (`npm run fluent:verify`) type-checks every Fluent golden with strict `tsc` and runs
  `now-sdk build` offline; [`test/fluent-sdk-oracle.test.js`](../../test/fluent-sdk-oracle.test.js)
  runs it and skips when the SDK is absent ([SDK-PARITY.md](../SDK-PARITY.md), P-29).
- P-26 … P-28 are SDK-verified against 4.12.2 ([DONE.md](../DONE.md) batch 17).
- The SDK is never a runtime dependency, so it does not change the published package.
- Moving to another SDK version (the parity baseline notes 4.13.0 on `next`) is a new decision
  and supersedes this record.
- The other SDK parity gates (O-5, O-6, O-8, O-9) remain open.

## Links

- [SDK-PARITY.md](../SDK-PARITY.md) — §7 owner gates (O-7) and P-29.
- [ROADMAP-V3.md](../ROADMAP-V3.md) — "O — Owner gates" (O-5 … O-9).
- [TODO.md](../TODO.md) — "Decided 2026-10-01" and the batch 16 owner decisions.
- [DONE.md](../DONE.md) — batch 17 (2026-10-01).
