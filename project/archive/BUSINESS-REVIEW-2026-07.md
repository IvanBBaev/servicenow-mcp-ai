# servicenow-mcp-ai — Business Review (post-2.0)

Date: 2026-07-01 · Lens: senior business analyst · Read-only assessment, no code changes.
Companion to [BUSINESS-ANALYSIS-V2.md](BUSINESS-ANALYSIS-V2.md) (the strategy this review
audits), [COMPETITIVE-ANALYSIS.md](../COMPETITIVE-ANALYSIS.md) (positioning and the R1–R7
platform risks), [ROADMAP-V2.md](ROADMAP-V2.md) (the v2.0 execution tracker) and
[UX-REVIEW-2026-07.md](UX-REVIEW-2026-07.md) (the UX/DX twin of this review). Those
documents defined the plan; **this one measures reality against it ten days after the
2.0.0 release** and ends with a prioritized action list. §8 is a dated addendum
(2026-07-02): the merciless assessment — same facts, harder verdict, plus the
consolidated evidence from the 2026-07-01 review cycle.

> Scope note: strategy, market sizing, business model and the B1–B7 risk register are
> **not** re-derived here — they live in BUSINESS-ANALYSIS-V2 and still hold. This file
> adds the post-release delta: delivery scorecard, adoption reality, KPI measurability,
> the Jira decision, and a 30-day recommendation.

---

## 1. Executive summary

- **The product is strategically complete but commercially at zero.** v2.0 delivered the
  entire trust + depth + reach bundle on plan — and more (DF-3/4/5/6, originally triaged
  to 2.1, shipped inside 2.0). The engineering question is answered.
- **Distribution infrastructure is built; distribution execution has not started.** npm,
  MCP Registry, Claude Code plugin, VS Code Marketplace and the docs site all exist —
  but no demo GIF, no content, no community seeding. Every adoption KPI is ≈ 0.
- **Engineering is months ahead of market work.** The 2026-07-01 gap analysis verdict
  stands: the codebase is over-reviewed relative to its user base. The marginal value of
  the next unit of engineering is far below the marginal value of the first unit of
  distribution.
- **Two decisions are on the table, and neither is a feature:** (a) what happens to the
  uncommitted Jira surface (ARCH-14) — a positioning decision, not a technical one; and
  (b) whether the next month is spent on code or on go-to-market.
- **Recommendation:** a two-week distribution sprint with zero new code, a formal Jira
  decision (separate package or pause), a measurable proxy-KPI set, and two cheap
  trust-hygiene fixes (extension version-sync gate, dependabot/CodeQL). Monetization
  stays frozen exactly as sequenced in BUSINESS-ANALYSIS-V2 §6.

---

## 2. Delivery vs strategy — scorecard

BUSINESS-ANALYSIS-V2 §11 defined v2.0 as _trust + depth + reach + discovery_ with a cut
line of DF-0/DF-2/DF-1/DX-1/DX-3. Delivery against that definition:

| Pillar        | Planned                                     | Delivered                                                                       | Status             |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------- | ------------------ |
| **Trust**     | DF-2 plan-and-apply + journal · DF-5 · DX-2 | All 13 write tools plan-by-default; audit journal; redaction                    | ✅ shipped         |
| **Depth**     | DF-0 preflight · DF-1 ACL scan · DF-4       | `check_capabilities` + degrade; security scan in `code_health`; `where_used`    | ✅ shipped         |
| **Reach**     | DF-6 HTTP transport                         | `SN_TRANSPORT=http`, loopback-bound, token guard                                | ✅ shipped         |
| **Extras**    | DF-3 triaged to 2.1                         | `drift` CLI gate shipped in 2.0                                                 | ✅ over-delivered  |
| **Discovery** | DX-1 publish + registry · DX-3 sharp demo   | npm 2.0.1 + MCP Registry + Claude Code plugin + VS Code extension; demo written | 🟡 **GIF pending** |

The only open item is the **DX-3 screen-capture GIF** — ironically the cheapest artifact
with the highest expected adoption effect. The strategy itself is explicit that uptake is
capped by discovery and a sharp demo "far more than by features" (COMPETITIVE-ANALYSIS
§8) — and that is exactly the piece not done.

---

## 3. Adoption reality — the funnel is empty

Signals collected 2026-07-01 (gap-analysis session, [WORKLOG.md](../../WORKLOG.md)):

| Signal                    | Value                 | Reading                                                    |
| ------------------------- | --------------------- | ---------------------------------------------------------- |
| GitHub stars / forks      | 1 / 0                 | No community signal                                        |
| GitHub issues             | 0                     | No activation signal (nobody is using it enough to report) |
| Repo traffic (2 weeks)    | 314 views · 63 unique | Trickle; no content is driving visits                      |
| npm downloads             | ~939/month            | Likely mostly registry mirrors, not humans                 |
| VS Code extension version | 2.0.0 (npm is 2.0.1)  | Version drift; no sync gate in `publish-vscode.yml`        |
| External contributors     | 0                     | Bus-factor (B3) unmitigated                                |

Interpretation: this is **not a product problem**. The funnel's top has never been fed —
there is no demo asset, no content in the channels the segment reads (ServiceNow
Community, LinkedIn, r/servicenow), no awesome-mcp listings. The plan predicted exactly
this failure mode (B7 "low discoverability keeps a good product unused") and prescribed
the fix (DX-3 + content); the prescription has not been executed.

---

## 4. The KPI measurability problem

BUSINESS-ANALYSIS-V2 §10 defines KPIs (adoption, activation, depth, trust), but the
product's **local-first, zero-telemetry posture — correct, and part of the moat — makes
most of them unmeasurable directly.** Without proxies, "adoption-first" has no feedback
loop. Proposed proxy set:

| Planned KPI    | Measurable proxy today                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Adoption       | GitHub stars + traffic, npm weekly downloads, **VS Code Marketplace install count** (public counter — the honest human-user signal) |
| Activation     | Issues/Discussions opened by real users; questions in community threads                                                             |
| Depth / Trust  | Not measurable pre-adoption; park until the first cohort of users exists                                                            |
| Community (B3) | External PRs/issues; contributors count                                                                                             |

Ritual: a **15-minute monthly review** of these numbers, logged in WORKLOG. Cheap, and it
is the only way to know whether the distribution work (§6, item 1) is moving anything.

---

## 5. The Jira decision (ARCH-14) — a positioning decision, not a technical one

The uncommitted work-in-progress adds a Jira HTTP client, config, host guard and ADF
marshalling (`src/core/jira/`, `src/api/jira/`) — **no tools yet, no registry entry, no
docs**. TODO.md frames ARCH-14 as a safety-rails design decision. The business framing
is bigger:

1. **The entire business case is ServiceNow-specific.** The name (`servicenow-mcp-ai`),
   the SEO work, COMPETITIVE-ANALYSIS and the durable-moat logic all rest on asymmetries
   against the ServiceNow platform (paid SKU, metering, does-not-read-code,
   single-instance). None of that transfers to Jira.
2. **The Jira competitive landscape is different and unanalyzed.** Atlassian ships an
   official **remote MCP server, free for Cloud customers** — so the "zero-entitlement /
   any instance / free" wedge that defines this product's ServiceNow lane does not exist
   there. No equivalent of COMPETITIVE-ANALYSIS has been written for Jira, and the
   burden of proof is on the expansion: _who is the buyer, and why this server instead
   of Atlassian's official one?_
3. **The opportunity cost is the real cost.** Finishing Jira properly means the same
   rails as ServiceNow (package axis, `SN_READONLY`, plan/apply, journal, redaction) for
   a whole second system — weeks of the single maintainer's time, spent exactly when the
   MCP land-grab window (B1/R7) is open and distribution is the binding constraint.

Options, in recommended order:

| Option                                | Verdict                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Separate package** (shared core) | **Preferred if Jira proceeds at all** — clean positioning, brand intact, code reuse. Gate it on a written answer to the buyer question above |
| **B. Pause / cut**                    | **Acceptable and honest** — frees the maintainer for the actual gap (distribution); the branch can wait                                      |
| **C. Fold into the main package**     | **Not recommended** — dilutes the name, weakens the safety contract until the rails land, and defocuses at the worst possible moment         |

---

## 6. Risk register — delta since BUSINESS-ANALYSIS-V2

The B1–B7 register stands. What has changed in ten days:

- **B7 (discoverability) is now the #1 active risk** — and it feeds B3: a product with
  no users attracts no contributors, so the bus factor stays 1 indefinitely.
- **B3 (single maintainer) is manifesting as defocus**, not as burnout: the Jira WIP is
  the symptom. The mitigation is scope discipline (§5), not more capacity.
- **R7/B1 (the rented moat) is a clock, not a hypothesis.** Every month of engineering
  without distribution consumes the first-mover window the strategy is built on.
- **New operational risk: release-channel drift.** npm at 2.0.1, extension at 2.0.0, no
  version-sync check in `publish-vscode.yml`. Small, but it is a trust signal aimed at
  precisely the audience that judges tools by such details.

---

## 7. Recommendations (prioritized)

1. **Two-week distribution sprint, zero new code.**
   - Record the DX-3 GIF (≈1 day) and drop it into the README + docs-site hero.
   - Publish 2–3 pieces on the narrative _"ServiceNow has no find-usages — here's how
     to get it"_ (ServiceNow Community, LinkedIn, r/servicenow), each ending at the
     quickstart.
   - PR the server into the awesome-mcp lists; verify the MCP Registry listing renders
     well.
2. **Decide Jira formally** (§5): separate package or pause. Do not dark-ship it in the
   main package.
3. **Adopt the proxy-KPI set (§4)** and the monthly 15-minute review.
4. **Trust hygiene:** version-sync gate in `publish-vscode.yml`, dependabot, CodeQL —
   hours of work, visible to exactly the enterprise-adjacent adopters the strategy
   targets.
5. **Monetization: do nothing.** The adoption-first sequencing in BUSINESS-ANALYSIS-V2
   §6 is correct; Phase β stays frozen until activation is demonstrably > 0.

---

## 8. Addendum (2026-07-02) — the merciless assessment

Lens: a deliberately no-mercy overall review, delivered after the 2026-07-01
`/full-review` cycle over the uncommitted Jira integration and the gap-analysis sweep.
§§1–7 measure delivery against strategy; this section names the uncomfortable patterns
behind the numbers. Status markers reflect the repo as of 2026-07-02 — notably, GA-1…GA-6
were executed between the assessment being delivered and this write-up (§8.3), which
partially answers finding 6 and sharpens finding 1.

### 8.1 Evidence base — what one full review cycle actually found

The 2026-07-01 architect → dev → qa cycle, scoped to the uncommitted Jira WIP
(`src/core/jira/`, `src/api/jira/`, `src/core/http-util.ts` and the touched
`core/http.ts`/`core/host.ts`). Full detail in [TODO.md](../TODO.md) and
[DONE.md](../DONE.md); the consolidated shape:

| Persona   | Found  | Fixed  | Deferred (owner)             | Gate after the step               |
| --------- | ------ | ------ | ---------------------------- | --------------------------------- |
| Architect | 8      | 4      | 4 (ARCH-10 / 11b / 12b / 14) | 358 tests · 95.22/84.07/98.56 · 0 |
| Dev       | 3      | 3      | 0 (+2 reviewed-OK, pinned)   | 358 tests · 95.19/84.01/98.56 · 0 |
| QA        | 5      | 5      | 0                            | 363 tests · 95.23/84.17/98.56 · 0 |
| **Total** | **16** | **12** | **4 — all design decisions** | green at every step, audit 0      |

The single most telling number: **the QA step found zero product bugs.** All five QA
findings (QA-23…QA-27) were test gaps — assertions to pin behavior that was already
correct. The dev step's three findings were latent-parity hardening (no current caller
hits DEV-9; DEV-8 needs a saturated semaphore) — real, but not user-visible today. The
review machine is working; it is also **saturated**: it polishes a codebase that
[§3](#3-adoption-reality--the-funnel-is-empty) shows nobody is using.

### 8.2 Findings

1. **Engineering excellence has become the comfortable substitute for market work.**
   Five full-review passes since mid-June; the latest produced only test gaps (§8.1). The
   marginal return of another review pass is measurably near zero — while the marginal
   return of the first distribution act is unknown _because it has never been attempted_
   (§3). Review passes feel like progress and carry zero rejection risk; posting the
   product where ServiceNow developers actually are carries plenty. That asymmetry, not
   the backlog, explains how the work has been sequenced.
2. **The "deliberate split" of the twin HTTP clients did not survive contact with
   reality.** `http-util.ts` documents the design as "there is still effectively 'one
   HTTP client' — the two callers differ only in host resolution, auth and error-body
   shape, not in how they retry or rate-limit." Yet DEV-8 and DEV-9 found the twins
   already drifted apart _within a single work-in-progress_: `snRequest` started its
   timeout clock before acquiring a semaphore slot (the Jira twin did it right) and
   lacked the `?`-join guard (ditto). Both are fixed, but the premise — "the two loops
   can be maintained in parallel by discipline" — is now empirically weakened after one
   WIP, with zero external contributors to notice future drift. ARCH-10 (the
   hook-parameterised unification, deferred as an owner decision) should be decided with
   this evidence on the table, not on the header comment's optimism.
3. **The Jira WIP is scope creep until it has a written business case.** It is real
   engineering (client, host guard, ADF marshalling, 380-test gate) pointed at a market
   where the wedge does not exist (§5: Atlassian's official remote MCP server is free for
   Cloud customers). The strongest — currently the _only_ — defensible story is the
   **bridge**: a ServiceNow incident and its Jira development ticket handled in one
   conversation, by the tool that already knows the ServiceNow side. That is Jira as a
   _feature of the ServiceNow product_, not a second product competing with Atlassian.
   The honest options remain §5's A or B: a thin bridge MVP (get/search/create issue +
   comment + SN↔Jira link) behind the same safety rails as a separate or clearly
   subordinate surface — or shelve the branch and spend the weeks on the actual
   constraint. Dark-shipping more Jira infrastructure without that decision is scope
   creep with excellent test coverage.
4. **Distribution has been flagged repeatedly and executed never — while the
   monetization surface quietly grows.** The gap analysis flagged adoption ≈ 0 (GA-8);
   this review flagged it (§3, §7.1); the roadmap has carried DX-3 as "the only open
   item" since the 2.0.0 release. Meanwhile the same week shipped three donation links
   (GitHub Sponsors, Ko-fi, Donatree — commits `72564dd`, `5a933e4`, `a307a41`) onto a
   README with one star and no known human users. Each link is individually cheap and
   harmless; together they are the ask placed before the give. The order is backwards:
   the demo GIF and the first community post come first, the tip jar earns its place
   after the first real user exists.
5. **The core thesis — "knows your instance" — has never been proven against a live
   instance.** All 380 tests are mock-fetch. Nothing in CI or in the release process has
   ever executed `where_used`, the ACL scan or `check_capabilities` against a real
   ServiceNow instance (GA-9). For a product whose differentiation is _depth of instance
   understanding_, the strongest evidence artifact — a nightly PDI e2e run with a badge —
   is also the cheapest credibility win available, and it is still "on request".
6. **The cheap trust wins sat unpicked for ten days — then took one day.** GA-1…GA-4
   (dependabot, CodeQL, extension version-sync, Windows lint/format) were flagged as
   "hours of work" on 2026-07-01 and executed in full within a day (the
   2026-07-01 → 02 sweep, §8.3) — which
   proves the point rather than refuting it: the cost was never the constraint;
   prioritization was. The same pattern should now be applied to GA-8, which has been
   waiting longer and matters more.

### 8.3 What changed between the assessment and this write-up (2026-07-02)

- **GA-1…GA-6 executed** ([DONE.md](../DONE.md)): dependabot (npm root + `extension/` +
  github-actions), CodeQL workflow, extension bumped to 2.0.1 + version-sync gate in
  `publish-vscode.yml`, lint/format on the Windows CI leg, dedicated unit tests for
  `core/policy.ts` / `core/write-journal.ts` (+ `parseRedirect` edges), and the
  env-docs sync test. Gate: **380 tests**, coverage 95.29/84.36/98.56, audit 0. This
  closes finding 6 and the "trust hygiene" item in §7.4.
- **Still open, in priority order:** GA-8 (distribution — untouched), DX-3 (the GIF),
  ARCH-14 (the Jira decision, §5/§8.2-3), GA-9 (PDI e2e nightly), ARCH-10/11b/12b
  (deferred design decisions, now with the §8.2-2 evidence attached).

### 8.4 Verdict — the two-week plan

Zero new features. In order:

| When         | Action                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Week 1**   | Decide Jira formally (§5 options A/B — the bridge MVP or the shelf; written, in TODO.md). Record the DX-3 GIF. Clean up the stale `io.github.LeassTaTT` registry duplicates.                                                    |
| **Week 1**   | First community post (ServiceNow Community or sndevs Slack) on the find-usages narrative, ending at the quickstart.                                                                                                             |
| **Week 2**   | Two more posts (LinkedIn, r/servicenow) + awesome-mcp list PRs. Start the §4 monthly proxy-KPI ritual with the first logged snapshot.                                                                                           |
| **Week 2**   | Stand up the GA-9 PDI e2e nightly (needs a PDI + credentials) — the live-instance proof and badge.                                                                                                                              |
| **Standing** | **Full-review moratorium**: no further `/full-review` passes until a real user issue arrives or a substantive new surface (the Jira tool layer) lands. The gate is saturated (§8.1); each pass costs the only maintainer a day. |

### 8.5 30-day success targets

The §4 proxy set gets two concrete, falsifiable targets, measured on **2026-08-01**:

1. **First 5 identifiable human users** — marketplace installs, traffic inflection, or a
   comment/mention anywhere a human wrote it.
2. **First externally opened issue or discussion** on the repo.

If the distribution sprint actually executes and both targets are still missed, the
honest next review is not of the code but of the premise (B1/§3.3 of
BUSINESS-ANALYSIS-V2: is the segment reachable at a solo maintainer's effort level?) —
and that review should be allowed to conclude "park it" without treating the conclusion
as failure.

---

## Sources & basis

- Internal: [BUSINESS-ANALYSIS-V2.md](BUSINESS-ANALYSIS-V2.md) (strategy §§2–11),
  [COMPETITIVE-ANALYSIS.md](../COMPETITIVE-ANALYSIS.md) (positioning, R1–R7, §8),
  [ROADMAP-V2.md](ROADMAP-V2.md) (delivery status), [TODO.md](../TODO.md) (ARCH-14),
  [CHANGELOG.md](../../CHANGELOG.md) (2.0.0 scope), [WORKLOG.md](../../WORKLOG.md) 2026-07-01
  gap-analysis entry (adoption metrics).
- External context: the Atlassian official remote MCP server (free for Cloud) as the
  comparator for any Jira expansion. As with BUSINESS-ANALYSIS-V2, external figures are
  directional, not audited.
- Addendum (§8): [TODO.md](../TODO.md) / [DONE.md](../DONE.md) 2026-07-01 full-review cycle
  (ARCH-9…14, DEV-8…10, QA-23…27, per-step gates) and the 2026-07-01 → 02 gap-analysis execution
  (GA-1…GA-6, the 380-test gate); `src/core/http-util.ts` header (the quoted design
  claim); git history `72564dd`/`5a933e4`/`a307a41` (the donation links).
