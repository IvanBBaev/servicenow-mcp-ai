# Role review — Senior MCP protocol & AI-agent tooling engineer (2026-10-29)

Reviewer role: I judge the server the way an LLM agent and its host client meet it. That covers
tool names and descriptions as routing signals, input schemas as something a model fills in, error
payloads as self-correction prompts, the `tools/list` and result token economy, progressive
disclosure, prompts and skills, behaviour across clients (Claude Code, Claude Desktop, VS Code
Copilot, Cursor, Codex, Gemini CLI), and whether the evals measure what the roadmap claims.

Baseline: main @ dc29e9c · servicenow-mcp-ai 3.0.0 · scope: `src/mcp/*` (registry, define, params,
tool-search, params-errors, result-cap, result-hints, prompts/skills at header level), a sample of
tool specs in `src/tools/*.ts` (as published by the lean serializer), `evals/tool-selection`,
`project/CONFORMANCE-2026-07-28.md`, `project/TOKEN-OPTIMIZATION-PLAN-2026-10.md`,
`project/roadmap.yaml`, `project/TODO.md` (OD-12/13/15, O-10, O-19, O-21), and the 2026-07-28 tools
spec page (fetched 2026-10-29). No instance access.

## 1. Verdict

**Score: 7 / 10.** At the protocol level this server is more careful than almost every
ServiceNow MCP server I know of: the error contract, strict schemas, plan tokens, a shape-preserving
result cap, deterministic order and a conformance matrix. Its agent-facing quality, though, rests on
assumptions nobody has measured. No real model has ever been scored on tool selection. The default
profile shows 20 of 100 tools. On the 2026-07-28 wire the advertised escape hatch
(`enable_package`) refuses, so 80 tools can be found but not called. The byte budget has become a
ratchet that blocks features with no evidence of what each byte buys.

- **Top 3 risks:**
  1. Progressive disclosure is a dead end on the modern wire (RR-MC-01).
  2. Zero model-based selection signal: "33 %" is lexical separability, not accuracy (RR-MC-02).
  3. The budget lever blocks value without any eval link (RR-MC-03).
- **Top 3 strengths:**
  1. Flat error contract with code and hint, plus a strict schema whose errors come back as
     `isError` the model can fix.
  2. Shape-preserving result cap with `next_offset`, `format:"file"` and client size hints.
  3. Lean, deterministic `tools/list` with a full per-tool reference resource carrying examples.

## 2. What I examined

- `npm run -s tokens:report` (all profiles), plus a scratch dump of the published `tools/list` for
  `all` and `discovery` via `test/surface.js` → `listPublishedTools`. I read every published
  description and schema the way a model would.
- `src/mcp/define.ts` (`buildInputSchema`, `runSpec`, `normalizeParamAliases`),
  `src/mcp/params.ts`, `src/mcp/registry.ts`, `src/mcp/tool-search.ts`,
  `src/mcp/params-errors.ts`, `src/mcp/result-cap.ts`, `src/mcp/result-hints.ts`,
  `src/mcp/input.ts` (`onModernWire`), `src/core/errors.ts` (ERROR_CODES).
- `src/tools/admin.ts`: `togglePackage`, the find_tools handler, list_packages.
- Sampled specs: query_table, get_record, create_record, delete_record, describe_table,
  get_cmdb_meta, list_scripts, get_artifact, explain_artifact, where_used, search_code,
  get_artifact_dependencies, trace_table_event, get_flow / explain_flow, send_email.
- `evals/tool-selection/` (cases, backends, `baseline.offline.json`, `latest-offline.json`), and the
  skill eval folders `evals/skills/sn-*`.
- The 2026-07-28 spec, `server/tools`: list stability, list_changed via `subscriptions/listen`,
  input-validation errors as tool errors, structured content mirrored in text.
- Roadmap cross-check: N-18, N-36, N-57…N-65, N-59 (T2 dropped), N-63, N-74, N-67, N-82, F5-18,
  F5-21, O-10, O-19 (d), O-21, OD-12, OD-13, OD-15.

## 3. Strengths (keep doing)

- **Error contract that teaches.** `fail()` returns `code`, `hint` and `source`. ERROR_CODES has
  specific, recoverable codes (PLAN_REQUIRED, STALE_RECORD, AMBIGUOUS_KEY, POLICY_DENIED naming the
  setting, ELEVATION_REQUIRED). An unknown or typo'd argument is rejected by `.strict()` and comes
  back as `isError` (test/mcp-smoke.test.js:164), as the 2026-07-28 spec recommends. Spec-level
  -32602 is compressed into one line (`params-errors.ts`) instead of a zod dump.
- **Result economy.** `result-cap.ts` shrinks the largest array by binary search and keeps
  `note`, `plan_token` and `mermaid` intact. `truncated` + `note` + `next_offset` give the model a
  concrete next call. `format:"file"` and `SN_OVERSIZE_TO_FILE` keep big payloads out of context.
  Seven heavy readers emit `_meta["anthropic/maxResultSizeChars"]` (N-65).
- **Lean, cache-friendly list.** Shallow outputSchema on the wire with the full schema in
  `servicenow://reference/tools/{name}` (N-60). Defaults are omitted from annotations. The order is
  deterministic (N-38). Every tool has a schema-checked example call (N-56/N-35 reference).
- **Write safety designed for agents.** Plan by default, `apply:true`, and a single-use
  `plan_token` for destructive applies. The B4 "self-healing" rule turns a token-less apply into a
  preview instead of an error.
- **Naming.** A uniform `servicenow_<verb>_<noun>` prefix aggregates well next to other servers.
  v2 aliases are hidden unless `SN_LEGACY_TOOL_NAMES=1`. All four annotation hints are explicit in
  source.
- **Conformance discipline.** `CONFORMANCE-2026-07-28.md` has 316 covered rows and 2 named
  deviations. Few servers can show where they stand against the spec.
- **Skills over MCP plus a CLI installer** (F5-18 / N-76) for cursor, codex, gemini and agents,
  with trigger and negative eval sets per skill.

## 4. Findings

### RR-MC-01 — On the 2026-07-28 wire, 80 of 100 tools are findable but not callable (severity: high · verified)

- **Evidence:**
  - The default profile is `discovery`: 20 tools in admin/aggregate/schema/table (N-63, B20). This
    is confirmed by `tokens:report` and by the `initialize` instructions ("More via
    SN_TOOL_PACKAGES or servicenow_enable_package").
  - `togglePackage` in `src/tools/admin.ts` returns `fail(..., { code: "NO_PACKAGE_SESSION", hint:
PACKAGES_BY_CONFIG })` when `onModernWire()`. The hint says to set `SN_TOOL_PACKAGES` and
    restart.
  - The `find_tools` hint on the modern wire also says "Disabled packages: … restart".
  - This is correct per spec: the 2026-07-28 tools page says the list "MUST NOT vary per-connection
    or as a side effect of other requests". O-19 (d) and ADR 0008 fixed the lists per server. The
    instructions still advertise `enable_package` regardless of wire.
- **Why it matters:** an agent asked "explain this flow" or "who uses this script include" will
  find `servicenow_explain_flow` through `find_tools`, then has no way to call it. It cannot finish
  the job. Its only option is to tell a human to edit config and restart, which most users of a
  zero-config `npx` install will not do. The headline 100-tool value is unreachable by default on
  exactly the clients that negotiate the newest revision. On older wires `list_changed` works, but
  several clients ignore it or re-read the list only between turns (reported, community client
  matrices).
- **Recommendation:** add one dispatcher tool, `servicenow_call_tool { name, arguments }`. It
  validates `arguments` against the target's own zod schema and runs it through the same `runSpec`,
  so policy, plan/apply, plan tokens, journaling and redaction all stay intact. Permitted targets are
  any tool in a package the policy allows, not only the enabled set. Have `find_tools` return each
  match's lean `inputSchema` (or the reference URI) so the model can fill `arguments` in one step.
  This is legal on every wire because `tools/list` does not change. It is the established
  "tool-search + invoke" pattern that clients with deferred loading converge on.
  - Annotations: the dispatcher must not claim `readOnlyHint`. Mark it as destructive-capable and
    let the client confirm each call. Optionally offer two dispatchers (read and write) so
    read-only hosts can auto-approve the read one.
  - Make the `initialize` text and the `enable_package` description wire-aware so neither promises
    what the wire refuses.
- **Existing roadmap link:** none. O-19 (d) and N-63 settled list stability but not reachability.
  N-36 (find_tools) is done and only finds tools.

### RR-MC-02 — No real-model tool-selection score has ever been measured (severity: high · verified)

- **Evidence:**
  - `evals/tool-selection/baseline.offline.json` is `lexical-tfidf@0.05` over 149 cases: discovery
    16.1 % top-1, all 34.2 %, deferred 30.2 %. `latest-offline.json` is identical. The roadmap note
    for N-18 quotes 33.6 % for all, so the number already drifts between documents.
  - N-18's notes: "Real-model baseline dropped 2026-10-13 (owner: no ANTHROPIC_API_KEY)". O-10 (d)
    had chosen `claude-sonnet-5-5` with three repeats, about $60–90.
  - The backends are lexical, recorded and anthropic. None of them drives a subscription CLI
    (`claude -p`, the Agent SDK with a logged-in session, or `codex exec` / `gemini -p`).
  - N-59 phase T2 (−6 KB of description and parameter cuts) and "moving usage notes to the
    reference" were both dropped explicitly because no baseline exists.
- **Why it matters:** TF-IDF top-1 measures how distinct the descriptions are as bags of words.
  It does not predict what a model picks, because models read names, examples and argument
  structure and use world knowledge ("BR" is a business rule). So every token decision (budgets,
  T2, routing text, the discovery default) is taken blind, and the absence of a baseline has already
  frozen about 6 KB of savings. "32.9 %" or "34 %" must not appear anywhere as a quality figure.
- **Recommendation:** add a `cli` backend that shells out to `claude -p --output-format json` with
  the tool list injected as a stub MCP server, which runs on the owner's subscription with no API
  key. Or record one run per release in an interactive session into the existing `recorded`
  backend. Run discovery, all and deferred with three repeats and McNemar (already built). Commit
  the baseline. Label the lexical score "separability" in every report.
- **Existing roadmap link:** extends N-18 (its real-model part was dropped, not finished) and
  unblocks the N-59 T2 work the owner dropped on 2026-10-13.

### RR-MC-03 — The hard byte budget is the wrong lever now: it blocks value without measuring it (severity: high · judgement + verified)

- **Evidence:**
  - Headroom is 150 B on core, 277 B on discovery and 521 B on all (`tokens:report`).
  - OD-15 lists N-71, N-72, N-73, the rest of N-4, N-82 and N-74 as blocked by the budget. N-74
    alone needs +263 / +361 / +863 B, and N-67 about +1,100 B on all.
  - `all` is 121,591 B, about 30.4k tokens. Of that, inputSchema is 71.8 KB, parameter
    descriptions 23.6 KB and descriptions only 14.6 KB.
- **Why it matters:** the budget did its job. It took `all` from about 136 KB to 122 KB and forced
  the lean serializer. Now it is a ratchet with no exchange rate: a 300 B routing hint that could
  lift selection accuracy is refused the same way as 300 B of noise. Per-byte ceilings set a
  little above the current size turn every feature into a budget negotiation with the owner. The
  costs that matter to a client are tokens per profile, the per-tool cliff (some clients truncate
  long descriptions) and cache stability, not bytes on `all`.
- **Recommendation (answer to OD-15 / O-10):**
  1. Freeze `discovery` hard. It is the default and the one most users pay for.
  2. Turn `core`, `all` and the rest into token ceilings with planned headroom (for example
     `all` ≤ 32k tokens) plus a per-tool lint (description ≤ 600 B, any one tool ≤ 3.5 KB).
  3. A change that adds more than 200 B must show a non-negative eval delta (RR-MC-02), or be a
     new capability.
  4. Fund the blocked items from RR-MC-04 (about −2.5 KB) instead of raising ceilings.
- **Existing roadmap link:** OD-15, O-10, N-0, N-57. This finding proposes a replacement policy and
  does not reopen the closed N-57 work.

### RR-MC-04 — The `instance` parameter is published on 99 tools, including local-only ones (severity: medium · verified)

- **Evidence:**
  - `buildInputSchema` in `define.ts` adds `instance: instanceParam` ("Profile (default active)")
    to every tool that does not declare one.
  - The repeated-text analysis shows ×99 = 2,548 B on `all`. Total duplicated parameter text is
    8,434 B, including `apply` ×22 = 2,016 B.
  - It also appears on tools that never touch an instance: `find_tools`, `list_packages`,
    `enable_package`, `disable_package`, `explain_policy`.
  - Most installs configure one profile, so the parameter is dead weight in every request, and it
    is a hallucination target: models invent values like "prod" or "dev".
- **Why it matters:** this is the cheapest 2.5 KB on the list. It is enough to fund N-74 and most
  of N-67 together, with no change to wording.
- **Recommendation:**
  - Drop `instance` from local-only tools (a `local: true` spec flag). This is not breaking,
    because the argument is ignored there.
  - Publish `instance` only when more than one profile is configured. The list is still fixed per
    server, since profiles are read at start.
  - A call that passes `instance` to a single-profile server keeps working through the alias layer
    (`normalizeParamAliases`, or an accept-and-ignore), so strict validation does not turn old
    prompts into errors.
- **Existing roadmap link:** TK-41 / N-59 T2 (text shortening, dropped by the owner). This finding
  is different: it removes the parameter where it is not needed and leaves the text alone.

### RR-MC-05 — Overlapping tool clusters with no routing text (severity: medium · verified)

- **Evidence (published descriptions on `all`):**
  - list_scripts / get_script vs list_artifacts / get_artifact / explain_artifact
  - get_record vs get_change / get_ci / get_knowledge_article
  - query_table vs list_changes / list_cis
  - describe_table vs get_cmdb_meta
  - where_used vs search_code vs get_artifact_dependencies
  - trace_table_event vs generate_table_flow vs describe_table_logic
  - get_flow vs explain_flow
  - No description says "prefer X for …" or "not for …". The eval's cluster metric is 16.7 %
    (lexical), the weakest dimension.
- **Why it matters:** models fail mostly at the boundary between near-synonym tools, not on
  outliers. Generic `get_record` will win over `get_change` if nothing says the domain tool adds
  joins or derived fields, and the reverse wastes calls.
- **Recommendation:** add one routing clause (≤ 80 B) to the roughly 14 tools above, for example
  "Domain view of a change with tasks and approvals; for raw fields use get_record". Measure with
  the cluster metric on the model backend, and keep only the clauses that move it. That is about
  +1.1 KB, funded by RR-MC-04.
- **Existing roadmap link:** none. N-59 T2 cut text; it did not add routing.

### RR-MC-06 — `find_tools` is lexical only and returns no schema (severity: medium · verified)

- **Evidence:** `src/mcp/tool-search.ts` (90 lines) scores tokens with fixed weights (name 3,
  package 2, title 2, description 1, prefix half), stopwords and naive stemming. It has no synonym
  table and no domain abbreviations. The default limit is 8. Results carry name, package, title,
  description, readOnly and enabled, but no `inputSchema`.
- **Why it matters:** ServiceNow users speak in jargon: BR, SI, ACL, RITM, CI, UI policy,
  "workflow" when they mean Flow Designer, "catalog item". A lexical match on "BR" finds nothing.
  Combined with RR-MC-01, the agent's one discovery path is also its weakest.
- **Recommendation:** add a small, test-pinned synonym map (about 40 entries) applied to the query.
  Return the lean `inputSchema`, or the `servicenow://reference/tools/{name}` URI, for the top
  three matches. Add 20 jargon queries to the eval cases. 0 B on `tools/list`, apart from a
  `limit` description (RR-MC-09).
- **Existing roadmap link:** N-36 (done; this extends it).

### RR-MC-07 — `query_table` exposes 17 parameters, several of them rare REST flags (severity: low · verified)

- **Evidence:** the published schema includes `queryCategory`, `suppressPaginationHeader`,
  `queryNoDomain` and `domain` next to the core `table`, `query`, `fields` and `limit`. At
  3,064 B it is the second-heaviest tool, and the most-called one.
- **Why it matters:** each optional parameter is a chance for the model to set something
  plausible and wrong. Flat parameter lists with niche flags measurably raise argument errors.
- **Recommendation:** move the rare flags into an `advanced: {…}` object, or accept them only by
  alias and document them in the reference resource. This is BREAKING for callers that pass them
  flat, unless the aliases stay. Wait for the O-4 register.
- **Existing roadmap link:** none.

### RR-MC-08 — Write and delete descriptions do not mention the plan → apply → plan_token flow (severity: low · verified)

- **Evidence:** `delete_record` is "Delete a record from a table by its sys_id."; `create_record`
  is similar. The flow is explained only in the `initialize` instructions and the `apply` /
  `plan_token` parameter text. Lean annotations for `delete_record` show only
  `{"idempotentHint":true}` because default values are omitted.
- **Why it matters:** several hosts drop or truncate `instructions` (reported for some IDE
  clients). A model reading only the tool sees a delete that "just deletes", calls it once, gets a
  preview, and may report success. The B4 preview fallback prevents damage but costs a turn and
  confuses the user.
- **Recommendation:** add a 6–8-word suffix on the about 22 write tools ("Preview first; apply:true
  to run"). Destructive ones add "+ plan_token". About +700 B, funded by RR-MC-04. Keep
  `destructiveHint:true` explicit even if it costs bytes, because some clients treat a missing
  value as false.
- **Existing roadmap link:** none (N-59 T2 cut in the other direction).

### RR-MC-09 — Small description defects visible to the model (severity: low · verified)

- **Evidence:**
  - The `find_tools` `limit` parameter has no description.
  - The `enable_package` description mentions "list_changed is sent", which is protocol mechanics
    the model cannot act on, and is false on the modern wire.
  - The `initialize` text promises `servicenow_enable_package` regardless of wire.
- **Recommendation:** fix all three together with MC-I1. Net change about +/−0 B.
- **Existing roadmap link:** none.

### RR-MC-10 — The `all` profile is exactly 100 tools, sitting on known client caps (severity: low · verified + reported)

- **Evidence:** `tokens:report` gives `all` = 100 tools and `all+legacy` = 115. Windsurf caps at 100
  (F5-21). Cursor has historically warned at about 40 active tools across all servers, and Copilot
  limits tools per request to 128 (reported).
- **Why it matters:** one more tool on `all` breaks a supported client silently. A dispatcher
  (MC-I1) removes the pressure to make `all` the "get everything" answer.
- **Recommendation:** add a test assertion `all.length ≤ 100`. Document "use discovery + call_tool"
  as the answer for capped clients.
- **Existing roadmap link:** F5-21 (distribution / Windsurf). This adds the assertion only.

### RR-MC-11 — The skill evals are trigger tests, not outcome tests (severity: low · judgement)

- **Evidence:** the `evals/skills/sn-*` folders hold trigger and negative prompt sets (sn-discover
  has both). I found no task-completion or tool-sequence assertions for skills such as sn-safe-write
  (plan → confirm → apply order).
- **Why it matters:** a skill that triggers but leads the model to apply without a preview is the
  failure that matters. Trigger accuracy does not catch it.
- **Recommendation:** add, for sn-safe-write and sn-impact only, a recorded-transcript check that
  the expected tool sequence occurs, with a stub server. This reuses the `recorded` backend.
- **Existing roadmap link:** none. F5-18 / N-76 delivered the skills.

## 5. Proposed roadmap items

| Temp id | Title                                                                    | Findings       | Priority | Effort | tools/list                           | Breaking               | Owner decision                           |
| ------- | ------------------------------------------------------------------------ | -------------- | -------- | ------ | ------------------------------------ | ---------------------- | ---------------------------------------- |
| MC-I1   | `servicenow_call_tool` dispatcher + schema-bearing `find_tools`          | 01, 06, 09, 10 | P0       | M      | about +600 B on every profile        | no                     | yes (new tool on discovery; annotations) |
| MC-I2   | Model-based selection eval without an API key (`cli` / recorded backend) | 02, 03         | P0       | S–M    | 0 B                                  | no                     | yes (which model and which client)       |
| MC-I3   | Budget policy v2: frozen discovery, token ceilings, eval-gated growth    | 03             | P1       | S      | 0 B (policy)                         | no                     | yes (replaces O-10 bytes rule)           |
| MC-I4   | `instance` only where it means something                                 | 04             | P1       | S      | about −2.5 KB all, −0.5 KB discovery | no (accept-and-ignore) | yes (conditional schema)                 |
| MC-I5   | Routing clauses for overlap clusters and write-flow suffixes             | 05, 08         | P1       | S      | about +1.8 KB all                    | no                     | no, if MC-I2 shows a gain                |
| MC-I6   | `find_tools` synonym map + jargon eval cases                             | 06             | P1       | S      | +about 40 B (`limit` text)           | no                     | no                                       |
| MC-I7   | `query_table` advanced-flags object                                      | 07             | P3       | S      | about −400 B                         | yes (O-4)              | yes                                      |
| MC-I8   | Outcome checks for sn-safe-write / sn-impact                             | 11             | P2       | S      | 0 B                                  | no                     | no                                       |

### MC-I1 — `servicenow_call_tool` dispatcher + schema-bearing `find_tools`

- **Scope:**
  - New admin tool `servicenow_call_tool { name: ToolName enum or string, arguments: object }`.
  - It looks up the spec in the registry, checks the package against policy (not the enabled set),
    validates against the spec's strict schema, and runs through `runSpec`. It returns the target's
    result unchanged, including `structuredContent`.
  - `find_tools` adds a `schema` (lean input schema) for the top three matches.
  - The `initialize` text and the `enable_package` description become wire-aware.
- **Acceptance:**
  - On the 2026-07-28 wire with `discovery`, an agent can find and run `explain_flow` with no
    restart (smoke test over `InMemoryTransport`).
  - Plan tokens, policy denial, journaling and redaction behave the same as with a direct call
    (parity test over the 22 write tools).
  - Errors on an unknown `name` carry a hint naming `find_tools`.
  - `hooks/require-plan-token.mjs` treats `call_tool` with a destructive target as destructive.
- **Dependencies / gates:** O-10 (+bytes on discovery, funded by MC-I4). Check with O-19 that
  "fixed list, dynamic dispatch" is acceptable (it is spec-legal). Coordinate with N-82 (tasks) so
  task support flows through.

### MC-I2 — Model-based selection eval without an API key

- **Scope:** an `evals/tool-selection` backend `cli` that renders the profile's `tools/list` to a
  stub MCP server, runs `claude -p --output-format json --mcp-config …` once per case, and parses
  the first tool_use. Optional `codex exec` / `gemini -p` adapters. Rename the lexical metric to
  "separability" in reports and docs.
- **Acceptance:**
  - A committed `baseline.model.json` for discovery, all and deferred with three repeats.
  - The README states what the score means.
  - Every PR that changes `tools/list` text by more than 200 B attaches a delta (outside the gate).
- **Dependencies / gates:** O-10 (d) model choice (already `claude-sonnet-5-5`). Owner choice of
  subscription versus key. Unblocks N-59 T2, MC-I3 and MC-I5.

### MC-I3 — Budget policy v2

- **Scope:** update `test/fixtures/token-budgets.json` semantics:
  - `discovery`: hard byte ceiling, as today.
  - Other profiles: token ceiling (bytes ÷ 4, or a tokenizer if available) with declared headroom.
  - Per-tool lint (description ≤ 600 B, tool ≤ 3.5 KB).
  - Documented "growth must show eval delta or be a new capability" rule in CONTRIBUTING.
- **Acceptance:** OD-15 closed. N-74 and N-67 land without a ceiling raise once MC-I4 is in.
- **Dependencies / gates:** O-10, OD-15. Best after MC-I2.

### MC-I4 — `instance` only where it means something

- **Scope:**
  - A `local: true` spec flag drops `instance` from admin and local tools.
  - `buildInputSchema` publishes `instance` only when `profiles.length > 1` at start.
  - An incoming `instance` on a single-profile server is accepted and ignored if it matches the
    active profile, and refused with a hint otherwise.
- **Acceptance:**
  - `all` is about −2.5 KB, verified with `tokens:report`.
  - Manifest regenerated.
  - Multi-profile servers are unchanged.
  - `test/output-schema.test.js` covers both modes.
- **Dependencies / gates:** O-10, the O-4 note (schema varies by configuration, not by
  connection, so it is spec-legal).

### MC-I5 — Routing clauses and write-flow suffixes

- **Scope:** one ≤ 80 B routing clause on about 14 cluster tools. A preview/apply suffix on about
  22 write tools. `destructiveHint` explicit on destructive tools.
- **Acceptance:** the cluster metric (model backend) improves by ≥ 4 points, using the existing
  McNemar rule. Clauses that do not help are reverted.
- **Dependencies / gates:** MC-I2. Bytes funded by MC-I4.

### MC-I6 — `find_tools` synonyms

- **Scope:** `src/mcp/tool-search-synonyms.ts` (about 40 pairs, test-pinned), plus a `limit`
  description and 20 jargon eval cases.
- **Acceptance:** all 20 jargon cases return the expected tool in the top 3 (lexical, so it can
  run in the gate).
- **Dependencies / gates:** none.

### MC-I7 — `query_table` advanced flags

- **Scope:** move `queryCategory`, `suppressPaginationHeader`, `queryNoDomain` and `domain` under
  `advanced`, keeping flat aliases for one major.
- **Acceptance:** the schema has ≤ 13 top-level properties. The alias test passes.
- **Dependencies / gates:** O-4 BREAKING register.

### MC-I8 — Skill outcome checks

- **Scope:** recorded transcripts for sn-safe-write and sn-impact, asserting the tool sequence
  (preview before apply; the token passed).
- **Acceptance:** the check runs offline in `eval:skills` and fails if the sequence breaks.
- **Dependencies / gates:** MC-I2 (the recorded format).

## 6. Owner decisions needed

1. **Dispatcher on the default profile (MC-I1).**
   - Options: (a) add `call_tool` to discovery; (b) add it only to an opt-in profile; (c) keep the
     restart-only answer.
   - Recommendation: **(a)**. Without it, the default install on the newest wire is a 20-tool
     server that advertises 100.
2. **How to get a real-model baseline without an API key (MC-I2).**
   - Options: (a) a `claude -p` subscription backend; (b) one manual recorded run per release;
     (c) a paid key run ($60–90, as decided in O-10 (d)).
   - Recommendation: **(a)**, with (b) as the fallback.
3. **Budget policy (OD-15 / O-10, MC-I3).**
   - Options: (1) lower budgets to the measured sizes; (2) keep the current headroom; (3) policy
     v2: frozen discovery, token ceilings elsewhere, eval-gated growth, funded by MC-I4.
   - Recommendation: **(3)**. Option (1) deepens the blockage, and (2) only postpones it.
4. **Conditional `instance` (MC-I4).**
   - Options: (a) publish only with more than one profile and drop it from local tools; (b) local
     tools only; (c) leave it.
   - Recommendation: **(a)**.
5. **`query_table` flags (MC-I7).**
   - Options: (a) nest them in the next major; (b) leave them.
   - Recommendation: **(a)**, low priority.

## 7. Metrics this role would track

| KPI                                                                    | Current value                                                                        | Target                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Tools callable without restart on the 2026-07-28 wire, default profile | 20 / 100                                                                             | 100 / 100 (via MC-I1)                                   |
| Model top-1 tool-selection accuracy (discovery / all)                  | not measured (lexical separability 16.1 % / 34.2 %)                                  | baseline committed, then ≥ +4 pt per routing change     |
| `tools/list` size: discovery / all                                     | 23,531 B / 121,591 B (≈ 30.4k tokens)                                                | discovery frozen; all ≤ 32k tokens with ≥ 2 KB headroom |
| Duplicated parameter text on `all`                                     | 8,434 B (`instance` 2,548 B)                                                         | ≤ 5,500 B                                               |
| `find_tools` jargon recall@3                                           | not measured (no synonyms)                                                           | 20 / 20                                                 |
| Share of `fail()` sites with a `hint`                                  | not computed; INVALID_INPUT (27) and NOT_CONFIGURED (25) are the most frequent codes | ≥ 90 %                                                  |
