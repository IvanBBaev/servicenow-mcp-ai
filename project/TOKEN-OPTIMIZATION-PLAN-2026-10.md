# servicenow-mcp-ai — Token Optimization Plan (2026-10)

Date: 2026-10-05 · Status: **proposed — docs only, no code.** Baseline: `main` at `2dda123` (97 tools in
26 packages, 1672 tests).

This is the implementation plan for the token economy. It is round 9 of the 2026-10 gap pass and refines
round 6 ([TOKEN-DOCS-ANALYSIS-2026-10.md](TOKEN-DOCS-ANALYSIS-2026-10.md), findings `TK-01` … `TK-20`,
items N-35 … N-44). Round 6 set the strategy. This round measured the mechanics and decided the order of
work. It adds:

- findings `TK-34` … `TK-51` (§2);
- work packages `N-57` … `N-65` (§4), tracked as rows 141–149 in [ROADMAP-V3.md](ROADMAP-V3.md);
- changes to N-18, N-36, N-37, N-39 and N-40 (§5);
- sub-questions on the existing owner gates O-4, O-10, O-19 and O-21 (§7). No new gate is added.

Round 8 (TK-30 … TK-33, N-54 … N-56, **P0**, in the same analysis) runs before this plan. Two of its
items interact with this one:

- **N-54** adds an outputSchema to the 60 tools that lack one. That grows `tools/list`. N-60 (shallow
  output schemas) keeps the published cost of N-54 low, so N-54 should land after N-57 and N-58, or state
  its delta against the N-57 fixture.
- **N-56** scans the model-facing text. Every description rewrite in N-59 has to pass that scan.

## Method

1. **Analysis v1.** The tech lead measured `tools/list` on the current build with an in-process `McpServer`
   and an `InMemoryTransport` client. The measurement broke the list down by component and by JSON key,
   and listed the heaviest tools and the repeated parameter descriptions.
2. **Meta-analysis.** The tech lead then listed what v1 could not know. That gave six gaps:
   - client behaviour;
   - whether the changes can be built in SDK 1.31 / zod 4;
   - real ServiceNow payload sizes;
   - the risk to tool-selection accuracy;
   - how to measure and gate the results;
   - sequencing and owner gates.

   Each gap got a senior role:

   | Role                                                | Gap                                                              |
   | --------------------------------------------------- | ---------------------------------------------------------------- |
   | R1 — MCP protocol and client-integration specialist | spec text 2025-11-25 and 2026-07-28; Claude Code binary and docs |
   | R2 — TypeScript / Node architect                    | SDK 1.31 and v2 sources; prototype post-processor                |
   | R3 — ServiceNow platform architect                  | Table / Aggregate / Change API behaviour; synthetic records      |
   | R4 — LLM tool-design / agent-UX engineer            | all 97 definitions; selection risk; eval design                  |
   | R5 — QA / measurement architect                     | budget test, tokenizers, gate design                             |
   | Tech lead                                           | synthesis, sequencing, gates                                     |

   A principal-engineer red-team review then checked the draft. Its changes are in §9.

3. **Rules for the role reviews.** They read the repo and changed nothing in it. Their prototypes and
   measurement scripts ran in a scratch directory.

Evidence marker:

- **verified**: the claim was re-checked in code, in `node_modules`, in the spec text or by a measurement
  during this round.
- **estimate**: the claim is a reasoned number with its basis stated.

Sizes are UTF-8 bytes of `JSON.stringify(tools)` from a clean env.

## 1. Measurements

### 1.1 Where the `tools/list` bytes go (verified)

| Component                                    | core (24 tools) | all (97 tools) |
| -------------------------------------------- | --------------- | -------------- |
| total                                        | 32,737          | 135,956        |
| inputSchema                                  | 16,987          | 75,824         |
| — parameter descriptions                     | 7,051           | 29,833         |
| — `$schema` (draft-07 URI, every schema)     | ~1,200          | 4,900          |
| — `maxLength` / `pattern`                    | ~2,100          | 8,300          |
| outputSchema (incl. 1.9 KB `$schema` in all) | 6,594           | 21,961         |
| tool descriptions                            | 3,031           | 13,966         |
| annotations + `execution`                    | 2,778           | 11,207         |
| titles                                       | 664             | 2,314          |

- **Heaviest tools:**

  | Tool                        | Size  | Note                        |
  | --------------------------- | ----- | --------------------------- |
  | `get_status`                | 4,418 | of which outputSchema 3,801 |
  | `explain_artifact`          | 3,807 |                             |
  | `get_artifact_dependencies` | 3,529 |                             |
  | `upsert_artifact`           | 3,440 |                             |
  | `get_artifact`              | 3,197 |                             |
  | `query_table`               | 2,987 |                             |
  | `generate_fluent`           | 2,592 |                             |

- **Repeated parameter text** would save ~7.1 KB in `all` if each text appeared once:

  | Text                                    | Repeats |
  | --------------------------------------- | ------- |
  | `instance` ("Profile (default active)") | ×96     |
  | `apply`                                 | ×21     |
  | `plan_token`                            | ×8      |
  | the registry `type`                     | ×6      |
  | `update_set`                            | ×5      |

### 1.2 Prototype of the mechanical cuts (verified, R2)

The prototype is a post-processor over the real `tools/list` output. Every transformed inputSchema still
compiles in Ajv. The steps are cumulative.

| Step                                                        | core Δ | all Δ   | all after |
| ----------------------------------------------------------- | ------ | ------- | --------- |
| drop `$schema`                                              | −1,872 | −6,968  | 128,988   |
| omit `execution` when it is `forbidden`                     | −960   | −3,880  | 125,108   |
| drop `maxLength` where an anchored pattern bounds it        | −300   | −1,215  | 123,893   |
| strip ±2^53−1 integer bounds                                | −81    | −324    | 123,569   |
| drop `propertyNames:{type:"string"}`                        | −340   | −1,326  | 122,243   |
| omit annotation hints equal to the spec default (safe rule) | −638   | −2,780  | 119,463   |
| outputSchema reduced to `{type:"object"}`                   | −5,562 | −18,762 | 100,701   |

Two of v1's estimates were too high:

- the integer bounds save 0.3 KB, not ~1 KB;
- the annotation step saves 2.8 KB under the safe rule (N-58, remeasured by the red team), not 5.1 KB. Dropping every
  default hint would also drop `destructiveHint: false` on read tools.

### 1.3 Runtime payloads (estimate, R3, synthetic OOTB records — no PDI)

| Table          | Fields, all | Bytes, all fields | Empty-string share | Summary set |
| -------------- | ----------- | ----------------- | ------------------ | ----------- |
| incident       | ~95–100     | 2.4–4 KB          | ~55 % of keys      | ~340 B      |
| change_request | ~140        | 3.5–6 KB          | ~55–60 %           | ~400 B      |
| sys_user       | ~100        | 2.2–3 KB          | ~60 %              | ~300 B      |
| cmdb_ci_server | ~170        | 3.5–5 KB          | ~70 %              | ~350 B      |
| sys_script     | ~50         | 1.5–6 KB (script) | ~45 %              | ~300 B      |

What this means for a default call:

- A default `query_table` (10 incidents, all fields) is **24–40 KB, about 8–14k tokens**. The summary set
  brings it down to ~3 KB (−88 %).
- Omitting empty fields saves −42 % per record.
- `display_value=all` costs 2.4× the raw size.

### 1.4 Bytes against tokens (verified, R5)

These were measured offline on the live `all` list with `gpt-tokenizer` (o200k), `@anthropic-ai/tokenizer`
and `tokenx`:

- On schema JSON, all three are within ±5 % of bytes / 4.
- ServiceNow records are denser, about 3.1 bytes per token, so bytes / 4 undercounts responses by ~25 %.
- The tokenizer for current Claude models is not public.

## 2. Findings

### 2.1 Measurement and gates

- **TK-34 — The budget ratchet is inert (verified).**
  - `TOOLS_LIST_BUDGET_ALL = 151_000` and `TOOLS_LIST_BUDGET_CORE = 36_500` in
    `test/output-schema.test.js`.
  - The numbers 150,916 / 36,158 come from a comment and are not measured.
  - The tree measures 135,956 / 32,737 with or without `baselineEnv()`.
  - That leaves about 15 KB of growth before the test fails.
- **TK-35 — Drift goes unnoticed (verified).** N-0 recorded 135,881 B for `all`, and the tree is now at
  135,956 B. Nothing flagged the +75 B.
- **TK-36 — N-0 trimmed descriptions without an eval baseline (verified).**
  - GAP-ANALYSIS-2026-10 orders the N-18 baseline first, but `evals/` does not exist.
  - N-0's selection impact is therefore unknown.
- **TK-37 — Bytes are the right unit for the gates (verified).**
  - Bytes are deterministic and need no dependency.
  - Token figures in reports use fixed ratios: 4.0 for schema and text, 3.1 for records.
  - An owner-run calibration against `messages/count_tokens` refreshes the ratios. It stays outside the
    gate.

### 2.2 The `tools/list` surface

- **TK-38 — Schema mechanics cost ~13.7 KB in `all` and carry no information (verified).**
  - `$schema` declares draft-07. Without it, MCP defaults to JSON Schema 2020-12, the dialect every
    implementation must support (2025-11-25 and 2026-07-28 specs).
  - The emitted schemas use no `$ref`, `$defs`, `prefixItems`, tuple `items` or `format`, so dropping
    `$schema` changes no semantics.
  - The other carriers are listed in §1.2: `execution: forbidden` (the spec default), length bounds
    repeated by a pattern, the safe-integer bounds and `propertyNames`.
- **TK-39 — Annotations always carry all four hints (verified).**
  - The spec defaults are `readOnlyHint:false`, `destructiveHint:true`, `idempotentHint:false` and
    `openWorldHint:true`.
  - Only a value equal to its default can be omitted. An absent `destructiveHint` means destructive, so
    `destructiveHint:false` must always stay.
- **TK-40 — outputSchema is 22 KB that no model reads (verified, R1; the model-side part is inferred).**
  - The Anthropic tool definition has only `name`, `description` and `input_schema`.
  - The SDK 1.31 client validates `structuredContent` against outputSchema with Ajv, so the schema still
    has a wire role. 37 of 97 tools declare one today.
- **TK-41 — Shared parameter text is duplicated in code as well as on the wire (verified).**
  - `instanceParam` and `planTokenParam` are in `src/mcp/define.ts`.
  - `applyInput` is in `src/mcp/write-mode.ts`.
  - `updateSetInput` is in `src/tools/table.ts`, with a private copy in `src/tools/updatesets.ts`.
- **TK-42 — Model-facing text has stale and internal content (verified).**
  - `generate_fluent` says the SDK target is "not type-checked". It has been SDK-verified since
    2026-10-01.
  - `upsert_artifact` exposes the gate id "O-5".
  - Error-code mechanics, file layouts and caps sit in descriptions where a reference resource would do.
- **TK-43 — The M-6 targets cannot be reached by trimming (verified, R2 / R4).**
  - The targets are `all` ≤ 45 KB and `core` ≤ 14 KB.
  - Every mechanical cut together leaves `all` at ~98 KB and `core` at ~22.5 KB.
  - The rest needs structural change: a narrower core, discovery, or consolidation, which is BREAKING.
- **TK-44 — Claude Code changes what costs model tokens (verified, R1 — docs and the 2.1.286 binary).**
  - **Tool search is on by default.** Only tool names and server instructions load up front; a full
    definition loads on demand.
  - **Text is dropped.** When a result has `structuredContent`, the text blocks are discarded and the
    model sees the serialized structured payload.
  - **Truncation limits.** Descriptions and server instructions are truncated at 2,048 characters.
  - **File persistence.** Results over 50,000 characters are persisted to a file unless
    `_meta["anthropic/maxResultSizeChars"]` raises the limit.
  - **What this means.** In Claude Code the text-plus-structured duplication costs wire bytes only, and
    `tools/list` size matters per loaded tool. Clients that load everything (Claude Desktop, VS Code,
    Cursor — not re-verified) pay for the full list.
- **TK-45 — 2026-07-28 clashes with per-session packages (verified, R1).**
  - The 2026-07-28 spec says `tools/list` "MUST NOT vary per-connection or as a side effect of other
    requests". It may vary by authorization.
  - M-5 dynamic packages and N-36's "enable a package for the session" break that rule.
  - It is a design decision for O-19, not a migration step.

### 2.3 Results

- **TK-46 — Only `query_table` JSON is size-capped (verified).**
  - `ok()` (`src/mcp/result.ts`) applies no cap. Only `okQueryResult` does.
  - The comment in `src/mcp/define.ts` that says the payload is "truncated by ok()" is wrong.
  - The `format:"csv"` path of `query_table` is uncapped.
  - `deliverJson` keeps oversize snapshot, compare and document results inline unless
    `SN_OVERSIZE_TO_FILE` is on.
- **TK-47 — Three reads can explode (verified in code; sizes are estimates).**
  - **`list_tables`** with no filter runs `fetchAll` over `sys_db_object` (`src/api/meta.ts`). That is
    ~7–9k rows on a PDI, ~400–600 KB, and it is sent twice because the tool declares an output.
  - **`list_changes`** sends no default `sysparm_limit` and keeps all fields (`src/api/change.ts`).
  - **`describe_table`** on wide CMDB classes is ~18 KB.
- **TK-48 — `SN_MAX_RESULT_CHARS` (100,000) is twice Claude Code's 50,000-character persistence
  threshold.** Large results reach Claude Code as files anyway, and other clients get ~25k tokens.
- **TK-49 — Reference display values are missing in three places, so the model makes follow-up calls
  (verified).**
  - `get_record` has no `displayValue` input.
  - `aggregate` sends no `sysparm_display_value`, so a `groupBy` on a reference returns sys_ids.
  - `query_table` defaults to `false`.
- **TK-50 — A tabular form exists but is poor (verified).**
  - `format:"csv"` encodes `{value, display_value}` cells as JSON inside CSV, which is then escaped again
    inside JSON.
  - The truncation loop halves the row count, so 10 rows drop to 5 even when 9 would fit.
  - `getTableChain` makes one request per hierarchy level.
- **TK-51 — N-39 as planned saves no model tokens (verified for Claude Code, R1; other clients inferred).**
  - Claude Code shows only `structuredContent`, and other clients show only the text.
  - No client capability says "I read `structuredContent`", and `clientInfo` should not drive behaviour.
  - So a structured-only payload would starve one client family or the other.

## 3. Design principles for this round

1. **Measure first.** No cut lands without the before/after protocol in N-57, and a description change
   needs an N-18 run.
2. **Pure transforms, replaceable wiring.**
   - The `tools/list` cuts are pure functions over JSON Schema.
   - In SDK 1.31 they are wired through the `tools/list` request handler, the only wire-level hook.
   - At N-35 the wiring moves to a Standard Schema wrapper, and the functions stay.
3. **The specification is kept at the source.**
   - Specs keep all four annotation hints and every zod `.max()`; the leaning happens at publish time.
   - `test/schema-bounds.test.js` and the "every tool declares all four annotation hints" test keep
     guarding the specs.
4. **Safety text is never moved out of the per-parameter residue.** Server instructions are not read by
   every client, and Claude Code truncates them at 2 KB.
5. **Fix bugs first.** The uncapped results in TK-46 and TK-47 are bugs. Opt-in compact forms ship
   before any default change (O-21).
6. **Names are frozen after M-7.** Consolidation is optional, BREAKING and last.

## 4. Work packages

Every package must:

- state its byte delta per profile (`core` / `discovery` / `all`);
- update `npm run gen:manifest` and the budgets fixture;
- end with a green `npm run check`, bar the known `pack:check` failure.

### N-57 — Token measurement harness (M) — first

- **Why:** TK-34, TK-35, TK-37.
- **Files:**
  - `test/surface.js`: `measureSurface(profile, env)` → `{bytes, tools, perTool[{name, description, title,
annotations, inputSchema, outputSchema}]}`. It pins env (tasks off, legacy names off), and the test,
    the report and the budget test use it. It is async, because it reads the wire through an in-process
    client.
  - `test/fixtures/token-budgets.json`: `{profiles: {core, discovery, all, "all+tasks", "all+legacy"},
slackPct: 2}`. `discovery` is a placeholder until N-63.
  - `scripts/tokens-budget.mjs --write`: sets each budget to the measured value rounded up to 256 B.
  - `scripts/tokens-report.mjs` (`npm run tokens:report`):
    - the §1.1 breakdown, with estimated tokens at the TK-37 ratios;
    - duplicate-text savings and the top-15 tools;
    - deltas against the fixture;
    - `--json` output, and `--base <ref>`, which builds the ref in a temp worktree.
  - `scripts/gen-manifest.mjs` → manifest v5, with per-tool `size: {description, inputSchema,
outputSchema, total}`. - These sizes are **spec-derived**: they come from the sync `describeToolSchemas` after the N-58
    transform, with no task or legacy input. The wire figures come only from `measureSurface`. - The manifest version bump (currently `MANIFEST_VERSION = 4`) is coordinated with any bump that N-56
    makes, so there is one bump.
- **Tests:**
  - `test/output-schema.test.js` reads the fixture.
  - New: "tools/list budget is tight (ratchet down)". It fails when the measured size is under
    `budget × (1 − slackPct/100)`, so a saving cannot sit as headroom.
  - `test/tool-size.test.js`: "every tool stays within its size caps". It uses global caps plus a named
    `OVERSIZE_ALLOW` map, with a reason per entry and a stale-entry check.
  - `test/response-size.test.js` with `test/fixtures/responses/*.json`. These are synthetic,
    anonymised ServiceNow payloads, marked `synthetic: true` until O-5, served through
    `createFetchDouble`. They cover:
    - `query_table` / `get_record` on a 100-column incident;
    - a 200-row page;
    - `describe_table`, `get_status`, `get_artifact`, `explain_artifact`;
    - one `okStructured` tool per family.

    Each case records `{textBytes, structuredBytes}`.

- **E-5:**
  - `recordToolCall` gains result bytes, kept separately for text and structured content.
  - `ToolStats` gains `bytesTotal`, `bytesP50` and `bytesP95`.
  - Prometheus gets `sn_tool_result_bytes`.
  - This is the metrics part of N-40.
- **Budgets:**
  - The first `--write` lowers the stale constants to the measured 135,956 / 32,737 (rounded up).
  - Tightening is not a restatement, but O-10 (a) confirms the method.
  - After that, lowering is automatic and reviewed as a diff. Raising a budget is a manual edit that
    needs O-10.
- **Gate:** none, bar O-10 (a).
- **Order (red team):**
  - The budget fixture with the lowered budgets is step 1 of N-57. It lands inside R0, **before N-54**.
    Otherwise N-54's outputSchema growth (≈ +24–36 KB on `all`, see §6) would fall inside today's
    ~15 KB of dead headroom and go unmeasured.
  - It only tightens, so it changes no wire. The rest of N-57 stays in T0.

### N-18 refined — selection eval baseline (M) — with N-57, before any description change

The size and runs below replace N-18's "≤ 2 points" rule, which is below the noise floor (TK-36).

- **Case set (~150 cases):**
  - one positive paraphrase per tool (97);
  - 30 cases across ~10 confusable clusters, e.g. `query_table` / `aggregate` / `get_record`,
    `get_artifact` / `explain_artifact` / `get_artifact_dependencies`, `get_flow` / `explain_flow`;
  - 15 plan → apply write tasks;
  - 8 cases where no tool fits or the tool is in a disabled package.
- **Metrics:**
  - top-1 accuracy, overall and per cluster;
  - argument validity (zod parse against the live inputSchema);
  - plan-first compliance;
  - calls per task;
  - tokens per task, from API usage.
- **Runs:**
  - Single-step cases stop at the first `tool_use`. Multi-step cases run through the fetch double.
  - There are three surface modes: `all`, `core` + `find_tools`, and simulated tool search (names only
    plus a search tool).
  - At least two models, one of them small.
  - Three repeats, with paired comparison (McNemar).
- **Acceptance:** top-1 is not below the baseline by more than 4 points, and no flagship task
  regresses.
- **Baseline:** the first run covers `78fa65c` (before N-0) and `HEAD`, so it checks N-0 after the fact.
- **Gate:** "description change needs a fresh eval".
  - The eval stores the manifest `description_sha256` values it ran against. They already exist
    (`scripts/gen-manifest.mjs`), so no new hash is introduced.
  - The test fails when they differ. It needs no API key.
  - The eval itself is owner-run (an API key, model ids: O-10 (d)).

### N-58 — Lean `tools/list` serializer (S) — after N-57; the wire change waits for O-10 (b)

- **Why:** TK-38, TK-39.
- **Files:**
  - New `src/mcp/lean-list.ts`, with pure `leanJsonSchema(schema)` and `leanToolsList(tools)`.
  - **Wiring (verified, red team).** In SDK 1.31 `McpServer` installs the `tools/list` handler once,
    lazily, on the first `registerTool` (`setToolRequestHandlers`). It never reinstalls it, including
    after a package is enabled or disabled.
    - In `registerAllTools` (`src/mcp/registry.ts`), patch `server.server.setRequestHandler` on the
      instance for the duration of registration.
    - When the schema is `ListToolsRequestSchema`, wrap the handler so its result passes through
      `leanToolsList`.
    - Restore the original method afterwards.
    - This is an instance patch, not the Proxy that `src/mcp/packages.ts` uses: the SDK calls
      `this.server.setRequestHandler` on the target, so a Proxy would not see the call.
    - Fallback: re-set the handler after registration through `Protocol.setRequestHandler`, which does
      not assert on an existing handler.
  - The same transform in `describeToolSchemas`, so the manifest matches the wire.
  - `wireAnnotations(spec.annotations)` at the annotation site in `registry.ts`, including the legacy
    alias registration.
  - Annotations are not part of `describeToolSchemas`. The manifest takes them from `describeAllTools`,
    which also feeds `get_status`. The manifest gets the wire form. `get_status` keeps the full spec
    form, because it is a diagnostic.
- **Rules:**
  1. Drop `$schema` in input and output schemas.
  2. Drop `execution` when `taskSupport` is `forbidden`.
  3. Drop `maxLength` only when the **whole** pattern matches the anchored form
     `^\^\[[^\]]+\]\{(\d+),(\d+)\}\$$` and `maxLength` ≥ the pattern's `n`.
     - 96 of 307 bounded strings carry a pattern.
     - The comma field-list pattern (`+`) and the email pattern (it contains `{1,64}` but has
       `maxLength` 254) do not match the form, so they keep their bound.
     - `minLength` stays, because its removal is unmeasured.
  4. Drop `maximum` / `minimum` equal to ±(2^53−1).
  5. Drop `propertyNames: {type: "string"}`.
  6. Annotations:
     - omit `openWorldHint: true`, `idempotentHint: false` and `readOnlyHint: false`;
     - omit `destructiveHint: true` on write tools;
     - always keep `readOnlyHint: true`, `destructiveHint: false` and `openWorldHint: false`.
- **Not done:**
  - `title` stays. It is display-only, so removing it saves wire bytes but no model tokens, and UI
    clients use it in approval prompts.
  - zod `.max()` stays in the source, so the bounds walker is unaffected.
- **Tests:**
  - Unit tests for each rule.
  - A wire smoke test: no `$schema`, no `execution` and no ±2^53−1 bound in `tools/list`. It guards the
    SDK's lazy-init order.
  - A dialect guard: no `$ref`, `$defs`, `prefixItems` or `format` in any published schema, since the
    published schemas now default to 2020-12.
    - N-54's "shared definitions" are shared in source only and inlined on the wire.
  - The "all four hints" test stays on specs.
  - `mcp-smoke` also checks that the SDK client still validates `structuredContent`.
- **Budget:**
  - `all` 135,956 → 119,463 B (−16,493, of which −2,780 is the safe annotation rule).
  - `core` 32,737 → 28,546 B.
  - Both are verified by the red-team prototype.
- **At N-35:** rule 2 becomes free, because v2 passes `execution: undefined`. The wiring moves to a
  Standard Schema wrapper (`~standard.jsonSchema`), and the manifest takes one more churn as the dialect
  moves to 2020-12.

### N-59 — Shared parameters and description hygiene (S) — after N-58 and an N-18 baseline

- **Why:** TK-41, TK-42.
- **Files:**
  - New `src/mcp/params.ts`, the single source for `instance`, `plan_token`, `apply`, `update_set`, the
    registry `type` / `sys_id` / `key` triple and the alias text.
  - `src/mcp/define.ts`, `src/mcp/write-mode.ts`, `src/tools/table.ts` and `src/tools/updatesets.ts`
    import from it, which removes the private copy.
- **Per-parameter text (the safety-bearing part stays):**

  | Parameter    | Description                                          |
  | ------------ | ---------------------------------------------------- |
  | `instance`   | "Profile"                                            |
  | `apply`      | "Execute; omit for a plan preview" (35 B, was 103 B) |
  | `plan_token` | "From the plan preview"                              |
  | `update_set` | "Update set (sys_id or name) to record in"           |

- **Server instructions:** one `update_set` line (~120 B) is added, within the 2,048 B cap pinned by
  `test/server-info.test.js`. Profile, plan → apply and `plan_token` are already stated there.
- **Descriptions:**
  - Fix the stale `generate_fluent` text and remove "O-5" from `upsert_artifact`.
  - Rewrite the heaviest descriptions as the R4 drafts propose. Each new text leads with verb + object,
    names a discriminator and drops the mechanics. For example, the `query_table` description:

    > Read records from any table with an encoded query, fields and paging (Table API). Prefer
    > servicenow_aggregate for counts. Syntax: servicenow://reference/encoded-query.

  - Usage detail moves to the N-37 resource `servicenow://reference/tools/{name}`. That covers error-code
    mechanics, the `^` / HTTP 414 note, file layouts, caps and the `fetchAll` strategy.
  - Descriptions that only echo a `sysparm_*` name get 5–8 words.

- **Tests:** the N-18 eval (must pass the acceptance rule), the manifest fixture, the reference resource
  test and `test/server-info.test.js`.
- **N-56 scan:** every rewrite passes `scan:surface`.
  - Its URL allowlist must accept `servicenow://reference/...`.
  - Its cross-tool-directive rule must accept the server's own `servicenow_*` names.
- **Budget:** about −6 KB on `all` and −1.7 KB on `core` (estimate).

### N-60 — Shallow output schemas (S) — waits for O-10 (c)

- **Why:** TK-40.
- **Surface:**
  - Published outputSchema keeps the top-level property names and their JSON types.
  - Nested objects become `{type: "object"}` and arrays become `{type: "array"}`.
  - `additionalProperties: {}` stays on the wire, as `test/output-schema.test.js` asserts. It is never
    `false`, so Ajv-validating clients keep passing.
  - The full schema stays in `servicenow://reference/tools/{name}`.
  - It is done in `leanJsonSchema` with `mode: "output"`. The full zod output shape stays the test oracle
    in `test/output-schema.test.js`.
- **Why shallow instead of absent:** with no schema, the SDK client no longer protects `structuredContent`
  on the 37 tools that have an outputSchema today (all 97 after N-54).
- **Trade-off with N-54 (O-10 (c)):**
  - Code-mode clients build typed bindings from nested output shapes, which is the purpose of N-54.
  - A shallow published schema keeps the `tools/list` cost low.
  - The nested shape then lives only in the reference resource.
  - The owner chooses between the two, or chooses shallow for `all` only and full for the `alwaysLoad`
    tools.
- **Budget (verified, red team, with today's 37 schemas):** −9.3 KB on `all` and about −2.8 KB on
  `core`. Keeping names, types and `required` saves −10,324 / −3,025 B, and keeping
  `additionalProperties: {}` costs back about 1 KB. Dropping the schema entirely saves 18.8 / 5.6 KB.
- **Tests:** a published output schema stays a valid JSON Schema, and the real `structuredContent` of
  every golden validates against it.

### N-61 — Result size safety (S) — bug fixes now; the default lowering waits for O-21 (b)

- **Why:** TK-46, TK-47, TK-48, TK-50.
- **Surface:**
  - **Universal cap.**
    - **Placement.** The cap lives in `runSpec` (`src/mcp/define.ts`), **before** the
      `withStructuredContent` branch. That branch runs only when `spec.output` is set, so a cap there would
      miss the tools without an outputSchema, `list_changes` among them. The `query_table` CSV path is
      included.
    - **Shape preservation (blocker, red team).**
      - The SDK server validates `structuredContent` against the full zod output schema before
        returning. A payload with a missing required key fails with `InvalidParams`.
      - Text that is not JSON gets no `structuredContent`, and the SDK then throws "has an output schema
        but no structured content".
      - So the cap never cuts the serialized text. It shrinks the largest array in the payload by binary
        search on its length, then re-serializes.
      - Every output shape declares optional `truncated` and `note` fields.
      - The cap never removes a required key, `plan_token` or an error body.
      - `okQueryResult`'s last fallback, which drops `records`, is replaced by an empty array.
    - **What it measures.** The serialized structured payload when there is one, which is what Claude Code
      shows the model, and otherwise the text. N-65's `maxResultSizeChars` uses the same measure.
    - **The `format:"file"` hint** appears only on the tools that support it.
    - Fix the wrong "truncated by ok()" comment.
  - **Truncation by binary search on rows** instead of halving.
  - **Default limits.**
    - `list_tables` with no filter: a default `limit` of 200, `truncated` and a hint to filter.
    - `list_changes`: a default `sysparm_limit` of 10.
  - **`getTableChain`** dot-walks `super_class` six levels per request. It loops from the last ancestor
    while that ancestor is non-empty, keeping today's `MAX_CHAIN_DEPTH = 20` (`src/api/meta.ts`).
    - A short chain would silently drop inherited columns from `describe_table`.
    - A multi-level `super_class.super_class…` dot-walk in `sysparm_fields` is unverified until O-5.
- **Opt-in now, default under O-21 (b):**
  - lower `SN_MAX_RESULT_CHARS` to 48,000, under Claude Code's 50,000 threshold;
  - an oversize result goes to a file automatically and returns a `resource_link` plus a short summary.
    This is the "auto file result" of N-40.
- **Tests:**
  - a cap test per non-query tool family;
  - **every capped golden still passes the tool's zod output schema**;
  - truncation keeps the maximum row count that fits;
  - the `list_tables` / `list_changes` defaults;
  - a chain of 20 levels resolved in ⌈20/6⌉ requests;
  - the
    `docs:env --check` / settings-manifest snapshot.
- **Breaking?**
  - The universal cap and the `list_changes` limit change outputs only for results that were already
    harmful. They are bug fixes, recorded in the CHANGELOG.
  - The `list_tables` default limit changes an existing call's result. It needs an O-4 register entry
    unless the owner rules it a fix under O-21 (b).

### N-62 — Platform-aware compact reads (M) — opt-in now; defaults wait for O-21 (a)

- **Why:** TK-49, TK-50.
- **Replaces:** the `fields:"display"` / `format:"table"` part of N-40.
- **`fields: "summary"` resolver.**
  - It works per table and profile and is cached in the schema LRU.
  - **Hierarchy:** one dot-walked `sys_db_object` call.
  - **Display field:** the child-most `display=true` column from `describeTable`, falling back to `name`
    and then `number`.
  - **List view:** the default list layout from `sys_ui_list_element`, using the query below.
    Formatter elements (names starting with `.`) are dropped. If the table has no layout, the resolver
    walks up the hierarchy.

    ```text
    list_id.name=<t>^list_id.view.name=NULL^list_id.parentISEMPTY^list_id.sys_userISEMPTY^ORDERBYposition
    ```

  - **Result:**
    - `sys_id`, the display field, up to 12 list columns and `sys_updated_on`;
    - with no layout, a heuristic set filtered by the dictionary;
    - the response states `field_set: "summary"` and the resolved `fields`.
  - **Cost:** 0 extra calls when warm, 1–3 cold.

- **`display_value: "display"` mode.**
  - It asks for `all` on the requested columns, then compacts each column by dictionary type:

    | Column type    | Output                                     |
    | -------------- | ------------------------------------------ |
    | reference      | `[sys_id, name]`                           |
    | choice         | the label, plus the value when they differ |
    | dates          | raw UTC                                    |
    | journal fields | excluded unless named                      |

  - `get_record` gains `displayValue`.
  - `aggregate` gains `displayValue`, with default `true` when `groupBy` is set under O-21 (a).

- **`omit_empty: true`.**
  - Only with a top-level `columns` list, plus `empty_omitted: <n>`.
  - The note says: "absent column = empty string; columns not in `columns` were not requested; a field
    hidden by ACL may also be absent".
  - It never omits `"0"` or `"false"`.
- **`format: "table"`.** The shape is `{columns, rows, cell, total, truncated}`:
  - a value equal to its display value collapses to a scalar;
  - a reference becomes `[sys_id, display]`;
  - redaction runs before encoding;
  - the cap works on rows;
  - it does not reuse CSV.
- **Tests:**
  - goldens on the N-57 incident fixtures, before and after;
  - the summary resolver with and without a list layout, on a custom table and with an inherited
    display field;
  - omit-empty semantics;
  - the table form with `display_value: all`.
- **Expected saving per default query (estimate):**
  - summary: −85–90 %;
  - table form: −30–45 % on top;
  - omit-empty: −42 % per all-field record.
- **Unverified until O-5:**
  - the default-view query;
  - journal size under `display_value=true`;
  - the display-field fallback order;
  - field-ACL omission;
  - the Change API value-pair shape.

### N-63 — Narrow core and a discovery profile (M) — refines N-36; waits for O-10 (b) and O-19 (d)

- **Why:** TK-43, TK-45.
- **Surface:**
  - `attachment` leaves `core`. That saves 3,395 B even after N-58 (measured, red team).
  - `servicenow_find_tools` joins `core` and returns names and one-line descriptions by intent.
  - `discovery` becomes a budget profile and the documented default.
  - `all` becomes a non-default profile.
- **Per-connection invariant (O-19 (d)):** the 2026-07-28 spec forbids a `tools/list` that varies per
  connection. One of three options must be chosen before N-36's per-session package enabling ships:
  - packages scoped by configuration or authorization;
  - `find_tools` returns full definitions inline, to call through a generic dispatcher;
  - accept the deviation until N-35.
- **Claude Code hint:** `_meta["anthropic/alwaysLoad"]` on ~5 core tools (`get_status`, `query_table`,
  `aggregate`, `describe_table`, `find_tools`) under O-21 (c).
- **Budget (estimate):**
  - `core` after N-58 … N-60 is ~24.0 KB; after N-63 it is ~21.2 KB. **The old `core ≤ 20 KB` goal of
    N-36 is not met.**
  - Reaching 20 KB needs one more cut: the `schema` package out of `core`, or no outputSchema on the
    core tools.
  - Reaching 14 KB needs both.
- **BREAKING:** two changes alter what an existing caller sees, so each needs an O-4 register entry
  beside O-10 and O-19:
  - `discovery` as the default profile;
  - `attachment` leaving `core`.
- **Tests:**
  - the N-18 eval in `core + find_tools` mode;
  - the `discovery` budget profile;
  - a `find_tools` golden.

### N-64 — Selective consolidation (S) — optional, BREAKING, proposed B14, waits for an O-4 amendment

- **Why:** TK-43.
- **Surface.** Only the low-risk pairs merge, behind the `SN_LEGACY_TOOL_NAMES` alias path:
  - `list_atf_tests` + `list_atf_suites`;
  - `run_atf_test` + `run_atf_suite`;
  - `list_packages` + `enable_package` + `disable_package`, split by read and write;
  - the read-only local docs tools.
- **Rules:**
  - Read and write tools never merge, because client approval keys off `readOnlyHint`.
  - The `explain_*` family stays separate.
  - The artifact read family stays separate. Claude Code tool search matches names, and verbs in names
    help selection.
- **Budget:** about −3 KB on `all` (estimate).
- **Acceptance:** the N-18 eval is neutral or better. Otherwise the package is dropped.

### N-65 — Client result hints (S) — waits for O-21 (c)

- **Why:** TK-44, TK-48.
- **Surface:**
  - `_meta["anthropic/maxResultSizeChars"]` on the deliberately large readers: `document_*`, `snapshot`,
    `compare_*`, `get_script`. These get a file in Claude Code today.
  - The value is tied to the N-61 cap.
  - `resource_link` results, from N-61, are preserved by Claude Code (verified, R1).
- **Tests:** the `_meta` presence per tool, and the setting that turns the hints off.

## 5. Changes to existing items

- **N-18:** refined as in §4: size, acceptance rule, surface modes and the hash gate. It moves to phase T0.
- **N-36:** becomes N-63. The `core ≤ 20 KB` goal is restated to ≤ 22 KB (§6). Per-session enabling
  waits for O-19 (d).
- **N-37:** the per-tool size lint and the manifest sizes move to N-57. The reference resource is used by
  N-59. The "top-level outputSchema only" part becomes N-60.
- **N-39:** **parked until N-35.** TK-51 shows that structured-only payloads save no model tokens today
  and risk one client family. Instead:
  - the error text keeps the full diagnostic (Claude Code reportedly drops `structuredContent` on
    `isError`, unverified);
  - the wire duplication is reduced only through N-61's caps and N-62's compact forms.
  - Parking N-39 while N-54 adds `structuredContent` to every tool doubles the wire bytes of each result,
    text plus structured. In Claude Code the model still sees one copy. The owner accepts this under
    O-21 (d), or N-39's opt-in `SN_STRUCTURED=0` lands with N-54.
- **N-40:**
  - the metrics part moves to N-57;
  - the auto-file result and the cap move to N-61;
  - `fields` / `format` move to N-62;
  - only `SN_MAX_RESULT_TOKENS` with a `next` cursor stays in N-40. It counts records at 3.1 B per token
    (TK-37).
- **N-38:** a deterministic-order test can land now, inside N-57. `ttlMs` and `cacheScope` stay after
  N-35. They are MUST on complete list results in 2026-07-28.

## 6. Projected budgets

All figures are bytes for a clean env. Each phase takes effect when its owner gate is decided.

| After                         | core    | all      | Basis                                 |
| ----------------------------- | ------- | -------- | ------------------------------------- |
| today                         | 32,737  | 135,956  | measured                              |
| N-57 (budgets tightened)      | 32,737  | 135,956  | budgets 32,768 / 136,192              |
| N-58 lean serializer          | 28,546  | 119,463  | verified (safe annotation rule)       |
| N-59 shared params + texts    | ~26,850 | ~113,460 | estimate (−1.7 / −6 KB)               |
| N-60 shallow outputSchema     | ~24,050 | ~104,160 | verified delta (−2.8 / −9.3 KB)       |
| N-63 narrow core              | ~21,250 | ~104,760 | −3,395 attachment, +~600 `find_tools` |
| N-64 consolidation (optional) | ~21,250 | ~101,760 | estimate                              |

These rows leave out **N-54** (P0, R0), which adds an outputSchema to the ~60 tools that lack one:

- about +24–36 KB on `all` at today's 594 B average per schema;
- about +14 KB once shallow, at ~230 B per tool.

N-54 states its own `core` delta. So the realistic `all` after T3 is about **119 KB** with N-60, and
about 130–140 KB without it.

The `{type:"object"}`-everywhere figure of 98,382 used the unsafe annotation rule. With the safe rule it
is 100,701, and that is the floor for output-schema cuts on today's 37 schemas.

**Proposed restatement of the M-6 targets (O-10 (b)):**

- `discovery` (the default) ≤ 22 KB, with a stretch of 14 KB (§4 N-63);
- `all` ≤ 120 KB as a non-default profile, including N-54;
- the 45 KB `all` target is retired. It would need more than 60 % further cuts through BREAKING
  consolidation, at medium selection risk.

In Claude Code with tool search, the cost to the model is paid per loaded tool. That makes the per-tool
caps (N-57) matter more than the profile totals.

## 7. Owner decisions

New sub-questions on existing gates (added to [TODO.md](TODO.md) and [ROADMAP-V3.md](ROADMAP-V3.md)):

- **O-10** (`tools/list` budget):
  - (a) the budgets-as-data method, with the automatic tightening ratchet;
  - (b) the restated targets in §6, and the wire changes of N-58 and N-63;
  - (c) shallow output schemas (N-60), and the trade-off with N-54's code-mode goal;
  - (d) the eval reference models and API budget for N-18.
- **O-19** (2026-07-28), sub-question (d): how M-5 / N-63 meet the "`tools/list` MUST NOT vary per
  connection" rule.
- **O-21** (response defaults):
  - (a) the `fields: "summary"`, `display_value: "display"`, `format: "table"` and `aggregate` display
    defaults (N-62);
  - (b) whether the `SN_MAX_RESULT_CHARS` default drops to 48,000, whether the automatic file result is
    on, and whether the `list_tables` default limit counts as a bug fix (N-61);
  - (c) the Claude Code `_meta` hints `anthropic/alwaysLoad` and `anthropic/maxResultSizeChars` (N-63,
    N-65);
  - (d) N-39 parked until N-35, and the doubled wire bytes after N-54.
- **O-4** is already approved, so each of these is a register amendment:
  - the proposed **B14** selective consolidation (N-64), or a name freeze after M-7;
  - `discovery` as the default profile, and `attachment` out of `core` (N-63);
  - the `list_tables` default limit (N-61), unless it is ruled a fix.
- **O-5** (PDI): the checks listed under N-62, plus real record sizes for the five tables in §1.3.

## 8. Sequencing

R0 (N-45 … N-56, P0) still runs first.

- **One proposed change inside R0:** N-57 step 1 (the budget fixture with the lowered budgets) lands
  before N-54. It only tightens. Its reason is in §4 under N-57.
- Phases T0 … T4 run after R0. The table below gives their order.

| Phase | Items                                                    | Gate                     | Why this order                                            |
| ----- | -------------------------------------------------------- | ------------------------ | --------------------------------------------------------- |
| T0    | N-57, N-18 baseline, N-38 order test                     | O-10 (a), (d)            | Without measurement and a baseline, no cut can be judged. |
| T1    | N-61 bug fixes, N-58, stale-text fix from N-59           | O-10 (b) for N-58's wire | Bugs first; the mechanical cut is risk-free and measured. |
| T2    | N-59, N-60, N-62 (opt-in), N-40 token cap                | O-10 (c)                 | Text changes behind the eval; compact forms opt-in.       |
| T3    | N-63, N-65, O-21 default flips                           | O-10 (b), O-19 (d), O-21 | Structural and default changes need the decisions.        |
| T4    | N-64 (optional), N-35 rewiring of N-58, N-38 cache hints | O-4, O-19                | BREAKING and protocol work last.                          |

Implementation starts with N-57 (§4).

## 9. Red-team review

A principal-engineer red team reviewed the draft against the code and the SDK sources, and remeasured
with scratch prototypes. Every finding is incorporated above. In order of severity:

1. **Blocker.** A naive universal cap would break tools with an outputSchema. The SDK validates
   `structuredContent` against the full zod schema, and non-JSON text yields no structured payload.
   - Fix: N-61 caps in `runSpec`, keeps the shape and tests every capped golden against the schema.
2. **Major.** The draft left out round 8's N-54, which adds ~60 output schemas. The draft also counted 30
   output schemas where there are 37, and it let the ratchet stay inert during R0.
   - Fix: the §6 note, the N-60 trade-off, the dialect-guard note and N-57 step 1 before N-54.
3. **Major.** The N-60 saving was overstated (−15 → −9.3 KB on `all`).
4. **Major.** §6 used a figure from the unsafe annotation rule and had one arithmetic slip, so it was
   recomputed. The attachment saving is now 3,395 B (measured).
5. **Major.** "Six levels" would regress `getTableChain` from today's depth of 20. Fix: dot-walk in a
   loop.
6. **Major.** The N-63 profile changes and the `list_tables` limit are BREAKING. Fix: they are routed to
   O-4.
7. **Minor.** Fixes made:
   - the exact pattern form for N-58 rule 3;
   - the setRequestHandler instance patch, not a Proxy;
   - the annotation source for the manifest;
   - reuse of `description_sha256` and the N-56 scan allowlist;
   - one manifest bump;
   - spec-derived manifest sizes.

**Verified by the red team:**

- `ok()` is uncapped, and the "truncated by ok()" comment is wrong.
- Unbounded reads:
  - `listTablesUncached` runs `fetchAll` when unfiltered;
  - `listChanges` has no default limit;
  - `aggregate` sends no display value.
- Budgets: the constants are 151,000 / 36,500, and the comment figures 150,916 / 36,158 are not
  measured. The wire measures 135,956 / 32,737.
- The §1.2 deltas match:
  - `$schema`, `execution`, `maxLength`, the integer bounds and `propertyNames` are exact;
  - Ajv compiles every transformed schema;
  - `execution` is always `forbidden`.
- Output schemas: no top-level `additionalProperties: false`, and 5 nested ones.
- SDK client: validates `structuredContent` with Ajv.
- Repo internals:
  - `schema-bounds` walks the zod specs;
  - `createFetchDouble` exists;
  - `registerAllTools` and `describeToolSchemas` work as described.

## 10. External references

- [MCP specification 2025-11-25 — tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP specification 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [Claude Code — MCP (tool search, output limits, `_meta` keys)](https://code.claude.com/docs/en/mcp)
- [VS Code — MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)
