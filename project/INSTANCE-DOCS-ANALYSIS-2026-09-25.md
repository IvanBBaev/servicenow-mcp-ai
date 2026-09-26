# servicenow-mcp-ai — Instance documentation: second pass (2026-09-25)

Date: 2026-09-25 · Status: **proposed — folded into [ROADMAP-V3.md](ROADMAP-V3.md) as refinements to S-15, S-16, M-4, M-8, S-7, E-6, E-7 and the sequencing rows 53–54.** A fourth pass over the v3.0 plan and the second one focused on instance documentation, read-only, against the local working tree of 2026-09-25 (`main` at `5acdcc7` plus the uncommitted work through batch 6 of 2026-09-24: S-14 docs store v2, M-3 progress, S-3 security scan, S-8, P-1 artefact registry, S-4, S-13, D-2, P-3/P-4, M-8, S-9, E-5, P-5 — gate green at 817/817, 72 tools in 20 packages, pack 794 KB of the 800 KB ceiling). It answers two questions: **what did the first pass ([INSTANCE-DOCS-ANALYSIS-2026-09.md](INSTANCE-DOCS-ANALYSIS-2026-09.md), 2026-09-23) get closed by the code that landed since**, and **what does the code that landed change about the open items** — chiefly S-15 (document generators), whose prerequisites moved. It reuses the finding format of the earlier passes and never re-proposes a closed finding.

Finding ids continue at `ID-18` … `ID-29`. Every `_(instance-docs pass 2 2026-09-25)_` bullet in ROADMAP-V3 names the finding it absorbs; the first pass's `_(instance-docs pass 2026-09-23)_` bullets stay as they are.

## 1. Scope and method

**In scope** — the same surfaces as the first pass, re-read as they are today: the docs store (`src/api/docs.ts`, 920 lines), the Mermaid module (`src/api/mermaid.ts`) and the generators over it (`src/api/diagrams.ts`, `src/api/flows.ts`, `src/api/whereused.ts`), the writers (`src/api/snapshot.ts`, `src/api/compare.ts`, `src/api/codecheck.ts`), the `document_table` prompt, the docs and reference resources, the tests; plus the three things that did not exist on 2026-09-23 and change the design of S-15: the artefact registry (`src/core/artifacts/registry.ts`, P-1 + S-4), the generic artefact readers (`src/api/artifacts.ts`, P-5) and the security scan (`src/api/security.ts`, S-3).

**Out of scope** — unchanged from the first pass: the server's own README / manifest generation (D-3), journal content model (H-5), the Jira surface. The SDK-parity epic is referenced where S-15 and P-21 share code, not re-planned.

**Method** — every claim marked **verified** was re-read in code during this pass (file:line against the 2026-09-25 tree) or produced by a command (`node -e 'import("./build/core/artifacts/registry.js")…'` for the registry counts, `grep -c '^test('` for suite sizes). Nothing was run against an instance. The disposition table in §3 is the deliverable the first pass asked for ("re-check in the first hour of the item"); §4 holds the new findings; §9 lists the tracker deltas applied today.

## 2. What landed since the first pass (2026-09-23 → 2026-09-25)

### 2.1 Docs store v2 (S-14) — **verified**

- Frontmatter on every generated file: `sn_generated`, `sn_generated_at`, `sn_generator`, `sn_generator_version`, `sn_instance`, `sn_kind`, `sn_profile`, `sn_source_hash` (`src/api/docs.ts:21-35` header, `parseFrontmatter` `:179`); JSON companions carry the same keys at top level.
- `mergeManualBlocks` (`:237`) preserves `<!-- sn:manual:start -->` … `<!-- sn:manual:end -->` byte for byte; `sourceHash` (`:271`) over `DocMeta.source` decides `unchanged`; `DOC_GENERATED` protects generated files from `docs_write` and hand-written files from generators unless `overwrite` (`DocMeta` `:276-301`).
- Profile namespace: `resolveDocsProfile` (`:398`) + `scoped` (`:412`) on `docsList` (`:510`), `docsRead` (`:537`), `docsSearch` (`:579`), `docsWrite` (`:762`); `docsWriteRaw(relPath, content, extensions, meta?)` (`:790-869`) is the single generator primitive.
- Manifest `index.json` = `{ schema_version: 1, files: ManifestEntry[] }` (`:648-709`), `ManifestEntry {path, kind, title, profile, generator, generated_at, source_hash, bytes, headings}`; `index.md` is rendered from it (`renderIndex` `:712`); regeneration is serialised through `indexTail`.
- Caps and hygiene from H-6 / H-5: `SN_DOCS_MAX_FILE_BYTES`, portable segment guard, `docs/instance/` git-ignored, every write journalled as `local_write` (`persist` `:906-920`).

### 2.2 Mermaid module and generators (S-14, S-1) — **verified**

- `MermaidDoc` (`src/api/mermaid.ts:111`) owns escaping, node budget (`SN_DIAGRAM_MAX_NODES`, `:117-152`) and a `truncated` getter (`:205`). All three builders use it: ER + table flow (`src/api/diagrams.ts:309`), flows (`src/api/flows.ts:357`), where-used (`src/api/whereused.ts:145`).
- ER: `columns: "own" | "keys" | "all"`, `max_columns`, `depth: 0|1|2`, key markers (`generateErDiagram`); table flow: `operation`, lanes for own / inherited / global rules. `diagrams.ts` surfaces `truncated` (`:240`, `:401`); `flows.ts` and `whereused.ts` do not (→ ID-26).
- Goldens: ten `.mmd` fixtures under `test/fixtures/docs/` (`er-incident*.mmd` ×5, `flow-incident*.mmd` ×3, `trace-incident-update.mmd`, `whereused-incident.mmd`), linted by `test/mermaid-lint.js`.

### 2.3 Writers — **verified**

- Snapshot (`src/api/snapshot.ts`, 449 lines) is still one function: `trackProgress(requested.length + Object.keys(SCRIPT_TYPES).length + 5)` (`:129-130`), the automation loop over `SCRIPT_TYPES` at `:344`; M-3 progress + cancellation are in. The per-section collectors the first pass assumed for `document_instance` (E-7) do not exist yet.
- Compare writes `_compare/${a}-vs-${b}.md` at the store **root** with `kind: "compare"` filed under the first profile (`src/api/compare.ts:403`, `:457-459`).
- Code health writes `<profile>/code-health.md` + `.json`, `kind: "code-health"` (`src/api/codecheck.ts:470-473`), and now embeds the S-3 security scan (`securityScan()` call at `:374`, top-20 table). **There is no `servicenow_security_scan` tool** — the manifest lists none; S-3's result is reachable only through `servicenow_code_health`.

### 2.4 Artefact registry and generic readers (P-1, S-4, P-3, P-5) — **verified by command**

```
total 34   verified 9   scriptTools 24   unverified 25   groups 12
verified (script tools): business_rule script_include client_script ui_policy ui_action
                         scheduled_job transform rest_operation acl
unverified script seeds (S-4): script_action transform_map transform_entry fix_script email_script
                         processor data_source rest_message_fn ui_script ui_page ui_macro
                         validation_script sp_widget catalog_client_script dictionary_script
unverified non-script seeds: rest_api workspace uib_app_config uib_macroponent sp_portal sp_page
                         flow workflow catalog_item database_view
groups: core server classic-ui next-experience uib portal flow workflow catalog quality ai application
```

- `SCRIPT_TYPES` is a derived view over `ARTIFACT_TYPES.filter(t => t.scriptTools)` (`src/api/scripts.ts:40-41`); `listScripts` takes `scope` (`:100-101`, `:128`, `scopeClause` `:73`). Every descriptor has `scopeField`, most have `activeField`, `keyFields`, `children`, `sdkApi`, `tiers`, `verified`.
- P-5's `listArtifacts({ artifactType, scope?, query?, active?, limit? })` (`src/api/artifacts.ts:117`, options `:91-99`) returns `ArtifactSummary {sys_id, name, key, scope, active?, sdkManaged, …metadata fields}` (`:101-110`) through policy + redaction and marks unverified types `degraded` (`:181`); `artifactTypeCatalog()` (`:504`) is served as `servicenow://artifact-types` (`src/mcp/resources.ts:313-324`, JSON).
- Consequence for S-15: the "nine `SCRIPT_TYPES` kinds until S-4 lands" caveat in the tracker is stale, and `document_app` has a ready-made, policy-checked collector (→ ID-22, ID-29).

### 2.5 Security scan (S-3) — **verified**

`securityScan()` (`src/api/security.ts:264`) → `SecurityScan { available, unavailableReason?, aclCount, findings, bySeverity, truncated?, truncatedReason?: "cap"|"scan_limit"|"ceiling", filtered?, checks? }` (`:63`); checks `acl_roles | role_inheritance | public_rest_resources | public_ui_pages | tables_without_acl | admin_overlap_roles | elevated_privilege_acls` (`SecurityCheckName` `:54`); `SecurityFinding {sys_id, name, operation, rule, severity, hint, kind?, table?, roles?, grantedBy?}`; reads `sys_security_acl`, `sys_security_acl_role`, `sys_user_role`, `sys_user_role_contains`, `sys_ws_operation`, `sys_ui_page`, `sys_db_object` under `SECURITY_SCAN_MAX_ROWS = 50_000` (`:81`). 13 tests in `test/security-scan.test.js`. This is exactly the input the first pass's `security` document kind (ID-11) asked S-3 to provide (→ ID-23).

### 2.6 Progress and cancellation (M-3) — **verified**

`extra.signal` aborts fetch / queue / backoff (`CANCELLED`); throttled `notifications/progress` from `fetchAll`, snapshot, compare and batch. The first pass's ID-15 bullets in M-3 and M-9 (one tick per document on `document_instance` / `document_app`) stay open because the tools do not exist yet.

### 2.7 Prompt, resources, annotations (M-8, S-8, P-5) — **verified**

- `servicenow_document_table` prompt (`src/mcp/prompts.ts:82-121`): six steps, step 1 still tries the legacy root path first, step 4 already names `columns 'keys'` / `depth 1`; **no `requires`** — `registerPrompts(server)` is unconditional (`src/index.ts:112`, nothing in `prompts.ts` consults `SN_TOOL_PACKAGES`); no reference to `servicenow://reference/encoded-query`.
- `servicenow://reference/encoded-query` exists since S-8 (`src/mcp/resources.ts:130-150`, `text/markdown`) — M-4's first "new resources" bullet is half delivered.
- `servicenow://docs/{path}` (`:273-292`): `list: undefined`, `mimeType` fixed to `text/markdown`, `docsRead(docPath)` with no profile argument.
- Annotations: docs list / read / search / ER / flow `readOnlyHint: true` with all four hints present; `docs_write` `{ readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false }` (`src/tools/docs.ts:118-123`); snapshot / compare `{ readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:true }` (`src/tools/instance.ts:29-34`). M-8 made all four hints mandatory in the registrar.

### 2.8 Tests — **verified by command**

81 test files, 817 tests. Relevant suites: `docs-store` 12, `docs` 9, `docs-goldens` 9 (ten `.mmd` fixtures), `diagrams` 4, `mermaid` 6, `snapshot` 7, `compare` 4, `codecheck` 14, `security-scan` 13, `artifact-registry` 11, `artifacts` 11, `references` 22, `instance-resources` 3. The metadata-only guard (`METADATA_TABLES` `test/docs-goldens.test.js:46`, `assertMetadataUrl` `:76`, `fetchMeta` `:88`) is used **only** in that file; `snapshot`, `compare` and `codecheck` use the plain `withFetch` double from `test/helpers.js`. No golden exists for any Markdown writer (snapshot files, compare report, code-health report).

## 3. Disposition of the first-pass findings (ID-01 … ID-17)

| Finding                                                                      | First-pass target | Status today                   | Evidence (2026-09-25 tree)                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ID-01 Hand-written documents and the prompt ignore the profile namespace     | S-14              | **closed**                     | `resolveDocsProfile` / `scoped` on all four docs tools (`src/api/docs.ts:398-412`); the prompt writes `tables/<table>.md` with profile `current` (step 6). Residue: step 1's legacy-root read → ID-25.                                           |
| ID-02 Generated documents carry no provenance; regeneration overwrites       | S-14              | **closed**                     | Frontmatter + `sn_source_hash` + `DOC_GENERATED` + manual blocks (`:179-301`, `:790-869`). Follow-up: the single global `DOCS_GENERATOR_VERSION` → ID-18.                                                                                        |
| ID-03 Two competing indexes and a flat substring search                      | S-14              | **closed**                     | One manifest (`index.json`) renders `index.md` (`:648-712`); `docs_search` is heading-aware with `kind` / `profile` filters. Follow-ups: manifest has no `partial` / top-level timestamp → ID-19; `.json` companions absent from it → ID-21.     |
| ID-04 Store safety: git exposure, journal in the same tree, caps             | H-5, H-6, S-14    | **closed**                     | `.gitignore`, `SN_DOCS_MAX_FILE_BYTES`, portable segments, journal redacted / chained / rotated, `local_write` journal entries; metadata-only invariant stated in the header (`:21-35`) and enforced by the goldens walker. Guard scope → ID-27. |
| ID-05 ER diagram: no own/inherited split, no expansion, no cap, no keys      | S-14              | **closed**                     | `columns` / `max_columns` / `depth`, key markers, `MermaidDoc` cap with `truncated` surfaced (`src/api/diagrams.ts:240`). Nothing left open.                                                                                                     |
| ID-06 Table flow: business rules only, not fed by the trace                  | S-1, S-14         | **closed**                     | Lanes for own / inherited / global, `operation` filter, `truncated` surfaced (`:401`).                                                                                                                                                           |
| ID-07 Three Mermaid builders, three escaping rules, no validity test         | S-14              | **closed**                     | One `MermaidDoc`; `test/mermaid-lint.js` over ten goldens. Residue: `whereused.ts` pre-caps at `MERMAID_EDGES = 40` and neither it nor `flows.ts` surfaces `doc.truncated` → ID-26.                                                              |
| ID-08 "Document a table" exists only as a prompt                             | S-15              | **open**                       | No `src/api/document.ts`, no `servicenow_document_table` tool in the manifest (72 tools). Unblocked: every reader it needs exists. Pack ceiling is the only practical gate (§7).                                                                 |
| ID-09 No scoped-application document                                         | S-15              | **open, unblocked**            | The "after S-4" prerequisite is met and the collector exists (`listArtifacts`, `src/api/artifacts.ts:117`). Design refreshed → ID-22.                                                                                                            |
| ID-10 No instance overview document                                          | S-15, S-7, E-7    | **open, blocked**              | Snapshot is still monolithic (`src/api/snapshot.ts:129-130`, `:344`); the E-7 collector split is the hard prerequisite → ID-24.                                                                                                                  |
| ID-11 Missing kinds: security, catalog, integrations, notifications, choices | S-15, S-3, S-7    | **open, `security` unblocked** | S-3 delivers the full `SecurityScan` structure (§2.5) with no tool of its own → ID-23. `catalog` / `integrations` wait for S-15 itself; `notifications` / `choices` for S-7.                                                                     |
| ID-12 The harness `discovery` skill re-implements the server                 | S-16, D-8         | **open**                       | Unchanged; the P-5 catalog resource gives S-16 a registry rendering for free → ID-29.                                                                                                                                                            |
| ID-13 The docs resources cannot be browsed — refine M-4                      | M-4               | **open**                       | `list: undefined`, no `complete`, fixed `text/markdown` (`src/mcp/resources.ts:273-292`). Widened by the JSON-companion gap → ID-21.                                                                                                             |
| ID-14 Large documents are truncated silently — refine S-11                   | S-11              | **open**                       | `SN_MAX_RESULT_CHARS` still truncates tool results; `docs_read` truncates at `SN_DOCS_MAX_FILE_BYTES` with a flag (H-6). No change to the S-11 bullet.                                                                                           |
| ID-15 Long runs need progress and partial output — refine M-3, M-9, S-7      | M-3, M-9, S-7     | **partial**                    | M-3 done for snapshot / compare; the `document_*` ticks wait for the tools; `partial:true` needs a manifest field → ID-19.                                                                                                                       |
| ID-16 Annotations and package gating on the documentation tools              | M-8               | **partial**                    | Annotation half done (all four hints mandatory; `docs_write` `destructiveHint:true`). The prompt-gating half is **not** done although the M-8 bullet is ticked: `registerPrompts` runs unconditionally (`src/index.ts:112`) → ID-25.             |
| ID-17 Test depth: no goldens, no Mermaid validity, no content invariants     | S-14, E-6         | **partial**                    | Diagram goldens + Mermaid lint + metadata guard exist; no writer goldens (→ ID-28); the guard is local to one file (→ ID-27).                                                                                                                    |

Seven closed, five open, three partial, two open-but-unblocked. No first-pass finding changed severity.

## 4. New findings

Format as before: severity · status · effort · breaking · target line · the tracker item that absorbs it; then gap, design, acceptance, tests.

#### ID-18 — One global generator version invalidates every writer's `unchanged` short-circuit

- **Severity:** medium · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x (with the first S-15 writer) · **→ S-15**
- **Gap:** `DOCS_GENERATOR_VERSION = "1"` is one module-level constant (`src/api/docs.ts:169`), compared at `:829` and written at `:844` for every generator. Bumping it because the table document's layout changed forces snapshot, compare and code-health to rewrite every file too — and a writer that does _not_ bump it silently keeps serving an old layout when its own template changes, because `sn_source_hash` only covers the input. The key `sn_generator_version` is already per file; only the value is global.
- **Design:** `DocMeta` gains `generatorVersion?: string` (default: the global constant, so nothing changes for existing writers); `docsWriteRaw` compares and writes `meta.generatorVersion ?? DOCS_GENERATOR_VERSION`. Each S-15 kind declares its own version in `DOC_KINDS` (`{ title, version, collect, requires }`), and the existing writers move to per-writer constants in the same change (`SNAPSHOT_DOC_VERSION`, `COMPARE_DOC_VERSION`, `CODE_HEALTH_DOC_VERSION`). The manifest keeps `generator` and gains nothing.
- **Acceptance:** bumping one writer's version rewrites only its files on the next run; a second run of every writer against the same fixture is `unchanged` for all of them.
- **Tests:** `docs-store`: two writers, one bump, assert the other's `unchanged`; a frontmatter round-trip with a non-default version.

#### ID-19 — The manifest cannot say "this run stopped early" or "this is when the store was last touched"

- **Severity:** medium · **Status:** VERIFIED · **Effort:** S · **Breaking:** no (additive, `schema_version` stays 1) · **Target:** 2.x · **→ S-15, S-7**
- **Gap:** `index.json` is `{ schema_version: 1, files }` (`src/api/docs.ts:705`), rebuilt from a directory walk after every write. Nothing records whether the last multi-file run (snapshot today, `document_instance` tomorrow) completed, nor when the store was last regenerated; the first pass's `partial:true` (S-7 L6-05, S-15 ID-10) has no field to land in, and a reader of the manifest cannot tell a cancelled run from a finished one.
- **Design:** two additive top-level fields: `generated_at` (ISO, the rebuild time) and `runs: Record<generator, { profile, started_at, finished_at | null, partial: boolean, files: number }>` — the last run per generator, written by the writer through a small `docsRunBegin/End(generator, profile)` pair that `docsWriteRaw` does not need to know about. `partial` is `true` while a run is open and after a `CANCELLED` abort; `finished_at` closes it. `index.md` shows one line per open or partial run ("snapshot on `current` — partial, 7 files, cancelled 2026-09-25T…"). `schema_version` stays 1 because readers ignore unknown keys; the S-14 manifest test asserts the two keys are optional.
- **Acceptance:** cancelling a snapshot after three tables leaves `runs.servicenow_snapshot_instance.partial === true` and three valid files; the next full run flips it to `false`; `generated_at` changes on every rebuild and is excluded from the golden comparisons.
- **Tests:** `docs-store`: run begin / end round-trip, abort path via `AbortController`; `snapshot`: partial manifest on cancel (extends the M-3 cancel test).

#### ID-20 — The compare report lives outside every profile and is invisible to a scoped listing

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no (legacy path still read) · **Target:** 2.x · **→ S-7**
- **Gap:** `compareInstances` writes `_compare/<a>-vs-<b>.md` at the store root and files it under `profile: a` with a comment "the report covers both" (`src/api/compare.ts:403`, `:457-459`). `docs_list({ profile: "a" })` filters by the `<profile>/` path prefix (`src/api/docs.ts:510`), so the report never appears in a scoped listing, and `docs_read("_compare/…", { profile })` fails the prefix check. The frontmatter says one thing, the path another.
- **Design:** write `<a>/compare/<a>-vs-<b>.md` (+ `.json` companion with the diff structure) with `kind: "compare"`, `profile: a`, and a `sn_compare_with: b` frontmatter key; keep reading the legacy root path through `isLegacyOutput` for one minor so an existing report is taken over on the next run (the legacy file is deleted after a successful write). `index.md` lists compare reports under the first profile's kind group. Sequenced with S-7 because that item rewrites the report body anyway.
- **Acceptance:** after one compare, `docs_list({ profile: "a", kind: "compare" })` returns the report and `docs_list({ profile: "b" })` does not; a pre-existing `_compare/…` file is replaced without tripping `DOC_GENERATED`.
- **Tests:** `compare`: path + frontmatter assertions, legacy takeover, scoped listing.

#### ID-21 — JSON companions are written but cannot be listed, read or served

- **Severity:** medium · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ M-4 (resource), S-15 (`docs_read`)**
- **Gap:** every generator writes a `.json` companion, yet `walk` collects `.md` only (`src/api/docs.ts:143`), so companions are absent from `index.json`; `resolveDocPath` defaults to `[".md"]` (`:96`) and `docsRead` exposes no extension argument, so `docs_read("current/tables.json")` throws; the docs resource hard-codes `mimeType: "text/markdown"` (`src/mcp/resources.ts:280`, `:290`). The structured data S-15 hashes for `sn_source_hash` — the most useful thing for a second model or a script — is unreachable through MCP.
- **Design:** `walk` takes an extension list (`[".md", ".json"]` for the manifest walk); `ManifestEntry` gains `companion?: string` on the `.md` entry (the sibling `.json` path) and JSON files get their own entry with `kind` from the top-level `sn_kind`, `headings: []`; `docs_read` accepts `.json` paths (`extensions: [".md", ".json"]`) and returns `{ content, mimeType }`; the resource sets `mimeType` by extension (`application/json` for `.json`) and passes `profile` when the URI starts with a known profile segment. `docs_search` keeps searching Markdown only. Ties into ID-13 (the manifest-driven `list` gets the companions for free).
- **Acceptance:** `docs_read("current/tables.json")` returns the companion with `mimeType: "application/json"`; the manifest lists it and links it from the `.md` entry; `docs_search` results are unchanged.
- **Tests:** `docs-store`: manifest with companions, `docs_read` of a `.json`, path guard still refuses `.txt`; `instance-resources`: JSON mimeType on the docs resource.

#### ID-22 — `document_app` should be registry-driven through the P-5 collector, not a `SCRIPT_TYPES` loop

- **Severity:** high (design, blocks S-15's second tool) · **Status:** VERIFIED · **Effort:** M (inside S-15) · **Breaking:** no · **Target:** 2.x · **→ S-15**
- **Gap:** the S-15 `document_app` bullet still says "artefacts per kind from the S-4 registry filtered by `sys_scope` (the nine `SCRIPT_TYPES` kinds until S-4 lands, and it says so)". S-4 landed; the registry has 34 types in 12 groups (§2.4), every one with `scopeField`, and P-5 added `listArtifacts({ artifactType, scope })` (`src/api/artifacts.ts:117`) which already applies policy, redaction, `scopeClause`, the `active` flag, `sdkManaged` and a `degraded` marker for the 25 unverified types. A `document_app` that loops `SCRIPT_TYPES` would cover 24 script types and skip flows, portals, UI Builder, catalog items, REST APIs and workspaces; one that reuses the P-5 collector covers everything the server knows about with the same caveats the tools show.
- **Design:** `documentApp(scope)` iterates `ARTIFACT_GROUPS` in order (`core`, `server`, `classic-ui`, `next-experience`, `uib`, `portal`, `flow`, `workflow`, `catalog`, `quality`, `ai`, `application`), and within each group every `ARTIFACT_TYPES` entry, calling `listArtifacts({ artifactType, scope, limit: SN_MAX_RECORDS })`; each type renders one table (name, key, active, sdkManaged, plus the type's metadata fields) with a count line; an unverified type renders its table under a "not confirmed on a live instance (gate O-5)" note when `degraded` is set and is otherwise indistinguishable; an unreadable type becomes a Caveats line. The application record itself (`sys_app` / `sys_store_app`), tables in scope (`sys_db_object` `sys_scope=…`) with an ER at `depth:0`, roles and cross-scope privileges stay as in the first pass. SDK-managed detection (P-3) appears as a single verdict line in the header (`sdkManaged: yes/no/unknown`, from `src/core/artifacts/sdk-managed.ts`). The `.json` companion is `{ app, tables, artefacts: Record<type, ArtifactSummary[]>, degraded: string[], unreadable: string[] }`. P-21 keeps its role as the registry-wide successor (dependency graph, per-flow / experience / portal diagrams) — the P-5 collector is what makes "one writer, not two" concrete.
- **Acceptance:** for a fixture scope with two tables and artefacts of five types across three groups, the document has one section per non-empty group in `ARTIFACT_GROUPS` order, one table per type, the unverified type carries the O-5 note, and `global` is refused with the `document_instance` hint; a registry-completeness test fails when a type is added to `ARTIFACT_TYPES` without a rendering column set.
- **Tests:** golden app document; `degraded` + `unreadable` rendering; the completeness test in `artifact-registry`.

#### ID-23 — The `security` document kind is one rendering away and has no tool today

- **Severity:** medium · **Status:** VERIFIED · **Effort:** S (inside S-15) · **Breaking:** no · **Target:** 2.x (can ship with `document_table`) · **→ S-15**
- **Gap:** S-3 delivered `securityScan()` with checks, `bySeverity`, per-finding `table` / `operation` / `roles` / `grantedBy`, `truncatedReason` and `unavailableReason` (§2.5), but the only consumer is `servicenow_code_health` (`src/api/codecheck.ts:374`), which renders a top-20 table. The first pass's `security` kind (ID-11) was planned "from S-3" with a table × operation ACL matrix; the input now exists in full and there is no reason to hold it behind `document_instance`, which is blocked on E-7 (ID-24).
- **Design:** `DOC_KINDS.security = { title: "Security", version: "1", requires: ["codecheck"], collect: securityScan }` rendering `<profile>/security.md` + `.json`: a header with `aclCount`, `available` / `unavailableReason`, `truncatedReason` and `filtered` as Caveats; one section per check in `SecurityCheckName` order with its `bySeverity` counts; findings grouped by `table` then `operation` (the ACL matrix: rows = tables, columns = create / read / write / delete, cells = roles or "public"), then the non-table checks (roles, REST resources, UI pages) as flat tables; `hint` text verbatim. Code health keeps its top-20 summary and links to the full document. Reachable as `document_instance({ kinds: ["security"] })` once that tool exists; until then as `document_table`'s sibling `servicenow_document_kind({ kind, profile?, write? })` **only if** the owner accepts one more tool (73) — otherwise it waits for `document_instance`. Recommendation: accept the tool; it is the generic entry point every later kind (catalog, integrations, notifications, choices) reuses, and it keeps `document_instance` thin.
- **Acceptance:** on the S-3 ACL fixture the security document has one matrix row per table × operation, the same `bySeverity` totals as `code_health`, and `truncatedReason` in Caveats when the scan cap trips; `unavailableReason` yields a two-line document, not an error.
- **Tests:** golden `security.md` from the `security-scan` fixture; the cap and unavailable paths.

#### ID-24 — `document_instance` needs the snapshot collectors split first; make E-7 name them

- **Severity:** medium · **Status:** VERIFIED · **Effort:** M (E-7 scope) · **Breaking:** no · **Target:** 2.x (before `document_instance`) · **→ E-7, S-7**
- **Gap:** `snapshotInstance` is one function with one progress budget (`src/api/snapshot.ts:129-130`) and one automation loop (`:344`); its readers for tables, plugins, apps and automation are not exported. Both S-7 (per-table files, `resume`) and S-15 (`document_instance` over "the E-7 per-section snapshot collectors") depend on collectors that E-7 only describes as "split `snapshotInstance` and `compareInstances` into per-section collectors". Without names and signatures the two items cannot be scheduled independently, and `document_instance` cannot land on 2.x.
- **Design:** E-7 exports, from a new `src/api/collectors.ts`: `collectTables(ctx)`, `collectPlugins(ctx)`, `collectApps(ctx)`, `collectAutomation(ctx, types = SCRIPT_TYPES)`, `collectSchema(ctx, table)` — each `(ctx: { signal?, progress? }) => Promise<{ data, unreadable: string[], truncated?: boolean }>`, no file I/O, no Markdown; `snapshotInstance` becomes composition + rendering + `docsWriteRaw`, byte-identical output (the existing `snapshot` tests are the regression net), and `compareInstances` reads the same shapes. `document_instance` then calls the collectors it needs per `depth` and never the snapshot. This is the one E-7 bullet that must precede S-15's third tool; the lint-rule bullets of E-7 can stay later.
- **Acceptance:** snapshot output is byte-identical before and after the split (goldens from ID-28 pin it); `document_instance({ depth: "overview" })` runs `collectApps` + `collectPlugins` only, and the progress total equals the number of documents written.
- **Tests:** `snapshot` (unchanged, plus goldens); a `collectors` suite with one test per collector on the fetch double (`unreadable`, `truncated`, abort).

#### ID-25 — The `document_table` prompt is unguarded, reads the legacy path and ignores the reference resource

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x (with `document_table`) · **→ S-15, M-4, M-8**
- **Gap:** (a) the M-8 bullet for ID-16 is ticked, but `registerPrompts(server)` is unconditional (`src/index.ts:112`) and `prompts.ts` never consults the enabled packages: a client with `docs` off still sees a prompt whose every step names a tool that does not exist. (b) Step 1 (`src/mcp/prompts.ts:100`) still reads `tables/<table>.md` at the legacy root before the profile path, a year after ID-01 closed. (c) M-4's acceptance says "the encoded-query resource is used by the `document_table` prompt"; the resource exists (S-8) and the prompt does not mention it — nor could it usefully until the prompt asks the model to write a query (the "tables referencing this one" step).
- **Design:** `registerPrompts` takes the enabled package set and registers each prompt only when its `requires` packages are on (`servicenow_document_table`: `docs` + `scripts`; the change prompt: `change` or `table`); the L4-02 manifest walker gains the prompts. When the `document_table` tool lands (ID-08) the prompt shrinks to: call the tool with `write:true`, read the result path, write the Purpose narrative into the manual block via `docs_write` with `overwrite:false`; step 1 reads only the profile path; the reference-query step points at `servicenow://reference/encoded-query` for the `reference=<table>` query it asks the model to run. M-4's acceptance sentence moves to this bullet.
- **Acceptance:** with `SN_TOOL_PACKAGES=table` the prompt list is empty; with `docs,scripts` it contains `servicenow_document_table`; the prompt text names only registered tools (walker) and the reference resource.
- **Tests:** `mcp-smoke` / `packages`: prompt gating per package set; the manifest walker over prompt text.

#### ID-26 — Two Mermaid builders still hide their own truncation

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ S-15 (diagram bullet), E-7**
- **Gap:** `buildMermaid` in `src/api/whereused.ts:140-165` slices its edge list at a local `MERMAID_EDGES = 40` (`:138`, `:158`) _before_ `MermaidDoc` applies `SN_DIAGRAM_MAX_NODES`, and the result never reads `doc.truncated` (`src/api/mermaid.ts:205`); `flows.ts:357` builds through `MermaidDoc` but likewise drops the getter. `diagrams.ts` surfaces `truncated` (`:240`, `:401`). A where-used graph with 60 references silently shows 40 with no "+20 more" node and no flag; a user raising `SN_DIAGRAM_MAX_NODES` sees no change.
- **Design:** drop `MERMAID_EDGES`; let `MermaidDoc` fold the overflow into its "+N more" node; both builders return `{ mermaid, truncated? }` and the tools copy `truncated` into the result next to the existing `caveats`. The `whereused-incident.mmd` golden gains an overflow variant.
- **Acceptance:** 60 references with the default cap render the cap's node count plus one "+N more" node and `truncated: N`; with `SN_DIAGRAM_MAX_NODES=100` all 60 render.
- **Tests:** `whereused`, `flows`: overflow goldens; `mermaid`: unchanged.

#### ID-27 — The metadata-only guard protects the diagram generators only

- **Severity:** medium · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ E-6, S-15 (tests bullet)**
- **Gap:** `METADATA_TABLES` + `assertMetadataUrl` + `fetchMeta` live in `test/docs-goldens.test.js:46-88` and are used nowhere else. The writers that actually put many files on disk — snapshot, compare, code health, and since S-3 the security scan — are tested with the plain `withFetch` double, so a future collector reading `incident` rows would pass the gate. The store header (`src/api/docs.ts:31-35`) promises the invariant for exactly those writers.
- **Design:** move the three helpers to `test/helpers.js` (`withMetadataFetch`), keep the allow-list in one exported constant, and switch `snapshot`, `compare`, `codecheck`, `security-scan` and every S-15 suite to it. Grow the allow-list with the tables S-3 and S-15 read: `sys_security_acl_role`, `sys_user_role`, `sys_user_role_contains`, `sys_ui_page`, `sys_public`, `sys_ws_definition`, `sys_ws_operation`, `sys_rest_message`, `sys_properties`, `sysevent_email_action`, `sys_choice`, `sc_catalog`, `sc_category`, `sc_cat_item`, `item_option_new`, plus every `table` and `children[].table` of `ARTIFACT_TYPES` (derived at test time, so a new registry type cannot bypass the guard). The self-test that asserts the guard rejects `incident` stays.
- **Acceptance:** a snapshot test that queries `incident` fails with the guard's message; the allow-list test enumerates the registry and passes.
- **Tests:** the helper's own self-test; one negative test per moved suite.

#### ID-28 — No golden exists for any Markdown writer

- **Severity:** medium · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x (before E-7's split) · **→ E-6, S-15 (tests bullet)**
- **Gap:** `test/fixtures/docs/` holds ten `.mmd` diagram goldens and nothing else; snapshot (`tables.md`, `automation.md`, `schema/<table>.md`, `index.md`), compare (`_compare/…`) and code-health (`code-health.md`) are asserted by substring only. The E-7 split (ID-24) and the ID-18 / ID-19 / ID-20 changes all touch these files; without goldens "byte-identical after the refactor" is unverifiable, and the S-14 acceptance ("defaults byte-identical") has no writer coverage.
- **Design:** one golden per writer output on the existing fixtures, frontmatter compared with `sn_generated_at` and `sn_source_hash` masked (the helper `stripVolatile` from the goldens suite); goldens regenerated only through an explicit `UPDATE_GOLDENS=1` run (the `docs-goldens` convention). S-15's goldens (table, app, security, instance README) join the same folder under `docs/writers/`.
- **Acceptance:** the E-7 split lands with zero golden changes; ID-20's path change updates exactly the compare golden.
- **Tests:** `snapshot` ×4 files, `compare` ×1, `codecheck` ×1 (plus `.json` companions compared as parsed objects).

#### ID-29 — Discovery and the instance document should render the registry catalog, not re-list artefact tables

- **Severity:** low · **Status:** VERIFIED · **Effort:** S (inside S-16) · **Breaking:** no · **Target:** 2.x · **→ S-16, S-15**
- **Gap:** the first pass's S-16 (`depth: "overview"|"apps"|"artefacts"`, `artifacts-<scope>.md`) predates the registry. `artifactTypeCatalog()` (`src/api/artifacts.ts:504`) already serves `servicenow://artifact-types` as JSON with group, table, key fields, children, tiers and `verified`; nothing renders it as Markdown, and neither S-15's `document_instance` nor S-16's discovery files say which artefact kinds were **not** collected and why (unverified, unreadable, package off, cap hit).
- **Design:** `document_instance` writes `<profile>/artifact-types.md` from `artifactTypeCatalog()` (one table per group, `verified` column, "collected in this run: yes / no (reason)") and the S-16 `artifacts-<scope>.md` is the per-scope rendering of the same data joined with ID-22's per-type tables; the `servicenow://artifact-types` resource stays JSON (a Markdown twin is not needed once the document exists). The M-4 `servicenow://reference/tools` idea stays as it is; no `reference/artifacts` resource is proposed.
- **Acceptance:** after `document_instance({ depth: "artefacts" })` the artefact-types document lists all 34 types, marks the 25 unverified ones, and the "collected" column matches the `degraded` / `unreadable` arrays of the per-scope documents.
- **Tests:** golden `artifact-types.md` from the registry (registry-driven, so it changes exactly when the registry does).

## 5. Target design refresh (what changes in the first pass's §4)

- **`src/api/document.ts`** keeps `documentTable`, `documentApp`, `documentInstance` and `DOC_KINDS`; each kind now carries `version` (ID-18) and `requires` (packages, ID-25); `documentApp` is built on `listArtifacts` over `ARTIFACT_GROUPS` (ID-22); `documentInstance` is built on the E-7 collectors (ID-24) and writes `artifact-types.md` (ID-29).
- **Store contract:** per-writer `generatorVersion` in `DocMeta` (ID-18); manifest `generated_at` + `runs` with `partial` (ID-19); `.json` companions listed, readable and served as `application/json` (ID-21); compare under `<a>/compare/` (ID-20).
- **Tool surface:** `servicenow_document_table` (72 → 73) first; `servicenow_document_kind` (→ 74) for `security` and later kinds is an owner call (ID-23); `document_app` and `document_instance` (→ 76) follow. M-6's tool-count budget bullet ("stays at 70") is already overtaken by P-5 (72) and must be restated by the owner with the pack ceiling (§7).
- **Diagrams:** unchanged apart from `truncated` on the two remaining builders (ID-26).
- **Tests:** writer goldens (ID-28) and the shared metadata guard (ID-27) land **before** the E-7 split so the split is provably neutral.

## 6. Finding → roadmap item index

| Finding | Item(s)        | Bullet marker                                                      |
| ------- | -------------- | ------------------------------------------------------------------ |
| ID-18   | S-15           | `_(instance-docs pass 2 2026-09-25)_` store bullet                 |
| ID-19   | S-15, S-7      | S-15 `document_instance` bullet; S-7 pass-2 bullet                 |
| ID-20   | S-7            | S-7 pass-2 bullet                                                  |
| ID-21   | M-4, S-15      | M-4 pass-2 bullet; S-15 store bullet                               |
| ID-22   | S-15           | rewritten `document_app` bullet                                    |
| ID-23   | S-15           | rewritten kinds bullet + tool bullet                               |
| ID-24   | E-7, S-7       | E-7 pass-2 bullet (named collectors); S-7 cross-reference          |
| ID-25   | S-15, M-4, M-8 | S-15 prompt bullet; M-4 resources bullet split; M-8 bullet amended |
| ID-26   | S-15           | S-15 diagram bullet                                                |
| ID-27   | E-6, S-15      | E-6 pass-2 bullet; S-15 tests bullet                               |
| ID-28   | E-6, S-15      | E-6 pass-2 bullet; S-15 tests bullet                               |
| ID-29   | S-16, S-15     | S-16 rewritten first bullet                                        |

## 7. Sequencing and effort

1. **Now, on 2.x, no prerequisite:** ID-18, ID-19, ID-21, ID-26, ID-27, ID-28 (six small store / test items, ~2 days together) — they make every later writer cheaper to verify. ID-28 before ID-24.
2. **`document_table` + `security` kind** (ID-08, ID-23, ID-25): unblocked; the practical gate is the **pack ceiling** — 794 KB of 800 KB after batch 6; `src/api/document.ts` plus goldens will not fit. Owner decision: raise the ceiling to 1 MB or trim (`docs/` site assets, manifest fixture) before S-15 starts. Second owner decision: the 73rd / 74th tool (ID-23).
3. **`document_app`** (ID-09, ID-22): unblocked by P-1 / S-4 / P-5; depends only on step 2's module.
4. **E-7 collector split** (ID-24) → **`document_instance`** (ID-10, ID-19, ID-29) → **S-16**. S-7 is no longer a prerequisite for anything in S-15 except the `choices` kind and the richer schema columns.
5. **ID-20** rides with S-7.

Net effect on the first pass's sequencing row 53: "after S-4 and S-7" becomes "after S-14; `document_instance` after the E-7 collector split; S-7 only for `choices`". Effort for S-15 stays L; E-7 grows by the named-collectors bullet (M → M, the split was already in it).

## 8. Explicitly not proposed

- A `servicenow_security_scan` tool of its own — the `security` document kind and `code_health` cover both audiences; a third rendering of the same scan adds a tool for no new data.
- A `servicenow://reference/artifacts` Markdown resource — `servicenow://artifact-types` (JSON) plus the ID-29 document suffice.
- Bumping the manifest `schema_version` — both ID-19 and ID-21 are additive.
- Merging `snapshot_instance` into `document_instance`, a docs site, full-text search — unchanged from the first pass's §7.
- Re-opening any closed first-pass finding.

## 9. Deltas applied to ROADMAP-V3 and the mirrors (2026-09-25)

- **Status line:** "Fourth pass 2026-09-25 … reassessed ID-01…ID-17 (7 closed, 3 partial, 7 open — 2 unblocked) and added ID-18…ID-29, refining S-15, S-16, M-4, M-8, S-7, E-6, E-7."
- **Intro pointer:** both analysis files and both bullet markers.
- **S-15:** store bullet gains per-writer `generatorVersion`, manifest `runs` / `partial` / `generated_at`, `.json` companions (ID-18, ID-19, ID-21); `document_app` bullet rewritten over `listArtifacts` + `ARTIFACT_GROUPS` (ID-22); kinds bullet: `security` from `securityScan()` now, optional `servicenow_document_kind` (ID-23); `document_instance` bullet names the E-7 collectors (ID-24) and `artifact-types.md` (ID-29); prompt bullet absorbs gating + legacy path + reference resource (ID-25); diagram bullet absorbs ID-26; tests bullet absorbs ID-27 / ID-28; prerequisites sentence rewritten; tool-count note updated (72 today).
- **S-16:** first bullet rewritten to render the registry catalog (ID-29).
- **M-4:** the "new resources" bullet split — encoded-query ticked (S-8), `reference/tools` open; new pass-2 bullet for `application/json` companions and the profile-aware docs resource (ID-21); acceptance sentence about the prompt moved to S-15 (ID-25).
- **M-8:** the ticked ID-16 bullet amended: annotation half done, prompt-gating half → ID-25 / S-15.
- **S-7:** pass-2 bullet for the compare path (ID-20) and the manifest `runs` field (ID-19); the collector sentence now points at E-7's named collectors (ID-24).
- **E-6:** pass-2 bullet for the shared metadata guard and the writer goldens (ID-27, ID-28).
- **E-7:** pass-2 bullet naming the five collectors and their contract (ID-24), sequenced before `document_instance`.
- **Sequencing rows 53–54** reworded per §7; no new rows.
- **Mirrors:** `project/ROADMAP.md` (status line, callout), `project/PRODUCT-STATE.md` (note, 3.0 row, docs table), `project/TODO.md` (done bullet + the two owner decisions), `project/ARCHITECTURE.md` §11, `README.md` docs table, `.github/copilot-instructions.md`, `project/SDK-PARITY.md` (P-21 depends line, §7 S-15 row: P-5 collector). Docs only — no code, no tests, gate unchanged.
