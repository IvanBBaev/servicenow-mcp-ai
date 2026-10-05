# servicenow-mcp-ai — Token Economy & Documentation Analysis (2026-10)

Date: 2026-10-04 · Status: **proposed — docs only, no code.** Baseline: `main` at `78fa65c` plus
the uncommitted N-0 / N-6 / N-8 work (97 tools in 26 packages).

This pass asks two questions:

1. **What does the server cost the model in tokens, and how can it cost less?**
2. **How should the project document itself, given what changed in AI-facing documentation in
   2025–2026?**

While checking those questions it found a third topic that comes first: the **MCP
specification 2026-07-28** deprecates features this server uses and plans to use.

It is round 6 of the 2026-10 gap pass ([GAP-ANALYSIS-2026-10.md](GAP-ANALYSIS-2026-10.md);
round 5 is [UIB-ANALYSIS-2026-10.md](UIB-ANALYSIS-2026-10.md)). The details are:

- findings `TK-01` … `TK-29` (round 7, §2.5, TK-21 … TK-29: the agent harness and distribution, **P0**);
- plan items `N-35` … `N-53`, tracked as rows 119–137 in [ROADMAP-V3.md](ROADMAP-V3.md);
- new owner gates **O-19** … **O-22**.

Evidence marker: **verified** means the claim was re-checked during this pass, in code, in
`node_modules` or in the npm registry. A byte count becomes an approximate token count by
dividing by four.

## 1. Measurements

| What                                                             | Value                                                                                                                                                                         | Source                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `tools/list`, all packages                                       | 150,916 B (~38k tokens)                                                                                                                                                       | `test/output-schema.test.js:80-84`  |
| `tools/list`, `core`                                             | 36,158 B (~9k tokens)                                                                                                                                                         | same                                |
| Times the budget was raised                                      | 8 since M-6                                                                                                                                                                   | `test/output-schema.test.js:37-90`  |
| Heaviest definitions                                             | `get_status` 4,493 B, `explain_artifact` 3,682 B, `get_artifact_dependencies` 3,400 B, `upsert_artifact` 3,322 B, `get_artifact` 3,051 B, `query_table` 2,829 B               | `test/fixtures/tools-manifest.json` |
| Result cap per call                                              | `SN_MAX_RESULT_CHARS` = 100,000 (~25k tokens)                                                                                                                                 | `src/core/settings.ts:24`           |
| Tools that send their payload twice (text + `structuredContent`) | 30                                                                                                                                                                            | `src/mcp/result.ts` `okStructured`  |
| Installed MCP SDK                                                | `@modelcontextprotocol/sdk` 1.31; latest 1.x is 1.32.0; both speak up to protocol `2025-11-25`                                                                                | `node_modules`, npm                 |
| SDK with protocol `2026-07-28`                                   | the v2 split packages `@modelcontextprotocol/server` / `@modelcontextprotocol/core` 2.3.0                                                                                     | npm (`core` 2.3.0 dist)             |
| Tracked Markdown                                                 | 84 files, 1.46 MB                                                                                                                                                             | `git ls-files '*.md'`               |
| Largest docs                                                     | `ROADMAP-V3.md` 211 KB, `CHANGELOG.md` 156 KB, `README.md` 126 KB, `DEEP-REVIEW-2026-09.md` 112 KB, `SDK-PARITY.md` 111 KB, `DONE.md` 105 KB, `GAP-ANALYSIS-2026-09.md` 98 KB | `wc -c`                             |
| AI-facing site files                                             | `docs/llms.txt` (2.3 KB), `docs/index.html` (169 KB); no `llms-full.txt`                                                                                                      | `docs/`                             |

## 2. Findings

### 2.1 MCP specification 2026-07-28

The 2026-07-28 revision does the following:

- It makes the protocol core stateless. The `initialize` handshake and `Mcp-Session-Id` are
  removed, and every request carries its version and capabilities in `_meta`.
- It adds `server/discover`, multi round-trip requests (`input_required`), the `Mcp-Method` /
  `Mcp-Name` headers, and cacheable list results (`ttlMs`, `cacheScope`, deterministic order).
- It moves Tasks to the `io.modelcontextprotocol/tasks` extension.
- It replaces Dynamic Client Registration with Client ID Metadata Documents.
- It deprecates Roots, Sampling, Logging and the legacy HTTP+SSE transport, with a minimum
  window of 12 months.

| Id    | Finding                                                                                                                                                                                                                                                                                                                     | Evidence                                                                                                                                           | Severity | → Item |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| TK-01 | **The SDK line we use cannot speak the new protocol.** Version 1.31 is installed and 1.32.0 is the latest 1.x; both stop at `2025-11-25`. The 2026-07-28 support is only in the v2 split packages (`@modelcontextprotocol/server` / `core` 2.3.0). Moving to them is a dependency and import migration, not a version bump. | **verified**: `node_modules/@modelcontextprotocol/sdk/dist/esm/types.js`; npm registry; the `core` 2.3.0 dist contains the `2026-07-28` code paths | High     | N-35   |
| TK-02 | **N-9 is planned on a deprecated feature.** Sampling summaries rely on `sampling/createMessage`, which 2026-07-28 deprecates.                                                                                                                                                                                               | **verified**: `project/GAP-ANALYSIS-2026-10.md` N-9                                                                                                | High     | N-35   |
| TK-03 | **The log bridge uses deprecated Logging.** M-8 forwards server logs with `sendLoggingMessage`.                                                                                                                                                                                                                             | **verified**: `src/mcp/log-bridge.ts:38,79`                                                                                                        | Medium   | N-35   |
| TK-04 | **HTTP sessions are built on `Mcp-Session-Id`.** H-7 requires the header and generates session ids. The stateless core removes both.                                                                                                                                                                                        | **verified**: `src/mcp/http-sessions.ts:170,219`                                                                                                   | Medium   | N-35   |
| TK-05 | **Tasks and identity move.** M-9 implements experimental core tasks (`SN_EXPERIMENTAL_TASKS`), which are now an extension with `tasks/get` / `tasks/update`. N-17 (HTTP identity) was planned before the DCR → CIMD change.                                                                                                 | **verified**: `src/mcp/tasks.ts`; N-17 plan                                                                                                        | Medium   | N-35   |

### 2.2 Tool surface

| Id    | Finding                                                                                                                                                                                                                                                                             | Evidence                                                                                                   | Severity | → Item |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------- | ------ |
| TK-06 | **The `tools/list` budget is a ratchet.** It has been raised eight times, and the N pillar adds at least another 20 KB. N-0's description trim reclaimed bytes once, but the surface keeps growing. Clients that load every tool upfront pay ~38k tokens before the first question. | **verified**: `test/output-schema.test.js:37-90`                                                           | High     | N-36   |
| TK-07 | **The heaviest definitions are schema-bound.** The six largest tools are 2.8–4.5 KB each, mostly `outputSchema` and long enum or parameter prose. Nothing measures description and schema bytes separately, and there is no per-tool cap.                                           | **verified**: manifest sizes above                                                                         | Medium   | N-37   |
| TK-08 | **Detailed tool help has no home outside the description.** Usage notes, examples and edge cases either bloat the description or are missing. `servicenow://reference/tools` lists tools but has no per-tool page.                                                                  | **verified**: `src/mcp/resources.ts`                                                                       | Medium   | N-37   |
| TK-09 | **Dynamic packages break prompt caching.** M-5 changes the tool list mid-session (`listChanged`), which invalidates the client's cached prefix. Lists carry no `ttlMs` / `cacheScope`, and nothing asserts a stable order. Cache hits cost about a tenth of uncached input.         | **verified**: `src/mcp/packages.ts:153-241` (the SDK's `enable()` / `disable()` emit `tools/list_changed`) | Medium   | N-38   |

### 2.3 Responses

| Id    | Finding                                                                                                                                                                                                                                                                                                   | Evidence                                                             | Severity | → Item |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------- | ------ |
| TK-10 | **30 tools send every payload twice.** `okStructured` returns the same JSON as text and as `structuredContent`. Whether the model sees both depends on the client, but the wire always carries both.                                                                                                      | **verified**: `src/mcp/result.ts` (`okStructured`)                   | Medium   | N-39   |
| TK-11 | **The result cap is in characters and high.** The 100,000-character default is ~25k tokens for one call. Truncation is honest (`truncated: true` plus a note) but counts characters, not tokens. Large results are not sent to a file (S-11 `format:"file"`) or a `resource_link` unless the caller asks. | **verified**: `src/core/settings.ts:24`; `src/mcp/result.ts:125-212` | Medium   | N-40   |
| TK-12 | **Record lists repeat every key.** A list of N records with K fields repeats K keys N times. There is no tabular form (columns once, rows as arrays, or a CSV / TOON-like encoding), which typically saves 30–60 % on uniform lists.                                                                      | **verified**: `src/mcp/result.ts`                                    | Medium   | N-40   |
| TK-13 | **`query_table` returns every field by default.** Without `fields`, the instance returns all columns of the table.                                                                                                                                                                                        | **verified**: `src/api/table.ts:125`                                 | Medium   | N-40   |
| TK-14 | **Response size is not observed.** E-5 metrics count calls and latency, not bytes per tool, so the token cost of a tool in real use is unknown.                                                                                                                                                           | **verified**: `src/core/metrics.ts`                                  | Low      | N-40   |

### 2.4 Documentation

| Id    | Finding                                                                                                                                                                                                                                                     | Evidence                                          | Severity | → Item |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------- | ------ |
| TK-15 | **The doc corpus is large and has no index.** 84 Markdown files, 1.46 MB. Six files are over 100 KB. Completed analyses sit next to live plans. An agent or reader that opens the wrong file spends tens of thousands of tokens.                            | **verified**: sizes in §1                         | High     | N-41   |
| TK-16 | **The roadmap status is prose in a table.** Status lives in 211 KB of Markdown. "How far are we?" needs a hand-parsed count, and the row notes repeat CHANGELOG and DONE.                                                                                   | **verified**: `project/ROADMAP-V3.md`             | Medium   | N-41   |
| TK-17 | **The tool reference is part of a 126 KB README.** `docs:sync` keeps the counts honest, but the per-package reference is not generated from the manifest and cannot be fetched one package at a time.                                                       | **verified**: `README.md`; `scripts/` docs checks | Medium   | N-42   |
| TK-18 | **The site has `llms.txt` but no `llms-full.txt` and no Markdown pages.** The landing page is 169 KB of HTML. Serving Markdown to agents saves most of that.                                                                                                | **verified**: `docs/`                             | Low      | N-42   |
| TK-19 | **No `AGENTS.md`.** Contributor agents (Codex, Copilot, Cursor and others) read `AGENTS.md`, the cross-tool convention. The repo has only `.github/copilot-instructions.md` (4.4 KB), whose architecture prose is hand-written and can drift from the code. | **verified**: repo root; `.github/`               | Low      | N-43   |
| TK-20 | **Decisions have no committed home.** Architecture decisions (ARCH-10, ARCH-14, the O-gates) are spread over TODO, ROADMAP rows and analyses, with no record format and no "superseded by" link.                                                            | **verified**: `project/TODO.md`                   | Low      | N-44   |

### 2.5 Agent harness and distribution (round 7, P0)

Added 2026-10-04 at the owner's request, with the **highest priority (P0)**: N-45 … N-53 run
before every other N item. N-0 still applies to any item that changes `tools/list`; only N-50
does, and it adds no tools.

The repo ships these harness pieces today:

- a Claude Code plugin with a marketplace entry (`.claude-plugin/`);
- five skills (`skills/`, 8.9 KB);
- one `PreToolUse` hook (`hooks/require-plan-token.mjs`);
- `.github/copilot-instructions.md`, `docs/llms.txt`, `server.json` and `smithery.yaml`;
- MCP prompts, elicitation, and tool annotations (29 files use `readOnlyHint`).

| Id    | Finding                                                                                                                                                                                                                                                                                                     | Evidence                                                      | Severity | → Item |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------- | ------ |
| TK-21 | **An assistant settings file is tracked.** `.claude/settings.json` was committed in `46812ba`, although the project keeps assistant harness files out of git. It also allows `git add *` and `git commit *` without a prompt, which contradicts the rule that nothing is committed without an explicit ask. | **verified**: `git ls-files .claude`                          | High     | N-45   |
| TK-22 | **Agent instructions are not scoped by path.** Current agents load rules only for the files being edited (nested `AGENTS.md`, `.github/instructions/*.instructions.md` with `applyTo`, `.cursor/rules/*.mdc`). The repo has one flat 4.4 KB `copilot-instructions.md`, so every task pays for every rule.   | **verified**: `.github/`                                      | Medium   | N-46   |
| TK-23 | **The plugin has no subagents.** Plugins can ship `agents/*.md` subagents with their own tool allowlist and context window. A read-only reviewer or investigator keeps large ServiceNow payloads out of the main conversation.                                                                              | **verified**: `.claude-plugin/plugin.json` keys; no `agents/` | Medium   | N-47   |
| TK-24 | **One hook only.** Nothing injects the active profile and write mode at session start. Nothing reacts when a result comes back `truncated` with a hint to narrow `fields` or use `format`.                                                                                                                  | **verified**: `hooks/hooks.json`                              | Medium   | N-48   |
| TK-25 | **Skills are untested.** The five skills have structural tests (`test/plugin-skills.test.js`) but no behavioural evals. Plugin eval suites (`claude plugin eval`) can check that a skill triggers on the right prompts and calls the right tools. N-18 covers tool selection, not skills.                   | **verified**: `test/`                                         | Medium   | N-49   |
| TK-26 | **No MCP Apps.** The MCP Apps extension lets a tool return an interactive `ui://` view that the client renders in the chat. Plan diffs, Mermaid diagrams, `explain_flow` and the UIB page tree are all text today.                                                                                          | **verified**: no `ui://` in `src/`                            | Medium   | N-50   |
| TK-27 | **No MCP bundle.** Claude Desktop installs `.mcpb` bundles (formerly DXT) in one click, with a typed settings form that marks secrets as sensitive. The server reaches Claude Desktop only through manual JSON config, `npx` or Smithery.                                                                   | **verified**: no `manifest.json` / `.mcpb`                    | Medium   | N-51   |
| TK-28 | **Skills reach Claude Code only.** Agent Skills (`SKILL.md`) is an open format that other agents (Copilot in VS Code, Codex) also read. The skills ship only inside the Claude plugin, and the VS Code extension does not offer them.                                                                       | **verified**: `skills/`, `extension/package.json`             | Low      | N-52   |
| TK-29 | **The docs are not in agent doc indexes.** Coding agents fetch library docs on demand from indexes such as Context7, which a project claims with a `context7.json`. The server's docs are not indexed.                                                                                                      | **verified**: no `context7.json`                              | Low      | N-53   |

## 3. Design principles

- **Measure first.** Every token item lands with a byte measurement before and after, checked
  in a test like the `tools/list` budget.
- **Defaults change only through an owner gate.** A smaller default response or a structured-only
  channel changes what existing clients see, so it goes through O-21. New forms are opt-in until
  then.
- **Progressive disclosure over trimming.** Moving detail to on-demand resources, packages and
  skills beats cutting words that help the model choose the right tool. N-18 (tool-selection
  eval) guards any description change.
- **Generate, don't hand-write.** Every derived doc (tool reference, `llms-full.txt`, roadmap
  status, agent instructions) is generated and `--check`ed in `npm run check`, like
  `docs:env` and `docs:sync`.
- **Protocol before features.** No N item builds new surface on a feature 2026-07-28 deprecates.

## 4. Implementation plan

### N-35 — Protocol 2026-07-28 alignment (L) — owner gate O-19

- **Why:** TK-01 … TK-05.
- **Step 1 — spike.** On a branch, move to `@modelcontextprotocol/server` / `core` 2.x. Record:
  - the import and API changes;
  - what the `tools/list`, `outputSchema`, completion and resource code needs;
  - whether 2025-11-25 clients still work, because the v2 packages also speak older versions.
- **Step 2 — the migration, by area:**
  - **HTTP (H-7):** stateless request handling with the `Mcp-Method` / `Mcp-Name` headers.
    Session state, where the server still needs it, goes into the journal and plan-token keys,
    not into the transport.
  - **Logging (M-8):** stderr plus result `_meta` warnings take over from the log bridge. The
    bridge stays behind its flag for the deprecation window.
  - **Tasks (M-9):** move to the `io.modelcontextprotocol/tasks` extension.
  - **Sampling (N-9):** N-9 is re-scoped to a client-side prompt that summarises a result,
    using no server-initiated sampling, or it is dropped.
  - **Identity (N-17):** rebased on CIMD.
  - **Discovery:** `server/discover`.
  - **Elicitation and plan-token confirmations (H-3):** move to MRTR (`input_required`).
- **Owner decision O-19:**
  - the migration window;
  - whether dropping protocol versions before 2025-11-25 is BREAKING (a 4.0 item) or a 3.x minor;
  - the fate of N-9.
- **Tests:** the spawn suite against both protocol versions, stateless HTTP round-trip, the tasks
  extension, and the `input_required` confirmation flow.

### N-36 — Tool discovery instead of a bigger budget (M) — with O-10

- **Why:** TK-06.
- **Surface:** a `servicenow_find_tools` meta-tool in `core` searches the full manifest by
  intent and returns the matching tools with their packages. It can enable a package for the
  session (M-5).
  - **Goal:** `core` shrinks to ≤ 20 KB, and `all` is no longer what most clients load.
  - **Budget:** the `tools/list` test gains a "discovery" profile. O-10 restates the budget for
    that profile instead of raising `all` again.
- **Tests:** the N-18 eval set: the correct tool is found from intent for every flagship task.

### N-37 — Lean definitions and per-tool reference (M)

- **Why:** TK-07, TK-08.
- **Surface:**
  - The manifest generator records description bytes and schema bytes per tool, and a lint caps
    each tool at a size O-10 sets.
  - Long usage notes, examples and edge cases move to a new resource
    `servicenow://reference/tools/{name}`, which the description points to in one line.
  - `outputSchema` keeps only the top-level shape where clients do not validate deeper.
- **Tests:** a size test per tool, the resource test, and N-18 selection accuracy before and
  after.

### N-38 — Cache-friendly listing (S, after N-35)

- **Why:** TK-09.
- **Surface:**
  - Deterministic tool, prompt and resource order, asserted by a test.
  - `ttlMs` / `cacheScope` on list results.
  - Package changes are batched so a session sees as few `listChanged` events as possible. The
    server instructions tell the client which packages to enable up front.
- **Tests:** the order is identical across restarts and package toggles, and the list carries the
  cache hints.

### N-39 — One channel per payload (S) — owner gate O-21

- **Why:** TK-10.
- **Surface:** for a client that declares structured-output support, the 30 `okStructured` tools
  send a short text summary (counts, ids, `truncated`) and the full payload in
  `structuredContent` only. Older clients keep both. The default flip is O-21.
- **Tests:** both client modes; the bytes saved on the 30 goldens.

### N-40 — Compact records and token-aware caps (M) — owner gate O-21

- **Why:** TK-11 … TK-14.
- **Surface:**
  - `format: "table"` on list-returning tools: columns once, rows as arrays.
  - `fields: "display"` uses the table's display and summary fields. This is opt-in; making it
    the default is O-21.
  - `SN_MAX_RESULT_TOKENS` is an estimated-token cap with a `next` cursor, beside the character
    cap.
  - A result over the cap goes to a file automatically (S-11) and returns a `resource_link`.
  - E-5 metrics record bytes per tool call.
- **Tests:** a byte-reduction golden on a 200-record fixture, cursor continuity, the automatic
  file result, and the metrics counters.

### N-41 — Documentation corpus and machine-readable roadmap (M)

- **Why:** TK-15, TK-16.
- **Surface:**
  - A `project/README.md` index: one line per document, its status (live / reference /
    archived) and its size class.
  - Completed analyses (2026-07, DEEP-REVIEW, GAP-2026-09, INSTANCE-DOCS) move to
    `project/archive/` with stable links.
  - `project/roadmap.yaml` (id, title, pillar, phase, size, status, gates, links) becomes the
    status source. `npm run roadmap:status` prints progress per pillar, and ROADMAP-V3's table is
    generated from it, with `--check` in `npm run check`.
  - Row notes shrink to a link to DONE or CHANGELOG.
- **Tests:** the generator round-trip and `platform-corners` still green.

### N-42 — Generated tool reference and `llms-full.txt` (M)

- **Why:** TK-17, TK-18.
- **Surface:**
  - `docs/tools/<package>.md` is generated from the manifest: each tool's purpose, parameters,
    output shape, errors and writes.
  - The README keeps install, setup and a package table that links to these pages.
  - `docs/llms.txt` links the per-package pages.
  - A generated `docs/llms-full.txt` holds README, SECURITY and the tool reference in one
    Markdown file, and the site serves a Markdown alternate of the landing page.
  - All of it is `--check`ed by `docs:sync`.
- **Tests:** `docs:sync --check` covers the new files; link check.

### N-43 — Agent-facing repository docs (S) — owner gate O-20

- **Why:** TK-19.
- **Surface:**
  - A public `AGENTS.md` for contributors' agents: commands, layer rules, test conventions, and
    no-go areas (`pack-check`, BREAKING items).
  - `.github/copilot-instructions.md` is generated from the same source, so the two cannot drift.
  - Plugin skills for the N flagships extend D-8 / N-19.
  - O-20 decides whether a public agent-instructions file is wanted at all.
- **Tests:** a drift check between `AGENTS.md`, the copilot file and the manifest counts.

### N-44 — Decision records (S)

- **Why:** TK-20.
- **Surface:** `project/adr/` with a short template: context, decision, status, consequences,
  superseded-by.
  - Each owner gate (O-1 … O-21) gets a record when decided.
  - ARCH-10 and ARCH-14 are written up from TODO.
  - ROADMAP rows link to the ADR instead of restating the decision.
- **Tests:** a lint that every decided O-gate has an ADR.

### N-45 — Harness hygiene (S) — P0

- **Why:** TK-21.
- **Surface:**
  - Stop tracking `.claude/settings.json` (`git rm --cached`; the file stays on disk) and exclude
    the path locally.
  - Add a test that fails when an assistant harness path is tracked.
- **Tests:** the new guard test; `npm run check`.
- **Done 2026-10-04 (local, uncommitted):** `.claude/settings.json` untracked (removal staged);
  `test/harness-files.test.js` guards every harness path; `.claude/` added to the ESLint and
  Prettier ignores, so stale agent worktrees no longer break `npm run lint` / `format:check`.

### N-46 — Path-scoped agent instructions (S) — P0, the `AGENTS.md` part waits for O-20

- **Why:** TK-22.
- **Surface:** one source file per area: `src/api`, `src/mcp`, `src/core`, `src/tools`, `test`,
  `extension` and `scripts`. Each holds that area's layer rules, test conventions and no-go
  zones.
  - A generator writes `.github/instructions/<area>.instructions.md` (with `applyTo`) and, after
    O-20, nested `<area>/AGENTS.md`. The generator is checked in `npm run check`.
  - The root file shrinks to commands and global rules. It is shared with N-43.
- **Tests:** a drift check between the sources and the generated files.

### N-47 — Plugin subagents (S) — P0

- **Why:** TK-23.
- **Surface:** two subagents in `agents/`, each with a `tools` allowlist:
  - `sn-investigator`: read-only. It uses the discovery, explain, trace and query tools and
    returns a short report, not raw records.
  - `sn-change-reviewer`: read-only. It uses plan, compare and security scan, and reviews a
    pending write or update set.
  - The skills hand large investigations to these subagents.
- **Tests:** `test/plugin.test.js` checks the frontmatter, and that every allowlisted tool exists
  and is read-only.

### N-48 — Hooks v2 (S) — P0

- **Why:** TK-24.
- **Surface:**
  - `SessionStart`: adds the active profile, instance host, write mode and enabled packages from
    the local configuration. It makes no network call and prints no secrets.
  - `PostToolUse` on `servicenow_*`: when a result carries `truncated: true`, it adds a one-line
    hint (narrow `fields`, use `format: "file"` or the cursor).
  - Both are plain Node scripts, like `require-plan-token.mjs`.
- **Tests:** spawn tests with fixture payloads, like `test/plugin-hook.test.js`; a test that
  credentials never appear in the output.

### N-49 — Skill evals (M) — P0

- **Why:** TK-25.
- **Surface:**
  - A `claude plugin eval` suite per skill: prompts that must trigger it, prompts that must not,
    and the expected tool calls, run against the fetch double.
  - The suite runs manually and in an optional workflow, because it needs a model key. Results
    are recorded next to the N-18 eval set.
- **Tests:** the suite itself; a structural test that every skill has an eval file.

### N-50 — MCP Apps views (L) — P0, opt-in

- **Why:** TK-26.
- **Surface:**
  - Behind `SN_MCP_APPS=1` and the client's MCP Apps capability, some tools also return a
    `ui://` resource: `plan_changes` / apply (plan diff), the Mermaid generators (rendered
    diagram), `explain_flow` (flow graph) and `explain_ui_experience` (page tree).
  - The views are static HTML with no network access and receive their data through the
    extension's message channel.
  - Text output stays identical when the feature is off.
  - **Unverified:** the extension's current capability and MIME names. Check them against the
    spec and the SDK before building.
- **Tests:** output is byte-identical when off; resource listing; an HTML snapshot per view;
  untrusted content is escaped (M-4 boundary).

### N-51 — MCP bundle (`.mcpb`) (M) — P0, publication waits for O-22

- **Why:** TK-27.
- **Surface:**
  - A `manifest.json` with `user_config` (instance URL, auth type, and credentials marked
    sensitive) that maps to the existing settings manifest (E-4).
  - `npm run mcpb:pack` builds the bundle, and the release job attaches it to the GitHub
    release.
  - The bundle is separate from the npm tarball, so `pack:check` is untouched.
- **Tests:** a manifest drift check against the settings manifest; the bundle builds in CI.

### N-52 — Skills beyond Claude Code (S) — P0

- **Why:** TK-28.
- **Surface:**
  - Keep `skills/` in the portable Agent Skills format: no Claude-only frontmatter, and tool
    names written as `servicenow_*`, not with an `mcp__` prefix.
  - Document how to install the skills in other agents.
  - The VS Code extension offers to copy them into the workspace's skills folder.
  - **Unverified:** the skills folder each client reads. Confirm it per client before
    documenting.
- **Tests:** a frontmatter lint for the portable subset.

### N-53 — Agent documentation index (S) — P0, registration waits for O-22

- **Why:** TK-29.
- **Surface:**
  - A `context7.json` that points the index at README, SECURITY, `docs/tools/` (N-42) and
    `llms-full.txt`, and excludes `project/` and the test fixtures.
  - The owner registers the project.
- **Tests:** none beyond JSON validity; it is checked in `docs:sync`.

## 5. Sequencing

| Phase   | Items                                                | Why this order                                                                                              |
| ------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| R0 (P0) | N-45, N-46, N-47, N-48, N-52, N-49, N-51, N-53, N-50 | Owner priority: harness hygiene first, then cheap harness wins, then distribution, then the one large item. |
| R       | N-35 step 1 (spike), N-41                            | Know the protocol cost before building more surface; make the docs navigable first.                         |
| A       | N-40 (metrics part), N-39, N-37                      | Measure response bytes, then cut the duplication and the definition weight.                                 |
| B       | N-36 (with O-10), N-35 step 2 (O-19), N-38           | Discovery replaces the budget ratchet; protocol migration; cache hints need the new protocol.               |
| C       | N-40 (rest), N-42, N-43 (O-20), N-44                 | Opt-in compact forms, then the generated docs.                                                              |

R0 runs before every other N item. N-46's nested `AGENTS.md` waits for O-20, and the N-51 / N-53 publication steps wait for O-22. The rest of R0 has no gate. N-9 does not start until O-19 decides it. N-17 waits for the N-35 spike.

## 6. Owner gates (new)

- **O-19** Protocol 2026-07-28:
  - the migration window to the v2 SDK packages;
  - whether dropping protocol versions before 2025-11-25 is BREAKING;
  - whether N-9 is re-scoped or dropped.
- **O-20** Whether to publish a public `AGENTS.md` for contributor agents.
- **O-22** External distribution: attaching `.mcpb` bundles to releases (N-51) and registering
  the docs with an agent doc index such as Context7 (N-53).
- **O-21** Response defaults: structured-only payloads for capable clients (N-39), and
  `fields: "display"` / `format: "table"` as defaults (N-40).

## 7. External references

- [MCP specification 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP context bloat — tool search, code mode, progressive disclosure](https://mcp.directory/blog/mcp-context-bloat-fix-2026-tool-search-code-mode-progressive-disclosure)
- [MCP token optimization approaches compared](https://www.stackone.com/blog/mcp-token-optimization/)
- [Writing LLM-friendly documentation](https://buildwithfern.com/post/how-to-write-llm-friendly-documentation)
- [MCP Apps extension](https://modelcontextprotocol.io/extensions/apps/overview)
- [MCP bundles (`.mcpb`)](https://github.com/modelcontextprotocol/mcpb)
- [AGENTS.md](https://agents.md/)
- [Agent Skills](https://agentskills.io/)
- [Serving Markdown and llms.txt to AI agents](https://www.deployhq.com/blog/making-your-documentation-ai-friendly-serving-markdown-to-ai-coding-assistants)
