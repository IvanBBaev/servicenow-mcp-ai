# MCP 2026-07-28 conformance matrix

[ADR 0008](adr/0008-full-protocol-2026-07-28-conformance.md) (O-19) sets the target as
**full conformance** with MCP protocol revision 2026-07-28, served next to 2025-11-25 (dual
protocol). "Full" is proven by tests, not claimed. The proof is a matrix:
[test/fixtures/protocol-2026-07-28-conformance.json](../test/fixtures/protocol-2026-07-28-conformance.json),
checked by [test/protocol-conformance-matrix.test.js](../test/protocol-conformance-matrix.test.js).

## What a row is

Each row is one normative **server** requirement (MUST, MUST NOT, SHOULD, SHOULD NOT, and the
RFC 2119 equivalents REQUIRED and RECOMMENDED). The rows come from the 2026-07-28 core
specification, its schema and changelog, and the `io.modelcontextprotocol/tasks` extension. A
row keeps the spec sentence, its source URL and an `applies` scope (`always`, `http`, `stdio`,
`auth`, `tasks`). Client-only requirements are left out.

A row has one of three statuses:

- **covered**: a test in this repo pins the behaviour. The row names the test as
  `test/<file>.test.js :: <exact title>`, and the gate fails if that title disappears. A row is
  covered only when its behaviour does not depend on the wire revision. Behaviour that only
  exists on the 2026-07-28 wire stays pending until the dual-revision suite pins it.
- **pending**: the row needs the modern wire or new work. It names the step (below) that will
  cover it.
- **n/a**: the requirement is outside this server's scope, for example a feature it never
  uses. The row says why.

The gate holds `pendingCeiling` equal to the pending count, so the count can only go down:
whoever covers a row also lowers the ceiling.

## Counts

| total | covered | pending | n/a |
| ----- | ------- | ------- | --- |
| 364   | 68      | 245     | 51  |

Pending rows by step:

| step       | rows | delivered by                                                                                           |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `wire`     | 33   | N-35 step 1: modern wire on SDK v2 (dual-revision negotiation, `_meta`, `resultType`, new error codes) |
| `http`     | 52   | N-35 step 1: stateless Streamable HTTP (standard headers, validation, statuses, SSE cancellation)      |
| `mrtr`     | 34   | N-35 / N-38 track: `InputRequiredResult` in place of server-to-client requests                         |
| `tasks`    | 43   | N-35 step 2: hand-rolled tasks extension                                                               |
| `auth`     | 35   | N-17: OAuth 2.1 resource server (RFC 9728 metadata, audience-bound tokens)                             |
| `shape`    | 14   | N-35: `tools/list` shape suite (JSON Schema 2020-12 meta-validation, name charset, URI syntax)         |
| `listen`   | 11   | N-35 step 1: `subscriptions/listen`                                                                    |
| `logging`  | 7    | N-35 step 1: per-request log level; no `notifications/message` without it                              |
| `cache`    | 6    | N-38: `ttlMs` / `cacheScope`                                                                           |
| `discover` | 5    | N-35 step 1: `server/discover`                                                                         |
| `packages` | 5    | O-19 (d): lists fixed per server, deterministic order                                                  |

The n/a rows cover features the server never uses: client-supplied `$ref` resolution, custom
transports, URL-mode elicitation, roots and sampling (ADR 0009), the legacy HTTP+SSE transport,
`https://` and binary resources, image and audio prompt content, and the client-side parts of
authorization.

## Keeping it current

- When a test starts pinning a pending row, set the row to `covered`, list the test, lower
  `pendingCeiling` and update the counts row above (the gate checks it).
- The rows were taken from the spec text once. If the spec gets an erratum, edit the affected
  rows by hand and say so in the commit.
- Do not add a covered row on the strength of code reading alone. It needs a test.

## Open owner questions

These came up while classifying the rows. None is decided yet, and the matrix records the
affected rows (`ownerQuestion`) without taking a position:

1. **Dynamic `resources/list` entries** (`resources-02`): keep the per-profile entries and mark
   them `ttlMs: 0`, `cacheScope: private`, as an accepted deviation from the "fixed list" rule.
   Or drop them from the list and keep them reachable only through templates.
2. **`request_secrets` form mode (D-2)** (`mrtr-19`, `mrtr-20`, `mrtr-42`): on the 2026-07-28
   wire, form-mode elicitation must not collect secrets. Should the tool refuse on the modern wire
   and point to the secret-file route?
3. **A declined destructive apply on the modern wire** (`mrtr-34`): should a decline returned
   through `input_required` burn the plan token, like a declined elicitation does today?
