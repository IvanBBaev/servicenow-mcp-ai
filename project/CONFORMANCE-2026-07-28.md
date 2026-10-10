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
| 364   | 238     | 70      | 56  |

Pending rows by step:

| step       | rows | delivered by                                                                                           |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `wire`     | 0    | N-35 step 1: modern wire on SDK v2 (dual-revision negotiation, `_meta`, `resultType`, new error codes) |
| `http`     | 1    | N-35 step 1: stateless Streamable HTTP (standard headers, validation, statuses, SSE cancellation)      |
| `mrtr`     | 19   | N-35 / N-38 track: `InputRequiredResult` in place of server-to-client requests                         |
| `tasks`    | 12   | N-35 step 2: hand-rolled tasks extension                                                               |
| `auth`     | 35   | N-17: OAuth 2.1 resource server (RFC 9728 metadata, audience-bound tokens)                             |
| `cache`    | 2    | N-38: `ttlMs` / `cacheScope`                                                                           |
| `packages` | 1    | O-19 (d): lists fixed per server, deterministic order                                                  |

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

## Coverage notes

- `deprecated-03` (do not adopt `logging/setLevel`): the modern wire takes the level from each
  request's `_meta` only. During the legacy window, lines logged outside a call still reach 2025
  sessions through `sendLoggingMessage`.
- `tasks-36` / `tasks-37` (`statusMessage` on a failed task) are pinned by a store-level test,
  not end to end.
- `tools-06`, `prompts-04`, `resources-04` (`list_changed` on a listen stream) are pinned on
  stdio. Over HTTP the lists are fixed per server (O-19 d), so nothing publishes `list_changed`.
- `mrtr-19` / `mrtr-42` (no secrets through form mode) are covered by decision 2: the modern
  wire refuses the request. `mrtr-20` (use URL mode instead) stays pending, since the server
  never uses URL mode.
- `cache-03` / `cache-04` (one scope on every page) are covered because the server does not
  paginate: every 2026-07-28 list is a single page carrying its method's hint. `cache-05` and
  `cache-07` stay pending: no test checks the scope per caller yet.
- `base-42` (W3C trace formats): the server accepts the client's keys and emits none of its
  own, so the emit side holds vacuously. `prompts-08` and `completion-02` are pinned on their
  `-32602` paths; `-32603` cannot be triggered and `-32601` is unreachable while completions
  are always advertised.
- The `http` rows are pinned end to end against the shipped transport by
  `test/protocol-http-modern.test.js` (raw POSTs, real status codes and SSE frames).
  `http-32`, `http-37`, `http-43` and `http-45` are n/a: they apply to a recognized
  `Mcp-Param-{Name}` header, and no tool declares `x-mcp-header`. `base-14` (no connection
  affinity) stays pending until plan tokens stop depending on the serving process.

## Owner decisions

The owner decided these on 2026-10-10. They came up while classifying the rows, and the affected
rows carry `ownerQuestion` with the decision's number. The rows stay pending until their step
lands with a test.

1. **Dynamic `resources/list` entries** (`resources-02`): the per-profile entries stay in the
   list. On the 2026-07-28 wire the list carries `ttlMs: 0` and `cacheScope: private`. This is a
   known deviation from the "fixed list" rule.
2. **`request_secrets` form mode (D-2)** (`mrtr-19`, `mrtr-20`, `mrtr-42`): on the 2026-07-28
   wire, `set_credentials` refuses form-mode secret elicitation and returns a hint to use the env
   file or secret files. The legacy wire is unchanged.
3. **A declined destructive apply on the modern wire** (`mrtr-34`): a decline returned through
   `input_required` burns the plan token, the same as a declined elicitation on the legacy wire.

Defaults that need no decision: caching TTLs are constants (lists 300000 ms public, static
resource reads 3600000 ms public, `server/discover` 300000 ms private). The `requestState` TTL
equals the plan-token TTL and uses a per-process HMAC key, with no new setting.
