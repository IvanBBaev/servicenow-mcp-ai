# servicenow-mcp-ai — Instance documentation: analysis and v3.0 plan

Date: 2026-09-23 · Status: **proposed — folded into [ROADMAP-V3.md](ROADMAP-V3.md) as S-14, S-15, S-16 plus refinements to S-7, S-11, M-3, M-4, M-8, E-7, H-5, D-8.** A third, focused pass over the v3.0 plan, read-only, against the local working tree of 2026-09-23 (`main` at `5acdcc7` plus the uncommitted H-1, H-2, E-9, H-10, S-1 and H-9 work; gate green, 494/494 when the pass ran — §9 reconciles it with the H-8, H-5 and H-6 work and the SDK-parity plan that landed later the same day, gate 568/568). It answers one question: **how can the server's ability to document a ServiceNow instance be improved**, and turns the answer into tracker items with a definition of done each. Companion to [DEEP-REVIEW-2026-09.md](DEEP-REVIEW-2026-09.md) (five lenses, 2026-09-02) and [GAP-ANALYSIS-2026-09.md](GAP-ANALYSIS-2026-09.md) (nine lenses, 2026-09-09); it reuses their finding format and cross-references their ids where a gap was already known.

Finding ids here are `ID-01` … `ID-17` ("instance documentation"). Every `_(instance-docs pass 2026-09-23)_` bullet in ROADMAP-V3 names the finding it absorbs.

## 1. Scope and method

**In scope** — everything the server does to turn a live instance into documents a human or a model can read later:

- the `docs` package (`servicenow_docs_list/read/search/write`, `servicenow_generate_er_diagram`, `servicenow_generate_table_flow`) and the local Markdown store behind it (`src/api/docs.ts`, `SN_DOCS_DIR`, default `docs/instance/`);
- the `instance` package (`servicenow_snapshot_instance`, `servicenow_compare_instances`) and the other writers that land files in the same store (`code_health`, the write journal);
- the Mermaid generators (`src/api/diagrams.ts`) and the two other Mermaid builders (`src/api/flows.ts`, `src/api/whereused.ts`);
- the `servicenow_document_table` prompt and the `servicenow://docs/{path}` resource;
- the harness-level `discovery` skill (outside the repo) that re-implements part of this with `curl`, because it shows what users actually want from "document the instance".

**Out of scope** — the README/site/manifest generation for the _server's own_ documentation (D-3), the write journal's content model (H-5) and redaction (H-5) except where they touch the store, and the Jira surface (dark, O-1).

**Method** — code read with file:line evidence, the existing tests counted, the prompt and resource registrations checked, the ROADMAP-V3 items that already touch documentation listed (S-4, S-5, S-7, S-9, S-11, M-3, M-4, M-7/B13, M-8, M-9, H-5, H-6, H-8, E-7, D-3, D-8) so that nothing is proposed twice. Nothing was run against an instance. Everything below marked **verified** was re-read in code during this pass.

## 2. Current state — inventory

### 2.1 Surfaces that produce or serve documentation

| Surface                                                                                       | Kind                               | Where                                                 | Output                                                                                                           | Notes                                                                |
| --------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `servicenow_docs_list/read/search`                                                            | tools (`docs`)                     | `src/tools/docs.ts:14-57`                             | JSON                                                                                                             | `annotations: { readOnlyHint: true }` only (GAP L4-07 → M-8)         |
| `servicenow_docs_write`                                                                       | tool (`docs`)                      | `src/tools/docs.ts:59-80`                             | writes `<path>.md`, regenerates `index.md`                                                                       | `{ readOnlyHint:false, idempotentHint:true, openWorldHint:false }`   |
| `servicenow_generate_er_diagram`                                                              | tool (`docs`)                      | `src/tools/docs.ts:83`, `src/api/diagrams.ts:30-58`   | `{ tables, mermaid }`                                                                                            | one entity per table, `}o--\|\|` per reference field                 |
| `servicenow_generate_table_flow`                                                              | tool (`docs`)                      | `src/tools/docs.ts:101`, `src/api/diagrams.ts:82-195` | `{ table, tables, count, mermaid }`                                                                              | business rules by phase; inherited + global lanes since S-1          |
| `servicenow_snapshot_instance`                                                                | tool (`instance`)                  | `src/tools/instance.ts:14-40`, `src/api/snapshot.ts`  | `<profile>/{tables,plugins,apps,automation}.md\|json`, `<profile>/schema/<table>.md\|json`, `<profile>/index.md` | idempotent overwrite; `warnings[]`; `SAFE_NAME` guard on table names |
| `servicenow_compare_instances`                                                                | tool (`instance`)                  | `src/api/compare.ts:385-386`                          | `_compare/<a>-vs-<b>.md`                                                                                         | reads `<profile>/tables.json` etc. via `readSnapshotJson` (`:88`)    |
| `servicenow_code_health`                                                                      | tool (`codecheck`)                 | `src/api/codecheck.ts:538-544`                        | `<profile>/code-health.md`                                                                                       | script inventory, lint top 20, ACL scan top 20                       |
| write journal                                                                                 | side effect of every applied write | `src/core/write-journal.ts:63-103`                    | `<profile>/write-journal.{jsonl,head,md}`                                                                        | append-only; redacted, hash-chained and rotated since H-5 (§9)       |
| `servicenow_document_table`                                                                   | prompt                             | `src/mcp/prompts.ts:96-112`                           | model-written `tables/<table>.md`                                                                                | the only "document a table" workflow; prompt-capable clients only    |
| `servicenow://docs/{path}`                                                                    | resource template                  | `src/mcp/resources.ts:205-209`                        | `text/markdown`                                                                                                  | `list: undefined`, no `complete` (GAP L5-03 → M-4)                   |
| `servicenow://schema/{table}`, `servicenow://{profile}/schema/{table}`, `servicenow://tables` | resources                          | `src/mcp/resources.ts:108,152`                        | JSON                                                                                                             | machine-readable, not documents                                      |

**Verified.** Every file writer goes through one primitive, `docsWriteRaw(relPath, content, [".md", ".json"])` (`src/api/docs.ts:292-320`), which confines the path (`resolveDocPath`, `:74-99`), creates directories and overwrites unconditionally. `docsWrite` (`:277-290`) is the hand-written variant (`.md` only) and is the only writer that regenerates the store-wide `index.md` (`:249-275`, serialised through `indexTail`). Line numbers refreshed against the H-5/H-6 tree (§9).

### 2.2 The store today

```
docs/instance/                      # SN_DOCS_DIR (default; not created until first write)
  index.md                          # flat list of every *.md, regenerated by docs_write only
  tables/<table>.md                 # written by the document_table prompt (root, no profile)
  <profile>/
    index.md                        # snapshot's own index (+ Warnings), regenerated by snapshot only
    tables.md | tables.json         # sys_db_object list (name, label, super_class)
    schema/<table>.md | schema.json # only for the tables the caller named
    plugins.md | plugins.json       # v_plugin, fallback sys_plugins
    apps.md | apps.json             # sys_app + sys_store_app
    automation.md | automation.json # Aggregate counts per SCRIPT_TYPES kind
    code-health.md                  # code_health report
    write-journal.{jsonl,head,md}   # every applied write (journal v2 since H-5: hash chain, rotation)
  _compare/<a>-vs-<b>.md            # compare report
```

Observations (all **verified**):

- **Two indexes** (`index.md` at the root, `<profile>/index.md` from the snapshot) that never see each other; `docs_write` lists snapshot files but not their meaning, the snapshot index lists only its own files.
- **No metadata on any generated file.** `generatedAt` is a sentence inside the Markdown (`src/api/snapshot.ts:93,124,204,263,319,343`) and a field in the JSON companion; nothing records the generator, its version, the instance host, or whether the file was hand-written. Nothing distinguishes a stale snapshot from a fresh one without opening it.
- **Overwrite semantics differ by accident:** the prompt tells the model to "update rather than duplicate" a hand-written `tables/<table>.md`, while every generator overwrites. A hand-edited table document is lost the moment the prompt is re-run with a sloppy client.
- **Search** (`docsSearch`, `:201-247`) is a case-insensitive literal substring scan per line, one snippet of ≤ 200 chars per hit, no ranking, no heading context, no filter by profile or kind; `docsList` (`:140-155`) returns paths only (per-file `bytes` was deferred by H-6 to S-14, ID-02).
- **Not ignored by git** in this repo at the time of the pass: `.gitignore` did not list `docs/instance/` (`.prettierignore` did; H-9's `pack-check` excludes it from the tarball), and the journal, which carried raw field values, lives in the same tree (SEC-12 → H-5). **Closed the same day by H-5** — `.gitignore` lists `docs/instance/`, the journal is redacted, hash-chained and rotated (§9).
- **Windows reserved names and size caps** were missing (GAP L2-10 → H-6). **Closed the same day by H-6** — `RESERVED_SEGMENT_RE`, `assertPortableSegments`, `SN_DOCS_MAX_FILE_BYTES` on reads; `docsWriteRaw` stays uncapped by design (§9).

### 2.3 The generators

`src/api/diagrams.ts` (195 lines, **verified**):

- `ident()` (`:14`) and `label()` (`:19-24`) are the only escaping; `label()` replaces `"[]{}|` with `'` and folds newlines.
- `generateErDiagram(tables)` (`:30-58`): for each table one `entity { type name }` block from `describeTable` (which already includes inherited columns, `src/api/meta.ts:103`) and one `}o--||` relationship per reference field. No own/inherited distinction (the `sourceTable` of `ColumnInfo`, `src/api/meta.ts:87-98`, is ignored), no key or mandatory markers, no column cap (a `task`-family table emits 100+ lines per entity), no automatic inclusion of referenced tables (they appear as bare entities Mermaid creates implicitly), no choice information.
- `generateTableFlow(table)` (`:82-195`): one `listScripts` query (`collectionIN<chain>^ORglobal=true^active=true^ORDERBYwhen^ORDERBYorder`, limit 500), phases `display → before → after → async` with own / inherited / global lanes (S-1). Business rules only: no client-side lane, no flow triggers, workflows or notifications — although `traceTableFlow` in `src/api/flows.ts:449-450` already collects those for the same table and operation. The diagram and the trace are two data paths for one question.
- Two more Mermaid builders exist with their own escaping and caps: `buildMermaid` in `src/api/flows.ts:354` (trace, `flowchart TD`) and `buildMermaid` in `src/api/whereused.ts:78-82` (`graph LR`, 40-node cap). DEEP-REVIEW H4 already lists the dedup under E-7.
- `sysparm_display_value=all` shapes (`{value, display_value}` objects) are not pinned for the generators (DEEP-REVIEW C-4 → H-8); `snString` hides most of it but not the `type`/`reference` fields of `describeTable`.

### 2.4 The `document_table` prompt

`src/mcp/prompts.ts:96-112` (**verified**): six steps — `docs_read tables/<table>.md` first; `describe_table`; `table_logic`; `generate_er_diagram` with the table and key referenced tables; `generate_table_flow`; `docs_write tables/<table>.md` with purpose, a key-fields table, both diagrams in ` ```mermaid ` blocks and a summary of business rules, client scripts, UI policies and ACLs; "Read every value from the instance; do not fabricate". It is the right recipe, but:

- it exists **only as a prompt** — clients without prompt support (most agent frameworks, Copilot's tool-only mode, scripted use) cannot ask for a table document; the result depends on the model and is not reproducible;
- it writes to the **root** `tables/<table>.md`, the only writer that ignores the `<profile>/` namespace, so two instances documented from one working directory overwrite each other;
- it hard-codes tool names and is registered even when the `docs` package is off (GAP L4-02 → M-5/M-7).

### 2.5 Tests

| File                              | Tests | Covers                                                                                                                             |
| --------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `test/docs.test.js`               | 9     | write + index, read, list, search, traversal refusal, extension whitelist, 404, whitespace path (QA-15), concurrent writes (DEV-3) |
| `test/diagrams.test.js`           | 4     | ER entity + relationship, phase subgraphs, S-1 lanes, caret refusal (DEV-7)                                                        |
| `test/snapshot.test.js`           | 4     | file set, schema for named tables, plugin fallback, truncation warning                                                             |
| `test/compare.test.js`            | 4     | table/column/script/plugin diffs, snapshot fallback                                                                                |
| `test/instance-resources.test.js` | 3     | profile-scoped schema resource                                                                                                     |

All assertions on Mermaid are substring checks; no test proves the output parses, none pins a golden document, none checks that the prompt's tool names exist, none asserts that a generated document contains no record data.

### 2.6 What the harness `discovery` skill does that the server does not

`~/.claude/skills/discovery/SKILL.md` (harness, not in the repo) logs in with `curl` and writes `docs/ai/discovery/<instance>/{overview.md, apps.md, tables-<scope>.md, artifacts-<scope>.md}` in three tiers: **Tier 1** environment overview (version, counts), **Tier 2** applications and data model per scope, **Tier 3** code artefacts per scoped app. It is what a user means by "discover / document this instance", and it bypasses every server rail (policy axes, redaction, capability preflight, host guard, journal of local writes). The server has the readers for all three tiers (`listTables`, `describeTable`, `listScripts`, the snapshot's app and plugin collectors) but no tool that composes them into those documents.

## 3. Findings

Format as in GAP-ANALYSIS: **Severity** (high / med / low) · **Status** (VERIFIED = re-read in code) · **Effort** (S ≤ 1 day, M 2–5 days, L 1–2 weeks) · **Breaking** · **Target** (2.x / 3.0 / 3.x) · **→ item**.

### A. Store and document lifecycle

#### ID-01 — Hand-written documents and the prompt ignore the profile namespace

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ S-14**
- **Gap:** every generator writes under `<profile>/…` (`src/api/snapshot.ts:82`, `src/api/codecheck.ts:540`, `src/core/write-journal.ts:151`), `docs_write` and the `document_table` prompt write wherever the caller says — the prompt says `tables/<table>.md` (`src/mcp/prompts.ts:102,107`). With two profiles (`dev`, `test`) the same table document is overwritten by whichever instance was documented last, and `docs_search` cannot tell which instance a hit describes.
- **Design:** `docs_write`, `docs_read`, `docs_list`, `docs_search` gain an optional `profile` argument: `profile:"current"` resolves the active profile and prefixes the path, an explicit name selects that profile, omitted keeps today's root behaviour (non-breaking). `docs_list` returns `profile` per file (parsed from the first path segment when it matches a configured profile). The prompt writes `<profile>/tables/<table>.md` and reads the same path first; on a miss it also reads the legacy root path and says so.
- **Acceptance:** `docs_write({path:"tables/incident.md", profile:"current"})` on profile `dev` lands in `dev/tables/incident.md`; `docs_search({text, profile:"dev"})` returns only that subtree; root writes unchanged.
- **Tests:** profile prefixing on the four tools; unknown profile → 400; the prompt text names the profile-scoped path (walker from L4-02).

#### ID-02 — Generated documents carry no provenance; regeneration overwrites silently

- **Severity:** med · **Status:** VERIFIED · **Effort:** M · **Breaking:** no · **Target:** 2.x · **→ S-14**
- **Gap:** no generated file records who produced it, from which instance, when, from which inputs; the only timestamp is prose inside the Markdown (`src/api/snapshot.ts:93,343`). A model reading `docs/instance/dev/tables.md` cannot tell whether it is a week or a year old, and `docs_write` can overwrite a generated file (or a generator a hand-written one) with no warning (`docsWriteRaw`, `src/api/docs.ts:292-320`).
- **Design:** a **frontmatter contract** on every generated Markdown file, written by `docsWriteRaw` when the caller passes `meta`:

  ```yaml
  ---
  sn_generated: true
  sn_generator: snapshot | document_table | document_app | document_instance | code_health | compare
  sn_generator_version: 2.1.0 # package version
  sn_profile: dev
  sn_instance: dev12345.service-now.com
  sn_generated_at: 2026-09-23T10:00:00.000Z
  sn_source_hash: sha256:… # of the structured input (the JSON companion), so "unchanged" is detectable
  ---
  ```

  Hand-written sections inside a generated document are preserved between `<!-- sn:manual:start -->` / `<!-- sn:manual:end -->` markers on regeneration (the generator reads the previous file, lifts the marked blocks, re-emits them in place). `docs_write` refuses to overwrite a file whose frontmatter says `sn_generated: true` unless `overwrite:true`; generators refuse to overwrite a file **without** that frontmatter unless `overwrite:true` (a hand-written file is never clobbered by accident). `docs_list` parses the frontmatter and returns `generated`, `generator`, `generated_at`, `profile`, `stale` (older than `SN_DOCS_STALE_DAYS`, default 30) and `bytes` per file (the per-file size H-6 deferred here; today `docsList` returns paths only). The JSON companions get the same fields at the top level.

- **Acceptance:** a snapshot re-run reports `unchanged: true` per file whose `sn_source_hash` did not move; a manual block survives a regeneration byte-for-byte; `docs_write` on a generated file without `overwrite` fails with `DOC_GENERATED`.
- **Tests:** frontmatter round-trip; manual-block preservation; both refusal paths; `stale` computed from an injected clock.

#### ID-03 — Two competing indexes and a flat substring search

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ S-14**
- **Gap:** the root `index.md` (`src/api/docs.ts:249-275`) and the snapshot's `<profile>/index.md` (`src/api/snapshot.ts:337-356`) are regenerated by different writers and list different things; `docsSearch` returns a bare line snippet with no heading context and no filter, so a search for `assignment_group` across three profiles returns an unranked pile.
- **Design:** one **manifest** per store, `index.json` (files with the ID-02 metadata, kind, title = first `#` heading, bytes, headings list), rebuilt by every writer through the existing `indexTail` chain; `index.md` is rendered from it, grouped by profile then kind, with the hand-written section last. Kinds are open-ended: the SDK-parity epic adds `fluent` (P-26 writes `.now.ts` under `<profile>/fluent/<scope>/`, [SDK-PARITY.md](SDK-PARITY.md)) and P-21's per-scope application report, both through `docsWriteRaw` with this metadata, so the manifest lists them without a second index. The snapshot's own `index.md` becomes the profile README (ID-10) and stops duplicating the list. `docs_search` gains `profile`, `kind`, `generated` filters and returns the nearest preceding heading with each hit; hits are grouped per file and capped (`SN_DOCS_SEARCH_MAX`, default 200).
- **Acceptance:** `docs_list` and the `servicenow://docs/` listing (M-4) are served from `index.json` without walking the tree; a search hit carries `heading`.
- **Tests:** manifest rebuilt after a snapshot and after `docs_write`; filters; heading attribution; cap.

#### ID-04 — Store safety: git exposure, journal in the same tree, caps — already tracked, one addition

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-5, H-6**
- **Gap:** covered by SEC-11/SEC-12 (H-5: `docs_write` cannot target `write-journal.*`, README documents ignoring `docs/instance/`) and L2-10 (H-6: reserved names, `SN_DOCS_MAX_FILE_BYTES`). Two things are not written anywhere yet: this repo's own `.gitignore` does not list `docs/instance/` (the pack-check excludes it from the tarball, git does not), and no invariant says that **generated documents contain metadata only** — with ID-08's tool writing full table documents, a generator that ever pastes record data would put PII in a file that is one `git add` away from a public repo.
- **Design:** add `docs/instance/` to `.gitignore` in H-5; state the invariant in `docs.ts`'s header comment and enforce it with a test that every generator's mock fetch serves only metadata tables (`sys_db_object`, `sys_dictionary`, `sys_script*`, `sys_plugins`, `sys_app*`, `sys_security_acl`, …) and fails on any other table name; the `document_table` prompt gains "do not paste record data into the document".
- **Acceptance:** the invariant test lists the allowed metadata tables in one place and fails when a generator queries anything else.
- **Tests:** the allow-list walker over the generators' fetch calls.
- **Reconciled (same day, §9):** the `.gitignore` half landed with H-5 and the caps with H-6, both marked done in ROADMAP-V3; the metadata-only invariant (header comment + allow-list walker) is the one open half and is carried by S-14's tests bullet, not by H-5 any more.

### B. Generators

#### ID-05 — ER diagram: no own/inherited split, no expansion, no cap, no key markers

- **Severity:** med · **Status:** VERIFIED · **Effort:** M · **Breaking:** no · **Target:** 2.x · **→ S-14**
- **Gap:** `generateErDiagram` (`src/api/diagrams.ts:30-58`) prints every column of every table, including the ~70 inherited from `task`, with no marker for what the table itself adds, no `PK`/mandatory markers (Mermaid supports `type name PK "comment"`), no cap, and referenced tables outside the set appear as empty entities. For `incident` the result is a wall that no renderer lays out usefully.
- **Design:** options with today's behaviour as the default: `columns: "all" | "own" | "keys"` (`own` = `sourceTable === table`, `keys` = `sys_id`, references and mandatory fields), `max_columns` (default 40; the rest folded into one `string more_columns "… +N"` line), `depth: 0 | 1 | 2` (auto-include referenced tables to that depth with `columns:"keys"`, capped by `SN_DIAGRAM_MAX_NODES`), markers `PK` on `sys_id`, `FK` on references, `"required"` / `"inherited from task"` comments from `mandatory` / `sourceTable`, choice fields marked when S-7's `choices` lands. Inheritance drawn as `task ||--|| incident : extends` when both are in the set.
- **Acceptance:** `generate_er_diagram({tables:["incident"], columns:"own", depth:1})` renders `incident` with its own columns, `task` as `keys`, and one edge per reference — under 60 lines; the default call is byte-identical to today's output for the existing fixture.
- **Tests:** golden fixture per option; cap; depth expansion; unchanged default.

#### ID-06 — Table flow: business rules only, not fed by the trace

- **Severity:** med · **Status:** VERIFIED · **Effort:** M · **Breaking:** no · **Target:** 2.x (lanes that exist today) / 3.0 (S-5 lanes) · **→ S-14, S-5**
- **Gap:** `generateTableFlow` (`src/api/diagrams.ts:82-195`) runs its own `listScripts` query and draws business rules only, while `traceTableFlow` (`src/api/flows.ts:449-450`) already resolves flow triggers, legacy workflows and notifications for the same table and operation, and S-5 adds the client-side lane, data policies, events and SLAs to the trace. Two data paths for one question means the diagram lags the trace by construction.
- **Design:** the diagram is rendered **from the trace result**: `generateTableFlow(table, { operation, lanes })` calls `traceTableFlow` and draws one subgraph per lane in execution order (client → display → before → after → async → flows/workflows → notifications), keeping the S-1 inherited/global sub-lanes; `lanes` defaults to what the trace returns, so every lane S-5 adds to the trace appears in the diagram for free. The old direct query is deleted. The `operation` argument (insert / update / delete / query, default insert) is new and optional.
- **Acceptance:** the S-1 diagram tests pass unchanged through the new path; a fixture with one flow trigger and one notification shows two extra subgraphs after `async`.
- **Tests:** existing four + trace-fed lanes + `operation` filter.

#### ID-07 — Three Mermaid builders, three escaping rules, no validity test

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ S-14 (delivers the E-7 dedup)**
- **Gap:** `src/api/diagrams.ts:14-24`, `src/api/flows.ts:354` and `src/api/whereused.ts:78-82` each escape labels their own way and cap nodes differently (none / none / 40); every test asserts substrings, so a label with a `"` inside a `[…]` node, or an unbalanced `subgraph`, ships unnoticed. H-8 C-4 (`{value, display_value}` shapes) is not pinned for any of them.
- **Design:** one module `src/api/mermaid.ts` — `ident()`, `label()` (also escapes `#`, `;`, backticks and `%%`), `node(id, text, shape)`, `edge(a, b, style)`, `subgraph(id, title, body)`, `erEntity()`, `erRelation()`, a `MermaidDoc` builder with a node cap (`SN_DIAGRAM_MAX_NODES`, default 200, "+N more" node when exceeded) and a `lint(mermaid)` helper for tests (balanced `subgraph`/`end`, every edge endpoint declared, no raw `"` inside `["…"]`, no `^` in identifiers). The three builders become callers, and so do the SDK-parity epic's `explain_flow({format:"mermaid"})` (P-10) and the per-flow / experience / portal diagrams of P-21 ([SDK-PARITY.md](SDK-PARITY.md)) — which is why S-14 precedes P2 of that epic. No parser dependency (bundle size, D-5); the lint is structural, not a grammar.
- **Acceptance:** all Mermaid-producing tests run through `lint()`; a `display_value=all` fixture renders the same diagram as the scalar one.
- **Tests:** `lint()` on every generator's output; C-4 fixtures; escaping table.

### C. Document kinds and coverage

#### ID-08 — "Document a table" exists only as a prompt

- **Severity:** high · **Status:** VERIFIED · **Effort:** M · **Breaking:** no · **Target:** 2.x · **→ S-15**
- **Gap:** see §2.4. The most requested documentation artefact — one readable page per table — depends on a prompt-capable client and on the model following six steps; nothing deterministic exists, so no two runs produce the same document and no automation can call it.
- **Design:** `servicenow_document_table({ table, profile?, write?: boolean = true, diagrams?: boolean = true, columns?: "own"|"all" })` in the `docs` package, backed by `documentTable()` in a new `src/api/document.ts`, producing a **deterministic Markdown document** from existing readers only:
  1. **Header** — frontmatter (ID-02), title `label (name)`, the inheritance chain (`getTableChain`), scope, `sys_db_object` attributes (`is_extendable`, `number_ref`, audit flag when readable).
  2. **Columns** — own columns first, then one table per parent in chain order (`sourceTable`), with label, type, mandatory, max length, reference target, and default/choices when S-7 lands.
  3. **Relationships** — the ER diagram (`columns:"own", depth:1`) in a ` ```mermaid ` block plus the list of tables that reference this one (from `listTables` + `describeTable` of the referencing set is too expensive — use `sys_dictionary` `reference=<table>` directly, one query).
  4. **Lifecycle** — the table-flow diagram (ID-06) for insert and update.
  5. **Logic** — from `tableLogic` (`src/api/scripts.ts:402-417`): business rules (name, when, order, active, condition), client scripts, UI policies, UI actions, ACLs (operation, roles), each as a table; `unreadable[]` becomes a Caveats line, not a failure.
  6. **Caveats** — truncation (`SN_MAX_RECORDS`), unreadable artefact types, domain separation (H-8 C-11), and the "metadata only, no record data" note.
  7. A `<!-- sn:manual -->` block for a human "Purpose" narrative, preserved on regeneration.

  Writes `<profile>/tables/<table>.md` + `.json` (the structured input, hashed for `sn_source_hash`); `write:false` returns the Markdown only. The prompt becomes a thin wrapper: call the tool, then ask the model to write the Purpose narrative into the manual block from what it reads; it references the tool by spec name (L4-02) and declares `requires:["docs","scripts"]`. Tool count 67 → 68 (M-6 budget: the description stays under 400 chars).

- **Acceptance:** two runs against the same fixture produce byte-identical files except `sn_generated_at`; a tool-only client gets the same document the prompt used to describe; the manifest snapshot test gains one entry.
- **Tests:** golden document for the `incident` fixture (own + inherited columns, one BR per phase, one ACL); `write:false`; `unreadable` caveat; manual block round-trip.

#### ID-09 — No scoped-application document

- **Severity:** med · **Status:** VERIFIED · **Effort:** M · **Breaking:** no · **Target:** 3.0 (needs S-4) · **→ S-15**
- **Gap:** `apps.md` lists applications (`sys_app` + `sys_store_app`: name, scope, version, active — `src/api/snapshot.ts:243-270`) and nothing else; the question "what is in scope `x_acme_hr`" — its tables, artefacts, REST APIs, roles, cross-scope privileges — has no answer short of a dozen `query_table` calls, which is exactly what the discovery skill's Tier 2/3 does by hand.
- **Design:** `servicenow_document_app({ scope, profile?, write? })` → `<profile>/apps/<scope>.md` + `.json`: application record (name, version, vendor, active, store/custom), tables in scope (`sys_db_object.sys_scope`, with one-line column summaries and an ER diagram at `depth:0`), artefacts per kind from the S-4 registry filtered by `sys_scope` (counts + name lists, inactive marked), REST APIs (`sys_ws_definition` → operations), scripted REST/outbound (`sys_rest_message`), roles (`sys_user_role` in scope), cross-scope access (`sys_scope_privilege`, when readable), and a Caveats section. Until S-4 lands the artefact section covers the nine `SCRIPT_TYPES` kinds and says so. P-21 (application documentation generator, [SDK-PARITY.md](SDK-PARITY.md)) is the registry-wide successor of this document: it reuses `documentApp` and `DOC_KINDS` and adds the dependency graph and one diagram per flow / experience / portal from P-10 / P-14 / P-16 — one writer, not two.
- **Acceptance:** for a fixture scope with two tables and three artefact kinds the document lists them with counts that match the fixture; a global-scope call is refused with a hint to use `document_instance`.
- **Tests:** golden document; `unreadable` degradation; the refusal.

#### ID-10 — No instance overview document; the snapshot index is the closest thing

- **Severity:** med · **Status:** VERIFIED · **Effort:** M · **Breaking:** no · **Target:** 2.x (overview) / 3.0 (with S-7 kinds) · **→ S-15, S-7**
- **Gap:** the profile's `index.md` (`src/api/snapshot.ts:337-356`) is a file list with warnings. There is no front page that says what this instance is: version and build, counts (tables, custom `u_`/scoped tables, active plugins, scoped apps, artefacts per kind), the scoped apps with links to their documents, update sets in progress (S-6), whether domain separation is on (H-8 C-11), when it was last documented and by which server version.
- **Design:** `servicenow_document_instance({ profile?, tables?: string[], apps?: string[] | "all", kinds?: DocKind[], write? })` → `<profile>/README.md` (the overview, linking every other document of the profile), running the existing snapshot collectors (E-7 splits them into per-section functions), `documentTable` for the named tables and `documentApp` for the named or all custom scopes, plus the ID-11 kinds requested. Version/build from `sys_properties` (`glide.war`, `glide.buildname`, `instance_name`, `glide.installation`) when readable, else from the `x-servicenow-*`-free fallback of "unknown, needs the `sys_properties` read role". Writes per document as it goes (usable partial output on cancel), reports progress per document (M-3), marks `partial: true` in `index.json` when interrupted. `snapshot_instance` stays as-is (compare depends on its JSON); `document_instance` calls the same collectors.
- **Acceptance:** one call documents a fixture instance into `README.md` + `tables/*.md` + `apps/*.md` with the manifest updated; cancelling after the first table leaves a valid partial manifest.
- **Tests:** golden README; partial run; progress notifications counted.

#### ID-11 — Missing document kinds: security, catalog, integrations, notifications, choices

- **Severity:** med · **Status:** VERIFIED · **Effort:** L (spread over S-15, S-4, S-7) · **Breaking:** no · **Target:** 3.0 (security, catalog, integrations) / 3.x (notifications, choices, data model per scope) · **→ S-15, S-4, S-7**
- **Gap:** the store knows tables, plugins, apps and script counts. Nothing documents the security model (roles, role containment, ACLs per table and operation), the service catalog (catalogs → categories → items → variables and variable sets), the integration surface (scripted REST APIs and their operations, outbound REST messages, import sets and transform maps, MID-server-free data sources), notifications (`sysevent_email_action`: table, event, recipients, template) or choice lists (`sys_choice`, which S-7 already plans to snapshot). These are the sections a real "instance documentation" hand-over contains.
- **Design:** a **document-kind registry** in `src/api/document.ts` — `DOC_KINDS: Record<DocKind, { title, collect(profile, ctx) → Section, requires: tables[] }>` — with one collector per kind reused by `document_instance({kinds})` and by a `servicenow_document_kind({kind})`-free design: kinds are only reachable through `document_instance` to keep the tool count flat. 3.0 kinds: `security` (roles + containment + ACL matrix per table from S-3's completed scan), `catalog` (catalog package readers), `integrations` (S-4 registry: `sys_ws_definition`/`sys_ws_operation`, `sys_rest_message`, `sys_transform_map`, `sys_data_source`). 3.x kinds: `notifications`, `choices` (S-7's `sys_choice` snapshot rendered), `data_model` (ER per scope). Each kind writes `<profile>/<kind>.md` + `.json` with the ID-02 frontmatter and degrades per `unreadable` table exactly like `tableLogic`.
- **Acceptance:** `document_instance({kinds:["security"]})` on the ACL fixture produces the matrix with one row per table × operation; an unreadable `sys_user_role` yields a Caveats line, not a failure.
- **Tests:** one golden per kind; registry completeness test (every kind has `requires` and a collector); degradation.

#### ID-12 — The harness `discovery` skill re-implements the server without its rails

- **Severity:** low · **Status:** VERIFIED · **Effort:** S (once ID-09/ID-10 exist) · **Breaking:** no · **Target:** 3.0 · **→ S-16, D-8**
- **Gap:** §2.6. The skill writes four document shapes per instance with `curl` and no policy, redaction, preflight or journal; its output lands in `docs/ai/discovery/` where the server cannot search it. Everything it reads, the server can read.
- **Design:** `document_instance` gains `depth: "overview" | "apps" | "artefacts"` (= the skill's Tier 1/2/3) and writes the skill's file set under `<profile>/discovery/` (`overview.md`, `apps.md`, `tables-<scope>.md`, `artifacts-<scope>.md`) as thin renderings of ID-10 and ID-09 data, so the two outputs converge. D-8's plugin ships an `sn-discover` skill that calls the tool; the harness skill delegates to the server when a configured profile exists and falls back to `curl` otherwise (harness change, outside this repo).
- **Acceptance:** `document_instance({depth:"apps"})` produces the four-file set; the plugin skill needs no credentials of its own.
- **Tests:** file set per depth; the plugin skill's tool names exist (manifest walker).

### D. Delivery and exposure

#### ID-13 — The docs resources cannot be browsed — refine M-4

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ M-4**
- **Gap:** `servicenow://docs/{path}` is registered with `list: undefined` (`src/mcp/resources.ts:205`); M-4 already adds `list`/`complete` capped at 100 (L5-03). Without ID-03's manifest the list has no titles, no kinds and no profile grouping, and 100 entries is one snapshot with 90 schema files.
- **Design:** M-4's `list` is served from `index.json`: one entry per document with `name` = title, `description` = `<profile> · <kind> · <generated_at>`, `mimeType` `text/markdown` (or `application/json` for companions); generated documents first, capped at 100 with a final `servicenow://docs/index.md` entry that always lists everything; `complete` on `{path}` completes from the manifest by prefix and profile.
- **Acceptance:** the inspector lists the profile README and the table documents with titles; the cap never hides `index.md`.
- **Tests:** list shape; cap + index entry; completion by prefix.

#### ID-14 — Large documents are truncated silently — refine S-11

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ S-11**
- **Gap:** `ok()` serialises the whole result and `SN_MAX_RESULT_CHARS` truncates records (`src/mcp/result.ts:88-99,173`); a Mermaid string or a table document is one string, so a `task`-family ER diagram or a `document_table` for `task` either blows the context window or is cut mid-diagram with no note. S-11 plans `format:"file"` for `query_table`, snapshot and compare.
- **Design:** S-11 also covers the generators and the `document_*` tools: a result whose text would exceed `SN_MAX_RESULT_CHARS` is written to the store (generators under `<profile>/diagrams/<name>.mmd`, documents to their normal path) and the tool returns `{ path, bytes, preview }` with the first 2,000 chars and `truncated:true`; `write:true` results always return `{ path, preview }` and never the full text. `SN_DOCS_DIR/exports/` stays for data exports.
- **Acceptance:** a 300-column ER diagram returns a path and a preview under the cap; the file is complete and lints (ID-07).
- **Tests:** cap crossover for a diagram and a document; `preview` length.

#### ID-15 — Long documentation runs need progress and partial output — refine M-3, M-9, S-7

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x (M-3) / 3.x (M-9) · **→ M-3, M-9, S-7**
- **Gap:** `snapshotInstance` is sequential with no progress (GAP L6-05 → S-7 adds fan-out, per-table files, `resume:true`); `document_instance` over 50 tables and 10 scopes is minutes of work with nothing visible until the end and nothing on disk if the client cancels.
- **Design:** M-3's `progressToken` list gains `document_instance` and `document_app` (one tick per document, `message` = the path just written); M-9's `run_as_task` list gains the same two; S-7's `index.json` is the ID-03 manifest with `partial: true` and `resume:true` skipping documents whose `sn_source_hash` is unchanged.
- **Acceptance:** cancelling a `document_instance` after three documents leaves three valid files and a manifest with `partial:true`; `resume:true` finishes only the rest.
- **Tests:** progress count; partial manifest; resume skips unchanged.

#### ID-16 — Annotations and package gating on the documentation tools — cross-reference M-8

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ M-8**
- **Gap:** M-8 already adds `openWorldHint:false` to `docs_list/read/search` and `destructiveHint:true` to `docs_write` (L4-07). The new `document_*` tools read the instance **and** write locally, so they take the snapshot's annotation set (`readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:true`, `src/tools/instance.ts:23-28`); `docs_write` with `overwrite:true` (ID-02) is the one destructive path and its description says so.
- **Design:** the M-8 naming/annotation pass covers `document_table`, `document_app`, `document_instance`; the prompt registration is gated on `docs` + `scripts` (L4-02).
- **Acceptance:** the manifest snapshot pins the three annotation sets.
- **Tests:** manifest snapshot.

### E. Tests

#### ID-17 — Test depth: no golden documents, no Mermaid validity, no content invariants

- **Severity:** med · **Status:** VERIFIED · **Effort:** S (grows with each item) · **Breaking:** no · **Target:** 2.x · **→ S-14, S-15 acceptance; E-6 fixture corpus**
- **Gap:** §2.5 — 24 tests over the whole documentation surface, all substring assertions; nothing pins a document's shape, nothing proves a diagram parses, nothing checks the frontmatter contract or the metadata-only invariant.
- **Design:** a fixture corpus `test/fixtures/docs/` (E-6): the `incident`-family dictionary, one scope with two tables and three artefact kinds, one ACL set; golden files (`*.md`, `*.mmd`) compared after normalising `sn_generated_at`; the ID-07 `lint()` on every Mermaid output; a "documentation contract" test — every generated file starts with the frontmatter, `docs_list` parses it, the manifest lists it; the ID-04 metadata-only walker.
- **Acceptance:** a change to any generator's output fails a golden test; `UPDATE_GOLDEN=1` regenerates.
- **Tests:** as listed; they are the acceptance of S-14/S-15.

## 4. Target design (summary)

### 4.1 Store v2

```
docs/instance/
  index.json                         # manifest: every file with kind, title, profile, generator, generated_at, source_hash, bytes, headings
  index.md                           # rendered from index.json, grouped by profile → kind → hand-written
  <profile>/
    README.md                        # instance overview (document_instance)              S-15
    tables/<table>.md | .json        # table documents (document_table)                   S-15
    apps/<scope>.md | .json          # application documents (document_app)               S-15
    security.md | catalog.md | integrations.md | … (+ .json)   # document kinds          S-15 / S-4 / S-7
    discovery/{overview,apps,tables-<scope>,artifacts-<scope>}.md   # skill-shaped views  S-16
    diagrams/<name>.mmd              # oversized generator output                         S-11
    tables.md|json, plugins.*, apps.*, automation.*, schema/<t>.*   # snapshot (unchanged)
    code-health.md                   # unchanged
    write-journal.jsonl | .md        # unchanged; never a docs_write target (H-5)
  _compare/<a>-vs-<b>.md             # unchanged
  exports/                           # data exports (S-11)
  <anything else>.md                 # hand-written, root (unchanged)
```

Rules: every generated file carries the ID-02 frontmatter; every writer updates the manifest through `docsWriteRaw`; hand-written content is never overwritten by a generator and vice versa without `overwrite:true`; manual blocks survive regeneration; generated documents contain metadata only.

### 4.2 Modules

| Module                 | New / changed        | Holds                                                                                                                                                                    |
| ---------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/api/mermaid.ts`   | new (S-14)           | `ident`, `label`, `node`, `edge`, `subgraph`, `erEntity`, `erRelation`, `MermaidDoc`, `lint`, `SN_DIAGRAM_MAX_NODES`                                                     |
| `src/api/diagrams.ts`  | changed (S-14)       | `generateErDiagram(tables, options)`, `generateTableFlow(table, { operation, lanes })` rendered from `traceTableFlow`                                                    |
| `src/api/docs.ts`      | changed (S-14)       | frontmatter read/write, `meta` on `docsWriteRaw`, `overwrite` guards, manifest (`index.json`) + rendered `index.md`, `profile` on list/read/search, heading-aware search |
| `src/api/document.ts`  | new (S-15)           | `documentTable`, `documentApp`, `documentInstance`, `DOC_KINDS` registry, manual-block preservation, "metadata only" allow-list                                          |
| `src/tools/docs.ts`    | changed (S-14, S-15) | `profile` arguments; `servicenow_document_table`, `servicenow_document_app`, `servicenow_document_instance`                                                              |
| `src/mcp/prompts.ts`   | changed (S-15)       | `document_table` prompt wraps the tool; spec-name references; `requires`                                                                                                 |
| `src/mcp/resources.ts` | changed (M-4)        | docs `list`/`complete` from the manifest                                                                                                                                 |
| `src/api/snapshot.ts`  | changed (E-7, S-7)   | per-section collectors reused by `document_instance`                                                                                                                     |

### 4.3 What stays the same

`snapshot_instance` and `compare_instances` keep their files and JSON shapes (compare depends on them); the root docs path and the four `docs_*` tools keep today's behaviour when `profile` is omitted; the two generators' default output is byte-identical to today's for the existing fixtures; `SN_DOCS_DIR` semantics unchanged. **No entry in the breaking-change register is needed** — every change is opt-in or additive. The only visible behaviour change is the `document_table` prompt writing under `<profile>/` instead of the root; prompts are not an API contract and the prompt reads the legacy path first.

## 5. Finding → roadmap item index

| Finding                    | Item                                                                                                               | Where in ROADMAP-V3                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| ID-01, ID-02, ID-03        | **S-14** Docs store v2 + generator depth                                                                           | new section; sequencing row 52                                                |
| ID-04                      | H-5 (`.gitignore` — done), H-6 (L2-10 — done; per-file `bytes` moved to S-14), S-14 (metadata-only invariant test) | `_(instance-docs pass 2026-09-23)_` bullet in H-5 (ticked); S-14 tests bullet |
| ID-05, ID-06, ID-07        | **S-14** (ID-06's S-5 lanes arrive through the trace)                                                              | new section; E-7 bullet notes the dedup moved to S-14                         |
| ID-08, ID-09, ID-10, ID-11 | **S-15** Document generators: table, app, instance                                                                 | new section; sequencing row 53                                                |
| ID-12                      | **S-16** Native discovery + skill delegation                                                                       | new section; sequencing row 54; D-8 bullet                                    |
| ID-13                      | M-4                                                                                                                | bullet                                                                        |
| ID-14                      | S-11                                                                                                               | bullet                                                                        |
| ID-15                      | M-3, M-9, S-7                                                                                                      | bullets                                                                       |
| ID-16                      | M-8                                                                                                                | bullet                                                                        |
| ID-17                      | S-14 / S-15 acceptance; E-6                                                                                        | bullets                                                                       |

## 6. Sequencing and effort

| Item                                     | Size | Depends on                                                                             | Position                                                                                                                                   | Why there                                                                                                                                                                |
| ---------------------------------------- | ---- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S-14** Docs store v2 + generator depth | M    | S-1 (done)                                                                             | joins the must-have set right after S-2 (row 52)                                                                                           | non-breaking, small, and S-7's per-table files and `index.json` must be born with the frontmatter and manifest — doing S-7 first means migrating its files a second time |
| **S-15** Document generators             | L    | S-14, E-7 collectors, S-4 (app artefacts), S-7 (`describe_table` extras, `sys_choice`) | stretch, after S-4 and S-7 (row 53); `document_table` alone (ID-08) can land on 2.x right after S-14 because it needs only today's readers | the app document and the 3.0 kinds need the registry and the richer schema; the table document does not                                                                  |
| **S-16** Native discovery                | S    | S-15, D-8                                                                              | with D-8 (row 54)                                                                                                                          | it is a rendering of S-15 plus a plugin skill                                                                                                                            |

Recommended: **S-14 in the 2.1 cut** (about a week including tests); **S-15 split** — `document_table` (2–3 days) on 2.x, `document_app` + `document_instance` + the 3.0 kinds on 3.0 after S-4/S-7; **S-16 on 3.0** with D-8. The 2.1 cut grows from "12–15 weeks" to roughly 13–16. The SDK-parity epic ([SDK-PARITY.md](SDK-PARITY.md), same day) does not move these positions: it consumes S-14 (`src/api/mermaid.ts`, the store contract) from its P2 phase on and extends S-15's `document_app` in P-21, so S-14 is the only item here that the epic needs first (§9).

## 7. Explicitly not proposed

- **A docs site or zip bundle** of `docs/instance/` — the profile `README.md` + manifest is the deliverable; static-site generation is 3.x at the earliest.
- **Full-text search index** (lunr/minisearch) — a dependency for a store that is tens of files; the manifest + heading-aware substring search covers it.
- **Merging `snapshot_instance` into `document_instance`** — compare depends on the snapshot files; revisit in 3.x once both share collectors.
- **Rendering diagrams to SVG/PNG** — a Mermaid runtime is a browser or a headless renderer; out of the lane.
- **A separate `document_kind` tool per kind** — kinds ride `document_instance({kinds})` to keep the tool count and `tools/list` budget flat (M-6).

## 8. Deltas applied to ROADMAP-V3 (2026-09-23)

- Status line: this pass added S-14, S-15, S-16 and refined S-7, S-11, M-3, M-4, M-8, E-7, H-5, D-8.
- Sequencing rows 52–54 and a **2026-09-23 update** paragraph (S-14 joins the cut; S-15/S-16 stretch).
- New definitions of done: S-14, S-15, S-16 (with acceptance criteria and tests as in §3).
- `_(instance-docs pass 2026-09-23)_` bullets in H-5, M-3, M-4, M-8, M-9, S-7, S-11, E-7, D-8.
- "Explicitly NOT in 3.0" gains the §7 items; no breaking-register entry.
- Pillar table and id ranges (`S-1 … S-16`) mirrored in ROADMAP.md, PRODUCT-STATE.md and the document maps.
- Later the same day (§9): the H-5 ID-04 bullet ticked for its `.gitignore` half with the invariant moved to S-14; `bytes` added to S-14's `docs_list` fields; S-14/S-15 cross-linked with the SDK-parity rows 64, 75, 80 and the epic section; SDK-PARITY.md P-10 / P-21 / P-26 gained the S-14 / S-15 dependencies and §7 rows for S-14 and S-15.

## 9. Same-day reconciliation (H-8, H-5, H-6, SDK parity)

Three other lines of work landed on the same working tree after this pass was written (all local, uncommitted; gate green at 568/568 including the untracked `test/platform-corners.test.js`, `test/journal-v2.test.js` and `test/outbound-hardening.test.js`). Nothing in §3 changes its severity or target; the deltas are bookkeeping so that the tracker and this document agree with the code.

| Landed                                    | Effect on this analysis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H-8** (platform corners, port)          | No effect on the store. C-4 `{value, display_value}` shapes are now handled in the readers, so the ID-07 fixture bullet pins behaviour that exists rather than one that has to be built.                                                                                                                                                                                                                                                                                                                                    |
| **H-5** (journal v2 + deep redaction)     | Closes the `.gitignore` half of ID-04 (`.gitignore` lists `docs/instance/`) and the §2.2 "journal in the same tree" concern: the journal is redacted, hash-chained (`write-journal.head`), rotated at `SN_JOURNAL_MAX_BYTES`, and `docsWriteRaw` refuses `write-journal.*` (`src/api/docs.ts:101,300-305`). Every docs / snapshot / compare / `code_health` file write is journalled as `local_write`. The metadata-only invariant stays open — carried by S-14's tests bullet.                                             |
| **H-6** (outbound hardening)              | Closes the reserved-names / size-cap half of ID-04: `RESERVED_SEGMENT_RE`, `assertPortableSegments` and `SN_DOCS_MAX_FILE_BYTES` on `docs_read` / `docs_search` (`src/api/docs.ts:49-72,104-119`). H-6 explicitly deferred per-file `bytes` in `docs_list` and left `docsWriteRaw` uncapped; the former is now in ID-02 / S-14, the latter stays by design (generators own their size).                                                                                                                                     |
| **SDK-parity plan** (P-1…P-29, docs only) | Four touch points, now cross-linked in both trackers: P-10 `explain_flow({format:"mermaid"})` and P-21's per-artefact diagrams render through S-14's `src/api/mermaid.ts` (ID-07), so S-14 precedes the epic's P2; P-21 is the registry-wide successor of S-15's `document_app` (ID-09) and must reuse `documentApp` / `DOC_KINDS`; P-26 `generate_fluent` writes under `<profile>/fluent/<scope>/` and becomes a manifest kind (ID-03); P-20 widens S-7's snapshot, which is why S-14's frontmatter must exist before S-7. |

Line references in §2 and §3 were refreshed against this tree (`src/api/docs.ts`, `src/core/write-journal.ts`, `src/mcp/result.ts`); every other cited range was re-checked and still holds. The two owner decisions of §6 are unchanged: S-14 in the must-have cut, and `document_table` on 2.x before the rest of S-15.
