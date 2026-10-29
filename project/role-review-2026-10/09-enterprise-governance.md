# Role review — Enterprise IT Governance, Risk & Compliance lead (2026-10-29)

Reviewer role: a CISO delegate who sits on the architecture board with the ServiceNow platform
owner and the ITSM process owner of a regulated enterprise (bank, pharma, public sector). The
question on the table is "may our developers and admins point this AI MCP server at our
dev/test/prod instances?". This persona cares about five things. Every change must be
attributable to a named human. Change control (CAB, update-set promotion) must not be
bypassable. Least privilege has to be documented. Personal data must not leave the boundary
unrecorded. Controls must be centrally enforceable, so that a developer cannot switch them off.
The persona also owns the legal side: licence, trademark, vendor subscription terms and the
vendor-risk questionnaire. "Good" means the security team can write a one-page approved
configuration, lock it, and prove after the fact who changed what and when.

Baseline: main @ dc29e9c · servicenow-mcp-ai 3.0.0 · scope: SECURITY.md, SUPPORT.md, LICENSE,
README.md (security, trademark, env sections), `src/core/{policy,settings,settings-data-*,
settings-manifest,write-journal,identity,delegation,redaction}.ts`, `src/mcp/{packages,
package-policy,file-result}.ts`, `src/tools/{admin,cicd}.ts`, `src/api/cicd.ts`, package-lock
licence fields, the local `docs/instance/` store, and the project corpus (roadmap.yaml, TODO.md,
V3.5-ANALYSIS-2026-10.md), which I grepped before writing each finding.

## 1. Verdict

The engineering controls are well above the community-MCP median. Writes default to plan mode,
destructive applies need a single-use token, system tables are write-protected, the host and
SSRF guards hold, secret columns are masked type-based, and SECURITY.md is unusually honest and
complete. On governance the design is still **single-user**. Every control comes from an env
file that the person it is meant to restrain can edit. The audit trail is a local, best-effort,
world-readable file that names no human on stdio. Exports full of instance data pile up in the
developer's working directory with no retention. A regulated enterprise would approve it today
for **personal developer instances and sandboxes only**, not for shared test or prod.

**Score: 5/10.** The safety rails are strong. Central enforceability, attribution and data
lifecycle, which this role is graded on, are missing.

Top 3 risks: (1) no admin-lockable policy layer, and "prod" is self-declared (RR-GV-01);
(2) writes are attributed only to the shared service account, and the local journal is
fail-open and forgeable (RR-GV-02, -03); (3) PII leaves the instance into LLM context with
redaction off, no read-access record, and unbounded on-disk exports (RR-GV-04, -05).

Top 3 strengths: plan → `plan_token` → apply with prod confirmation; a write-protected
system-table list plus a two-axis policy; a mature SECURITY.md (disclosure, response targets,
OWASP MCP mapping, supply-chain section).

## 2. What I examined

- `SECURITY.md` (all sections), `SUPPORT.md`, `LICENSE`, `extension/LICENSE`,
  `README.md:1869-1958` (security notes, trademark, licence history).
- `src/core/policy.ts`, `src/core/settings.ts:150-240`, `src/core/settings-data-runtime.ts`
  (`SN_ENV`, `SN_PROD_WRITES`, `SN_REDACT_*`, `SN_JOURNAL_MAX_BYTES`, `SN_DOCS_DIR`).
- `src/core/write-journal.ts` (entry schema, append path, rotation), `src/core/identity.ts`,
  `src/core/delegation.ts`, `src/core/redaction.ts`.
- `src/mcp/packages.ts:220-235`, `src/tools/admin.ts:829-842` (`servicenow_enable_package`),
  `src/api/cicd.ts:140-170` (commit guard).
- `ls -la docs/instance/default{,/exports}` → 148 export files, 80 MB, all `-rw-r--r--`.
- `node -e` over `package-lock.json` and `extension/package-lock.json` → licence counts.
- `git shortlog -sne HEAD` → 1 author (702 commits); `git tag -v v3.0.0` → lightweight, unsigned.
- Corpus greps: retention, SBOM, HMAC, managed, lock, GPL, trademark, DPA, GDPR, SIEM, change.
- Web search (2026-10-29) on ServiceNow integration-user licensing (sources under RR-GV-11).

## 3. Strengths (keep doing)

1. **Write safety by default.** Plan mode, single-use `plan_token` for destructive applies, and
   prod profiles that stay in plan mode unless `SN_PROD_WRITES=I_UNDERSTAND`, with elicitation
   always required for prod destructive applies (`src/core/settings.ts:189-240`). This is the
   control a CAB delegate asks about first, and it is real.
2. **Protected system tables.** Identity, roles, ACLs, `sys_properties`, OAuth, scripts and
   certificates are write-refused by default (`src/core/policy.ts:72`, SECURITY.md "Hardened
   defaults"). This blocks the classic privilege-escalation path of an AI agent.
3. **Type-based secret masking that cannot be turned off** (N-21, SECURITY.md). Credentials
   stored on the instance do not reach the model.
4. **Disclosure and supply-chain hygiene.** A private advisory channel, written response
   targets, SHA-pinned actions, least-privilege workflow permissions, npm `--provenance`, a
   tarball allow-list, and the production `npm audit` in the gate (SECURITY.md:23-63, 338-363).
5. **Identifying User-Agent on every request** (`src/core/identity.ts`), which carries the
   server version, transport and MCP client name. The instance's network/WAF logs can therefore
   tell AI traffic apart.
6. **HTTP + OAuth phase 2 (per-user ServiceNow tokens)** (`src/core/delegation.ts`, SECURITY.md
   "Per-user ServiceNow tokens"). This is the correct end state for attribution, already built.
7. **Dependency licences are clean.** The production tree is Apache-2.0 (`@modelcontextprotocol/
{server,node,core}`) plus MIT (`zod`, `acorn`, `hono`, `@hono/node-server`). All are
   GPL-3.0-compatible, with no copyleft surprises.

## 4. Findings

### RR-GV-01 — No centrally enforceable policy; every guard is user-editable and "prod" is self-declared (severity: high · verified)

- **Evidence:** Every policy key is read from the process environment or the user's own env
  file: `SN_READONLY` (`src/core/policy.ts:58-60`), `SN_TABLES_*`, `SN_PACKAGES_*`,
  `SN_PROTECTED_TABLES_WRITE=allow`, `SN_DESTRUCTIVE_CONFIRM=off`, `SN_WRITE_MODE=apply`.
  `grep -rn -i "policy_file\|managed-settings\|/etc/\|ProgramData" src` returns nothing, so no
  machine-wide or managed layer exists. Prod status is an operator-set label, `SN_ENV` /
  `SN_PROFILE_<NAME>_ENV` (`src/core/settings-data-runtime.ts:168-175`). An unlabelled prod
  profile gets none of the H-11 protection. `servicenow_enable_package` (`src/tools/admin.ts:829`)
  lets the model load any package that is not in `SN_PACKAGES_DENY` (`src/mcp/packages.ts:230`),
  so the `discovery` default is a usability profile, not a boundary.
- **Why it matters:** The security team cannot publish an "approved configuration" that a
  developer, or a prompt-injected agent writing the env file through `persist: true`, cannot
  quietly loosen. An auditor will ask: "show me the control the user cannot disable." Today
  there is none short of instance ACLs on the service account.
- **Recommendation:** Add a managed policy file at an admin-owned path
  (`/etc/servicenow-mcp-ai/policy.json`, `%ProgramData%\servicenow-mcp-ai\policy.json`, or
  `SN_MANAGED_POLICY_FILE` for containers). Its keys are floors the user can only tighten
  (readonly, deny lists, `PROTECTED_TABLES_WRITE=deny`, `DESTRUCTIVE_CONFIRM≥token`,
  `REDACT_PII=true`, allowed hosts, max tool packages). It also needs an
  instance-host → environment map, so that "prod" is decided by the admin per host, not per
  user profile. `get_status` and `doctor` must report "managed: yes, source X". A
  user override of a locked key is refused at startup with a clear message. VS Code's
  machine-scope settings and Claude Code's `managed-settings.json` are the precedent.
- **Existing roadmap link:** none — new. (H-11 delivered the per-profile prod label. What is
  missing is the admin-owned layer and host-based classification.)

### RR-GV-02 — Instance-side attribution is the shared service account; the stdio journal names no human (severity: high · verified)

- **Evidence:** `JournalEntry` records `client` (the MCP session id, HTTP only) and `subject`
  (OAuth, HTTP only) (`src/core/write-journal.ts:102-105, 439-454`). On stdio, the default and
  most common deployment, a journal line carries no OS user, hostname or MCP client name. On the
  instance, `sys_audit` / `sys_updated_by` show the configured account. Per-user tokens exist
  only behind `SN_TRANSPORT=http` + `SN_HTTP_OAUTH_USER_TOKENS` (`src/core/delegation.ts`).
  Nothing is stamped on the record itself: no work note and no audit reason
  (`grep -rn -i "work_notes.*mcp\|SN_WRITE_STAMP" src` returns nothing).
- **Why it matters:** SOX / GxP / ISO 27001 A.8.15 require that a change to a production record
  be attributable to a person. "`svc_mcp` updated INC0012345" plus a JSON file on some laptop
  fails that test. The OAuth Authorization Code path with a personal account (README "OAuth 2.1
  … recommended") solves it on stdio too, but the docs do not present it as _the_ governance
  requirement.
- **Recommendation:** (a) On stdio, stamp `os_user` (`os.userInfo().username`), `host`
  (hostname) and the `clientInfo` name/version on every journal line. (b) Add an opt-in
  `SN_WRITE_ATTRIBUTION` that appends a configurable, redacted work-note/comment, or sets a
  customer-chosen field (`u_ai_actor`), on journalled task-table writes. This makes the AI
  origin visible in the record's activity stream. (c) In the deployment guide (RR-GV-14), state
  that test/prod must use per-person OAuth (Authorization Code + PKCE on stdio, or HTTP phase 2)
  and never a shared basic-auth account. Doctor should warn on `basic` auth plus `SN_ENV=prod`.
- **Existing roadmap link:** none — new (N-17 phases 1-2 are done. What is missing is stdio
  attribution and on-record marking).

### RR-GV-03 — The write journal is fail-open, locally forgeable and has no central sink (severity: high · verified)

- **Evidence:** `appendWriteJournal` "never throws — journalling must not turn a successful
  write into a tool error". A file-system failure is only logged
  (`src/core/write-journal.ts:36-43, 455-472`). The chain is a plain SHA-256 of the previous
  line, with the head stored next to it in `write-journal.head` (lines 200-212, 465). Anyone
  who can edit the file can recompute the chain, so it detects only accidental truncation. The
  files are written with no explicit mode: on disk `write-journal.jsonl` is `-rw-r--r--`. By
  contrast `src/core/log-file.ts:153` uses `0o600`. Journal lines can reach a SIEM only by
  scraping the file, because they are not emitted as log or OTel events.
- **Why it matters:** SECURITY.md maps OWASP MCP08 ("Lack of Audit") to this journal. An auditor
  will not accept a record that the audited party can rewrite, that silently stops when the
  disk is full, and that never leaves the laptop. As built, it is a convenience undo log, not an
  audit trail.
- **Recommendation:** (1) `SN_JOURNAL_REQUIRED=true` (managed-lockable): pre-write the intent
  line and refuse the apply if it cannot be written (fail-closed). (2) Optional HMAC chain keyed
  by `SN_JOURNAL_KEY[_FILE]`, which a user without the key cannot forge. (3) Write files and
  directories with `0600` / `0700`. (4) Emit every journal entry as a structured `audit` log
  event (stderr / `SN_LOG_FILE` / OTel log) with a stable schema, so Splunk, Sentinel or
  Elastic can ingest it centrally. Document the schema.
- **Existing roadmap link:** none — new (H-5 built the chain. TODO.md:722 notes that "the HMAC
  the roadmap sketched" was not used for plan tokens; nothing covers the journal).

### RR-GV-04 — Exports and journal default into the working directory, world-readable, with no retention (severity: high · verified)

- **Evidence:** `SN_DOCS_DIR` defaults to `path.resolve(process.cwd(), "docs/instance")`
  (`src/core/settings.ts:153-158`). `SN_OVERSIZE_TO_FILE` defaults to `true`
  (`settings-data-runtime.ts:266-271`), so large `query_table` results are written to
  `<docs>/<profile>/exports/`. In this repo's own checkout: 148 export files, 80 MB, all
  `-rw-r--r--`, the oldest from 2026-10-09 (`ls -la docs/instance/default/exports`).
  `grep -n "unlink\|rmSync\|retention" src/core/write-journal.ts src/mcp/file-result.ts` returns
  nothing: rotated journal files and exports are never pruned. The only protection against
  committing them is a `.gitignore` line that exists in _this_ repo. The setting description
  merely asks users to add it in theirs (`settings-data-runtime.ts:423`).
- **Why it matters:** A developer who runs the server from a customer project checkout gets full
  incident or user extracts (names, emails, free-text descriptions) dropped into that git
  working tree. From there they reach a commit, a backup, a sync tool or another local user.
  GDPR Art. 5(1)(e) storage limitation and most bank data-handling standards forbid exactly
  this.
- **Recommendation:** Default `SN_DOCS_DIR` to a per-user state directory
  (`~/.local/state/servicenow-mcp-ai` / `%LOCALAPPDATA%`), keep `docs/instance` as an explicit
  opt-in, and add a migration note. Write exports, diagrams and journal with `0600` / `0700`.
  Add `SN_EXPORT_RETENTION_DAYS` (default e.g. 7) and `SN_JOURNAL_RETENTION_DAYS` (default
  unlimited, managed-lockable), with pruning at startup. Refuse a docs dir inside a git work
  tree unless it is ignored (`git check-ignore`). This is BREAKING because of the default path.
- **Existing roadmap link:** TODO.md:505 lists "export retention / size cap under `exports/`" as
  an unresolved owner question from batch 8 (S-11). That item is not on the roadmap; the default
  location and file modes are not covered at all.

### RR-GV-05 — PII flows to the LLM provider with redaction off and no record of what was read (severity: high · verified)

- **Evidence:** `SN_REDACT_PII` defaults to `false` (`settings-data-runtime.ts:322-326`). The
  PII patterns are three regexes: email, phone, and long digit runs
  (`src/core/redaction.ts:24-28`). Names, addresses, IBANs, IPs and free-text health data are
  not covered. `SN_TABLES_DENY` has no default, and `sys_user` appears only in the _write_
  protection list (`policy.ts:73`), so HR, customer and `sys_user` reads are open. The journal
  records writes only, which means no local record shows which records' personal data were sent
  into the model context.
- **Why it matters:** Every read result goes to a third-party LLM processor (Anthropic, OpenAI,
  GitHub Copilot) chosen by the developer, not by the controller. A DPO needs (a) a processor
  and data-residency decision, which is out of the server's hands but must be documented,
  (b) data minimisation by default, and (c) a record of processing (GDPR Art. 30). None of
  these is visible today.
- **Recommendation:** Ship a `regulated` policy preset (managed-lockable) with: `SN_REDACT_PII=
true`, a default read deny of `sn_hr_*`, `sn_customerservice_*`, `sys_user*`, `cmn_location`
  (or allow-list-only mode), `SN_OVERSIZE_TO_FILE=false`, and journal required. Add an opt-in
  `SN_READ_AUDIT=true` that logs `{ts, tool, table, query hash, record count, fields}`, never
  values, as audit events (RR-GV-03). Add a "Data protection" section to the docs: data flow,
  the fact that the server sends nothing anywhere except the instance, and that model-provider
  choice and its DPA and residency are the customer's.
- **Existing roadmap link:** none — new (DF-5 / H-5 / N-21 are done. What is missing is
  defaults, read audit and DPO documentation).

### RR-GV-06 — No link to change control: prod writes and update-set commits do not require an approved change (severity: medium · verified)

- **Evidence:** `assertCommitAllowed` (`src/api/cicd.ts:140-170`) checks only preview
  cleanliness and fingerprint drift. `grep -rln -i "REQUIRE_CHANGE\|change_number\|approved
change" src` returns nothing. A prod profile with `SN_PROD_WRITES=I_UNDERSTAND` can update any
  non-protected table, commit an update set, or order catalog items without any change-request
  reference.
- **Why it matters:** ITIL change enablement and SOX ITGC "change management" controls require
  every prod change to trace to an authorised RFC. Platform owners will read "AI can commit
  update sets to prod" as a CAB bypass, even with plan tokens.
- **Recommendation:** Add `SN_REQUIRE_CHANGE` (per profile, managed-lockable; default on for
  `prod` once managed). Prod applies and `commit_update_set` would then need a `change` argument
  that resolves to a `change_request` in an implement-ready state (state/approval configurable)
  and is open for the current window. Record the number in the journal line and, with
  RR-GV-02(b), in the work note. This costs `tools/list` bytes (one optional arg on the
  destructive tools), which O-10 must decide.
- **Existing roadmap link:** none — new.

### RR-GV-07 — No least-privilege role matrix per package (severity: medium · verified)

- **Evidence:** README and `docs/tools/*.md` contain no "required roles" guidance:
  `grep -n -i "required role\|roles needed\|rest_service\|web service access only"` returns
  only generic lines (README:149, 1899). The table allow/deny is documented, but not the
  instance roles a service account needs for `cmdb`, `cicd`, `access`, `ops`, `history`,
  `atf`, and so on.
- **Why it matters:** The platform owner must provision a dedicated integration user with the
  smallest role set. Without a matrix, the default answer becomes `admin`. That defeats every
  instance-side control and makes RR-GV-02 worse.
- **Recommendation:** Add a generated table (from the tool manifest plus a curated
  `requiredRoles` per package) in `docs/tools/README.md` and the deployment guide: package →
  read roles → write roles → elevation needed. Add a `doctor --roles` check that compares the
  account's roles (the existing `roles` capability probe) with the enabled packages and warns
  on `admin` / `security_admin`. Table and role names are unverified until O-5 (PDI).
- **Existing roadmap link:** none — new (the EL-1 / EL-2 capability probe is the building
  block).

### RR-GV-08 — Vendor-risk documents drift from the shipped artefact (severity: medium · verified)

- **Evidence:** SECURITY.md:346-351 says the runtime set is "deliberately three packages —
  `@modelcontextprotocol/sdk`, `zod` and `acorn` … (`^1.31.0`)". `package.json` actually ships
  four: `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/node` 2.1.1, `acorn`, `zod`.
  Transitive production dependencies include `hono` and `@hono/node-server`, plus the optional
  peer `@opentelemetry/api`. `docs/index.md:1137` still says "~200 tests" (actual ≈ 2,768).
  84 `package-lock.json` entries have no `license` field, so a lock-derived licence report or
  SBOM is incomplete. Git tags are lightweight and unsigned (`git tag -v v3.0.0` → "cannot verify
  a non-tag object").
- **Why it matters:** A vendor-risk analyst cross-checks SECURITY.md against the SBOM and
  `npm ls`. A stale dependency claim in the security policy undermines every other claim in it.
- **Recommendation:** Generate the SECURITY.md dependency paragraph from `package.json` in
  `docs:sync` (CI fails on drift), and fix the docs-site test count the same way. Sign release
  tags (`git tag -s` or gitsign), or state in SECURITY.md that npm provenance is the integrity
  anchor. Regenerate the lock with licence metadata when N-86 adds the SBOM.
- **Existing roadmap link:** N-86 (F5-35, O-24) covers the CycloneDX SBOM and build attestation.
  It is missing: the SECURITY.md drift check, tag signing, and lock licence completeness.

### RR-GV-09 — GPL-3.0 adoption friction is undocumented; no DCO/CLA (severity: medium · judgement)

- **Evidence:** `package.json` / `extension/package.json` licence `GPL-3.0-or-later`; README:1956
  says versions ≤ 3.0.0-beta.1 were MIT. `git shortlog` shows a single author, so the relicence
  was clean. CONTRIBUTING.md has no DCO / CLA (`grep -n "DCO\|Signed-off\|CLA"` returns
  nothing). V3.5 F5-21 notes the Docker MCP Catalog refuses GPL.
- **Why it matters:** Running the server internally (an MCP server spawned locally, or an HTTP
  service inside one legal entity) is not "conveying", so GPL obligations are minimal. Three
  enterprise patterns do convey, though: (a) a golden container image or internal developer
  platform distributed to subsidiaries or contractors, (b) bundling the server into an internal
  VS Code extension pack, (c) forking it with custom tools for a client. Each of these triggers
  source-offer obligations, and many enterprise open-source policies classify GPL as "legal
  review required", which stalls adoption by weeks. Because there is no DCO, the first external
  PR will freeze the licence choice: dual-licensing or adding an exception later would then need
  that contributor's consent. The Apache-2.0 / MIT dependencies are compatible (strength 7).
- **Recommendation:** Add a short "Licensing FAQ for organisations" (internal use = no
  obligations; what conveying means; container and extension redistribution; that tool results
  and instance data are not derivative works). Adopt DCO now (`Signed-off-by`, a GitHub DCO
  check) before outside contributions arrive. The owner should decide on the long-term posture
  (see §6).
- **Existing roadmap link:** O-24 (the container-catalogue licence posture) is container-only.
  The FAQ and DCO are new.

### RR-GV-10 — The trademark exposure is the product's display name, not the notice (severity: medium · judgement)

- **Evidence:** The notice is good (README:1943-1958, SECURITY.md:386-392). But the VS Code
  extension's `displayName` is `"ServiceNow MCP"` (`extension/package.json:3`). That is the
  bare mark plus a generic term, and it is close to ServiceNow's own GA "MCP Server Console"
  (F5-15). The npm and registry name `servicenow-mcp-ai` leads with the mark as well.
- **Why it matters:** Nominative fair use is strongest when the mark identifies compatibility
  ("… for ServiceNow"). It is weakest when the mark _is_ the product name, which is exactly how
  a Marketplace listing reads. A takedown request to the VS Code Marketplace or npm would cut off
  the distribution channel overnight. Enterprises also check this as part of vendor risk ("is
  this an official ServiceNow product?").
- **Recommendation:** Change `displayName` to "MCP Server for ServiceNow (community)" or similar,
  and add "Unofficial; not affiliated with ServiceNow" to the Marketplace short description and
  the `server.json` description. Keep the package name (renaming would be BREAKING; it needs an
  owner decision). Do not use ServiceNow logos or colours in `icon.png`; the owner should verify
  this.
- **Existing roadmap link:** none — new.

### RR-GV-11 — ServiceNow subscription terms for a shared AI-driven account are not addressed (severity: medium · reported + judgement)

- **Evidence:** The docs offer basic auth with one service account per profile (README
  "Supported authentication methods"). Community and vendor sources say that "Web Service Access
  Only" integration accounts usually do not consume a fulfiller licence, but that interactive
  use and role assignment matter, and that ServiceNow's contract is the authority
  ([ServiceNow Community](https://www.servicenow.com/community/developer-forum/adding-itil-role-ro-service-account-will-act-as-license-consumed/m-p/3570920),
  [Flexera integration-user guide](https://docs.flexera.com/ServiceNowFlexeraOneApp/SNapp/v1.6/Content/helplibrary/create-integration-user.htm)).
- **Why it matters (judgement):** Several humans acting through one integration account is the
  pattern licence audits flag as "indirect use" or credential sharing. It also defeats
  per-user attribution (RR-GV-02). Customers need to see the project acknowledge this, or their
  licence manager will block it.
- **Recommendation:** Add a "Licensing and subscription considerations" note to the deployment
  guide. It should say: each human should authenticate as themselves (OAuth), or the customer
  should confirm with their ServiceNow account team that shared integration use is covered.
  Mention REST rate limits / `sys_rate_limit_rules` and the API transaction quotas. Do not give
  legal advice.
- **Existing roadmap link:** none — new.

### RR-GV-12 — No incident-response runbook or runtime kill switch (severity: medium · verified)

- **Evidence:** SECURITY.md and README contain no "incident", "compromise" or "kill" runbook
  (`grep -n -i "incident response\|compromis"` returns nothing). Read-only can be enabled only by
  editing env and restarting (`policy.ts:409` hint: "…and restart the server"). For a fleet of
  developer machines or several HTTP replicas there is no single switch.
- **Why it matters:** The IR team's first question is "how do we stop all AI writes now,
  everywhere?". Today the answers are (a) deactivate or rotate the service account on the
  instance, (b) revoke the OAuth app or tokens, (c) kill processes. These are workable, but
  nowhere written down.
- **Recommendation:** Add an IR runbook to SECURITY.md: revoke the instance account and OAuth
  entity, `DELETE /oauth/servicenow/link`, rotate `SN_HTTP_TOKEN`, review the journal with
  `verify`, and revert from it. Add an instance-side kill switch: at startup and every N minutes
  (cached), read a customer-chosen system property such as `x_mcp.disable_writes` (when
  readable). If it is true, the server goes read-only. That gives the platform owner one central
  lever without touching any laptop. Document `SN_MANAGED_POLICY_FILE` (RR-GV-01) as the local
  equivalent.
- **Existing roadmap link:** none — new.

### RR-GV-13 — Solo-maintainer continuity is stated but not mitigated (severity: low · verified + judgement)

- **Evidence:** SUPPORT.md says "maintained by one person … no commercial support". SECURITY.md
  response targets are "not a contractual SLA". Fix target: critical within 30 days of triage.
  `git shortlog`: one author. npm/Marketplace publishing rights are presumably the owner's only.
- **Why it matters:** A vendor-risk questionnaire scores bus factor = 1 as high risk. The GPL
  source availability mitigates lock-in (an enterprise can fork), but not security fixes.
- **Recommendation:** Add a "Continuity" paragraph covering: what happens if the project goes
  dormant (the archive notice, forks welcome, the licence guarantees the source), the last
  supported version policy, and a backup person with npm/Marketplace publish rights for
  security releases (owner decision). If commercial support is ever offered, state the tier
  here.
- **Existing roadmap link:** none — new (documentation only).

### RR-GV-14 — No enterprise deployment/hardening guide or data-flow diagram (severity: low · verified)

- **Evidence:** The only docs are the 1,958-line README, SECURITY.md and `docs/index.md`.
  `grep -il "deployment guide\|data.flow\|enterprise"` over the corpus returns nothing. The
  hardened settings are spread across ~150 env keys in the README table.
- **Why it matters:** The architecture board approves a document, not a README. Without a
  one-page DFD (client ↔ LLM provider ↔ MCP server ↔ instance ↔ local disk) and a baseline
  config, every customer must reverse-engineer one. This is slow and gives inconsistent results.
- **Recommendation:** Create `docs/enterprise.md` (in the docs site) with a Mermaid DFD and trust
  boundaries. Include a tiered baseline (sandbox / test / prod), a generated
  `.env.enterprise.example`, the role matrix (RR-GV-07), the data-protection section
  (RR-GV-05), the IR runbook (RR-GV-12), licensing notes (RR-GV-09, -11), and a filled-in
  questionnaire appendix (SIG-lite / CAIQ-style answers that point to evidence).
- **Existing roadmap link:** none — new.

## 5. Proposed roadmap items

| Temp id | Title                                                      | Findings  | Priority | Effort | tools/list             | Breaking                      | Owner decision     |
| ------- | ---------------------------------------------------------- | --------- | -------- | ------ | ---------------------- | ----------------------------- | ------------------ |
| GV-I1   | Managed policy file + host-based environment map           | 01, 12    | P0       | L      | 0 (status output only) | no (opt-in)                   | yes (path, floors) |
| GV-I2   | Audit-grade journal: fail-closed, HMAC, 0600, audit events | 03, 02(a) | P0       | M      | 0                      | no                            | no                 |
| GV-I3   | Private state dir, file modes and retention for exports    | 04        | P0       | M      | 0                      | **yes** (SN_DOCS_DIR default) | yes (O-4)          |
| GV-I4   | `regulated` preset + read-access audit                     | 05        | P1       | M      | 0                      | no                            | yes (preset scope) |
| GV-I5   | On-record AI attribution (`SN_WRITE_ATTRIBUTION`)          | 02(b)     | P1       | M      | 0                      | no                            | no                 |
| GV-I6   | Change-request gate for prod applies and commits           | 06        | P1       | M      | +~120 B (optional arg) | no                            | yes (O-10 bytes)   |
| GV-I7   | Enterprise deployment guide (DFD, baseline, roles, IR)     | 07, 11–14 | P1       | M      | 0                      | no                            | no                 |
| GV-I8   | Vendor-risk doc truthfulness (dep drift, tags, DCO)        | 08, 09    | P1       | S      | 0                      | no                            | yes (DCO)          |
| GV-I9   | Trademark-safe display names                               | 10        | P2       | S      | 0                      | no (display only)             | yes                |

### GV-I1 — Managed policy file + host-based environment map

- **Scope:** `src/core/settings.ts` / `settings-manifest.ts`: a new top-precedence source that is
  read from `SN_MANAGED_POLICY_FILE`, else the OS default path (`/etc/servicenow-mcp-ai/
policy.json`, `/Library/Application Support/…`, `%ProgramData%\…`). Each manifest row gets a
  `lockable: floor | exact` property. The file can also hold `environments: { "<host glob>":
"prod" | "test" | "dev" }`, which overrides `SN_ENV`, plus optional `disableWrites` and
  `instanceKillSwitchProperty`. `get_status` / `doctor` / `explain_policy` report each locked
  key and its source. `use_instance persist` and `set_credentials` cannot write locked keys.
- **Acceptance:** a user env with `SN_READONLY=false` under a managed `readonly: true` stays
  read-only, and `doctor` names the managed file. A host matching a managed `prod` glob gets
  H-11 behaviour without `SN_ENV`. Loosening a floor key (`SN_DESTRUCTIVE_CONFIRM=off` over
  `token`) logs a refusal and keeps the floor. A malformed managed file stops startup (fail
  closed). With the kill-switch property readable and `true`, writes are refused with
  `POLICY_KILL_SWITCH` within the cache TTL.
- **Dependencies:** none. ADR needed.

### GV-I2 — Audit-grade journal

- **Scope:** `src/core/write-journal.ts`: `SN_JOURNAL_REQUIRED` (a pre-apply intent line; the
  apply is refused on a write error), `SN_JOURNAL_KEY[_FILE]` HMAC-SHA256 chain (`prev_mac`),
  `0600` files / `0700` dirs, and a new `os_user`, `host`, `client_name` on stdio lines. Every
  appended entry is also emitted as a `logger.info("audit", …)` event with `event.kind=audit`
  (and as an OTel log record when `SN_OTEL`). Document the schema in SECURITY.md.
- **Acceptance:** with the journal dir read-only and `SN_JOURNAL_REQUIRED=true`, an update
  apply returns an error and no HTTP write is sent. With a key, a line edited and re-chained
  with plain SHA-256 fails `verify`. File modes are tested on POSIX. A stdio journal line
  contains `os_user` and `client_name`. The audit events validate against a JSON schema in
  `test/`.
- **Dependencies:** none. Coordinate with the `journal list | show` CLI (F5-49).

### GV-I3 — Private state dir, file modes and retention

- **Scope:** `src/core/settings.ts:153-158`: default `SN_DOCS_DIR` → the per-user state dir,
  while an existing `docs/instance` in cwd is still read, with a deprecation warning, for one
  minor. `SN_EXPORT_RETENTION_DAYS` (default 7), `SN_JOURNAL_RETENTION_DAYS` (default unset),
  startup pruning, `0600` / `0700` for everything under the docs store. A warning, or a refusal
  with `SN_DOCS_IN_GIT=deny`, when the dir is inside a git work tree and not ignored.
- **Acceptance:** a fresh start with no `SN_DOCS_DIR` writes exports under the state dir with
  mode 0600. An export older than the retention is deleted at startup and the deletion is
  journalled as `local_write`. A docs dir inside an un-ignored git tree logs the warning.
  Migration is covered in `migrate` and CHANGELOG.
- **Dependencies:** O-4 (BREAKING register entry), and it resolves the TODO.md:505 question.

### GV-I4 — `regulated` preset + read-access audit

- **Scope:** a policy preset (`SN_POLICY_PRESET=regulated`, also usable from the managed file)
  that sets PII redaction on, a default read deny list, oversize-to-file off, journal required,
  and attribution on. `SN_READ_AUDIT=true` emits `{tool, table, query_sha256, count, fields}`
  audit events for reads. Extend the PII patterns with IBAN and IPv4/IPv6.
- **Acceptance:** under the preset a `query_table` on `sys_user` is refused with a policy hint,
  and an email in `short_description` is masked. With read audit on, each read emits exactly one
  audit event containing no field values. The IBAN and IP patterns are tested with fast-check.
- **Dependencies:** GV-I2 (audit event channel). Table names stay unverified until O-5.

### GV-I5 — On-record AI attribution

- **Scope:** `SN_WRITE_ATTRIBUTION=off|work_note|field:<name>`. On journalled create/update of
  `task`-derived tables, append a templated note ("Changed via servicenow-mcp-ai by
  {os_user|subject} — journal {id}") or set the named field. Values pass through redaction.
- **Acceptance:** with `work_note`, an `update_record` on `incident` sends `work_notes` with the
  journal id, and the plan preview shows it. A non-task table is unchanged. Turning the option
  off leaves the payload byte-identical to today.
- **Dependencies:** GV-I2 (`os_user`).

### GV-I6 — Change-request gate

- **Scope:** `SN_REQUIRE_CHANGE` (per profile, lockable), an optional `change` argument on the
  destructive / write tools when the gate is on, and validation against `change_request` (number,
  state ∈ `SN_CHANGE_ALLOWED_STATES`, planned window). The number is recorded in the journal.
- **Acceptance:** on a gated prod profile an apply without `change` returns `CHANGE_REQUIRED` and
  sends no write. An apply with a closed or unapproved change is refused. A valid one succeeds,
  and the journal line carries `change`. The `tools/list` delta is measured and stated.
- **Dependencies:** O-10 (bytes), O-5 (the `change_request` state model on the PDI).

### GV-I7 — Enterprise deployment guide

- **Scope:** `docs/enterprise.md` plus a site page: DFD with trust boundaries, sandbox / test /
  prod baselines, a generated `.env.enterprise.example`, a role matrix generated from a curated
  per-package `requiredRoles` in the manifest, a `doctor --roles` warning on admin, the
  data-protection section, the IR runbook, licensing and subscription notes, a continuity
  statement, and a questionnaire appendix.
- **Acceptance:** `docs:sync --check` fails when a package lacks `requiredRoles`. `doctor
--roles` flags `admin` on the account. The guide is linked from README, SECURITY.md and
  SUPPORT.md, and `test/scan-surface` checks that every cited file exists.
- **Dependencies:** GV-I1…I4 for the final baseline text (it can ship first with current keys).

### GV-I8 — Vendor-risk doc truthfulness

- **Scope:** generate the SECURITY.md runtime-dependency paragraph and the docs-site test count
  in `docs:sync`. Sign release tags (or document provenance as the anchor). Add DCO
  (`CONTRIBUTING.md` + a DCO check workflow). Add the licensing FAQ for organisations.
- **Acceptance:** changing a dependency in `package.json` without re-syncing fails `docs:sync
--check`. A PR without `Signed-off-by` fails the DCO check. `git tag -v` verifies the next
  release tag, or SECURITY.md states why it does not.
- **Dependencies:** N-86 (SBOM); owner decision on DCO.

### GV-I9 — Trademark-safe display names

- **Scope:** `extension/package.json` `displayName`/`description`, `server.json` description,
  the Marketplace/registry short text, and a check that `icon.png` uses no ServiceNow branding.
- **Acceptance:** no public display name starts with "ServiceNow" as the product noun, and every
  listing's short description contains "unofficial" or "not affiliated".
- **Dependencies:** owner decision.

## 6. Owner decisions needed

1. **Managed policy layer (GV-I1).** Options: (a) a managed file at an OS path plus an env
   override; (b) instance-side only (a system property read at startup); (c) both.
   **Recommend (c):** the file for laptops and containers, the property as the platform owner's
   central kill switch.
2. **Default location of instance data on disk (GV-I3, BREAKING).** Options: (a) keep
   `./docs/instance`; (b) a per-user state dir with a compatibility read for one minor.
   **Recommend (b)** in the next minor, entered in the B-register now.
3. **Export retention default.** Options: unlimited / 7 days / 30 days. **Recommend 7 days** for
   exports, unlimited for the journal (managed-lockable).
4. **Licence posture.** Options: (a) stay GPL-3.0-or-later and add the org FAQ; (b) GPL plus a
   written exception for internal redistribution and container catalogues; (c) dual-licence (GPL
   plus commercial). **Recommend (a) now plus DCO immediately**, which keeps (b) and (c) open.
   Revisit at O-24.
5. **Trademark display name (GV-I9).** Rename `displayName` now (no breakage) and keep the npm
   name. **Recommend yes.**
6. **Backup publisher for security releases (RR-GV-13).** **Recommend** naming one trusted
   person with npm 2FA publish rights, documented in SECURITY.md.

## 7. Metrics this role would track

| KPI                                                                      | Current                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------- |
| Policy keys an admin can lock (managed floor) / safety-relevant keys     | 0 / ~25                                                  |
| Share of journalled writes carrying a human identity (subject/os_user)   | stdio: 0 %; HTTP+OAuth: 100 %                            |
| Instance-data files on disk older than retention / with mode ≠ 0600      | 148 files, 80 MB, all 0644, no retention (this checkout) |
| Prod applies with a validated change-request reference                   | 0 % (no mechanism)                                       |
| Vendor-risk doc drift items (SECURITY.md vs `package.json`, docs counts) | 2 known (deps, test count)                               |
| Security-advisory time to fix (critical/high), against the 30-day target | no advisories published yet: n/a                         |
