# Role review — Senior Developer-Experience engineer & Technical Writer (2026-10-29)

Reviewer role: I review the product from the side of a ServiceNow developer or admin who knows the
platform well but is new to MCP. I follow the journey from discovery to install (npm/npx, VS Code
extension, `.mcpb`, Docker, Claude Code plugin), then credentials, the first call, the first
useful result, the first safe write and troubleshooting. I judge the docs against Diátaxis
(tutorial / how-to / reference / explanation). I also check their information architecture,
whether internal roadmap ids leak into user docs, whether the docs are accurate against the code,
and how long it takes to get first value.

Baseline: main @ dc29e9c · servicenow-mcp-ai 3.0.0 · scope: `README.md`, `docs/index.html` /
`docs/index.md` (site), `docs/llms.txt`, `docs/tools/*.md`, `extension/README.md` +
`extension/media/walkthrough/*`, `skills/*/SKILL.md`, `SUPPORT.md`, `CONTRIBUTING.md`,
`AGENTS.md`, `src/cli.ts`, `src/api/doctor.ts`, `src/core/{errors,host,http-error-body,http-util,
settings-model}.ts`, `src/mcp/package-policy.ts`; cross-checked against `project/roadmap.yaml`,
`project/TODO.md`, `project/V3.5-ANALYSIS-2026-10.md` (F5-45…F5-54, N-92…N-94).

## 1. Verdict

**Score: 6 / 10.** The runtime side is better than most MCP servers I have seen:

- `doctor` tells the user what to do next for each auth method.
- The 401 and 403 hints name the actual roles.
- Hibernating PDIs are detected.
- The skills and the extension walkthrough are short and clear.

The written side is the weak point. Most of it is reference, and parts of it are stale or wrong:

- The 1,958-line README carries 118 internal roadmap ids.
- The public docs site documents only 18 of the 28 packages and never mentions `init`.
- There is no tutorial that takes a person from install to a first safe write.
- The documented first-run path puts the instance password into the chat transcript.

**Top risks:**

1. The site and the README disagree with the code on facts a new user acts on: upsert arguments,
   whether table policy covers plugin APIs, and how many packages exist.
2. The password-in-chat first run contradicts the product's own promise that secrets are never
   tool arguments.
3. Roadmap-id jargon ("since H-4", "(3.0, B6)", "DF-3") makes the product read as an internal
   project.

**Top strengths:**

1. Actionable error hints (`doctor`, `http-error-body`, `host.ts`, published error codes).
2. Well-scoped skills and an up-to-date VS Code walkthrough.
3. Generated reference parts (`docs:env`, `docs:readme`, `docs/tools/*.md`, `llms.txt`) that
   could anchor a reliable docs set.

## 2. What I examined

- **README.md** (1,958 lines): every section, read in order as a new user would. I counted
  internal-id occurrences with a regex for `\b(H|M|S|D|E|P|N|DF|B|O|F5)-?\d+\b` plus "Phase N"
  (118 hits).
- **Docs site** `docs/index.html` and the rendered `docs/index.md`: quickstart, CLI section, tools
  reference (package sections counted, unique tool names counted), FAQ and Troubleshooting.
- **`docs/llms.txt`** and **`docs/tools/*.md`** (generated per-package reference).
- **VS Code extension**: `extension/README.md`, the four walkthrough steps, and the settings in
  `extension/package.json`.
- **All 8 skills** under `skills/`, plus `SUPPORT.md`, `CONTRIBUTING.md`, `AGENTS.md`/`GEMINI.md`.
- **CLI:**
  - Read `src/cli.ts` USAGE and the subcommand parsers.
  - Ran `node build/index.js --version` (prints `3.0.0`) and `--help`.
  - Did not run any command that writes files.
- **Error and hint paths:** `src/api/doctor.ts` (`configureHint`, `connectionHint`),
  `src/core/http-error-body.ts:27,31`, `src/core/http-util.ts:162,168`, `src/core/host.ts:288`,
  `src/core/errors.ts`.
- **Accuracy spot-check:** 14 claims in the README and the site, checked against the code (see
  RR-DX-03 and RR-DX-01). 4 were accurate and 10 were wrong or stale.
- **Planned work:** I grepped `project/roadmap.yaml`, `project/TODO.md` and
  `project/V3.5-ANALYSIS-2026-10.md` for README, site, CLI help, onboarding, troubleshooting and
  "Since", and mapped each finding to existing items.

## 3. Strengths (keep doing)

- **`doctor` hints are task-oriented** (verified, `src/api/doctor.ts`):
  - `configureHint` differs per auth method.
  - A 401 on basic auth returns `BASIC_AUTH_401_HINT`.
  - A 403 names `itil` / `snc_platform_rest_api_access`.
  - A network failure names `SN_INSTANCE`, DNS and `HTTPS_PROXY`.

  This is what a ServiceNow admin needs to hear.

- **Hibernating-PDI detection** (verified, `src/core/http-error-body.ts:27,31`,
  `src/core/http-util.ts:162,168`): the HTML sign-in page is recognised, and the user is told to
  wake the instance at developer.servicenow.com. This is the most common first-day failure on a
  PDI.
- **Host guard message** (verified, `src/core/host.ts:288`): "Host … is not a \*.service-now.com
  instance. Set SN_ALLOWED_HOSTS…". It states the cause and the fix in one line.
- **Published error codes with hints** (verified, `src/core/errors.ts`): `NOT_CONFIGURED`,
  `POLICY_DENIED`, `PACKAGE_DENIED`, `INSTANCE_HTTP_<status>`. This is a ready-made spine for a
  troubleshooting page.
- **Skills are well written** (verified, `skills/*/SKILL.md`): 51–85 lines each, no internal ids.
  `sn-safe-write` is a clear plan → apply → verify → revert procedure.
- **The extension walkthrough is current** (verified, `extension/media/walkthrough/*.md`): Sign In
  through SecretStorage, the `discovery` default, Run Doctor, and a first prompt that explains plan
  mode.
- **The CLI refuses unknown options with a clear message** (verified, `src/cli.ts` parsers).
  `--version` works.
- **Generated reference**: `docs:env`, `docs:readme`, `docs/tools/*.md` and `llms.txt` (the latter
  names `init` and `doctor`) are produced from code and stay in sync. Extending this approach is
  the main recommendation below.

## 4. Findings

### RR-DX-01 — The public docs site is stale and covers 18 of 28 packages (severity: high · verified)

- **Evidence:** in `docs/index.html` and its rendered `docs/index.md`:
  - The tools reference header says "100 tools across 28 packages" but has only 18 package
    sections. There are none for `access`, `artifacts`, `cicd`, `directory`, `history`, `ops`,
    `properties`, `revert`, `ui` or `updatesets`. Only 76 unique tool names appear.
  - The CLI section says the binary "has three invocations"; `src/cli.ts` USAGE lists 8 commands
    (`init`, `doctor`, `login`, `drift`, `support-bundle`, `migrate`, `skills install`, serve).
  - The FAQ says "~200 tests"; the suite has ~2,768.
  - The FAQ says "Any MCP client over stdio", although Streamable HTTP ships.
  - `servicenow-mcp-ai init` occurs 0 times in `index.html`, and `doctor` only once (in
    Troubleshooting).
  - `docs:sync` (`scripts/docs-sync.mjs`) checks only counts, so a page that says "100 tools"
    passes while listing 76 of them.
- **Why it matters:** the site is the first thing a non-expert reads (it is the npm `homepage` and
  the GitHub About link). It undersells the product by a quarter and teaches an outdated setup.
- **Recommendation:**
  - Generate the site's tools section from the same source as `docs/tools/*.md`. Either render it
    or link one page per package.
  - Add a `docs:site --check` gate that fails if any registered tool or CLI command is missing from
    the site.
  - Replace the hand-written counts with generated ones.
- **Existing roadmap link:** N-92 moves the tools reference to the site but does not say it must
  be generated or gated. F5-46 lists stale strings but notes that "`docs-sync.mjs` covers tool
  counts only" without proposing a coverage check. This finding is the coverage gate, which is
  missing from both.

### RR-DX-02 — The documented first run puts the instance password into the chat (severity: high · verified)

- **Evidence:**
  - README "First run: the model configures itself" (~line 582) shows the user typing the password
    into chat and the model passing it to `servicenow_set_credentials`.
  - README Examples (~1724) repeat a `set_credentials` call with `password`.
  - `docs/tools/admin.md:23` describes the tool as "Secrets are never arguments", yet line 33 lists
    a `password` argument.
  - `request_secrets` (`docs/tools/admin.md:37`) elicits only `api_key` and `oauth_client_secret`.
  - `project/TODO.md:460` (D-2) records "`password` argument kept (move to elicitation = O-4
    candidate)".
- **Why it matters:**
  - A ServiceNow admin following the first-run story leaves an admin password in the transcript,
    in client logs, and in any provider-side retention.
  - The docs contradict themselves on the exact point a security reviewer will check first.
  - Safer paths exist (`init`, `login`, extension Sign In), but the README presents the chat path
    as the headline experience.
- **Recommendation:**
  - Now (non-breaking): rewrite the first-run story around `npx servicenow-mcp-ai init` / `login` /
    extension Sign In. Mark the chat path "not recommended: the password enters the transcript".
    Fix the `set_credentials` description so it says which secrets are never arguments.
  - Later (BREAKING, O-4): elicit `password` in `request_secrets` and deprecate the argument.
- **Existing roadmap link:** D-2 / `TODO.md:460` has the code change as an O-4 candidate. Nothing
  covers the documentation, which can be fixed today without a breaking change.

### RR-DX-03 — README accuracy: 7 claims contradict the code (severity: high · verified)

- **Evidence (spot-check):**
  1. README ~1300 shows `servicenow_upsert_record({table, key, fields})`. The parameter is
     `values` (`docs/tools/table.md`), and the README elsewhere defines `fields` as "columns to
     return". A user copying the example sends the wrong argument.
  2. Security notes (~1891) say "Table policy does not cover plugin APIs. `SN_TABLES_DENY=
change_request` … Change Management API can still read/write". The two-axis section (~913,
     ~916) says "since H-4 … the Change tools check their backing table". These contradict each
     other, and the newer behaviour is the second one.
  3. The tool packages list (~1250) omits `cicd` and `access`.
  4. Project structure (~1860) says "test/ … (406 tests)"; the real count is ~2,768.
  5. Project structure gives `.env` as the credentials location; a project-root `.env` is
     deprecated (B5) in favour of `~/.config/servicenow-mcp-ai/.env`.
  6. Project structure says `bin/` holds "incl. the doctor command". `bin/` has only
     `servicenow-mcp-ai.cjs`, and `doctor` is a subcommand in `src/cli.ts`.
  7. Security notes say "The server uses the stdio transport"; HTTP transport ships.

  Accurate claims: the `SN_ALLOWED_HOSTS` message, the doctor hints, "unknown package names are
  ignored" (`package-policy.ts` logs a warning), and `--version` = 3.0.0.

- **Why it matters:**
  - Item 2 is a security statement. One version tells an admin that the deny list does not protect
    change requests, which is false and may lead to a needless extra control. Read the other way,
    the contradiction undermines trust in both statements.
  - Item 1 breaks the first upsert.
- **Recommendation:** fix all 7 in one docs commit. Add a test that runs every
  `servicenow_*({...})` example in the README through the tool's input schema (the shape check
  only, with no call).
- **Existing roadmap link:** F5-46 lists different stale strings (extension `@2.x`, SDK badge,
  B-register). N-92 restructures the README but does not mention correcting content. None of these
  7 claims is tracked.

### RR-DX-04 — Internal roadmap ids leak into user-facing docs (severity: high · verified)

- **Evidence:**
  - The README has 118 occurrences of internal ids: "(3.0, B6)" in the Docker section, "OAuth
    instead of a shared token (N-17)", "Container secrets (D-5)", "### CI drift gate (DF-3)", "Flow
    tracing & code checking (Phase 8)", and "since H-4" twice in the policy section.
  - The env table and the upgrade notes reference B5, B12, B13 and B20 without explaining them.
  - By contrast, the skills and the extension walkthrough have none.
- **Why it matters:**
  - A ServiceNow admin cannot resolve "H-4" or "B6". The ids read as noise, or worse, as a hint
    that the feature is still a plan.
  - Section headings with ids ("CI drift gate (DF-3)") show up in search results and anchors.
  - It is the clearest sign that the README was written for the maintainer.
- **Recommendation:**
  - Remove roadmap ids from `README.md`, `docs/index.html`, `extension/README.md`, `SUPPORT.md` and
    `skills/`. Breaking-change references become "changed in 3.0 (see CHANGELOG)".
  - Add a lint test (`test/user-docs-jargon.test.js`) that fails on the id regex in those files,
    with an allow-list for `CHANGELOG.md`, `CONTRIBUTING.md`, `AGENTS.md` and `project/`.
- **Existing roadmap link:** N-92 does not mention jargon. Not tracked.

### RR-DX-05 — The env reference shows "Since: next" on 87 rows of a GA release (severity: medium · verified)

- **Evidence:** `src/core/settings-model.ts:243` `export const NEXT = UNRELEASED;`. The generator
  behind `npm run docs:env` renders this as "next". 87 rows of the README env table read
  "Since: next" although 3.0.0 is on npm `latest`.
- **Why it matters:**
  - A user reading "next" assumes the variable is not in the version they installed and either
    skips it or pins a pre-release.
  - It also hides which settings are new in 3.0, which is the question an upgrading admin has.
- **Recommendation:**
  - At release, stamp `UNRELEASED` with the release version. A `release:stamp` step, or a check in
    `docs:env --check` that fails when `package.json` is not a pre-release and any row is still
    "next".
  - Render "3.0.0" for those 87 rows now.
- **Existing roadmap link:** none.

### RR-DX-06 — No troubleshooting in README or SUPPORT; the site's table is wrong about policy errors (severity: medium · verified)

- **Evidence:**
  - README has no Troubleshooting section, and neither does `SUPPORT.md` (59 lines; it covers bug
    reports only).
  - The only troubleshooting table is on the site (`docs/index.html` ~1096). It maps "403" to
    `SN_TABLES_DENY`. A policy refusal is not an HTTP 403: it returns `POLICY_DENIED` /
    `PACKAGE_DENIED` from `src/core/errors.ts`, and a real 403 means missing instance roles
    (`doctor.ts` `connectionHint`).
  - The hibernating-PDI detection (RR-DX strength) is not documented anywhere (grep over README and
    SUPPORT: no hits).
- **Why it matters:**
  - Troubleshooting is the Diátaxis how-to a first-day user needs most.
  - The one existing table sends a user with a role problem to edit the deny list, which is the
    wrong fix.
- **Recommendation:** generate `docs/troubleshooting.md` from `src/core/errors.ts` (code → cause →
  fix) plus the doctor hints and the hibernation case. Link it from the README, SUPPORT, the site
  and the error hint text.
- **Existing roadmap link:** N-92 adds a "Getting help" paragraph linking SUPPORT. That does not
  add troubleshooting content or fix the wrong 403 mapping.

### RR-DX-07 — No tutorial from install to first safe write; the Examples skip plan/apply (severity: medium · judgement)

- **Evidence:**
  - Diátaxis audit of the README: about 85% reference (env table, tool list, client matrix), about
    10% explanation (policy, safety), and no tutorial.
  - The Quickstart (~498) and Verify (~517) stop at `test_connection`.
  - "Create an incident" in Examples (~1724) does not say the first call returns a preview and
    needs `apply:true`, or that destructive applies need `plan_token`.
  - The extension README's "plan-and-apply" text does not mention `plan_token` either.
  - The `sn-safe-write` skill is a good procedure, but it is written for the model, not the human.
- **Why it matters:**
  - The first write is the moment of truth for an admin. With no tutorial, the preview looks like a
    failure ("it didn't create anything").
  - The plan, apply and revert flow is the strongest safety story the product has, but it is only
    told as reference.
- **Recommendation:** write a ~1-page tutorial, "Your first safe write". It should cover:
  - a PDI
  - `discovery` default
  - `enable_package` for one package
  - an update to a test incident
  - reading the preview
  - `apply:true`
  - verifying the change
  - `revert`

  Link it as step 2 after Quickstart and from the extension walkthrough. Fix the Examples text.

- **Existing roadmap link:** N-94 plans `docs/first-10-minutes.md` (also reused as an `sn-start`
  skill and walkthrough). Its scope (V3.5:560–566) reaches the first successful call and does not
  include a write, the preview, `plan_token` or revert. This item extends N-94.

### RR-DX-08 — The `admin` preset means "all packages" and collides with the `admin` package (severity: medium · verified)

- **Evidence:**
  - `src/mcp/package-policy.ts` PROFILES: `admin: ALL_PACKAGES`, `reader: ["table","schema",
"aggregate"]`.
  - The always-on package is also named `admin`.
  - `DISCOVERY_PROFILE` is the same set as `reader`.
- **Why it matters:**
  - `SN_TOOL_PACKAGES=admin` reads as "just the admin tools" but turns on everything, including
    `atf`, `email` and `access` (role grants).
  - Two names for one set (`reader` / `discovery`) make the docs harder to write and the presets
    harder to learn.
- **Recommendation:**
  - Document the trap prominently now.
  - Then add `all` as the canonical preset and make `admin` (as a preset) a deprecated alias that
    logs a warning. Removing it is BREAKING (O-4).
  - Document `reader` as an alias of `discovery`, or deprecate it.
- **Existing roadmap link:** none in roadmap.yaml / TODO.md. N-93 adds `profiles list`, which would
  show the set but not prevent the mistake.

### RR-DX-09 — Extension README tells Sign-In users to set `SN_READONLY` in an env file they do not have (severity: medium · verified)

- **Evidence:**
  - `extension/README.md`: "Start read-only… set `SN_READONLY=true` in your env file."
  - The extension flow is Sign In through SecretStorage, which creates no env file.
  - `extension/package.json` contributes only the `envFile`, `packages` and `transport` settings.
    There is no read-only setting.
- **Why it matters:** the extension is the lowest-friction install (506 installs per F5-52), and
  its users are the least likely to create a dotfile by hand. The advice to start read-only is
  good, but those users cannot follow it.
- **Recommendation:**
  - Add a `servicenowMcp.readOnly` boolean setting, passed as `SN_READONLY` to the spawned server.
  - Offer "Start read-only?" in the Sign In step.
  - Update the README line.
- **Existing roadmap link:** none.

### RR-DX-10 — The README "Project documentation" table links a local-only file and exposes the planning corpus (severity: medium · verified)

- **Evidence:**
  - README ~1923 links `WORKLOG.md`, which is excluded via `.git/info/exclude` and enforced by
    `test/harness-files.test.js`. It is a 404 on GitHub and absent from the npm tarball.
  - The same table links archive analyses (ID-18…, S-15…) and roadmap trackers.
- **Why it matters:**
  - Broken links in the first file a user opens erode trust.
  - The planning corpus is contributor material; in the README it adds noise and more jargon.
- **Recommendation:**
  - Remove the WORKLOG link.
  - Move the project-documentation table to `CONTRIBUTING.md`.
  - Extend `test/file-link.test.js` (or a sibling) to fail on README links to paths that
    `git ls-files` does not list.
- **Existing roadmap link:** none (F5-46 covered a different stale `ROADMAP.md` link).

### RR-DX-11 — The site quickstart relies on shell `export`, which GUI clients do not inherit (severity: medium · judgement)

- **Evidence:**
  - `docs/index.html` quickstart: `npm install -g servicenow-mcp-ai`, then `export SN_INSTANCE=…
SN_USER=… SN_PASSWORD=…`.
  - Step 3 is "servicenow_test_connection", which is a tool, but it is shown among the shell steps.
  - The README's recommended path is `init` writing `~/.config/servicenow-mcp-ai/.env`, and the
    site never mentions it.
- **Why it matters:**
  - Claude Desktop and VS Code launched from the Dock on macOS do not see shell exports. The user
    follows the site exactly and gets `NOT_CONFIGURED`.
  - The export also leaves the password in shell history.
- **Recommendation:** replace the site quickstart with the same three steps as the README:
  1. `npx servicenow-mcp-ai init`
  2. add the client config snippet
  3. ask the client "test the ServiceNow connection"

  Ideally render both from a single source.

- **Existing roadmap link:** N-92/N-94 do not mention the site quickstart.

### RR-DX-12 — The README opens with upgrade banners, and the Setup section is 370 lines before Quickstart (severity: low · verified)

- **Evidence:**
  - Two "Upgrading from 2.x / 1.x" banners come before any sentence saying what the product does.
  - Setup runs ~162–535 with an 11-client matrix, and Quickstart starts at ~498.
  - A Contents line exists (~29), so F5-47's "no TOC" is no longer accurate.
- **Why it matters:** time-to-first-value. A new user has to scroll past migration notes and ten
  clients they do not use before they reach the one command that matters.
- **Recommendation:**
  - Use the order "what it is (3 lines) → Quickstart → choose your client (collapsed `<details>`
    per client) → first safe write".
  - Move the upgrade banners under a "Upgrading" heading that links CHANGELOG / MIGRATION.
- **Existing roadmap link:** N-92 covers the restructure and the ≤500-line goal. The addition here
  is an ordering rule (Quickstart within the first screen) and noting that the TOC part of F5-47
  is done.

### RR-DX-13 — CLI help is one global block; the skill text is slightly stale (severity: low · verified)

- **Evidence:**
  - `src/cli.ts:40–87`: USAGE is one block, so `init --help` prints the same text as `--help`.
  - `skills/sn-safe-write/SKILL.md` says "The record tools are in `table` (part of `core`)". The
    default profile is now `discovery`.
- **Why it matters:** this is minor friction. Per-command help is the usual expectation.
- **Recommendation:**
  - Per-command help is already N-93.
  - Fix the one skill line in the next docs commit.
- **Existing roadmap link:** N-93 (per-command usage) covers the CLI part. The skill line is not
  tracked.

## 5. Proposed roadmap items

| Temp id | Title                                                               | Findings   | Priority | Effort | tools/list                     | Breaking                              | Owner decision |
| ------- | ------------------------------------------------------------------- | ---------- | -------- | ------ | ------------------------------ | ------------------------------------- | -------------- |
| DX-I1   | Docs-site coverage gate and generated tools/CLI sections            | 01, 11     | P1       | M      | 0                              | no                                    | no             |
| DX-I2   | README accuracy fixes + schema-checked examples                     | 03, 10, 13 | P1       | S      | 0                              | no                                    | no             |
| DX-I3   | Safe first-run docs now; `password` via elicitation later           | 02         | P1       | S + M  | ≈ +0 / small description delta | yes (2nd part, O-4)                   | yes (O-4)      |
| DX-I4   | User-docs jargon lint (no roadmap ids)                              | 04         | P1       | S      | 0                              | no                                    | no             |
| DX-I5   | Stamp "Since" with the release version                              | 05         | P2       | S      | 0                              | no                                    | no             |
| DX-I6   | Generated troubleshooting page from error codes                     | 06         | P2       | S–M    | 0                              | no                                    | no             |
| DX-I7   | "Your first safe write" tutorial (extends N-94)                     | 07, 12     | P2       | M      | 0                              | no                                    | no             |
| DX-I8   | `all` preset; deprecate `admin` preset alias and `reader` duplicate | 08         | P2       | S      | 0                              | deprecation only; removal is BREAKING | yes (naming)   |
| DX-I9   | Extension `readOnly` setting                                        | 09         | P2       | S      | 0                              | no                                    | no             |

### DX-I1 — Docs-site coverage gate and generated tools/CLI sections

- **Scope:**
  - Generate the site's tools reference from the registered tools: either one section per package,
    or links to `docs/tools/<pkg>.md`.
  - Generate the CLI command list from `src/cli.ts`.
  - Replace the quickstart with the `init` path.
  - Remove the hand-written counts ("three invocations", "~200 tests", "over stdio").
  - Add `npm run docs:site -- --check` to `npm run check`.
- **Acceptance criteria:**
  - Every registered tool name and every CLI command appears on the site.
  - The check fails when one is removed.
  - `init` and `doctor` appear in the quickstart.
  - There are no hard-coded counts left.
- **Dependencies / gates:** coordinate with N-92 (tools reference moves to the site). No
  `tools/list` change.

### DX-I2 — README accuracy fixes + schema-checked examples

- **Scope:**
  - Fix the 7 claims in RR-DX-03, the WORKLOG link and the planning table (RR-DX-10), and the
    `sn-safe-write` "part of core" line.
  - Add a test that parses each `servicenow_*({...})` example in `README.md` and `docs/` and
    validates its keys against the tool's zod input schema.
  - Add a test that every relative README link is a tracked file.
- **Acceptance criteria:**
  - The 7 claims match the code.
  - The upsert example uses `values`.
  - Security notes and the two-axis section agree.
  - Both new tests run in `npm run check`.
- **Dependencies / gates:** none. It can land before N-92 and reduces what N-92 has to rewrite.

### DX-I3 — Safe first-run docs now; `password` via elicitation later

- **Scope:**
  - **Part A (docs, now):**
    - Rewrite "First run" around `init` / `login` / extension Sign In.
    - Label the chat path as putting the password into the transcript.
    - Correct the `set_credentials` description to "API keys and OAuth secrets are never
      arguments", or similar.
    - Remove the password from the Examples.
  - **Part B (code, O-4):**
    - `request_secrets` elicits `password`.
    - The `password` argument is deprecated with a warning, then removed in the next major.
- **Acceptance criteria:**
  - No user doc shows a password passed as a tool argument.
  - The tool description no longer contradicts its schema.
  - Part B: elicitation works in a client that supports it, and there is a clear fallback message
    when the client does not support elicitation.
- **Dependencies / gates:**
  - Part B is BREAKING and needs O-4 (already the D-2 candidate in `TODO.md:460`).
  - The description change has a small `tools/list` byte delta that must be stated against the
    O-10 budget.

### DX-I4 — User-docs jargon lint

- **Scope:**
  - Remove roadmap ids from `README.md`, `docs/index.html`, `extension/README.md`,
    `extension/media/**`, `SUPPORT.md`, `skills/**` and the tool descriptions.
  - Add `test/user-docs-jargon.test.js` with the id regex and an allow-list for CHANGELOG,
    CONTRIBUTING, AGENTS and `project/`.
- **Acceptance criteria:**
  - 0 matches in the user-doc set (today: 118 in the README).
  - The test is part of `npm run check`.
- **Dependencies / gates:** best done together with N-92 so the rewrite does not happen twice.

### DX-I5 — Stamp "Since" with the release version

- **Scope:**
  - At release, replace `UNRELEASED` in `settings-model.ts` with the version.
  - `docs:env --check` fails when `package.json` is a non-pre-release version and any row still
    renders "next".
  - Backfill the 87 rows to 3.0.0.
- **Acceptance criteria:** the README env table has no "next" rows on a GA version, and the check
  enforces it.
- **Dependencies / gates:** fits into the release checklist (DevOps-owned).

### DX-I6 — Generated troubleshooting page

- **Scope:** add `docs/troubleshooting.md`, generated from `src/core/errors.ts` codes and their
  hints. It covers:
  - the doctor hints (401 basic, 403 roles, DNS / proxy)
  - hibernating PDIs
  - `SN_ALLOWED_HOSTS`
  - `POLICY_DENIED` vs a real 403

  Link it from the README, SUPPORT, the site and the extension.

- **Acceptance criteria:**
  - Every published error code has a row.
  - The site's 403 → `SN_TABLES_DENY` mapping is corrected.
  - A test fails if a new code has no row.
- **Dependencies / gates:** none.

### DX-I7 — "Your first safe write" tutorial

- **Scope:**
  - Extend the N-94 `first-10-minutes` doc, or add a sibling page, with the steps: enable one
    package, update a test incident, read the preview, `apply:true`, verify, `revert`. Explain
    `plan_token` for destructive applies.
  - Fix the README "Create an incident" example.
  - Mention `plan_token` in the extension README.
- **Acceptance criteria:**
  - A new user on a PDI completes the steps without other docs.
  - The tutorial is linked from Quickstart and from the walkthrough's last step.
- **Dependencies / gates:** N-94 (shared page and `sn-start` skill). Needs a PDI to verify (O-5).

### DX-I8 — `all` preset; deprecate the `admin` preset alias and the `reader` duplicate

- **Scope:**
  - Add `all` to PROFILES.
  - `SN_TOOL_PACKAGES=admin` keeps working but logs "the `admin` preset enables all packages; use
    `all`".
  - Document `reader` as an alias of `discovery`.
- **Acceptance criteria:**
  - Docs and `profiles list` (N-93) show `all`.
  - The warning appears once at startup.
- **Dependencies / gates:**
  - The owner chooses the naming.
  - Removing the alias later is BREAKING (O-4).

### DX-I9 — Extension `readOnly` setting

- **Scope:**
  - Add a `servicenowMcp.readOnly` boolean (default false, or true if the owner prefers) that sets
    `SN_READONLY` on the spawned server.
  - Add a prompt in the Sign In step.
  - Fix the README line.
- **Acceptance criteria:** toggling the setting restarts the server in read-only mode, and
  `get_status` reports it.
- **Dependencies / gates:** the owner decides whether the default changes.

## 6. Owner decisions needed

1. **O-4 / D-2:** move `password` to elicitation and deprecate the argument (DX-I3 part B). Until
   then, should the README stop presenting the chat path at all, or keep it with a warning?
2. **Preset naming (DX-I8):** should `all` be canonical, how long does the deprecated `admin`
   preset alias live, and should `reader` stay?
3. **Extension default (DX-I9):** should a new Sign In default to read-only?
4. **Where the canonical docs live:** pick either the site (N-92) or the README as the single
   source for the quickstart, the install matrix and the tool reference, so that DX-I1 and N-92
   generate one from the other and do not hand-maintain both.
5. **Jargon policy (DX-I4):** confirm that roadmap ids are banned from user docs and allowed in
   CHANGELOG / CONTRIBUTING / AGENTS / `project/`.

## 7. Metrics this role would track

| KPI                                                                      | Today (dc29e9c)                            | Target                |
| ------------------------------------------------------------------------ | ------------------------------------------ | --------------------- |
| Time from install to first successful `test_connection` (fresh PDI user) | not measured; ≥ 3 docs to read (judgement) | ≤ 5 min, 1 page       |
| Internal roadmap ids in user-facing docs                                 | 118 in README                              | 0 (lint-enforced)     |
| Site tool coverage (tools named on site / registered)                    | 76 / 100 · 18 / 28 packages                | 100 % (gate-enforced) |
| Stale or wrong claims per 14-claim spot-check                            | 10                                         | ≤ 1                   |
| README length                                                            | 1,958 lines                                | ≤ 500 (N-92)          |
| `doctor` first-run pass rate (support bundles / issues)                  | not collected                              | tracked per release   |
