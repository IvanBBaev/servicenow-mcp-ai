# 0003 — `acorn` as a runtime parser dependency (S-12)

- **Status:** accepted
- **Date:** 2026-10-01
- **Owner gate / ID:** S-12 (an owner decision on a roadmap item, not a numbered O-gate)
- **Supersedes:** —
- **Superseded by:** —

## Context

S-12 replaces the regex-based script lint with an AST-based one. The roadmap marked it
"Decide first": it adds a **runtime** dependency, and the alternative was to keep the regex
engine and add rules ([ROADMAP-V3.md](../ROADMAP-V3.md) §S-12).

## Decision

**Approved** on 2026-10-01: `acorn` is a runtime dependency used as the script parser, with the
regex rules kept as the fallback ([ROADMAP-V3.md](../ROADMAP-V3.md) §S-12;
[TODO.md](../TODO.md) "Decided 2026-10-01"; [DONE.md](../DONE.md) batch 17). It is declared in
[`package.json`](../../package.json) under `dependencies`.

## Consequences

- [`src/api/script-ast.ts`](../../src/api/script-ast.ts) wraps `acorn` (ES5 for global scope,
  ES2021 for scoped apps); the lint tries the AST engine first and falls back to the regex engine
  on a parse failure or Jelly markup ([ROADMAP-V3.md](../ROADMAP-V3.md) §S-12).
- The runtime dependency set grows by one package, which counts toward the install footprint
  ([FOOTPRINT.md](../FOOTPRINT.md)).

## Links

- [ROADMAP-V3.md](../ROADMAP-V3.md) — §S-12 (AST-based lint).
- [TODO.md](../TODO.md) — "Decided 2026-10-01".
- [DONE.md](../DONE.md) — batch 17 (2026-10-01).
