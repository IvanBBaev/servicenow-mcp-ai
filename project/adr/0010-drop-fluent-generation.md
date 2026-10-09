# 0010 — Drop Fluent generation; source control belongs to syncrona

- **Status:** accepted
- **Date:** 2026-10-10
- **Owner gate / ID:** P-26 … P-29 (SDK parity epic); O-7; breaking row B15
- **Supersedes:** [0002](0002-servicenow-sdk-exact-dev-dependency.md)
- **Superseded by:** —

## Context

The SDK parity epic added `servicenow_generate_fluent`. It turns instance records into Fluent
(`.now.ts`) source with emitters for tables, script artefacts, flows and UI (P-26 … P-28). It
also added a type-check oracle built on the `@servicenow/sdk` dev dependency (P-29,
[ADR 0002](0002-servicenow-sdk-exact-dev-dependency.md)) and a generated action table
(`scripts/gen-fluent-actions.mjs`). Together that is about 12,000 lines of source, scripts,
tests and goldens ([SDK-PARITY.md](../SDK-PARITY.md)).

Turning an application into Fluent source and keeping it in source control is a development
workflow, not instance access. The owner's separate `syncrona` CLI covers it with its
`@syncrona/fluent` package: `syncrona fluent init / build / transform / pack / status / types`.

## Decision

On 2026-10-10 the owner decided that Fluent generation is out of scope for this MCP server and
belongs to syncrona. The changes are:

- **Removed:** `servicenow_generate_fluent`, the `src/api/fluent*.ts` emitters, the Fluent goldens
  and tests, `scripts/fluent-verify.mjs` (`npm run fluent:verify`),
  `scripts/gen-fluent-actions.mjs` (`npm run fluent:actions`), and the `@servicenow/sdk` dev
  dependency.
- **Kept:** these do not need the SDK package, and removing them would change the output of
  existing tools.
  - The SDK-managed scope guard (P-3, P-22).
  - The registry's `sdkApi` field, `SDK_BASELINE`, and the API-name drift check
    (`scripts/sdk-drift.mjs`, P-4).

The removal is breaking row **B15** in the 3.0 register.

## Consequences

- The opt-in `artifacts` package goes from six tools to five, and `tools/list` gets smaller.
- A client that called `servicenow_generate_fluent` uses `syncrona fluent transform`, or the
  ServiceNow `now-sdk transform`, instead.
- `npm install` no longer pulls in the ServiceNow SDK and its toolchain, and `npm run check` loses
  the `fluent:actions` step.
- P-26 … P-29 keep their roadmap rows with the `dropped` status (⚫). O-7 has no consumer left.

## Links

- [ROADMAP-V3.md](../ROADMAP-V3.md) — rows P-26 … P-29, register row B15, "Explicitly NOT in 3.0".
- [SDK-PARITY.md](../SDK-PARITY.md) — the epic (kept for the record).
- [ADR 0002](0002-servicenow-sdk-exact-dev-dependency.md) — the superseded SDK dependency decision.
