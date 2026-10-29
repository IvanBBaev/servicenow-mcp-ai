# Role review — Senior Product Owner / Go-to-market lead for developer tools (2026-10-29)

Reviewer role: a product owner who has shipped and grown open-source developer tools and AI-agent
integrations, from first commit to a community with paying sponsors. This persona cares about one
thing: does the right user get value fast, and do we _know_ that they do. "Good" means a value
proposition a ServiceNow developer gets in 10 seconds, a short path from `npx` to first value, a
feedback loop that tells the maintainer what to build next, and a roadmap that spends a solo
maintainer's scarce hours on what moves adoption, not on what is technically interesting.

Baseline: main @ dc29e9c · servicenow-mcp-ai 3.0.0 (npm `latest`, Marketplace 3.0.0) · scope:
positioning, personas, adoption funnel, distribution, roadmap investment mix, sustainability,
competitive landscape. No code review, no instance access.

## 1. Verdict

The engineering is far ahead of the product. 3.0 is a deep, safe, well-tested tool with real moats:
plan → token → apply, a journal with revert, where-used and trace-on-save, dev↔prod drift, and it
works on a free PDI. The market barely knows it exists, and the project has no way to learn from
the few people who do. In 10 days since GA: 1,104 npm downloads a month, 10 stars, 553 Marketplace
installs, **zero issues ever opened by a human**, 0 sponsors. The nearest OSS competitor has 8.6×
the downloads and 26× the stars. Meanwhile the roadmap holds 178 items. About 10 % of them are
about distribution or adoption, and none are about validating demand.

**Score: 5/10.** It is a 9/10 product sold as a 2/10 one, and the roadmap keeps investing in the 9.

- **Top risks:** (1) no feedback loop of any kind, so the roadmap is driven by analyses, not by
  users; (2) the value proposition is spread over five different sentences, two of them stale;
  (3) the project competes on tool count, a race it has already lost.
- **Top strengths:** (1) differentiators that are durable and that the official console and the
  OSS field do not have; (2) every major client and channel is covered (npm, MCP Registry,
  Marketplace, plugin, `.mcpb`, skills); (3) a written marketing diagnosis already exists, and it
  is honest about the flat 3.0 launch.

## 2. What I examined

- `README.md` (1,958 lines; hero lines 9–13, Quick demo 39–82, Features 83+, Support 1926+),
  `docs/index.md` / `docs/index.html` (hero, stat strip, FAQ), `extension/README.md`,
  `package.json` (description, keywords, licence), `server.json`, `CHANGELOG.md` (`[Unreleased]`).
- `project/COMPETITIVE-ANALYSIS.md` (dated 2026-06-19), `project/V3.5-ANALYSIS-2026-10.md`
  (§2.2, §2.5, §4 N-77/N-92/N-94, §5–§7), `project/archive/BUSINESS-REVIEW-2026-07.md` (§3, §4,
  §8.5), `project/TODO.md` (OD-11…OD-16, O-3), `project/roadmap.yaml` (178 rows, pillar and title
  per row), `npm run -s roadmap:status`.
- `WORKLOG.md` (2026-10-23 and 2026-10-24 entries, KPI mentions);
  `~/.claude/skills/launch-marketing/references/projects/servicenow-mcp-ai-2026-10.md` (relaunch
  plan, KPI targets).
- Commands, all run today:
  - `curl api.npmjs.org/downloads/point/last-month/servicenow-mcp-ai`: 1,104; last week 273.
  - The same for competitors: `nowaikit` 9,508, `snow-flow` 3,095, `servicenow-mcp-server` 347,
    `servicenow-mcp` 101.
  - `gh repo view`: 10★, 3 forks, 1 issue, About text "67 tools", Discussions disabled.
  - `gh issue list --state all`: only #24, opened by `app/github-actions`.
  - `gh api …/traffic/views`: 185 views / 115 uniques in 14 days.
  - `gh api …/traffic/popular/referrers`: linkedin.com 31 plus the LinkedIn Android app 13, reddit
    6, MCP Registry 4, Google 1, the docs site 1.
  - `gh api graphql` sponsors: `totalCount: 0`.
  - The Marketplace gallery API: 553 installs, rating 4.45.
  - `npm view … dist-tags`: `latest` 3.0.0, `next` 3.0.0-beta.2.
  - `git log v3.0.0..HEAD`: 27 commits.
- Web, read today:
  - [aartiq/servicenow-mcp (NowAIKit)](https://github.com/aartiq/servicenow-mcp)
  - [Redpanda managed ServiceNow MCP](https://docs.redpanda.com/agentic-data-plane/connect/managed/servicenow.md)
  - [MCP Server Console release notes](https://www.servicenow.com/docs/r/release-notes/mcp-server-console-rn.html)
  - [jschuller/mcp-server-servicenow](https://github.com/jschuller/mcp-server-servicenow)
  - directory listings ([agentpedia](https://agentpedia.codes/mcp/servicenow),
    [glama](https://glama.ai/mcp/servers/@LokiMCPUniverse/servicenow-mcp-server)).

## 3. Strengths (keep doing)

1. **Durable, defensible differentiation.** Plan → token → apply plus journal revert, where-used,
   trace-on-save, dev↔prod drift with an exit code, and it runs on a free PDI. The official MCP
   Server Console needs a Now Assist SKU and exposes curated skills, flows and REST. The managed
   vendor server (Redpanda) authenticates as one principal and allows writes only on incidents
   and catalog submissions. NowAIKit offers only "read-only by default" plus opt-in flags, with
   no plan or token model. Evidence: README:39-82; the competitor pages above.
2. **Distribution surface is complete.** npm, the MCP Registry (`server.json`), the Marketplace
   (553 installs, 4.45★), the Claude Code plugin, `.mcpb`, and skills served over MCP (N-76,
   85600df). One-line installs exist for every client (README:179-205).
3. **The Quick demo picks the right jobs-to-be-done.** "Where is this field used / what runs on
   save / what drifted" (README:39-82) are pains every ServiceNow developer recognises.
4. **Honest self-diagnosis.** BUSINESS-REVIEW-2026-07 §3-§4 and the 2026-10-24 marketing analysis
   name the empty funnel, the KPI-measurability problem and the failed launch mechanics. The
   problem is execution, not insight.
5. **The local-first, zero-telemetry stance is right** for this audience: consultants on client
   instances will not run a tool that phones home. Keep it, and sell it (see RR-PO-01).

## 4. Findings

### RR-PO-01 — No feedback loop exists, so the roadmap is driven by analyses instead of users (severity: high · verified)

- **Evidence:**
  - `gh issue list --state all` returns one issue (#24, author `app/github-actions`). No human has
    ever opened an issue.
  - `hasDiscussionsEnabled: false`.
  - Sponsors `totalCount: 0`.
  - `.github/ISSUE_TEMPLATE/config.yml` disables blank issues and routes questions to `SUPPORT.md`,
    which adds friction at n≈0.
  - BUSINESS-REVIEW-2026-07 §4 prescribed a "15-minute monthly proxy-KPI review, logged in
    WORKLOG", plus a 2026-08-01 checkpoint (§8.5). `grep -n KPI WORKLOG.md` shows no snapshot
    between July and the 2026-10-24 marketing entry, so the ritual never ran.
  - The 54 findings behind 3.5 (F5-01…F5-54) come from audits of code, the protocol and release
    notes. None comes from a user request.
- **Why it matters (to this role):** without a signal, every roadmap item is a guess, and the
  analyses keep producing more guesses (N-0…N-94 in 26 days). A solo maintainer cannot afford to
  build what nobody asked for.
- **Recommendation:**
  - Build cheap, privacy-preserving loops, not telemetry:
    - enable GitHub Discussions with two pinned threads, "Show your setup" and "What did you
      try that didn't work?";
    - add a pre-filled feedback URL to `doctor` output and to `get_status` (zero `tools/list`
      bytes, because it lives in the result text);
    - add a read-only `scripts/kpi-snapshot.mjs` (npm, gh, Marketplace APIs) that appends one row
      a month to `project/KPI.md`.
  - Say "no telemetry, ever" in the README hero, because for consultants it is a selling point.
  - Recruit 3–5 design partners (consultants), the highest-value segment per
    COMPETITIVE-ANALYSIS §8.
- **Existing roadmap link:** O-3 "distribution + KPI checkpoint" (owner gate) names the
  checkpoint. It has no mechanism, no artefact and no cadence. → PO-I1.

### RR-PO-02 — The roadmap mix favours internals over adoption by roughly 4:1 (severity: high · verified + judgement)

- **Evidence:** classification of the 178 `roadmap.yaml` rows by pillar and title:

  | Category                                              | Rows | Share | Pillars and rows                                                   |
  | ----------------------------------------------------- | ---: | ----: | ------------------------------------------------------------------ |
  | ServiceNow capability                                 |  ~78 |  44 % | S 16, P 25 active, N ~37; 10 rows (N-25…N-34) are UI Builder alone |
  | Protocol, token budget, harness, engineering, hygiene |  ~78 |  44 % | H 11, E 9, M 9, N ~49 (N-35…N-65, N-79…N-91)                       |
  | Distribution and onboarding                           |  ~18 |  10 % | D 9, N-11, N-51, N-52, N-76, N-77, N-86, N-92…N-94                 |
  | Demand validation                                     |    0 |   0 % | —                                                                  |
  - The owner set N-45…N-56 (agent harness, code-mode outputs, OTel spans, surface scan) as
    **P0, ahead of every other N item** (CLAUDE.md "Priority (owner, 2026-10-04)").
  - O-3 (distribution) has been open since July.
  - 7 of 21 owner gates are open (`roadmap:status`), so the owner is the critical path, and every
    new analysis adds gates.

- **Why it matters:** the work that moves the KPIs (demo asset, positioning, onboarding, release
  cadence) is always "owner batch" or "3.5, last". The work that does not move them is P0.
- **Recommendation:**
  - Adopt an explicit adoption gate. No new analysis document and no new L or M capability item
    until either the KPI checkpoint (2026-11-19) shows movement or a design partner asks for the
    item.
  - Cap work in progress at one capability item and one adoption item at a time.
  - Record the gate in `project/TODO.md` as an OD.
- **Existing roadmap link:** none, new → PO-I6.

### RR-PO-03 — The one-sentence value is five different sentences, and the decided positioning is not in the repo (severity: high · verified)

- **Evidence:** how each surface describes the product today:

  | Surface                                       | Text                                                                                                        |
  | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
  | README:9-13                                   | "lets an MCP client … run commands against a ServiceNow instance through its REST APIs" (a commodity claim) |
  | docs/index.md:7                               | "turns any MCP-capable AI client … into a ServiceNow power user"                                            |
  | `package.json` / `server.json` / README badge | "100 tools in 28 packages over the full REST surface"                                                       |
  | GitHub About                                  | "67 tools … plan-and-apply write safety …"                                                                  |
  | Marketing analysis (2026-10-24)               | "safe AI writes, free on your PDI"                                                                          |
  - That last positioning lives only in `~/.claude/skills/launch-marketing/…`, outside the repo,
    so no repo surface carries it.
  - The README Quick demo sells read-only code intelligence, while the decided positioning sells
    safe writes.
  - N-77 ("positioning") is sequenced into **3.5, the last minor** (V3.5 §5), and is scoped to a
    comparison paragraph about the official console.

- **Why it matters:** a developer decides in about 10 seconds from the npm page, the GitHub About
  text or the Marketplace tile. Today they read "REST APIs" or "100 tools". Neither is a reason to
  pick this server over the eight others.
- **Recommendation:**
  - Settle one tagline plus three proof points, for example: "Let AI change ServiceNow without
    holding your breath: every write is previewed, destructive ones need a one-time token, all are
    journaled and revertible. Free, local, works on your PDI."
  - Keep it in one repo file. `docs:sync` copies it into the README hero, the docs hero, the
    `package.json` and `server.json` descriptions and the extension description.
  - Pull the README "vs the official console" paragraph out of N-77 into 3.1.
- **Existing roadmap link:** N-77 (missing: a single-source tagline, every surface beyond the
  README, and the earlier timing). → PO-I2.

### RR-PO-04 — It competes on tool count, a race the project has already lost (severity: high · verified + reported)

- **Evidence:**
  - Downloads in the last month: `nowaikit` 9,508 vs `servicenow-mcp-ai` 1,104 (8.6×);
    `snow-flow` 3,095.
  - NowAIKit has 265★ and 110 forks, sells "500+ tools", uses Elastic License 2.0, and installs
    with `npx nowaikit setup` ([repo](https://github.com/aartiq/servicenow-mcp), read today).
  - Our README badge row leads with `tools-100` (README:3).
  - The `package.json` description opens with "100 tools in 28 packages", and so does the
    `server.json` description.
  - The default profile actually exposes 20 tools, so the headline number is not even the
    first-run experience.
- **Why it matters:** 100 reads as a fifth of 500. The number invites the one comparison this
  project loses, and it hides the safe-writes and code-intelligence claims nobody else can make.
- **Recommendation:**
  - Remove the tool-count badge and move counts out of descriptions.
  - Lead with the capability nobody else has (plan → token → apply plus revert; find usages and
    what-runs-on-save).
  - Give the counts one line, lower down: "100 tools, 20 loaded by default, the rest on demand
    (token-cheap)". That turns the smaller number into a feature.
- **Existing roadmap link:** none, new (part of PO-I2).

### RR-PO-05 — Stale public numbers survived the "docs truth sweep" (severity: medium · verified)

- **Evidence:** N-91 is marked done (2026-10-27), yet these stale numbers remain:
  - README:1859 "406 tests";
  - docs/index.html:128 and :2670 "around 200 tests" / "~200 tests";
  - docs/index.html:476 and docs/index.md:20 "**3** prompts", while `grep -rn "registerPrompt("
src | wc -l` gives 15;
  - COMPETITIVE-ANALYSIS.md:56 "Free (MIT)" (the licence is GPL-3.0-or-later since 3.0);
  - GitHub About "67 tools".

  The marketing plan set 2026-10-30 as the deadline to fix these before the 2026-11-03 relaunch.
  `docs:sync` guards tool counts only (F5-46).

- **Why it matters:** every reader who clicks through from a post and sees contradicting numbers
  is lost, and the people who check numbers are exactly the senior consultants this tool targets.
- **Recommendation:** extend the `docs:sync` count guard to tests, prompts, resources and licence
  across README, `docs/index.html`, the extension README and `COMPETITIVE-ANALYSIS.md`. Fix the
  five strings today. The owner fixes the About text (OD-16).
- **Existing roadmap link:** N-91 (done, but incomplete for these strings) and OD-16 / F5-52 (the
  About text). Missing: guards for the non-tool counts. → PO-I3.

### RR-PO-06 — Shipped value is not released; the `next` tag points backwards (severity: medium · verified)

- **Evidence:**
  - `git log v3.0.0..HEAD` shows 27 commits, including the whole 3.1 and 3.2 blocks: attachment
    file I/O (N-66), multi-row import (N-68), the event lane plus three prompts (N-69), schema
    authoring (N-70), skills over MCP (N-76).
  - `package.json` is still 3.0.0.
  - `npm view dist-tags` gives `next: 3.0.0-beta.2`, older than `latest: 3.0.0`.
  - Roadmap N-11 "3.0.0-beta on `next`" is still `open` although 3.0.0 GA shipped on 2026-10-19.
- **Why it matters:** the relaunch on 2026-11-03 will point people at a version without the new
  features. A user who follows `@next` gets a downgrade. A stale "open" row makes the tracker look
  untrustworthy.
- **Recommendation:**
  - Cut 3.1.0 now, or 3.2.0 since both blocks are on `main`.
  - Move `next` to `latest`, or remove the tag.
  - Close N-11 as done or superseded.
  - Adopt a cadence policy: a minor ships within 48 h of its block landing on `main`, and the
    release notes lead with a "Highlights" section (N-92 already plans the format).
- **Existing roadmap link:** N-11 (stale), N-92 (Highlights format). Missing: the release itself
  and the cadence rule. → PO-I4.

### RR-PO-07 — No visual proof anywhere, for the fourth month running (severity: medium · verified)

- **Evidence:**
  - `grep -E '\.(gif|png|svg|webp|mp4)' README.md` finds badges only.
  - `extension/media/` holds only `walkthrough/`.
  - DX-3 (a 20 s GIF) has been open under O-3 since July (BUSINESS-REVIEW-2026-07 §3).
  - The marketing plan lists the GIF and three screenshots as pre-launch blockers, and they need a
    PDI session (owner).
- **Why it matters:** the core claim, "nothing changes until a human applies", is a behaviour.
  Behaviour sells on video. The best-performing content in this niche is short demos and
  tutorials (marketing analysis §3).
- **Recommendation:**
  - Make the demo **regenerable without a PDI**: a `vhs` tape (or asciinema script) under
    `scripts/demo/` that drives the CLI against the recorded fetch-double mocks already used by
    the skill evals (N-49). It should cover a delete attempt → preview + token → apply → revert,
    and `drift dev prod`.
  - Commit the output to `docs/assets/` and reference it in the README hero, the docs hero and
    the Marketplace gallery.
  - Re-record with a real PDI later.
- **Existing roadmap link:** DX-3 / O-3 / OD-16 (owner-only today). Missing: a route that does not
  need the owner's PDI time. → PO-I5.

### RR-PO-08 — The time to first value is long, and onboarding is sequenced last (severity: medium · verified)

- **Evidence:**
  - README is 1,958 lines, and Setup runs from line 162 to 536.
  - The first-run orientation (N-94 `first-10-minutes` / `sn-start`) and the README restructure
    (N-92) are both in **3.5**, after the change and catalog write surfaces (N-71, N-72) in 3.3
    (V3.5 §5).
- **Why it matters:** activation is where the 553 Marketplace installs either become users or
  churn. Adding write surfaces before fixing the first ten minutes optimises the wrong end of the
  funnel.
- **Recommendation:** move N-94 and N-92 to the front of 3.3, ahead of N-71 and N-72. The
  definition of done for N-94 should include "from `npx` to a first `trace_table_event` answer in
  ≤ 5 commands", checked by a scripted smoke against the mocks.
- **Existing roadmap link:** N-92, N-94 (the content is right, the timing is wrong). → PO-I6.

### RR-PO-09 — Persona drift: new write surfaces head into the lane the vendors own (severity: medium · judgement)

- **Evidence:**
  - Open capability items N-71 (change lifecycle), N-72 (catalog submit: record producers and
    order guides) and N-67 (bulk update and delete by query) serve ITSM process operators.
  - That is the lane where the official console exposes curated Now Assist skills and flow
    actions, and where Redpanda's managed server already offers catalog submit and record
    producers ([docs](https://docs.redpanda.com/agentic-data-plane/connect/managed/servicenow.md)).
  - COMPETITIVE-ANALYSIS §8 rates "low-code admins / process users" as low-interest, and
    developers and consultants as high.
- **Why it matters:** these are M-sized items, each with an owner gate, aimed at the segment
  least likely to adopt a CLI-configured MCP server. The UI Builder track (N-25…N-34, 10 rows)
  shows the same pattern: deep investment, no demand signal recorded.
- **Recommendation:** put N-71, N-72 and N-67 behind a demand gate: one design-partner request or
  one Discussions thread with at least 3 upvotes. Spend the hours on the developer moat instead
  (where-used, trace, drift, and safe writes for developer artefacts) and on adoption.
- **Existing roadmap link:** N-67 (O-23), N-71, N-72. Missing: demand criteria. → PO-I6.

### RR-PO-10 — The competitive analysis is four months stale and blind to the OSS and managed field (severity: medium · verified + reported)

- **Evidence:**
  - `project/COMPETITIVE-ANALYSIS.md` is dated 2026-06-19. It compares only against the official
    console, says "Free (MIT)" (:56), and has no OSS competitor table.
  - N-77 plans a refresh covering "official console, six servers" (V3.5:368).
  - Also missing: a third class, **managed vendor MCP servers** (Redpanda's ServiceNow connector:
    one principal, writes limited to incidents and catalog, no deletes).
  - Also missing: download and star data. `nowaikit` 9,508/mo under ELv2; `snow-flow` 3,095/mo;
    jschuller with 19 tools, which states that the console excludes the Table API.
- **Why it matters:** the positioning "the only one with safe writes" has to be checked every
  quarter against the fastest-moving competitor, which today is NowAIKit at about v4.7.
- **Recommendation:** extend N-77's scope as follows.
  - Add a three-class landscape (official console, managed vendor, OSS) with a dated metrics table
    (downloads, stars, licence, write-safety model).
  - Publish a public comparison page on the docs site.
  - Refresh it quarterly, with the dated metrics reproduced by PO-I1's snapshot script.
- **Existing roadmap link:** N-77 (missing: the managed class, metrics, the public page and the
  cadence). → PO-I7.

### RR-PO-11 — The sustainability model is "tips", with 0 sponsors and a licence that closes a channel (severity: medium · verified + judgement)

- **Evidence:**
  - Sponsors `totalCount: 0`. README:36 and :1926-1940 ask for tips.
  - The project was relicensed from MIT to GPL-3.0-or-later at 3.0 (README:1958).
  - The Docker MCP Catalog refuses GPL (F5-21; O-24 open).
  - The largest competitor uses source-available ELv2, which protects a commercial path.
  - BUSINESS-REVIEW-2026-07 §8.5 asked for an honest "park it" criterion. None is recorded.
- **Why it matters:** a solo GPL project with no revenue and no users is one life event away from
  abandonment. Enterprise consultants, the best segment, ask "who maintains this?" before they
  install anything on a client instance.
- **Recommendation:** decide the posture explicitly (owner):
  - (a) GPL plus paid support or a "consultant pack" (prompts, skills, drift CI templates);
  - (b) GPL plus a commercial exception, for catalogues and vendors;
  - (c) hobby mode with a declared maintenance policy.

  Whichever is chosen, write a `MAINTENANCE.md` stating the support window and response
  expectations, and record the park criteria in TODO.md.

- **Existing roadmap link:** O-24 touches only the container-catalogue licence. None for the rest,
  new.

### RR-PO-12 — Organic discovery is near zero; all traffic is from launch posts (severity: low · verified)

- **Evidence:**
  - Referrers for the last 14 days: LinkedIn 44 of about 65 referred views, Reddit 7, the MCP
    Registry 4, Google 1, the docs site 1.
  - 115 unique visitors in 14 days.
  - The docs site has a single hero page plus tool pages. No page targets a search intent such as
    "servicenow find where a field is used" or "compare servicenow instances dev prod".
- **Why it matters:** posts decay within 48 h. Long-tail search and ServiceNow Community articles
  compound over time. The marketing analysis covers Community articles, but not owned search
  pages.
- **Recommendation:** add 4–6 task-intent pages under `docs/` (one per hero job, plus "safe AI
  writes on ServiceNow" and "ServiceNow MCP on a free PDI"). Each page gets a demo snippet and
  install lines, and is listed in `sitemap.xml` and `llms.txt`.
- **Existing roadmap link:** none, new → PO-I8.

## 5. Proposed roadmap items

None of these items costs `tools/list` bytes, and none is BREAKING.

| Temp id | Title                                                          | Findings           | Priority | Effort | Owner decision           |
| ------- | -------------------------------------------------------------- | ------------------ | -------- | ------ | ------------------------ |
| PO-I1   | Feedback loop and KPI snapshot                                 | RR-PO-01, -10      | P0       | S      | yes (enable Discussions) |
| PO-I2   | Single-source positioning across every surface                 | RR-PO-03, -04      | P0       | S–M    | yes (approve tagline)    |
| PO-I3   | Public-number truth guard (tests, prompts, resources, licence) | RR-PO-05           | P0       | S      | no                       |
| PO-I4   | Release 3.x now, fix dist-tags, cadence rule                   | RR-PO-06           | P0       | S      | yes (publish)            |
| PO-I5   | Regenerable demo from recorded mocks                           | RR-PO-07           | P1       | M      | no                       |
| PO-I6   | Adoption gate and resequencing                                 | RR-PO-02, -08, -09 | P1       | S      | yes                      |
| PO-I7   | Competitive landscape refresh, a scope add to N-77             | RR-PO-10           | P1       | S      | no                       |
| PO-I8   | Task-intent landing pages                                      | RR-PO-12           | P2       | M      | no                       |

`tools/list` cost in detail:

- **PO-I1** adds 0 B. The feedback URL is in result text only.
- **PO-I2** is 0 B unless the server `instructions` change.

### PO-I1 — Feedback loop and KPI snapshot

- **Scope:**
  - Add `scripts/kpi-snapshot.mjs`, read-only. It reads npm last-month and last-week downloads,
    gh stars, forks, issues and discussions by non-bot authors, traffic and referrers (when a
    token allows), and Marketplace installs and rating. It appends a row to `project/KPI.md`.
    Expose it as `npm run kpi:snapshot`, outside the gate.
  - Make `doctor` (human and `--json`) and `get_status` text print one line: "Feedback / what's
    missing: <prefilled Discussions URL>".
  - Add a README "No telemetry, ever: nothing leaves your machine except calls to your instance"
    line near the hero.
  - Enable Discussions (owner) with two pinned threads.
- **Acceptance:**
  - `npm run kpi:snapshot` exits 0 offline with a "skipped" row.
  - With network access, it writes a dated row with at least 6 metrics.
  - A test pins the `doctor` feedback line.
  - `project/KPI.md` holds the 2026-10-29 baseline (§7).
- **Dependencies:** owner enables Discussions. A monthly calendar reminder (owner).

### PO-I2 — Single-source positioning across every surface

- **Scope:**
  - Add `docs/positioning.json` (tagline, 3 proof points, a one-line counts statement).
  - `docs:sync` writes it into:
    - README lines 9–13 (hero);
    - the `docs/index.html` hero;
    - the `package.json` description;
    - the `server.json` description (≤ 100 chars per the registry);
    - the `extension/package.json` description.
  - Remove the `tools-100` badge.
  - Re-order the Quick demo so the safe-writes demo comes first and the read-only jobs follow.
  - Pull the N-77 "how this differs from the official console" paragraph in.
- **Acceptance:**
  - `docs:sync --check` fails when any of the five surfaces drifts from `positioning.json`.
  - No description starts with a tool count.
  - The owner updates the GitHub About text from the same file.
- **Dependencies:** owner approves the tagline (OD below).

### PO-I3 — Public-number truth guard

- **Scope:**
  - Extend `scripts/docs-sync.mjs` with counts of prompts (`registerPrompt`), resources, the test
    total (from the last junit or a pinned constant updated by the gate) and the `package.json`
    licence.
  - Fix README:1859, docs/index.html:128, :476 and :2670, docs/index.md:20, and
    COMPETITIVE-ANALYSIS.md:56.
- **Acceptance:**
  - `grep -E '406 tests|200 tests|\b3\b prompts|Free \(MIT\)'` over README, docs and project is
    empty.
  - `docs:sync --check` fails on a planted wrong prompt count.
- **Dependencies:** none. Land it before the 2026-11-03 relaunch.

### PO-I4 — Release 3.x now, fix dist-tags, cadence rule

- **Scope:**
  - Version bump to 3.1.0 or 3.2.0, with a CHANGELOG "Highlights" section of ≤ 10 lines.
  - Publish (owner).
  - `npm dist-tag add servicenow-mcp-ai@<new> next`, or `npm dist-tag rm … next`.
  - Close N-11 as superseded.
  - Add the rule "a minor ships within 48 h of its block on main" to CONTRIBUTING.md.
- **Acceptance:**
  - `npm view servicenow-mcp-ai dist-tags` shows no tag older than `latest`.
  - `roadmap:status` no longer lists N-11.
  - The Marketplace version equals npm.
- **Dependencies:** a green gate; the owner publishes.

### PO-I5 — Regenerable demo from recorded mocks

- **Scope:**
  - `scripts/demo/safe-writes.tape` and `scripts/demo/drift.tape` (vhs), driving the CLI or a
    scripted MCP client against the N-49 recorded fetch-double mocks.
  - Output goes to `docs/assets/demo-*.gif` (≤ 2 MB each, within `pack:check` because `docs/` is
    not packed).
  - Reference the GIFs in the README hero, the docs hero and the extension gallery (no
    `galleryBanner` needed to start).
- **Acceptance:**
  - `npm run demo:render` reproduces both GIFs deterministically.
  - The README renders at least one image above the fold.
  - The demo shows preview → token → apply → revert in ≤ 20 s.
- **Dependencies:** vhs as a dev-only tool, outside the gate. A PDI re-record later (O-3).

### PO-I6 — Adoption gate and resequencing

- **Scope:**
  - Add an OD to `project/TODO.md`: "no new analysis document and no new L or M capability item
    until the KPI checkpoint or a design-partner request".
  - Re-order 3.3 in `roadmap.yaml` and V3.5 §5: N-94, then N-92, before N-71, N-72 and N-67.
  - Add a `demand:` note field to N-67, N-71 and N-72 ("needs one design-partner ask or a
    Discussions thread with ≥ 3 upvotes").
- **Acceptance:**
  - `roadmap:sync` is clean.
  - The sequencing table shows onboarding first in 3.3.
  - N-94's definition of done includes "≤ 5 commands from `npx` to a first `trace_table_event`
    answer", checked by a mock smoke test.
- **Dependencies:** owner approval.

### PO-I7 — Competitive landscape refresh (a scope add to N-77)

- **Scope:**
  - Rewrite `project/COMPETITIVE-ANALYSIS.md` around three classes: official console, managed
    vendor servers (Redpanda), and OSS (NowAIKit, snow-flow, jschuller, Happy-Technologies,
    LokiMCP).
  - Add a dated metrics table and the write-safety model of each.
  - Publish a public `docs/compare.md` page with only verifiable claims and links.
  - Set a quarterly refresh date.
- **Acceptance:**
  - Every competitor row has a URL and an access date.
  - No "MIT" anywhere.
  - The docs-site page is linked from the README "how this differs" paragraph.
- **Dependencies:** none for the docs part. The CIMD recipe stays behind O-25.

### PO-I8 — Task-intent landing pages

- **Scope:** 4–6 pages under `docs/`:
  - find usages of a field;
  - what runs when a record is saved;
  - compare dev and prod;
  - safe AI writes;
  - ServiceNow MCP on a PDI.

  Each page has one demo snippet, one GIF (from PO-I5), the install line for each client, and
  `sitemap.xml` / `llms.txt` entries.

- **Acceptance:**
  - Pages are generated or validated by `docs:sync`.
  - Each page is under 150 lines.
  - Search Console (owner) shows impressions after 30 days.
- **Dependencies:** PO-I5 for the assets.

## 6. Owner decisions needed

1. **Tagline.** Options:
   - (a) "safe AI writes, free on your PDI" (from the marketing analysis);
   - (b) "IDE-grade find usages, trace and drift for ServiceNow";
   - (c) both, with safe writes as the headline.

   **Recommend (c).** Safe writes is unclaimed, and code intelligence is the daily hook.

2. **Enable GitHub Discussions and recruit 3–5 design partners.**
   **Recommend: yes, both.** It costs nothing, and it is the only route to demand signal while
   staying telemetry-free.
3. **Release 3.x now** (both blocks are on `main`) and clean the `next` dist-tag.
   **Recommend: yes, before 2026-11-03**, so the relaunch points at the newest value.
4. **Adoption gate / WIP limit** (PO-I6), with N-71, N-72 and N-67 behind a demand signal.
   **Recommend: yes** until the 2026-11-19 checkpoint.
5. **Sustainability posture.** Options:
   - (a) GPL plus paid support or a consultant pack;
   - (b) GPL plus a commercial exception;
   - (c) declared hobby mode.

   **Recommend (a), plus a `MAINTENANCE.md` and recorded park criteria.**

6. **Drop the tool-count headline** (badge and descriptions). **Recommend: yes.**

## 7. Metrics this role would track

All values are baselines measured on 2026-10-29.

| KPI                                                      | Current value                                         | Target and notes                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| npm downloads / month                                    | 1,104 (273 last week)                                 | ≥ 1,500 at the 2026-11-19 checkpoint. Inflated by mirrors, so read the trend, not the level. |
| Human-authored issues + discussions, cumulative          | **0**                                                 | ≥ 3 by the checkpoint. The single most honest activation signal.                             |
| Marketplace installs (the best proxy for human installs) | 553, rating 4.45                                      | Track the monthly delta.                                                                     |
| GitHub stars and forks                                   | 10 and 3                                              | Target ≥ 40 stars. Benchmark: NowAIKit has 265★.                                             |
| Release lag                                              | 27 unreleased commits, 10 days since the last release | Target: unreleased capability commits ≤ 0 after 48 h.                                        |
| Organic share of referred traffic                        | Google 1 of ~65 (≈ 2 %)                               | Target ≥ 20 % within 90 days of PO-I8.                                                       |
