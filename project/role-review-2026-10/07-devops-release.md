# Role review — Senior DevOps / Release & Supply-chain Engineer (2026-10-29)

Reviewer role: a release and supply-chain engineer with 15+ years running CI/CD for open-source
packages and self-hosted services. I care that every artefact a user installs (npm tarball,
`.vsix`, `.mcpb`, container image, registry entry) is built once in CI from a reviewed commit,
is traceable to that commit, cannot be published by a stolen or expired credential, and that a
release does not depend on one person remembering a sequence of manual steps. For the HTTP mode
I care about what an operator needs: probes, metrics, logs, config by environment, clean
shutdown and an honest statement of how it scales. "Good" means a boring release: tag →
gated publish → attested artefacts on every channel, with no long-lived publish secrets.

Baseline: main @ dc29e9c · servicenow-mcp-ai 3.0.0 · scope: `.github/` (9 workflows,
dependabot, CODEOWNERS, release.yml), `scripts/sync-version.mjs`, `scripts/release-notes.mjs`,
`Dockerfile`, `.dockerignore`, `smithery.yaml`, `server.json`, `CONTRIBUTING.md` → Releasing,
`src/mcp/transport.ts`, `src/mcp/plan-token.ts`, `src/server.ts`, repo settings via `gh api`,
npm and Open VSX registry metadata, the last 20 CI runs and all publish runs.

## 1. Verdict

The CI design is well above the norm for a solo project: every action is SHA-pinned, every CI
job has `timeout-minutes`, permissions are least-privilege per job, there is actionlint, a
Node-floor leg, a Windows leg, CodeQL, npm provenance (SLSA v1 predicate, verified on the
registry) and a version-sync script with a guard test. The weak side is everything _around_ the
workflows: the repository has no branch or tag protection, secret scanning and push protection
are off on a public repo, publishing still rides on a long-lived `NPM_TOKEN` that npm now caps
at 90 days (set 2026-08-20, so it is due by 2026-11-18 at the latest), and the VS Code extension
is published in parallel with, not after, the gated npm publish. Dependabot is effectively
switched off in practice: 10 PRs open, the oldest from 2026-07-03, and the SDK group PR cannot go
green because a docs test pins the SDK version string. **Score: 7/10** — excellent workflow
hygiene, but the release path has a credential expiry cliff and no guard rails beyond the
owner's own discipline.

- Top risks: (1) `NPM_TOKEN` expiry breaks the next release and is a standing theft target;
  (2) no ruleset on `main` / `v*` tags + secret scanning off; (3) dependency updates stalled
  (moderate prod advisory unfixed, Actions three majors behind).
- Top strengths: (1) SHA-pinned, least-privilege, time-boxed CI with actionlint; (2) provenance +
  tag↔version guard + `sync-version.mjs` across 8 followers; (3) HTTP mode has open
  `/healthz` + `/readyz`, token-gated `/metrics`, OTel bridge and SIGTERM drain.

## 2. What I examined

- `.github/workflows/{ci,publish,publish-mcp,publish-vscode,codeql,live-smoke,sdk-drift,skill-evals}.yml`,
  `.github/dependabot.yml`, `.github/release.yml`, `.github/CODEOWNERS`.
- `scripts/sync-version.mjs`, `scripts/release-notes.mjs`, `CONTRIBUTING.md:240-300`,
  `CHANGELOG.md`, `server.json`, `smithery.yaml`, `Dockerfile`, `.dockerignore`, `.nvmrc`.
- `src/mcp/transport.ts:409-430` (probes), `src/mcp/plan-token.ts:40-70`, `src/server.ts:152-154`.
- `gh run list --limit 20`; `gh run list --workflow {publish,publish-mcp,publish-vscode}.yml`;
  `gh run view 40899232928 --log-failed`, `39819936652`, `39314095869`; `gh release list`;
  `gh pr list --state open`; `gh secret list`; `gh variable list`;
  `gh api repos/IvanBBaev/servicenow-mcp-ai{,/branches/main/protection,/rulesets,/environments}`.
- `npm view servicenow-mcp-ai dist-tags versions`, `npm view servicenow-mcp-ai@3.0.0 dist
dependencies`, `npm owner ls`, `npm audit --omit=dev --json`, `npm ls --omit=dev --all`,
  `npm outdated`; `curl https://open-vsx.org/api/ivanbbaev/servicenow-mcp-ai/3.0.0`.
- Roadmap cross-check: `project/roadmap.yaml` (N-86, D-6), `project/TODO.md`,
  `project/V3.5-ANALYSIS-2026-10.md` (F5-34, F5-35, F5-54, §4 N-86).
- External: GitHub changelog on npm token changes (2025-11-05, 2025-12-09) and Node 20 removal
  on Actions runners (2026-09-23).

## 3. Strengths (keep doing)

1. **Supply-chain basics in the workflows are done right.** Every `uses:` is a full SHA with a
   version comment (`ci.yml:31-32`, `codeql.yml:24`, `publish.yml:26-27`); `mcp-publisher` is a
   pinned version verified with `sha256sum --check` (`publish-mcp.yml:34,48-58`); `ovsx` is
   pinned (`publish-vscode.yml:24`); actionlint runs from a pinned image (`ci.yml:192-198`).
2. **Least privilege per job.** Workflow defaults are `contents: read`; write scopes are granted
   only on the job that needs them (`publish.yml:52-53,83-84`, `codeql.yml:19-21`).
3. **Time-boxed, cancel-superseded CI.** Six `timeout-minutes` in `ci.yml`, a `concurrency`
   group with `cancel-in-progress` (`ci.yml:13-15`). Real durations are healthy: CI 3m18s–7m54s,
   CodeQL ~2m30s (`gh run list`).
4. **Matrix covers what users run:** Node 22/24/26 on Linux, 22 on macOS, exactly 22.12.0 as the
   engines floor (`ci.yml:93-104`), Windows, an ancient-Node launcher probe (`ci.yml:165-188`).
5. **Provenance works end to end.** `npm view servicenow-mcp-ai@3.0.0 dist` shows
   `attestations.provenance.predicateType = https://slsa.dev/provenance/v1` (SLSA build L2 for
   the npm channel).
6. **One version everywhere.** `scripts/sync-version.mjs:45-54` rewrites 8 followers and is
   wired into the `version` lifecycle (`package.json` scripts); the extension job refuses skew
   (`publish-vscode.yml:47-54`); the publish job refuses a tag/version mismatch
   (`publish.yml:33-37`). Prerelease routing (`next`, prerelease release, skip registry and
   Marketplace) is explicit and tested (`test/distribution.test.js:102-140`).
7. **The release-notes 125 k limit was learned and fixed.** beta.1's release job failed with
   `body is too long (maximum is 125000 characters)` (run 39314095869); `release-notes.mjs:52-67`
   now fits the notes to 120 000.
8. **Container image is the right shape:** multi-stage, `npm pack` so the image equals the
   tarball, distroless `nonroot` runtime, `USER 65532`, allow-list `.dockerignore`
   (`Dockerfile:23-63`, `.dockerignore`).
9. **HTTP operability is real:** unauthenticated `/healthz` and `/readyz` that only say
   up/ready/draining (`transport.ts:417-429`), `/metrics` refused without a token
   (`transport.ts:381-385`), OTel bridge (`src/core/otel.ts`), SIGTERM = SIGINT graceful close
   (`server.ts:152-154`), session cap `SN_HTTP_MAX_SESSIONS` (README:485).

## 4. Findings

### RR-DO-01 — Publishing depends on a long-lived `NPM_TOKEN` that npm caps at 90 days (severity: high · verified + reported)

- **Evidence:** `publish.yml:45-47` uses `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`;
  `gh secret list` → `NPM_TOKEN 2026-08-20T12:15:09Z`. npm caps write-enabled granular tokens at
  90 days and revoked all classic tokens on 2025-12-09
  (https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/,
  https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/).
  A token set on 2026-08-20 expires no later than **2026-11-18**. CONTRIBUTING.md:258 still says
  "an automation/2FA token" — automation tokens were classic tokens and no longer exist. No
  roadmap item mentions trusted publishing (`grep -i "trusted.publish"` over roadmap/TODO/V3.5:
  0 hits).
- **Why it matters:** the next 3.x release (27 commits since v3.0.0, including a high zod
  advisory floor) fails with E401/E404 at the last step, and only the owner can fix it. A
  write token in repo secrets is also the classic npm worm entry point.
- **Recommendation:** switch to npm trusted publishing (OIDC): configure the trusted publisher
  on npmjs.com for `IvanBBaev/servicenow-mcp-ai` + `publish.yml`, add a step that installs npm
  ≥ 11.5.1 (Node 22 bundles npm 10), drop `NODE_AUTH_TOKEN`, delete the `NPM_TOKEN` secret and
  set the package to "require 2FA and disallow tokens". `id-token: write` is already present
  (`publish.yml:20`). Provenance becomes automatic. Update CONTRIBUTING Releasing step 4.
- **Existing roadmap link:** none — new (N-86 covers attestation/SBOM, not the publish credential).

### RR-DO-02 — No branch or tag protection; secret scanning and push protection off on a public repo (severity: high · verified)

- **Evidence:** `gh api repos/IvanBBaev/servicenow-mcp-ai/branches/main/protection` →
  `404 Branch not protected`; `.../rulesets` → `[]`; `security_and_analysis`:
  `secret_scanning`, `secret_scanning_push_protection`, `dependabot_security_updates` all
  `disabled`; environments: only `github-pages`.
- **Why it matters:** any `v*` tag push from any ref publishes to npm, the Marketplace, Open VSX
  and the MCP Registry. Autonomous agent sessions work directly on `main` in this repo (global
  rule: commit every finished item right away), so an accidental `git push --follow-tags` or a
  force-push rewrites the released history with nothing stopping it. Secret scanning push
  protection is free on public repos and is exactly the backstop the owner's "secrets are never
  committed" rule needs.
- **Recommendation:** (a) enable secret scanning + push protection + Dependabot security
  updates; (b) a ruleset on `main`: block force-push and deletion, require the `CI` checks
  (owner bypass allowed so solo work is not blocked); (c) a tag ruleset on `v*`: only the owner
  may create, nobody may update or delete; (d) a `release` environment with the owner as
  required reviewer, referenced by `publish`, `publish-vscode` and `publish-mcp` jobs — a tag
  then needs one click to ship, and secrets become environment-scoped.
- **Existing roadmap link:** none — new.

### RR-DO-03 — The VS Code extension ships before (and independently of) the gated npm publish (severity: high · verified)

- **Evidence:** both `publish.yml` and `publish-vscode.yml` trigger on `push: tags: ["v*"]`;
  `publish-vscode.yml` runs no `npm run check` and has no `needs`/`workflow_run` link to
  Publish. On v3.0.0 the extension run took 21 s and the npm run 4m20s, both started
  2026-10-19T20:35:12Z (`gh run list --workflow …`). The extension launches the server through
  `npx servicenow-mcp-ai@3.x` (`extension/src/config.ts` `SERVER_VERSION_RANGE`).
- **Why it matters:** for ~4 minutes on every GA release, and permanently if the npm gate fails,
  Marketplace and Open VSX users receive an extension pointing at a server version that is not
  on npm. A red npm gate does not stop the extension.
- **Recommendation:** trigger `publish-vscode.yml` like `publish-mcp.yml` — `workflow_run` on
  `Publish` with `conclusion == 'success'` and a non-prerelease `head_branch`, keep
  `workflow_dispatch`; check out `github.event.workflow_run.head_sha`. Extend the
  `distribution.test.js` assertion.
- **Existing roadmap link:** N-86 ("one gate run per publish") — N-86 dedupes `check` inside
  `publish.yml` but does not order the three publish workflows.

### RR-DO-04 — Dependabot is stalled: 10 open PRs, SDK group blocked by a docs-string test (severity: high · verified)

- **Evidence:** `gh pr list` → #10 (2026-07-03, `@eslint/js` 10 — already on `^10.0.1` in
  `package.json`, i.e. stale), #12 (2026-07-10), #18 (superseded by #26), #20, #21, #26–#30. PR
  #30 (SDK `server` 2.4.0, `node` 2.1.2, `acorn`, `eslint`, `prettier`) fails on every leg with
  `not ok 531 - N-91: the landing-page badge names the MCP SDK line of package.json`
  (`test/distribution.test.js:353`, run 40899232928). N-81 pinned the SDK packages to exact
  versions, so every SDK bump now needs a hand-regenerated landing page.
- **Why it matters:** the update channel is the main supply-chain control and it does not
  close. `npm audit --omit=dev` reports `@hono/node-server` 1.19.10–2.1.2 (moderate, `serveStatic`
  double decode) via `@modelcontextprotocol/node@2.1.1`; the fix is exactly PR #30
  (`node` 2.1.2 widens to `^2.1.3`). It is not reachable (no `serveStatic` in `src/`), but the
  gate's `--audit-level=high` hides it without a recorded triage.
- **Recommendation:** make the badge/landing strings derive from `package.json` at build time
  (or have `docs:sync --write` run in a Dependabot-only workflow that pushes the regenerated
  file to the PR branch); close #10/#18; add a `dependabot.yml` `groups` entry for the
  `@modelcontextprotocol/*` packages so the four exact pins move together; record accepted
  moderate advisories in a tracked allow-list (e.g. `audit-ci` config) with a reason and expiry.
- **Existing roadmap link:** none — new (E-2 audit recipe exists; nothing on PR flow).

### RR-DO-05 — GitHub Actions three majors behind; Node 20 runtime is gone from runners (severity: medium · verified + reported)

- **Evidence:** all workflows pin `actions/checkout@… # v4.4.0`, `actions/setup-node@… # v4.4.0`,
  `codeql-action@… # v3.38.1`, `codecov-action # v5.5.5`; open PRs #26–#29 offer checkout 7.0.1,
  setup-node 7.1.0, codeql 4.38.3, codecov 7.1.1 (open since 2026-10-16). GitHub removed Node 20
  from runners on 2026-09-23
  (https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions);
  the v4 actions now run on the forced Node 24 shim.
- **Why it matters:** CI is green today by grace of the runner's compatibility mode; a security
  fix to checkout/setup-node lands only on current majors, and SHA pins freeze you on the
  unsupported line. CodeQL v3 → v4 also changes the analysis engine.
- **Recommendation:** merge #26–#29 in one reviewed change (checkout v5+ changed
  `persist-credentials` handling — keep `persist-credentials: false` explicit on jobs that do not
  push); group `github-actions` updates in `dependabot.yml` so this cannot fan out again.
- **Existing roadmap link:** none — new.

### RR-DO-06 — Container base images not digest-pinned, not in Dependabot, healthcheck ignores `/healthz` (severity: medium · verified)

- **Evidence:** `Dockerfile:23` `FROM node:22-bookworm-slim`, `Dockerfile:46`
  `FROM gcr.io/distroless/nodejs22-debian12:nonroot` (tags, no `@sha256:`);
  `dependabot.yml` has no `docker` ecosystem; `Dockerfile:59-62` does a TCP connect and its
  comment says "The server has no unauthenticated health path" — false since
  `transport.ts:417` serves an open `/healthz` that also reports `draining` (503). CHANGELOG
  Unreleased: the in-image `npm run build` was broken from N-85 until N-76 because nothing builds
  the image in CI.
- **Why it matters:** the image is not reproducible, base CVE fixes do not arrive as PRs, and a
  TCP healthcheck stays green while the server drains or wedges.
- **Recommendation:** pin both stages by digest (`FROM node:22-bookworm-slim@sha256:…`), add a
  `docker` entry to `dependabot.yml`, switch HEALTHCHECK to
  `fetch('http://127.0.0.1:'+port+'/healthz')` and check `res.ok`; fix the comment.
- **Existing roadmap link:** N-86 adds a `docker build` + `/healthz` smoke job and GHCR publish —
  it misses digest pinning, the Dependabot ecosystem and the in-image HEALTHCHECK itself.

### RR-DO-07 — HTTP mode is single-replica by design but does not say so (severity: medium · verified)

- **Evidence:** plan tokens live in process memory (`src/mcp/plan-token.ts:43-58`, the
  stateless-wire store is `scope: "process"`); legacy sessions and the SSE replay ring are
  in-memory (`http-sessions.ts:267`, CHANGELOG N-79 "in-memory ring"); the write journal is a
  local JSONL file (`settings.ts:655`). `grep -i "sticky|replica|horizontal"` over README/docs
  finds only the OAuth link note (README:454).
- **Why it matters:** an operator who puts two replicas behind a round-robin load balancer gets
  `plan_token` misses on apply (preview on pod A, apply on pod B), lost sessions and two
  divergent journals — revert then sees half the history. These fail as "invalid token", which
  looks like a bug, not a topology error.
- **Recommendation:** a "Deployment topology" section in the README/docs: one replica per
  credential set, or sticky routing on `Mcp-Session-Id` _and_ the bearer principal; journal on a
  persistent volume per replica; what is lost on restart (plan tokens, sessions, replay ring).
  Optionally expose `instance_id` in `/readyz` and plan-token errors so a mismatch is
  diagnosable.
- **Existing roadmap link:** none — new.

### RR-DO-08 — Distribution notes are stale: Open VSX is live, but corpus says it is missing (severity: medium · verified)

- **Evidence:** `curl https://open-vsx.org/api/ivanbbaev/servicenow-mcp-ai/3.0.0` →
  published 2026-10-22T14:08Z by `IvanBBaev`, verified, 248 downloads; `gh secret list` →
  `OVSX_PAT 2026-10-22`. Yet `project/TODO.md:320` ("Add `OVSX_PAT` … or state that Open VSX is
  out"), V3.5 F5-54 and the assistant memory say it is missing. The only automated attempt, run
  39819936652, failed: `Extension … 3.0.0 is already published, but currently isn't active`
  — `--skip-duplicate` does not cover the inactive state.
- **Why it matters:** the last run of `publish-vscode.yml` is red, and planning decisions are
  being made on a false channel gap.
- **Recommendation:** mark F5-54's Open VSX half and the TODO bullet done; note in CONTRIBUTING
  that a manually uploaded version blocks the workflow for that version; the next GA tag proves
  the automated path.
- **Existing roadmap link:** D-6 / F5-54 — they miss that the gap is closed and the red run.

### RR-DO-09 — Release cadence: a security floor and 27 commits unreleased for 10 days; `next` points backwards (severity: medium · verified)

- **Evidence:** `git log v3.0.0..HEAD | wc -l` → 27; CHANGELOG `[Unreleased] → Security`: zod
  floor `^4.6.6` for GHSA-mrhx-c7xc-m3w5 (high); published 3.0.0 still declares `zod ^4.6.5`
  (`npm view …@3.0.0 dependencies`). `npm view dist-tags` → `latest 3.0.0`, `next 3.0.0-beta.2`.
- **Why it matters:** caret ranges let fresh installs float to the fixed zod, but anyone with an
  existing lock or `npx` cache stays vulnerable, and the advisory is invisible to users until a
  release. `npx servicenow-mcp-ai@next` today installs an _older_ beta than `latest`.
- **Recommendation:** a written policy: a high advisory in a prod dep ships as a patch within
  7 days (3.0.1 now); `npm dist-tag add servicenow-mcp-ai@3.0.0 next` after every GA (make it a
  step in `publish.yml` for GA tags).
- **Existing roadmap link:** none — new.

### RR-DO-10 — The published package floats to untested SDK versions (no shrinkwrap) (severity: medium · judgement)

- **Evidence:** published 3.0.0 depends on `@modelcontextprotocol/server ^2.3.1`,
  `@modelcontextprotocol/node ^2.1.1` (`npm view …@3.0.0 dependencies`); `npm outdated` shows
  `server` 2.4.0 latest — which is what a user's `npx servicenow-mcp-ai` resolves today, while CI
  for 2.4.0 (PR #30) is red. Unreleased N-81 pins exact SDK versions in `package.json`, which
  fixes direct deps but not transitive (`hono`, `@hono/node-server`, `zod` in the SDK).
- **Why it matters:** this is a CLI/server delivered by `npx`, not a library; users run a
  dependency graph the project never tested. The SDK is pre-1.0-style fast moving and reaches
  into private members (`test/sdk-internals.test.js`).
- **Recommendation:** ship `npm-shrinkwrap.json` (generated from the lockfile with
  `--omit=dev` in `publish.yml`) so `npx` installs the tested tree; `pack-check` must allow the
  file. Owner decision because it changes how fast transitive security fixes reach users
  (offset by RR-DO-09's patch policy).
- **Existing roadmap link:** none — new (N-81 pins direct SDK deps only).

### RR-DO-11 — No OpenSSF Scorecard, no workflow security linter (severity: low · verified)

- **Evidence:** no `scorecard` / `zizmor` / `harden-runner` in `.github/workflows/`
  (`ls`, grep over roadmap/TODO/V3.5: 0 hits for "Scorecard").
- **Why it matters:** Scorecard would have flagged RR-DO-01/02/04/05 automatically and gives
  enterprise evaluators a public score; actionlint checks syntax, not template injection or
  `workflow_run` trust issues.
- **Recommendation:** `ossf/scorecard-action` weekly with SARIF to code scanning plus the
  badge; `zizmor` as a step next to actionlint.
- **Existing roadmap link:** none — new.

### RR-DO-12 — Publish workflows lack concurrency guards; `publish-mcp` registers `main`, not the tag (severity: low · verified)

- **Evidence:** no `concurrency:` in `publish.yml`, `publish-vscode.yml`, `publish-mcp.yml` (three
  tags were pushed within 47 minutes on 2026-10-19). `publish-mcp.yml:36` checks out without a
  `ref`; on `workflow_run` that is the default-branch HEAD, so `server.json` comes from `main`,
  not from the tagged commit; a later `workflow_dispatch` registers whatever `main` says.
- **Why it matters:** overlapping publishes can race on the GitHub Release and the registry
  entry; a registry entry built from a commit other than the release breaks provenance.
- **Recommendation:** `concurrency: { group: release, cancel-in-progress: false }` on all three;
  `ref: ${{ github.event.workflow_run.head_sha }}` in `publish-mcp.yml` and refuse when
  `server.json` version ≠ tag.
- **Existing roadmap link:** N-86 (`timeout-minutes` only) — misses concurrency and the ref.

### RR-DO-13 — Release notes are a 120 KB truncated wall (severity: low · verified)

- **Evidence:** the 3.0.0 CHANGELOG section is 267,081 B (`awk … | wc -c`);
  `node scripts/release-notes.mjs 3.0.0 | wc -c` → 120,007, i.e. cut by `fitReleaseNotes`.
  Individual bullets run to several hundred words (CHANGELOG Unreleased).
- **Why it matters:** the GitHub Release is what Dependabot/Renovate show downstream users; a
  truncated wall of implementation detail hides the breaking and security lines.
- **Recommendation:** a generated "Highlights" head (Breaking / Security / top 10 Added, one
  line each, from the CHANGELOG headings) and link the full section; keep CHANGELOG as is.
- **Existing roadmap link:** none — new.

### RR-DO-14 — Release bus factor = 1 (severity: low · judgement)

- **Evidence:** `npm owner ls` → `ivanbaev` only; `VSCE_PAT` (Azure DevOps PAT, max 1 year,
  set 2026-06-27), `OVSX_PAT`, `NPM_TOKEN` are personal; CODEOWNERS is one user; the release
  runbook (CONTRIBUTING:240-300) has no "credentials and their expiry" section.
- **Why it matters:** an enterprise adopter asks "who ships the fix if you are away?". The
  answer today is nobody, and the PATs expire silently.
- **Recommendation:** trusted publishing (RR-DO-01) removes one secret; a credential register
  in CONTRIBUTING (secret, owner, created, expires, rotation steps) and a scheduled workflow
  that warns 14 days before `VSCE_PAT` expiry (the Marketplace API returns 401 on a dry
  `vsce verify-pat`); a documented emergency path (second npm owner or a sealed recovery doc).
- **Existing roadmap link:** none — new.

## 5. Proposed roadmap items

| Temp id | Title                                                                  | Findings              | Priority | Effort | tools/list | Breaking | Owner decision           |
| ------- | ---------------------------------------------------------------------- | --------------------- | -------- | ------ | ---------- | -------- | ------------------------ |
| DO-I1   | npm trusted publishing + repo guard rails (rulesets, env, scanning)    | 01, 02, 14            | P0       | S      | 0 B        | no       | yes (repo settings, npm) |
| DO-I2   | Ordered, serialized publish chain (extension after npm, tag ref)       | 03, 12, 09 (dist-tag) | P0       | S      | 0 B        | no       | no                       |
| DO-I3   | Unblock dependency updates (derived SDK strings, groups, merge #26–30) | 04, 05                | P1       | M      | 0 B        | no       | no                       |
| DO-I4   | Container hardening (digest pins, docker Dependabot, `/healthz` check) | 06                    | P1       | S      | 0 B        | no       | no (folds into N-86)     |
| DO-I5   | Deployment topology docs for HTTP mode                                 | 07                    | P1       | S      | 0 B        | no       | no                       |
| DO-I6   | Release policy: security patch SLA, 3.0.1 now, shrinkwrap decision     | 09, 10                | P1       | S      | 0 B        | no       | yes (shrinkwrap)         |
| DO-I7   | Scorecard + zizmor                                                     | 11                    | P2       | S      | 0 B        | no       | no                       |
| DO-I8   | Release-notes highlights + corpus truth for Open VSX                   | 08, 13                | P2       | S      | 0 B        | no       | no                       |

### DO-I1 — npm trusted publishing and repository guard rails

- **Scope:** `publish.yml` (npm ≥ 11.5.1 step, remove `NODE_AUTH_TOKEN`, add
  `environment: release`); same environment on `publish-vscode.yml` / `publish-mcp.yml`;
  CONTRIBUTING Releasing (credential register with expiry dates); owner actions: npm trusted
  publisher config, package "disallow tokens", delete `NPM_TOKEN`; enable secret scanning, push
  protection, Dependabot security updates; rulesets for `main` (no force-push/delete, CI
  required, owner bypass) and `v*` tags (create by owner only, no update/delete).
- **Acceptance:** `test/distribution.test.js` asserts no `NPM_TOKEN` / `NODE_AUTH_TOKEN` in
  `publish.yml` and an `environment:` on each publish job; `gh api …/rulesets` lists both
  rulesets; `security_and_analysis.secret_scanning_push_protection.status == enabled`; the next
  release shows provenance on npm without a token.
- **Dependencies:** owner (npmjs.com + GitHub settings); must land before 2026-11-18.

### DO-I2 — Ordered, serialized publish chain

- **Scope:** `publish-vscode.yml` → `workflow_run` on `Publish` (success, non-prerelease) +
  `workflow_dispatch`, checkout `head_sha`; `publish-mcp.yml` checkout `head_sha` and refuse a
  `server.json`/tag version mismatch; `concurrency: release` on all three; a GA-only step
  `npm dist-tag add servicenow-mcp-ai@$V next`.
- **Acceptance:** distribution tests assert the `workflow_run` trigger, the `ref`, the
  concurrency group and the dist-tag step; on the next GA tag the extension run starts after the
  npm run ends.
- **Dependencies:** none; combine with N-86's `timeout-minutes` work.

### DO-I3 — Unblock dependency updates

- **Scope:** derive the landing-page SDK badge from `package.json` at `docs:sync` time so
  `test/distribution.test.js:353` passes on a pure lockfile bump (or a Dependabot-only workflow
  that regenerates and pushes); `dependabot.yml`: group `@modelcontextprotocol/*`, group
  `github-actions`, add `docker`; close #10 and #18; merge #26–#30; tracked audit allow-list for
  accepted moderates with reason and expiry.
- **Acceptance:** a Dependabot SDK minor PR goes green without a human commit; `npm audit
--omit=dev` shows 0 moderate+ or each is in the allow-list; no Dependabot PR older than 14 days.
- **Dependencies:** none.

### DO-I4 — Container hardening

- **Scope:** `Dockerfile` digest-pinned `FROM`s, HEALTHCHECK on `/healthz` with `res.ok`, fixed
  comment; `dependabot.yml` docker ecosystem; `test/container.test.js` asserts `@sha256:` and the
  `/healthz` probe.
- **Acceptance:** `docker build` reproducible from digests; `docker inspect` health turns
  unhealthy when the server drains. Fold into N-86's smoke job.
- **Dependencies:** N-86 (CI docker build) for the end-to-end proof.

### DO-I5 — Deployment topology docs for HTTP mode

- **Scope:** README / `docs/` section: supported topologies (single replica; sticky on
  `Mcp-Session-Id` + principal), state lost on restart, journal volume per replica, probes,
  metrics, OTel env; optionally a replica id in `/readyz`.
- **Acceptance:** a docs test pins the section; the Dockerfile header links it.
- **Dependencies:** none.

### DO-I6 — Release policy

- **Scope:** CONTRIBUTING: high/critical prod advisory → patch release within 7 days; cut 3.0.1
  (or 3.1.0) now; owner decides on `npm-shrinkwrap.json`; if yes, generate it in `publish.yml`
  and allow it in `pack-check` (owner edits `pack-check.mjs`).
- **Acceptance:** policy text exists; a release containing the zod floor is on `latest`.
- **Dependencies:** DO-I1 (credentials) for the release itself.

### DO-I7 — Scorecard and zizmor

- **Scope:** `.github/workflows/scorecard.yml` (weekly, SARIF, `publish_results: true`), a
  zizmor step in the actionlint job, README badge.
- **Acceptance:** Scorecard ≥ 7.5 after DO-I1–I3; zizmor 0 high findings.
- **Dependencies:** DO-I1, DO-I3 for a good score.

### DO-I8 — Release-notes highlights and corpus truth

- **Scope:** `scripts/release-notes.mjs` prepends a highlights block; mark F5-54's Open VSX
  part and `TODO.md:320` done; note the "inactive version" Open VSX failure in CONTRIBUTING.
- **Acceptance:** release notes ≤ 20 KB with Breaking/Security on top; no "OVSX_PAT missing" text
  in `project/`.
- **Dependencies:** none.

## 6. Owner decisions needed

1. **Move npm publishing to trusted publishing and delete `NPM_TOKEN`?** Options: (a) OIDC
   trusted publishing now; (b) rotate a new 90-day token and keep the secret. Recommendation:
   (a), before 2026-11-18.
2. **Repository rulesets and a `release` environment with you as required reviewer?** Options:
   (a) rulesets + environment with approval; (b) rulesets only; (c) nothing. Recommendation: (a)
   — one click per release, and agents cannot ship by pushing a tag.
3. **Ship an `npm-shrinkwrap.json`?** Options: (a) yes, tested tree for `npx` users, paired with
   a 7-day security patch SLA; (b) no, keep floating ranges. Recommendation: (a), because the
   SDK moves fast and the project reaches its private members.
4. **Cut 3.0.1 / 3.1.0 now** to ship the zod security floor and the Docker build fix?
   Recommendation: yes, after DO-I1 and DO-I2.
5. **Second npm owner / emergency release path?** Options: trusted collaborator, sealed recovery
   doc, or accept bus factor 1 and say so in SUPPORT.md. Recommendation: at least document it.

## 7. Metrics this role would track

| KPI                                                        | Current (2026-10-29)                              | Target       |
| ---------------------------------------------------------- | ------------------------------------------------- | ------------ |
| Long-lived publish secrets in the repo                     | 3 (`NPM_TOKEN`, `VSCE_PAT`, `OVSX_PAT`)           | ≤ 2, dated   |
| Oldest open Dependabot PR / count                          | 118 days (#10, 2026-07-03) / 10                   | ≤ 14 d / ≤ 3 |
| Days from a high prod advisory fix on main to npm `latest` | 10+ and counting (zod floor)                      | ≤ 7          |
| Main CI wall time (p50 of last 5 pushes)                   | ~3m30s (3m18s–7m54s)                              | ≤ 5 min      |
| Release success on first attempt (per tag)                 | 2 of 3 in 3.0.0 cycle (beta.1 release job failed) | 100 %        |
| OpenSSF Scorecard                                          | not measured                                      | ≥ 7.5        |

Sources:
[npm token changes 2025-11-05](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/),
[npm classic tokens revoked 2025-12-09](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/),
[Node 20 removed from Actions 2026-09-23](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions).
