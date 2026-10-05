# servicenow-mcp-ai — UX/DX Review (post-2.0)

Date: 2026-07-01 · Lens: senior UX/UI designer · Read-only assessment, no code changes.
Companion to [BUSINESS-REVIEW-2026-07.md](BUSINESS-REVIEW-2026-07.md) (the business
twin of this review — its distribution sprint is largely implemented by the backlog in
§11 here) and [README.md](../../README.md) / the docs site, which are the product's actual UI.

> Framing: an MCP server has no screens, but it absolutely has a UX. Its "UI" is the
> README and docs site (first contact), the onboarding funnel (install → first
> successful tool call), the tool surface the model and the human see (names,
> descriptions, schemas, annotations), the error strings, the configuration model, the
> VS Code extension, and the shape of tool output. That is what this review covers.

---

## 1. Executive summary

- **The DX fundamentals are above the MCP-ecosystem average**: uniformly named tools
  (`servicenow_<domain>_<action>`), `.describe()` on every input field, full MCP
  annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`),
  actionable error strings with PII-safe URLs, plan-by-default writes, truncation and
  redaction signals in results. This is rare and worth stating plainly.
- **The weak link is the funnel, not the surface**: the first 5 seconds (no moving demo
  in the hero, three donation links above the fold) and the first 5 minutes (no guided
  "verify your setup" step, an intimidating full-reference `.env.example`, the
  recommended OAuth path buried in a subsection).
- **The most powerful capabilities are discoverable only by reading a 592-line README**:
  the two-axis policy, named profiles, the capability preflight and the write journal
  have no in-product discovery moment.
- **Top three fixes by leverage**: the DX-3 hero GIF, a minimal quickstart with a verify
  step, and named tool-package presets that tame the 67-tool surface.

---

## 2. Method and scope

Reviewed (read-only): `README.md` (592 lines) and the GitHub Pages site under `docs/`;
`.env.example`; the tool definitions and manifest (67 tools / 18 packages, sampled
across table, aggregate, batch, catalog, change, attachment, flows); error construction
in `src/core/errors.ts`, `src/core/http.ts`, and the policy denials in `src/core/policy.ts`;
configuration in `src/core/config.ts` / `src/core/settings.ts`; output shaping in
`src/mcp/result.ts` and `src/mcp/redact.ts`; prompts and resources in `src/mcp/`;
the VS Code extension in `extension/`; the uncommitted Jira WIP (`src/core/jira/`,
`src/api/jira/`) only as far as it affects the UX surface (it does not yet — no tools).

---

## 3. First five seconds — the hero

**What works**

- The terminal-grade dark redesign of the docs site matches the audience (CLI-native
  developers) — the aesthetic says "built by someone who lives where you live".
- The one-line positioning ("runs locally with the model and client you choose, against
  any instance — including a free PDI") is sharp and survives skimming.

**What does not**

- **No moving demo.** The product's magic moment is conversational ("ask in natural
  language → get a trace/diff/impact graph"), which a static page cannot convey. The
  DX-3 GIF is the single highest-leverage UX artifact in the entire backlog, and it is
  the only unshipped 2.0 item.
- **Three donation links above the fold** (Sponsors + Ko-fi + Donatree in the topbar
  and the top of the README). To a first-time visitor this reads as "the project wants
  something from me" before it has shown value. Recommendation: one discreet ❤️ Sponsor
  link up top; Ko-fi and Donatree move to the footer; the README Support section moves
  below the Quick demo, not above it.

---

## 4. First five minutes — the onboarding funnel

The documented path is 4–5 steps: install (`npx servicenow-mcp-ai`, no build) →
credentials (`.env`, real env vars, or the runtime `servicenow_set_credentials` tool) →
register with the MCP client (JSON snippets for Claude Desktop, the Claude Code plugin,
the VS Code extension) → optionally `npx servicenow-mcp-ai login` for OAuth.

Friction points, in funnel order:

| #   | Friction                                                                                                                                             | Recommendation                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `.env.example` is a full reference (~6 KB, 40+ variables) — intimidating as a first contact                                                          | A 3-line minimal quickstart block (`SN_INSTANCE`/`SN_USER`/`SN_PASSWORD`) in the README, linking to the full reference                                |
| 2   | **No "verify your setup" step.** `servicenow_test_connection` and `servicenow_check_capabilities` exist but are not part of the onboarding narrative | Add a "Verify your setup" section; longer-term, a `npx servicenow-mcp-ai doctor` command that fuses connectivity + credentials + capability preflight |
| 3   | The recommended auth path (OAuth 2.1 login) is buried in an "OAuth 2.1" subsection                                                                   | Promote `login` into the main setup steps                                                                                                             |
| 4   | Env-file resolution (project `.env` vs `~/.config/servicenow-mcp-ai/.env`) is correct but implicit                                                   | One sentence + example in the credentials section                                                                                                     |
| 5   | The extension README does not explain that Copilot Chat must be in **agent mode** — the first post-install step is a mystery to a newcomer           | Two sentences + a screenshot in `extension/README.md`                                                                                                 |

**Status (2026-07-02):** all five shipped — #1/#2 (README Quickstart + _Verify your
setup_ + `doctor`), #3 (OAuth `login` promoted in the Quickstart), #4 (env-file
resolution order in _Configure credentials_), #5 (extension README agent-mode section).
The extension screenshot itself is owner-gated (commented-out placeholder in place).

Positive: runtime credential update (with MCP elicitation confirmation where the client
supports it) means no restart friction after the first setup — good design, worth
surfacing in the README as a feature rather than leaving it as trivia.

---

## 5. The tool surface — 67 tools in 18 packages

**Strengths (uniform across the sample):**

- Naming: `servicenow_` prefix + snake_case, imperative verb-first descriptions
  ("Read…", "Compute…", "Trace…"), 1–2 sentences with context where it matters (e.g.
  the attachment tools flag truncation behaviour; `servicenow_trace_table_event`
  explains it is a logical test that executes nothing).
- Schemas: every input field carries `.describe()`; enums document their values;
  defaults are stated in the description ("default 10").
- Annotations: all four MCP hints are set per tool, enabling client-side affordances
  (lock icons for read-only, warnings for destructive).
- No naming or quality inconsistencies were found in the sample — unusual for a surface
  this size.

**The one structural weakness: 67 tools is a wall.** In a client's tool picker it is
claustrophobic; in the model's context it is bloat that dilutes tool selection quality.
`SN_TOOL_PACKAGES` exists as the mechanism, but it is a mechanism, not an experience —
nothing in onboarding suggests a subset. Recommendation: **named presets documented in
the quickstart**, e.g.:

| Preset      | Packages (illustrative)                           | For whom                          |
| ----------- | ------------------------------------------------- | --------------------------------- |
| `reader`    | table, schema, aggregate, admin                   | First contact, analysts, PDI play |
| `developer` | reader + scripts, flows, codecheck, docs/diagrams | The core segment                  |
| `admin`     | everything                                        | Consultants with broad roles      |

One env line per preset in the README turns the 67-tool wall into a choice.

---

## 6. Errors and feedback

The error UX meets the standard most servers miss: say what broke **and** what to do.

- Missing config: `"ServiceNow instance is not configured. Use the
servicenow_set_credentials tool first."` — actionable verbatim.
- Policy denials name the exact policy: `"Access to table "x" is denied by
SN_TABLES_DENY."` / `"Server is in read-only mode (SN_READONLY); "y" is not
permitted."` — with proper 403 semantics.
- API errors carry the HTTP status plus the parsed ServiceNow error body
  (`extractErrorDetail` in `src/core/http.ts`); transport errors use a **PII-safe URL**
  (query string omitted, since encoded queries can contain personal data).
- Write-mode refusals explain both escape hatches (`apply: true` or
  `SN_WRITE_MODE=apply`).

Remaining gap: **there is no easy answer to "what policies apply right now?"** The data
exists in `servicenow_get_status` (and the `servicenow://status` resource), but nothing
points there. Recommendation: policy-denial messages append a hint — _"run
servicenow_get_status to see the active policy"_ — one string change per denial site.

---

## 7. Configuration UX — profiles and the two-axis policy

The model is powerful and coherent once understood: legacy env vars = the `default`
profile; `SN_PROFILE_<NAME>_*` for named instances; `SN_ACTIVE_PROFILE` or the
`servicenow_use_instance` tool to switch; per-call routing for cross-instance work;
policy on two axes (tables and packages) with per-profile overrides.

Confusion points found:

1. **The axis split is buried.** "Table policy does not cover the plugin APIs — use the
   package axis" is a security-critical mental model documented deep in the README
   security notes. It belongs in the main configuration section with a two-row example.
2. **No "effective policy" surface** beyond `get_status` (see §6).
3. Minor: CSV list syntax (spaces trimmed) is undocumented trivia that costs a minute of
   doubt.

---

## 8. Output formatting

- Compact JSON by default with `SN_RESULT_PRETTY` opt-in is the right call for LLM
  consumption; `outputSchema` on structured tools lets capable clients render properly.
- The **honesty signals are exemplary** and should be marketed, not just shipped:
  `truncated: true` with a note (char budget, default 100k), `capped: true`
  (`SN_MAX_RECORDS`), `redacted: <count>` (DF-5). A model — and a human — can always
  tell when a result is partial.
- CSV export and Mermaid diagrams (trace flowcharts, ER diagrams, the where-used graph)
  are visual differentiators; they belong in the hero demo (§3).

---

## 9. Docs site — information architecture

A single generated page (~306 KB) with topbar navigation, no search. For a surface of
67 tools and 40+ env variables this does not scale: a visitor who arrives with a
question ("how do I set a timeout?", "what does where_used do?") has only Ctrl-F.
Recommendations, cheapest first: a sticky table of contents; client-side search
(Pagefind or lunr over the generated page); only then consider splitting into pages.

---

## 10. VS Code extension

The thin-wrapper design (31 lines: `registerMcpServerDefinitionProvider` →
`npx -y servicenow-mcp-ai`) is the right architecture — no duplicated logic, always the
published server. Two UX gaps:

1. **The agent-mode gap** (§4, item 5) — the only post-install instruction that matters
   is missing.
2. **Version drift is visible to users**: Marketplace shows 2.0.0 while npm is 2.0.1.
   Because the extension launches `npx -y servicenow-mcp-ai`, users actually get 2.0.1 —
   the drift is cosmetic, but to the exact audience this product courts, a mismatched
   version number reads as neglect. (The fix — a version-sync gate in
   `publish-vscode.yml` — is tracked in [BUSINESS-REVIEW-2026-07.md](BUSINESS-REVIEW-2026-07.md) §7.)

---

## 11. Prioritized UX backlog

| #   | Action                                                                               | Effect                           | Effort   |
| --- | ------------------------------------------------------------------------------------ | -------------------------------- | -------- |
| 1   | Record the DX-3 GIF; drop into README + docs-site hero                               | Largest single conversion lever  | hours    |
| 2   | Minimal quickstart (3-line env) + "Verify your setup" step                           | Shorter, guided funnel           | hours    |
| 3   | Donation links: one above the fold, rest to the footer; Support below the demo       | First-impression trust           | minutes  |
| 4   | `extension/README.md`: agent-mode steps + screenshot                                 | Unblocks the Marketplace channel | hours    |
| 5   | Named tool presets (`reader`/`developer`/`admin`) documented in quickstart           | Tames the 67-tool wall           | ~1 day   |
| 6   | Policy-denial hint → `servicenow_get_status`; axis-split example in main config docs | Policy discoverability           | hours    |
| 7   | Docs-site sticky TOC + client-side search                                            | Reference usability at 67 tools  | ~1 day   |
| 8   | `doctor` command (connection + credentials + capability preflight in one)            | First-class first-run experience | 1–2 days |

Items 1–4 are, together, under a week of work with zero server code — and they are the
concrete implementation of the distribution sprint recommended in
[BUSINESS-REVIEW-2026-07.md](BUSINESS-REVIEW-2026-07.md) §7.

**Status (2026-07-02):** items 2, 3, 5, 6, 8 shipped and committed on `main`
(`9e41b5d`, `b5657cf`, `7210045`, plus funnel follow-ups `848584f`/`1c2f36a`); item 4's
agent-mode steps shipped, its screenshot owner-gated; item 7 (docs-site sticky TOC +
search) implemented in `docs/index.html` but left uncommitted with the docs-freshness
cluster. Only item 1 (the DX-3 GIF) and item 4's screenshot remain owner-gated.

---

## Sources & basis

- Internal: `README.md`, `.env.example`, `docs/` (generated site), `extension/`,
  `src/mcp/` (result, redact, prompts, resources, write-mode), `src/core/` (errors,
  http, policy, config, settings), the tool manifest and sampled tool definitions;
  [PRODUCT-STATE.md](PRODUCT-STATE.md) for the shipped-capability baseline;
  [ROADMAP-V2.md](ROADMAP-V2.md) for DX-1/DX-3 status.
- Adoption context and the business twin of this review:
  [BUSINESS-REVIEW-2026-07.md](BUSINESS-REVIEW-2026-07.md).
