# servicenow-mcp-ai — Gap analysis 2026-09 (second pass over the v3.0 plan)

Date: 2026-09-09 · Scope: v2.0.1, `main` at `5acdcc7` plus the uncommitted H-1 change (SDK
`^1.30.0`, zod `^3.25.0`), local Node v22.23.2, SDK 1.30.0 installed · Method: a **second,
read-only pass** over the whole tree, the installed SDK and the packaging output, run through nine
narrower lenses than the 2026-09-02 review — **L1** network client, **L2** data handling and
write path, **L3** governance and policy, **L4** operator/model experience, **L5** MCP protocol
surface, **L6** reliability and runtime, **L7** operations and observability, **L8**
authentication, **L9** tests, CI and packaging. The question asked of every lens was: _what does
[DEEP-REVIEW-2026-09.md](DEEP-REVIEW-2026-09.md) not mention, and what does
[ROADMAP-V3.md](../ROADMAP-V3.md) therefore not plan?_ Every item that was already covered by a
ROADMAP-V3 definition of done is listed in §11 (with the evidence that was added to it), not
re-reported as a finding. Nothing in the repo was modified by the audit.

Every finding below is written to be **implementable without re-deriving it**: the gap, the
evidence (`file:line`), the impact, the design, the acceptance criteria, the tests, effort,
breaking flag, target release and the ROADMAP-V3 item that absorbs it. §13 is the finding →
item index; §14 lists the deltas applied to ROADMAP-V3 (six new ids, three new breaking-register
rows, extended definitions of done, one corrected bullet).

Legend — **Severity**: high / med / low / info. **Status**: **VERIFIED** = re-checked in code,
in the installed SDK or by running a command; **CLAIM** = ServiceNow platform or third-party
behaviour asserted from experience, not from this code; **UNVERIFIED** = not checkable offline.
**Effort** (single maintainer): **S** ≤ 1 day · **M** 2–5 days · **L** 1–2 weeks. **Target**:
**2.x** = non-breaking, ships on the 2.x line; **3.0** = part of the breaking cluster; **3.x** =
stretch after 3.0.0. **→ item** = the ROADMAP-V3 id that absorbs the finding (new ids are
**H-10, H-11, M-9, S-13, D-9, E-9**).

## 0. Executive summary — what the second pass adds

1. **The HTTP client has no operational identity and several silent misconfigurations.** No
   `User-Agent`, no `HTTPS_PROXY`/`NO_PROXY` support, and — the worst one — a custom CA
   (`SN_TLS_CA`) or `SN_TLS_REJECT_UNAUTHORIZED=false` is **silently ignored unless a client
   certificate is also configured**, because the undici dispatcher is only built for mTLS
   (`src/core/mtls.ts:24-33`). The OAuth token request bypasses the client entirely
   (`src/core/auth.ts:240-247`): no dispatcher, no proxy, no retry, no semaphore, no telemetry.
   The per-host semaphore has an unbounded wait queue and there is no overall deadline across
   retries. → new **H-10** (L1-01 … L1-10).
2. **Governance stops at exact table names.** The policy is an exact-match allow/deny list
   (`src/core/policy.ts:60-75`): no wildcards, no protected-table defaults (`sys_user`,
   `sys_user_has_role`, `sys_security_acl`, `sys_properties`, `oauth_entity` … are writable in
   apply mode with no policy set), no write caps, no notion of a production profile, and no way
   to ask the server what it would allow. → new **H-11** (L3-01 … L3-05), breaking **B11**.
3. **The write path has holes the 2026-09-02 review did not list.** No optimistic concurrency
   between plan and apply (a record edited by someone else between the two is overwritten); no
   `sys_id` / table-name / field-name validation, so a typo'd field on `update_record` is
   silently dropped by the instance and reported as success; 83 unbounded string parameters and 12
   unbounded string arrays in the tool schemas; batch writes journal only a count; local-file and
   credential writes are not journaled at all; the journal has no schema version, no integrity
   chain and no rotation; CSV export is open to formula injection. → extensions of **H-3, H-4,
   H-5, H-6, M-8** (L2-01 … L2-14).
4. **`use_instance` persists `SN_ACTIVE_PROFILE` to the env file and to `process.env`**
   (`src/core/config.ts:205-215`), so one client's profile switch survives restarts and leaks into
   every other client that shares the env file. → H-7 / D-2 extension, breaking **B12**.
5. **The manifest snapshot pins names and annotations only** (`scripts/gen-manifest.mjs`), so the
   input schemas, descriptions and output schemas that M-6/M-7 are about to change are not
   guarded by any test. → M-6 / E-6 extension (L5-01).
6. **Resource URI templates can collide** with profile names (`servicenow://docs/{path}` vs
   `servicenow://{profile}/schema/{table}`), and the prompts hard-code tool names that M-7
   renames. → M-7 extension, breaking **B13** (L4-02, L4-03).
7. **Credential lifecycle gaps:** a rotated OAuth `refresh_token` is never persisted, a static
   bearer has no expiry path, secrets cannot come from `*_FILE` sources (containers), and the
   `.env` writer refuses any quoted value containing a backslash (Windows paths). → D-2 / D-5
   extensions (L2-11, L2-12, L6-01, L6-02).
8. **Process and packaging hygiene:** no `unhandledRejection`/`uncaughtException` handlers, the
   dark Jira build output ships in the npm tarball, `.gitignore` does not cover `.env.prod`-style
   files, `ci.yml` has no `permissions`/`concurrency`/`timeout-minutes`, the Claude plugin
   manifest is already one patch version behind, SECURITY.md invites public issues for
   vulnerability reports. → new **E-9**, **D-9**; H-9 / E-2 / E-6 / E-8 extensions (L6-03,
   L9-01 … L9-12).
9. **Long-running operations** (snapshot, compare, ATF runs) have no progress, cancellation or
   parallelism today (M-3 covers the first two); the SDK 1.30 experimental **tasks** capability is
   the protocol-native way to model them once M-3 lands. → new **M-9** (L5-02), S-7 / S-10
   extensions.
10. **Two stale statements in the plan itself** — the H-4 bullet that cites
    `src/api/importset.ts:23-24` as missing the table check (it is present), and the ROADMAP.md
    line "Nothing is started; every item is 🔴" (H-1 is done) — plus two documentation drifts
    (`.env.example` retry comment vs the CHANGELOG; the plugin manifest version). → §1.

Counts by lens: L1 10 · L2 14 · L3 7 · L4 8 · L5 6 · L6 6 · L7 3 · L8 1 · L9 12 = **67
findings**, of which 9 high, 30 med, 23 low, 5 info (L6-03 med → low on 2026-09-09, C-7). 20 previously-planned items receive extended
definitions of done; 6 new ids are added; 3 rows join the breaking-change register.

## 1. Corrections to existing documents

| #   | Where                                                                              | What is wrong                                                                                                                                                                                                                                                                                                                                                                                               | Correction                                                                                                             | Status       |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------ |
| C-1 | [ROADMAP-V3.md](../ROADMAP-V3.md) §H-4, bullet citing `src/api/importset.ts:23-24` | `insertImportSetRow` **does** call `assertTableAllowed(stagingTable)` (line 23) and so does `getImportSetRow` (line 38); the bullet reports it as a missing check.                                                                                                                                                                                                                                          | Bullet reworded: the import-set path is already governed; what is missing there is `SN_IMPORT_SET_TABLES` (see L3-01). | **VERIFIED** |
| C-2 | [ROADMAP.md](../ROADMAP.md) §"Next — 3.0", callout                                 | "Nothing is started; every item is 🔴." — H-1 was done on 2026-09-03.                                                                                                                                                                                                                                                                                                                                       | Callout updated to name H-1 as done and point here.                                                                    | **VERIFIED** |
| C-3 | `.env.example` (retry comment)                                                     | Says "429/503 any method; 502/504 and network errors on GET"; the code (`src/core/http-util.ts:104-121`) and the CHANGELOG say 429 any method, **502/503/504 only on GET**.                                                                                                                                                                                                                                 | Regenerate the file from the settings manifest (L4-08 → D-3); until then, fix the comment when D-3 lands.              | **VERIFIED** |
| C-4 | `.env.example` (package list)                                                      | The `SN_TOOL_PACKAGES` comment omits `atf`, `codecheck`, `flows`, `instance`; "admin tools (set_credentials, get_status) are always registered" understates the always-on admin set.                                                                                                                                                                                                                        | Same as C-3 — generated from the registry (D-3).                                                                       | **VERIFIED** |
| C-5 | `.claude-plugin/plugin.json`                                                       | `"version": "2.0.0"` while every other manifest says 2.0.1.                                                                                                                                                                                                                                                                                                                                                 | Bump with the next release; H-9's version-sync test is the guard (L9-12).                                              | **VERIFIED** |
| C-6 | [DEEP-REVIEW-2026-09.md](DEEP-REVIEW-2026-09.md) §6 / ROADMAP-V3 §H-8              | Not wrong, but incomplete: the hibernating-PDI corner case (C-1) is the only case where a **non-JSON error body** is handled; any HTML error page (proxy 502, WAF block, login redirect) is still echoed verbatim (L1-08).                                                                                                                                                                                  | H-8 keeps C-1; the generic body cap lives in H-10.                                                                     | **VERIFIED** |
| C-7 | This file, L6-03 (first version, 2026-09-09)                                       | Claimed `src/index.ts` registers `SIGINT` only and has no `unhandledRejection` / `uncaughtException` handlers. In fact `src/index.ts:147-161` registers SIGINT **and** SIGTERM and both crash handlers (commit `db4bd5c`); what is missing is narrower — `unhandledRejection` only logs and keeps running, neither handler carries `pid`/`uptime`/`transport`, and nothing flushes stderr before `exit(1)`. | L6-03 reworded (2026-09-09, before E-9 started); severity lowered to low.                                              | **VERIFIED** |

## 2. L1 — Network client

### L1-01 — Environment proxy variables are ignored

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-10**
- **Gap:** Node's `fetch` (undici) does not honour `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`; the client
  passes no dispatcher unless mTLS is configured (`src/core/http.ts:128-147`). H-6 plans a
  dedicated `SN_HTTPS_PROXY` but says nothing about the conventional variables every corporate
  shell already exports.
- **Impact:** behind a corporate egress proxy the server cannot reach the instance at all; the
  failure surfaces as a generic "Could not reach ServiceNow" transport error.
- **Design:** one dispatcher factory in `src/core/http-util.ts` (`getDispatcher(host)`):
  precedence `SN_HTTPS_PROXY` → `HTTPS_PROXY`/`https_proxy` → `HTTP_PROXY`; `NO_PROXY` honoured
  (undici `EnvHttpProxyAgent` does this natively — verify it composes with the TLS `connect`
  options; otherwise build `ProxyAgent` + `NO_PROXY` matching by hand). The factory is the single
  place that also applies the TLS options (L1-03) and is reused by the OAuth token request
  (L1-10). `get_status` reports `proxy: {source, host}` without credentials.
- **Acceptance:** with `HTTPS_PROXY=http://127.0.0.1:8888` set and a fake proxy listening, every
  ServiceNow and OAuth request goes through it; with `NO_PROXY=*.service-now.com` none does;
  `SN_HTTPS_PROXY` overrides both.
- **Tests:** unit — dispatcher selection matrix (env × `NO_PROXY` × override); integration — a
  local `http.createServer` acting as a CONNECT proxy asserts the CONNECT was made (E-6 fetch
  double v2 can stub the dispatcher instead).

### L1-02 — No `User-Agent` header

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-10**
- **Gap:** requests carry no `User-Agent` (`src/core/http.ts:128-147` builds `Accept`,
  `Content-Type` and auth only), so instance-side transaction logs, WAF logs and the ServiceNow
  "REST API usage" dashboards attribute traffic to undici's default.
- **Design:** `User-Agent: servicenow-mcp-ai/<version> (node/<major>; <transport>; <client-name>)`
  where client name comes from `initialize` `clientInfo.name` when available (M-3 makes `extra`
  available). Set once per request in `snRequest`, override-able by `SN_USER_AGENT_SUFFIX`.
- **Acceptance:** every request in the fetch double's `calls` carries the header; the value is
  documented in the README security notes (it is a fingerprint operators may want to allow-list).
- **Tests:** header present on GET/POST/binary/OAuth-token paths.

### L1-03 — Custom CA and `SN_TLS_REJECT_UNAUTHORIZED` are silently ignored without a client certificate

- **Severity:** high · **Status:** VERIFIED · **Effort:** S · **Breaking:** no (behavioural fix) · **Target:** 2.x · **→ H-10**
- **Gap:** `getTlsDispatcher` returns `undefined` when `SN_TLS_CLIENT_CERT`/`_KEY` are absent
  **before** reading `SN_TLS_CA` and `SN_TLS_REJECT_UNAUTHORIZED` (`src/core/mtls.ts:24-33`). An
  operator with a private CA (on-prem, TLS-inspecting proxy) sets `SN_TLS_CA_FILE`, gets
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, and nothing tells them the variable was never used.
  `.env.example` documents both variables as independent.
- **Impact:** wrong docs → support load; worse, the natural workaround is `NODE_TLS_REJECT_UNAUTHORIZED=0`,
  which disables verification for the whole process.
- **Design:** build the dispatcher whenever **any** of cert+key, CA or `rejectUnauthorized=false`
  is present; `connect: {cert?, key?, ca?, rejectUnauthorized}`; log a `warn` once per process
  when verification is off (H-6 already plans the TLS-off warning — merge). Doctor prints the TLS
  block: `ca: file|inline|system`, `client_cert: yes|no`, `verify: on|off`.
- **Acceptance:** with only `SN_TLS_CA_FILE` set, the dispatcher is built with `ca` and no client
  cert; with only `SN_TLS_REJECT_UNAUTHORIZED=false`, verification is off and the warning is logged
  exactly once.
- **Tests:** dispatcher-option matrix (8 combinations); warning emitted once; doctor block.

### L1-04 — TLS dispatcher cache is global and keyed by PEM lengths

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 3.0 · **→ H-10** (with E-3)
- **Gap:** `cacheKey` is `${cert.length}|${key.length}|${ca.length}|${reject}`
  (`src/core/mtls.ts:38`); two certificates of equal length (routine when rotated by the same CA)
  collide, and the cache is a module singleton — one dispatcher for all profiles/hosts.
- **Design:** key by `sha256(cert)|sha256(key)|sha256(ca)|reject|profile`; store in the E-3
  runtime container so a `use_instance`/`set_credentials` disposes the previous dispatcher
  (`dispatcher.close()`), which also drops pooled sockets holding the old identity.
- **Acceptance:** rotating to an equal-length certificate produces a new dispatcher; switching
  profile never reuses another profile's client identity.
- **Tests:** equal-length rotation; profile switch closes the old dispatcher (spy on `close`).

### L1-05 — Host resolver drops `:port` and rejects IPv6 literals

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 3.x · **→ H-10**
- **Gap:** `resolveHostWithPolicy` strips a trailing `:\d+` (`src/core/host.ts:88`) and the
  character class `/^[A-Za-z0-9.-]+$/` (`:96`) rejects `[::1]`; a dev instance on
  `https://sn.internal:8443` or an IPv6-only lab host cannot be addressed even with
  `SN_ALLOWED_HOSTS` set.
- **Design:** keep an explicit port when the host is allow-listed (`SN_ALLOWED_HOSTS` entries may
  carry a port; a `*.service-now.com` host never may); accept bracketed IPv6 only when the literal
  appears in the allowlist (H-6 already SSRF-checks IPv6 ranges — reuse). The canonical form is
  `host[:port]`; `instanceBaseUrl` keeps it.
- **Acceptance:** `sn.internal:8443` in the allowlist round-trips into the base URL; the same host
  without the allowlist entry is refused; `[::1]:8080` allowed only when listed.
- **Tests:** table of 12 host inputs × allowlist on/off.

### L1-06 — One flat timeout; no overall deadline across retries

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-10**
- **Gap:** every attempt gets `AbortSignal.timeout(timeoutMs)` (`src/core/http.ts:145`); with
  `SN_MAX_RETRIES=3`, `Retry-After` honoured up to 60 s (`src/core/http-util.ts:132`) and backoff
  up to 8 s, one tool call can block for `4 × timeout + 3 × 60 s` — far beyond any MCP client's
  tool timeout (VS Code, Claude Desktop). Binary downloads and 200-row pages share the same cap.
- **Design:** `SN_DEADLINE_MS` (default `max(120000, 2 × SN_TIMEOUT_MS)`) enclosing all attempts:
  a retry is skipped when `now + wait + timeout > deadline`, and the final error names the deadline
  (`code: "DEADLINE_EXCEEDED"`, M-2). `snRequest` accepts a per-call `timeoutMs` override
  (attachment download, snapshot pages) and composes it with the M-3 cancellation signal via
  `AbortSignal.any`. `Retry-After` cap becomes `SN_RETRY_AFTER_MAX_MS` (default 60000).
- **Acceptance:** with a mocked 503 loop and `Retry-After: 120`, the call fails within the deadline
  with `DEADLINE_EXCEEDED`; a cancelled MCP request aborts the in-flight fetch.
- **Tests:** fake timers (E-6): deadline math; `AbortSignal.any` composition; override per call.

### L1-07 — No circuit breaker; rate-limit headers are dropped

- **Severity:** low · **Status:** VERIFIED (code) / CLAIM (ServiceNow headers) · **Effort:** M · **Breaking:** no · **Target:** 3.x · **→ H-10** (counters → E-5)
- **Gap:** a host returning 503 keeps every caller retrying independently; nothing reads the
  instance's rate-limit response headers (ServiceNow sends `X-RateLimit-Limit`/`-Remaining`/`-Reset`
  when a REST rate-limit rule applies — CLAIM) so the model learns about throttling only through
  429 errors.
- **Design:** per-host breaker in `http-util.ts`: open after `SN_BREAKER_THRESHOLD` (default 5)
  consecutive transport/5xx failures, half-open after `SN_BREAKER_RESET_MS` (default 30000); while
  open, requests fail fast with `code: "CIRCUIT_OPEN"` and a `hint`. Rate-limit headers are parsed
  into telemetry (`rateLimit: {limit, remaining, resetAt}`) and surfaced by `get_status` (E-5).
- **Acceptance:** 5 consecutive 503s open the breaker; the 6th call fails without a fetch; after
  the reset window one probe request is allowed.
- **Tests:** breaker state machine with fake timers; header parsing with and without the headers.

### L1-08 — Error bodies are echoed unbounded into the tool error

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-10** (contract → M-2)
- **Gap:** on `!res.ok` the whole body is parsed and, when it is not JSON, wrapped as
  `{raw: text}` and attached as `snDetail`; the message uses
  `extractErrorDetail(json) || res.statusText || text` (`src/core/http.ts:209-231`). An HTML error
  page from a proxy, a WAF block page or a login redirect (hundreds of KB) lands verbatim in the
  model's context, and the hibernation case (H-8 C-1) is only one instance of this.
- **Design:** cap the non-JSON body at 512 chars, strip tags (`/<[^>]+>/g`) and collapse
  whitespace; classify: `text/html` → `code: "UPSTREAM_HTML"` with `hint` ("proxy/WAF/login
  page — check the host and proxy"), hibernation → H-8's code; JSON `error.message`/`detail` kept
  as today but capped at 2 KB. The raw body is available at `debug` log level only.
- **Acceptance:** a 300 KB HTML 502 yields an error ≤ 1 KB with `UPSTREAM_HTML`; a ServiceNow
  JSON 400 keeps its `error.detail`.
- **Tests:** HTML page, plain text, oversized JSON, hibernation body.

### L1-09 — Per-host semaphore has an unbounded queue and no wait timeout

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-10**
- **Gap:** `withSlot` pushes every waiter into an array and blocks until a slot frees
  (`src/core/http-util.ts:83-105`). A stalled host (hibernating PDI, hung proxy) plus a
  `fetchAll` or a batch fan-out means every later call — including `get_status` — queues behind it
  until each earlier attempt times out.
- **Design:** `SN_MAX_QUEUE` (default 64) — a caller that would exceed it fails immediately with
  `code: "BUSY"` and `hint` ("reduce SN_MAX_CONCURRENT consumers or wait"); `SN_QUEUE_TIMEOUT_MS`
  (default = `SN_TIMEOUT_MS`) — a waiter gives up with `BUSY` after it; queue depth per host is
  exported to telemetry (E-5). `get_status` and `doctor` bypass the queue (they are the tools an
  operator uses to see the stall).
- **Acceptance:** with `SN_MAX_CONCURRENT=1` and one never-resolving fetch, the 65th call fails
  fast with `BUSY`; `get_status` still answers.
- **Tests:** queue bound; wait timeout; bypass for status.

### L1-10 — The OAuth token request bypasses the HTTP client

- **Severity:** high · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-10**
- **Gap:** `requestToken` calls the global `fetch` directly (`src/core/auth.ts:240-247`): no
  dispatcher (so no mTLS, no custom CA, no proxy — L1-01/L1-03), no retry on 429/503, no
  `withSlot`, no telemetry, no `User-Agent`, and its own `AbortSignal.timeout` without the
  deadline. The mTLS-protected instance that _requires_ a client certificate for `/oauth_token.do`
  therefore cannot obtain a token; behind a proxy every OAuth mode is dead.
- **Design:** a `rawRequest` primitive in `http-util.ts` (dispatcher + UA + timeout/deadline +
  429/503 retry + telemetry bucket `auth`) used by both `snRequest` and `requestToken`; the token
  path stays outside the table policy and the 401 re-auth loop. The same primitive serves the
  OAuth authorization-code exchange (`exchangeAuthorizationCode`, `:317`).
- **Acceptance:** with `SN_TLS_CLIENT_CERT_FILE` set, the token request is made through the mTLS
  dispatcher; with `HTTPS_PROXY` set it goes through the proxy; a 503 on the token endpoint is
  retried once.
- **Tests:** dispatcher spy on the token path; retry on 503; telemetry `auth` bucket increments.

## 3. L2 — Data handling and the write path

### L2-01 — CSV export is open to formula injection and has no BOM option

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-5** (result-boundary safety)
- **Gap:** `toCsv` quotes RFC-4180 style only (`src/mcp/csv.ts:11-30`); a record value starting
  with `=`, `+`, `-`, `@`, `\t` or `\r` (an incident short description like `=HYPERLINK(...)`)
  becomes a live formula when the CSV is opened in Excel/Sheets. No UTF-8 BOM, so Excel on Windows
  mis-decodes Cyrillic/accents.
- **Design:** neutralise per OWASP: prefix a cell with `'` when it matches `/^[=+\-@\t\r]/`
  (after trimming), keep quoting; `SN_CSV_BOM` (default `1`) prepends `\uFEFF`; `format:"csv"`
  results carry `_meta.csv = {escaped: n, bom: true}` so the model can mention it. S-11
  `format:"file"` reuses the same encoder.
- **Acceptance:** `=1+1` becomes `'=1+1`; a value `-5` (numeric string) becomes `'-5` (documented
  trade-off; opt-out `SN_CSV_FORMULA_GUARD=0`); output starts with the BOM.
- **Tests:** property test — every cell of the parsed output either equals the input or is the
  input prefixed with `'` and matched the trigger class; BOM on/off.

### L2-02 — The journal has no schema version, no integrity chain and no rotation

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-5**
- **Gap:** `appendWriteJournal` appends JSON lines and Markdown rows forever
  (`src/core/write-journal.ts:41-56`); entries carry no version field, so H-5's shape change
  (`before`, `id`, `plan_token`, `result`) cannot be told apart from v1 lines by S-2's revert
  reader; nothing detects a hand-edited or truncated journal; a busy automation grows the file
  unboundedly.
- **Design:** `schema_version: 2` on every line; `prev` = sha256 of the previous line (chain head
  stored in `write-journal.head`); rotation at `SN_JOURNAL_MAX_BYTES` (default 20 MiB) to
  `write-journal.<ISO-date>.jsonl` with the chain continued across files; `list_writes` (S-2) reads
  across rotated files and reports `integrity: ok|broken@<line>`; the Markdown mirror is
  regenerated from the last 200 entries instead of appended (keeps it readable).
- **Acceptance:** a v1 line is read with defaults; editing a line in place makes `list_writes`
  report `broken@n`; a 21 MiB journal rotates and revert still finds the entry.
- **Tests:** version defaulting; chain verification; rotation boundary; reader across files.

### L2-03 — Batch: one journal line per batch, no sub-request cap

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-4** (cap) / **H-5** (journal)
- **Gap:** the batch tool journals `{sub_requests: n}` once (`src/tools/batch.ts:69-73`) and the
  plan preview lists `method` + `url` only (`:63`); a batch of 40 deletes is one opaque row that
  S-2 cannot revert. There is no upper bound on `requests[]` — the ServiceNow Batch API limits
  are instance-side (CLAIM) and the error comes back after the payload was built and sent.
- **Design:** `SN_BATCH_MAX_REQUESTS` (default 50); one journal entry per non-GET sub-request
  (`action` derived from method, `table`/`sys_id` parsed from the mapped `/api/now/table/...`
  URL, `body_sha256`, `batch_id` linking them) plus the envelope entry; H-4's body preview
  applies per sub-request with the 2 KB cap of L4-06.
- **Acceptance:** a batch with 3 PATCHes produces 4 journal lines sharing one `batch_id`; 51
  sub-requests are refused before any request is sent.
- **Tests:** journal fan-out; cap; URL parsing for table/sys_id including the trailing-slash case
  from `src/api/batch.ts:115-120`.

### L2-04 — Local-file and credential writes are not journaled

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-5**
- **Gap:** `appendWriteJournal` is called in attachment, atf, batch, cmdb, change, catalog, email,
  importset and table tools, but never in `src/tools/{admin,docs,instance,codecheck}.ts` — so
  `docs_write`, `snapshot_instance`, `compare_instances`, `code_health` (its report file),
  `set_credentials` and `use_instance` leave no trace although all are write-annotated
  (`readOnlyHint:false`).
- **Design:** journal `action: "local_write"` with `target: "docs/<relPath>"`, `bytes`, `sha256`
  for every docs-dir write (through one `docsWriteRaw` chokepoint), and `action: "config"` with
  `keys: ["SN_INSTANCE", "SN_USER", …]` (names only, never values) for admin changes; `list_writes`
  filters by `action`. These entries are excluded from S-2 revert (non-instance) but included in
  the Markdown mirror.
- **Acceptance:** every write-annotated tool yields ≥ 1 journal line under the fetch double; the
  config entry never contains a value from the env file (asserted by grep over the journal).
- **Tests:** manifest-driven — for each tool with `readOnlyHint:false`, invoke and assert a
  journal append (extends the existing all-tools smoke).

### L2-05 — No optimistic concurrency between plan and apply

- **Severity:** med · **Status:** VERIFIED (code) / CLAIM (Table API has no `If-Match`) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-3**
- **Gap:** `update_record` reads `before` for the plan (`src/tools/table.ts:169-176`), then
  `apply:true` PATCHes without checking that the record is unchanged (`:180`). H-3's plan token
  binds the _arguments_, not the _record state_; an edit by another user between plan and apply is
  silently overwritten. The Table API offers no conditional PATCH (CLAIM), so the guard is
  client-side.
- **Design:** the plan captures `before.sys_mod_count` and `sys_updated_on` and folds them into
  the token payload; on apply with a token the tool re-reads those two fields and refuses with
  `code: "STALE_RECORD"` (+ current values, + `hint: "re-plan or pass force:true"`) when they
  differ; `force: true` skips the check and is journaled as `forced`. Same for `delete_record`
  and the CMDB/change update tools. `SN_WRITE_MODE=apply` without a token keeps today's behaviour.
- **Acceptance:** plan → external PATCH (mock) → apply fails with `STALE_RECORD`; `force:true`
  applies and journals `forced: true`.
- **Tests:** stale, unchanged, force, missing `sys_mod_count` (falls back to `sys_updated_on`).

### L2-06 — `sys_id`, table and field names are not validated

- **Severity:** med · **Status:** VERIFIED (code) / CLAIM (instance drops unknown fields) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ M-8** (typed builder) / **H-3** (preview warnings)
- **Gap:** `sys_id: z.string()` (`src/tools/table.ts:103,162,199`), `table: z.string()` everywhere;
  a malformed sys_id becomes a 404 round-trip, a table name with a caret or slash reaches
  `encodeURIComponent` unchecked, and an unknown field in `fields` on PATCH is ignored by the
  instance which still answers 200 (CLAIM) — the tool then reports "updated" for a no-op.
- **Design:** shared builders in `src/mcp/define.ts` (M-8): `sysId()` = `/^[0-9a-f]{32}$/`,
  `tableName()` = `/^[a-z][a-z0-9_]{0,79}$/`, `fieldName()` = `/^[a-z0-9_.]{1,120}$/`, applied
  through every tool file. In plan mode, when the schema cache holds the table (or
  `SN_STRICT_FIELDS=1` forces a `describe_table`), the preview lists `unknown_fields: [...]`; with
  strict mode the apply refuses them (`code: "UNKNOWN_FIELD"`). The response of a PATCH is
  compared with the requested fields and `not_applied: [...]` is reported when the instance
  returned a different value or omitted the field.
- **Acceptance:** `sys_id: "abc"` fails validation before any request; `fields: {shrot_description}`
  shows in `unknown_fields`; in strict mode it refuses.
- **Tests:** builder regexes (property: every 32-hex string passes, everything else fails);
  preview warnings; `not_applied` diff.

### L2-07 — 83 unbounded string parameters and 12 unbounded string arrays

- **Severity:** med · **Status:** VERIFIED · **Effort:** M · **Breaking:** no · **Target:** 2.x · **→ M-8** (builders) / **M-6** (budget test)
- **Gap:** across the tool schemas `.max()`/`.min()` appear in only 10 tool files; 83 `z.string()`
  parameters and 12 `z.array(z.string())` parameters carry no bound (count by grep over
  `src/tools/*.ts` on 2026-09-09). Examples: `send_email.to` (`src/tools/email.ts:23`) — no
  format, no maximum; `snapshot_instance.tables` (`src/tools/instance.ts:31`); every `query`,
  `body`, `content` string. A model (or an injected prompt) can relay a multi-megabyte string to
  the instance or ask for 10,000 tables in one snapshot.
- **Design:** builders with defaults — `encodedQuery(max 4000)`, `fieldList(max 200 items, each
≤ 120)`, `shortText(max 255)`, `longText(max = SN_MAX_BODY_BYTES)`, `email()` (RFC 5322 light
  - H-6 `SN_EMAIL_ALLOWED_DOMAINS`), `recipients(max 50)`, `tableList(max 200)`,
    `sysIdList(max 500)`; a manifest test that walks every tool's JSON schema and fails on any
    string/array leaf without `maxLength`/`maxItems` (allow-list for the two intentionally unbounded
    ones: `docs_write.content` capped by L2-10, `batch.requests[].body` capped by L2-03).
- **Acceptance:** the schema-bounds test passes for all 67 tools; `send_email` with 51 recipients
  or `not-an-email` fails validation client-side.
- **Tests:** the bounds walker; per-builder unit tests; manifest v2 snapshot (L5-01) records the
  bounds.

### L2-08 — Schema cache is unbounded

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 3.0 · **→ E-9**
- **Gap:** `cached()` stores every key in a module `Map` with a TTL but no size limit
  (`src/core/cache.ts:14-27`); after H-7 keys are per profile+host, so a long-lived HTTP server
  serving many sessions/tables grows without bound; `snapshot_instance` over 500 tables fills it
  in one call.
- **Design:** LRU with `SN_SCHEMA_CACHE_MAX` (default 256 entries); sweep expired entries on
  insert; expose `{size, hits, misses, evictions}` via E-5; `clearSchemaCache()` remains.
- **Acceptance:** inserting 257 keys evicts the least-recently-used one; stats visible in
  `get_status`.
- **Tests:** eviction order; TTL sweep; stats counters.

### L2-09 — Attachment upload has no size cap, MIME check or filename sanitisation

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-6**
- **Gap:** `uploadAttachment` forwards `file_name`, `content_type` and the decoded base64 body as
  given (`src/api/attachment.ts:75-104`); H-6's `SN_MAX_BODY_BYTES` is a _response_ cap. A file
  name with `../`, control characters or 1,000 characters is sent as-is; a 200 MB upload is
  decoded in memory first.
- **Design:** `SN_MAX_UPLOAD_BYTES` (default 10 MiB) checked on the base64 length _before_
  decoding; `file_name` → `path.basename`, strip `[\x00-\x1f\x7f]`, cap 255 bytes, refuse empty;
  `SN_UPLOAD_MIME_ALLOW` optional comma list (default any) matched against `content_type`; the
  plan preview shows `{file_name, content_type, bytes, sha256}` instead of the body.
- **Acceptance:** an 11 MiB upload is refused without decoding; `../../x.txt` is stored as
  `x.txt`; preview never contains base64.
- **Tests:** cap; sanitiser table; MIME allowlist; preview shape.

### L2-10 — Docs store accepts Windows reserved names and has no size caps

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-6**
- **Gap:** `resolveDocPath` rejects `..`, absolute paths and wrong extensions
  (`src/api/docs.ts:26-45`) but not `CON.md`, `NUL.md`, `COM1.md` (unwritable or device-mapped on
  Windows) nor NTFS alternate data streams (`notes.md:hidden`); `docsRead`/`docsSearch` read whole
  files with no limit (`:83-120`) and `docsWrite` accepts any `content` length.
- **Design:** reject segments matching `/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i` and any
  `:`; `SN_DOCS_MAX_FILE_BYTES` (default 5 MiB) enforced on write and on read (read returns the
  first N bytes with `truncated: true`); search skips files over the cap with a warning entry;
  `docs_list` reports `bytes` per file.
- **Acceptance:** `CON.md` refused on every platform; a 6 MiB write refused; read of a 6 MiB
  file truncated with the flag.
- **Tests:** reserved-name table; cap on write/read/search.

### L2-11 — The `.env` writer refuses backslashes in quoted values; CRLF and Windows permissions

- **Severity:** med · **Status:** VERIFIED (code) / CLAIM (dotenv single-quote semantics) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ D-2** (writer) / **E-4** (fail-fast)
- **Gap:** `formatEnvValue` throws when a value needs quoting and contains a backslash
  (`src/core/config.ts:229-244`); a Windows path with a space (`C:\Program Files\certs\ca.pem`)
  therefore cannot be saved by `set_credentials`/OAuth login. `persistEnv` rewrites the file with
  `\n` regardless of the original line ending (CRLF files are silently converted). `chmod 0600`
  is a documented no-op on Windows (`:308-315`) with no compensating warning.
- **Design:** dotenv (≥ 16) treats single-quoted values as fully literal (CLAIM — pin with the
  existing property test): emit single quotes whenever the value has no `'`, regardless of
  backslashes; keep the throw only for values containing both quote kinds _and_ a backslash, or a
  newline. Preserve the detected line ending on rewrite. On `win32`, doctor and `set_credentials`
  emit a one-line warning that the file inherits directory ACLs and suggest `icacls` (not
  executed by the server).
- **Acceptance:** the dotenv round-trip property test (`test/property.test.js`) passes with an
  alphabet that includes `\`, `"`, `'`, space and `#`; a CRLF file stays CRLF after a credential
  save.
- **Tests:** extended property alphabet; CRLF preservation; win32 warning (platform stubbed).

### L2-12 — Secrets cannot be supplied from `*_FILE` sources

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 3.0 · **→ E-4** (manifest) / **D-5** (containers)
- **Gap:** only the JWT key has a `_FILE` variant (`SN_JWT_KEY_FILE`, plus the TLS PEMs);
  `SN_PASSWORD`, `SN_API_KEY`, `SN_OAUTH_CLIENT_SECRET`, `SN_OAUTH_REFRESH_TOKEN`, `SN_TOKEN`,
  `SN_HTTP_TOKEN` must be environment values — the Docker/Kubernetes secret-mount convention (D-5)
  is unusable and secrets show in `docker inspect`.
- **Design:** the E-4 settings manifest marks secret settings; the loader resolves `<KEY>_FILE`
  generically (trimmed trailing newline, refuse world-readable files with a warning, re-read on
  401 for `SN_TOKEN_FILE` — L6-02). Profiles: `SN_PROFILE_<NAME>_PASSWORD_FILE` etc.
- **Acceptance:** `SN_PASSWORD_FILE=/run/secrets/sn` works with `SN_PASSWORD` unset; both set →
  fail-fast (E-4) naming the conflict.
- **Tests:** resolution matrix; conflict; missing file error text without the path's content.

### L2-13 — `use_instance` persists `SN_ACTIVE_PROFILE` globally

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** **yes** (default flips) → **B12** · **Target:** 3.0 · **→ H-7** / **D-2**
- **Gap:** `useProfile` writes `SN_ACTIVE_PROFILE` into the env file and into `process.env`
  (`src/core/config.ts:205-215`). One client's switch survives restarts and applies to every other
  client sharing `~/.config/servicenow-mcp-ai/.env` (VS Code + Claude Desktop + a cron job); in
  HTTP mode it flips all sessions (H-7 fixes the session part only).
- **Design:** `use_instance({profile, persist?: boolean})` — default `persist:false`: the switch
  is session-scoped (E-3 container; stdio = the process); `persist:true` writes the file and is
  journaled (L2-04). The startup default remains `SN_ACTIVE_PROFILE` from the environment/file.
  `get_status` shows `profile: {active, source: "env"|"file"|"session"}`.
- **Acceptance:** two stdio processes on the same env file: `use_instance("prod")` in one does not
  change the other's `get_status`; with `persist:true` it does after restart.
- **Tests:** session scope; persist path; journal entry; HTTP per-session (H-7 e2e).

### L2-14 — Table API conveniences: upsert and streamed `fetchAll`

- **Severity:** info · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 3.x · **→ S-8** (upsert) / **S-11** (streaming)
- **Gap:** no `upsert`/`get_or_create` (query by a key field, then create or update in one plan);
  `fetchAll` buffers every page in memory before returning (`src/api/table.ts`), so S-11's
  `format:"file"` still needs the whole result set in RAM.
- **Design:** `servicenow_upsert_record({table, key: {field: value}, fields})` = one plan with
  `action: "create"|"update"` decided at plan time and re-checked at apply (L2-05); `fetchAll`
  gets an `onPage` callback so the file writer streams pages (JSONL/CSV) and only the summary is
  buffered.
- **Acceptance:** upsert on a missing key plans a create, on a present key an update; a 50k-row
  file export never holds more than one page in memory (heap assertion under the fetch double).
- **Tests:** upsert branches; streamed export memory bound.

## 4. L3 — Governance and policy

### L3-01 — Policy matches exact table names; no wildcards, no protected-table defaults

- **Severity:** high · **Status:** VERIFIED · **Effort:** M · **Breaking:** **yes** (default deny on protected tables) → **B11** · **Target:** 3.0 · **→ H-11**
- **Gap:** `assertTableAllowed` does `allow.includes(table)` / `deny.includes(table)`
  (`src/core/policy.ts:60-75`). An operator cannot write `SN_DENY_TABLES=sys_*` or
  `SN_ALLOW_TABLES=u_*,incident`; with no policy at all and `SN_WRITE_MODE=apply`, every table is
  writable — `sys_user`, `sys_user_has_role`, `sys_user_grmember`, `sys_security_acl`,
  `sys_properties`, `oauth_entity`, `sys_auth_profile_basic`, `sys_script` (server scripts),
  `sys_ws_operation`. H-4 closes the _bypasses_ of the policy; it does not change what the policy
  can express or its defaults.
- **Impact:** a prompt-injected "add my user to the admin role" is one `create_record` on
  `sys_user_has_role` away when apply mode is on.
- **Design:** patterns — `*` and `?` (glob → regex, anchored, compiled once; `prefix*` covers
  the `u_*`/`x_*` scoped-app case); precedence deny > allow, exact > pattern; a built-in
  `PROTECTED_TABLES` list (the nine above plus `sys_user_role`, `sys_public`, `sys_ldap*`,
  `sys_certificate`, `sys_data_source`, `sys_rest_message*`) that is **write-denied by default**
  (reads unaffected) unless `SN_PROTECTED_TABLES_WRITE=allow` or the table is listed explicitly in
  `SN_ALLOW_TABLES` (explicit listing = informed consent). Import sets get their own
  `SN_IMPORT_SET_TABLES` allowlist (pattern `u_*`/`imp_*` by default) so a data load cannot target
  a real table through the staging path. `SN_TABLE_POLICY_FILE` (JSON) is optional for long
  lists. Effective policy is exported by L3-04.
- **Acceptance:** `SN_DENY_TABLES=sys_*` blocks `sys_user` and allows `incident`; with no policy,
  `create_record` on `sys_user_has_role` in apply mode fails with `POLICY_DENIED` + hint naming
  the override; `SN_ALLOW_TABLES=sys_user_has_role` re-enables it.
- **Tests:** glob compiler (property: pattern without wildcards behaves as exact); precedence
  table; protected defaults; import-set list; policy file loading errors.

### L3-02 — No write caps per session or per batch

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-11**
- **Gap:** nothing counts writes; a runaway agent loop can update thousands of records in apply
  mode at `SN_MAX_CONCURRENT` speed.
- **Design:** `SN_MAX_WRITES_PER_SESSION` (default unlimited in stdio, 500 in HTTP mode — session
  = E-3 container), `SN_MAX_BATCH_WRITES` (default 50, non-GET sub-requests), and
  `SN_MAX_DELETES_PER_SESSION` (default 100); when a cap is reached the tool fails with
  `code: "WRITE_CAP"` and `hint` ("restart the session or raise the cap"); counters in
  `get_status.writes = {count, deletes, cap}`; the journal records `cap_hit: true` on the refused
  call.
- **Acceptance:** the 101st delete in a session fails without a request; `get_status` shows the
  counters.
- **Tests:** counter increments per action; cap refusal; reset on new session.

### L3-03 — A profile cannot be marked as production

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-11**
- **Gap:** all profiles are equal (`src/core/config.ts:111-140`); the only way to make `prod`
  read-only is to omit its write mode, which `set_credentials` can flip at runtime.
- **Design:** `SN_PROFILE_<NAME>_ENV=prod|test|dev` (and `SN_ENV` for the default profile);
  `prod` implies: write mode `plan` unless `SN_PROFILE_<NAME>_WRITE_MODE=apply` **and**
  `SN_PROFILE_<NAME>_PROD_WRITES=I_UNDERSTAND`; destructive elicitation (H-3) is mandatory when
  the client supports it; every tool result from a prod profile carries
  `_meta.environment: "prod"` and the `servicenow_instance_overview` prompt (M-5) prefixes a
  warning; `use_instance` to a prod profile logs `warn`. Doctor lists `env` per profile.
- **Acceptance:** prod profile with `WRITE_MODE=apply` but without the acknowledgement stays in
  plan mode and says why; results carry the meta flag.
- **Tests:** env matrix; meta flag; prompt prefix.

### L3-04 — The model cannot ask what the policy allows

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-11** (resource → M-7)
- **Gap:** policy failures are discovered one call at a time; `get_status` reports only the raw
  env values (`src/mcp/status.ts:22-49`).
- **Design:** `servicenow_explain_policy({table?, action?})` → `{allowed, reason, rule,
write_mode, environment, caps}`; resource `servicenow://policy` (JSON: effective patterns,
  protected list, caps, per-profile env) for clients that pre-load resources; both read-only,
  local, no request to the instance.
- **Acceptance:** `explain_policy({table:"sys_user", action:"update"})` returns
  `{allowed:false, rule:"protected-default"}`; the resource matches what `assertTableAllowed`
  actually does (same evaluator function).
- **Tests:** evaluator shared between tool, resource and `assertTableAllowed` (one code path);
  golden output.

### L3-05 — Capability and plugin probes ignore the deny list

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-11** (H-4 routes the reads; this is the policy semantics)
- **Gap:** H-4 routes the direct `snRequest` reads in atf/diagnostics/capabilities/scripts through
  the policy, but `describe_capabilities`, `list_plugins` and `doctor` will then **fail** on a
  strict allowlist instead of reporting "not probeable"; the tests in `test/capabilities.test.js`
  assume the probes always run.
- **Design:** probe reads are classified `probe` and evaluated against a separate
  `SN_PROBE_TABLES` (default = the policy's read set; `*` allowed); a denied probe yields
  `{available: "unknown", reason: "policy"}` rather than an error; `get_status.packages` shows
  `unknown` for gated packages.
- **Acceptance:** `SN_ALLOW_TABLES=incident` — `describe_capabilities` returns `unknown` for the
  plugin probes and does not throw.
- **Tests:** probe under allowlist; status rendering.

### L3-06 — Capability preflight covers plugins only

- **Severity:** med · **Status:** VERIFIED · **Effort:** M · **Breaking:** no · **Target:** 2.x · **→ S-13** (new)
- **Gap:** `describe_capabilities` (`src/tools/capabilities.ts`) probes plugin activation and
  package availability; it does not tell the model whether **writes** will work (role, write mode,
  policy), whether an **update set** is set/required, whether the user may **attach** files,
  whether **aggregate**, **import set** or **email** endpoints are reachable, the instance
  **version** (family/patch — decides `sys_id`-less endpoints and the `sysparm_no_count`
  behaviour), or the caller's **roles** (`admin`, `rest_api_explorer`, `itil`).
- **Design:** `describe_capabilities({groups?: ["writes","update_sets","attachments",
"aggregate","import_sets","email","atf","version","roles"]})` runs one cheap probe per group
  through the policy (`sys_user_has_role` for roles → falls back to `unknown` if denied),
  `sys_properties?sysparm_query=name=glide.buildtag` for version, an `HEAD`-equivalent
  `sysparm_limit=1` read for each API; results are cached per profile for `SN_CAPABILITY_TTL_MS`
  (default 10 min) and refreshed by `refresh:true`. The `servicenow_instance_overview` prompt
  (M-5) calls it first; `doctor` prints the same matrix.
- **Acceptance:** on the fetch double with `sys_user_has_role` denied, the roles group is
  `unknown`; with `SN_WRITE_MODE=plan` the writes group says `plan-only`.
- **Tests:** per-group probe under allow/deny; TTL/refresh; doctor output.

### L3-07 — ATF runs cannot be awaited

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ S-10**
- **Gap:** `servicenow_atf_run` returns the execution tracker id; `atf_result` must be polled by
  the model (`src/tools/atf.ts`), which typically hammers it in a loop or gives up.
- **Design:** `atf_run({wait_seconds?: 0..600})` polls `sys_atf_test_result` every 5 s under the
  M-3 cancellation signal, reports progress notifications, and returns the final result or
  `{status: "running", tracker}` on timeout; with M-9 the same run is exposed as a task.
- **Acceptance:** with a mocked tracker that completes on the third poll, `wait_seconds:30`
  returns the result in ~10 s of fake time; cancellation stops the polling.
- **Tests:** polling with fake timers; timeout; cancellation.

## 5. L4 — Operator and model experience

### L4-01 — The server has no title, website or icon

- **Severity:** low · **Status:** VERIFIED (SDK 1.30 supports `title`, `websiteUrl`, `icons`) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ M-1**
- **Gap:** `new McpServer({name, version})` only (`src/index.ts:92-96`); clients that render a
  server card (Claude Desktop, VS Code "MCP: List Servers") show the package name and nothing
  else; `registerTool` `title` is used but the server-level `title` is not.
- **Design:** `title: "ServiceNow"`, `websiteUrl: <repo>`, `icons: [{src: "data:image/svg+xml;base64,…",
mimeType, sizes:["any"]}]` (inline SVG ≤ 4 KB, no external URL); `instructions` (M-1) stays.
- **Acceptance:** `initialize` result carries the three fields; inspector shows them.
- **Tests:** e2e `initialize` snapshot.

### L4-02 — Prompts hard-code tool names and are not package-gated

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no (with M-7 aliases) · **Target:** 3.0 · **→ M-5** / **M-7**
- **Gap:** `src/mcp/prompts.ts:13` embeds literal tool names (`servicenow_incident_triage`
  references `servicenow_query_table`, …); when M-7 renames tools the prompts drift silently, and
  the prompts are registered even when the packages they need are disabled by `SN_TOOL_PACKAGES`.
- **Design:** prompts reference tools by spec (`specs.table.query.name`) so a rename is a
  compile-time change; each prompt declares `requires: ["table","cmdb"]` and is registered only
  when all packages are on; a manifest test checks that every tool name mentioned in prompt text
  exists.
- **Acceptance:** disabling `cmdb` removes the CI prompt; a renamed tool breaks the build, not the
  prompt at runtime.
- **Tests:** package gating; name existence walker over prompt text.

### L4-03 — Resource URI templates can collide with profile names

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** **yes** (template URIs change) → **B13** · **Target:** 3.0 · **→ M-7**
- **Gap:** `servicenow://schema/{table}` (`src/mcp/resources.ts:108`),
  `servicenow://{profile}/schema/{table}` (`:152`) and `servicenow://docs/{path}` (`:205`) share
  one authority segment; a profile literally named `docs`, `schema`, `status`, `capabilities` or
  `reference` (all legal under `assertValidProfileName`) makes `servicenow://docs/schema/incident`
  ambiguous and the SDK's first-match routing decides.
- **Design:** move profile-scoped resources to `servicenow://profiles/{profile}/schema/{table}`;
  keep the old template as an alias for one minor (M-7 deprecation policy) with a `warn` on use;
  `assertValidProfileName` additionally reserves `docs|schema|status|capabilities|reference|
profiles|policy`; a startup check refuses an env file that defines a reserved profile.
- **Acceptance:** a profile named `docs` is rejected at load with a clear message; the new
  template resolves; the old one still resolves for 2.x clients.
- **Tests:** reserved names; both templates; alias warning once.

### L4-04 — `get_status` is missing the fields an operator needs first

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ M-1** (shape) / **E-5** (counters)
- **Gap:** `buildStatusPayload` (`src/mcp/status.ts:22-49`) reports instance, auth mode, packages,
  telemetry and profiles (`:51-64`, without per-profile auth mode); missing: package **version**,
  **uptime**, **pid**, **transport** (stdio/http), **write mode + effective policy summary**,
  **redaction on/off + field count**, **docs dir + writable?**, **limits** (`SN_MAX_ROWS`,
  `SN_MAX_RESULT_CHARS`, `SN_MAX_BODY_BYTES`, concurrency, retries, timeout, deadline), **TLS**
  (L1-03), **proxy** (L1-01), **cache stats** (L2-08), **write counters** (L3-02), **queue depth**
  (L1-09), **rate-limit** (L1-07), **profile source** (L2-13).
- **Design:** `get_status` v2 = the M-1 typed output schema with these groups; `profiles[]`
  gets `{name, host, auth, env, write_mode, active}`; every group is derived from the same
  settings manifest (E-4) so a new setting appears automatically.
- **Acceptance:** golden output under the fetch double; the manifest walker asserts every
  non-secret setting appears somewhere in the payload.
- **Tests:** golden; manifest coverage.

### L4-05 — `doctor` has no machine-readable output and assumes a UTF-8 terminal

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ D-1**
- **Gap:** `bin/doctor` prints glyphs (`✔`/`✖`) that render as `?` in `cmd.exe` and legacy
  PowerShell; no `--json` for CI/support scripts; it does not print **which** env file it loaded
  (`getEnvPath()`), the most common "wrong instance" cause.
- **Design:** `--json` (exit code unchanged; payload = `get_status` v2 + checks[]); `--ascii`
  auto-enabled when `!process.stdout.isTTY || process.platform === "win32" && !WT_SESSION`;
  first line `env file: <path> (exists|missing)`; `--profile <name>` runs the checks for one
  profile.
- **Acceptance:** `doctor --json | jq .checks` works; on a simulated win32 non-WT console the
  output is pure ASCII.
- **Tests:** json shape; ascii switch; env-file line.

### L4-06 — Email plan preview embeds the full body; recipients unvalidated

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-3** (preview) / **H-6** (recipients)
- **Gap:** `send_email` plan returns `{to, subject, body}` in full (`src/tools/email.ts:41-49`);
  a 100 KB HTML body is echoed back into the context; `to`/`cc`/`bcc` are free strings
  (`:23-26`) — H-6's `SN_EMAIL_ALLOWED_DOMAINS` needs parseable addresses to work.
- **Design:** preview shows `body_preview` (first 2 KB, tag-stripped) + `body_sha256` +
  `body_bytes`; recipients through the `email()` builder (L2-07) with `recipients(max 50)`; the
  journal stores the hash, not the body (L2-02 keeps sizes bounded).
- **Acceptance:** a 100 KB body previews in ≤ 2.2 KB; `to: ["x"]` fails validation.
- **Tests:** preview cap; builder; journal shape.

### L4-07 — The three docs tools have no explicit `openWorldHint`

- **Severity:** info · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ M-8**
- **Gap:** `servicenow_docs_list`, `_read`, `_search` omit `openWorldHint`
  (`test/fixtures/tools-manifest.json`); all 64 others set it. They are local-only, so the
  correct value is `false`; the omission is inconsistent and the manifest test does not require
  the key.
- **Design:** set `openWorldHint:false` explicitly; the M-8 definition helper makes all four
  annotation keys mandatory.
- **Acceptance:** manifest shows the key on every tool; the helper's type forbids omission.
- **Tests:** manifest walker.

### L4-08 — `.env.example`, `server.json` and the README env table are hand-maintained

- **Severity:** low · **Status:** VERIFIED (C-3, C-4 are the current drifts) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ D-3** (with E-4)
- **Gap:** three copies of the environment surface (`.env.example`, `server.json`
  `environmentVariables`, README "Environment" table) plus the docs site; the existing
  `test/env-docs-sync.test.js` checks presence, not the descriptive text — hence C-3/C-4.
- **Design:** the E-4 settings manifest (`src/core/settings-manifest.ts`: key, type, default,
  secret, since, description, group) is the single source; `npm run docs:env` regenerates
  `.env.example` (grouped, commented), the README table between markers, and the `server.json`
  list; `npm run check` runs it in `--check` mode (like `docs:readme`).
- **Acceptance:** editing a description in the manifest and running the generator updates the
  three targets; CI fails on drift.
- **Tests:** generator idempotency; drift detection.

## 6. L5 — MCP protocol surface

### L5-01 — The manifest snapshot does not pin schemas or descriptions

- **Severity:** high (for M-6/M-7 safety) · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ M-6** / **E-6**
- **Gap:** `scripts/gen-manifest.mjs` records `{name, title, annotations, package}`;
  `test/manifest.test.js` therefore cannot catch a changed `inputSchema` (M-8 builders, L2-07
  bounds), a description rewrite (M-6) or an added `outputSchema` (M-1); the README tools table is
  generated from the same subset.
- **Design:** manifest v2 = `{name, title, description_sha256, inputSchema (JSON Schema, sorted
keys), outputSchema?, annotations, package, since}`; the test diffs against the fixture and
  prints a human diff; `npm run gen:manifest` regenerates on purpose; the description budget test
  (M-6) reads the same file.
- **Acceptance:** changing one `.max()` fails the manifest test until the fixture is regenerated;
  the fixture diff in a PR shows exactly which tools changed.
- **Tests:** the manifest test itself; a regen-idempotency test.

### L5-02 — Long-running operations are not modelled as MCP tasks

- **Severity:** low · **Status:** VERIFIED (SDK 1.30 ships `experimental.tasks`, `_meta["io.modelcontextprotocol/related-task"]`) · **Effort:** M · **Breaking:** no · **Target:** 3.x · **→ M-9** (new; prerequisite M-3)
- **Gap:** `snapshot_instance`, `compare_instances`, `atf_run`, `codecheck` and a streamed
  export (S-11) can take minutes; M-3 adds progress + cancellation, but a client that disconnects
  loses the result and cannot re-attach.
- **Design:** behind `SN_EXPERIMENTAL_TASKS=1`, register the SDK's experimental task handlers
  (`tasks/list`, `tasks/get`, `tasks/cancel`, `tasks/result`) with an in-memory store per E-3
  container (TTL 1 h); the four tools accept `run_as_task:true` and return the task id with
  `_meta["io.modelcontextprotocol/related-task"]`; results are stored redacted; the docs mark the
  capability experimental and subject to SDK changes.
- **Acceptance:** `snapshot_instance({run_as_task:true})` returns within 100 ms; `tasks/get`
  shows progress; `tasks/result` returns the same payload the synchronous call would.
- **Tests:** e2e with the fetch double; TTL expiry; cancel.

### L5-03 — No argument completions; resource templates advertise no list

- **Severity:** low · **Status:** VERIFIED (SDK `completable()`, `ResourceTemplate` `list` callback) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ M-4**
- **Gap:** M-4 plans completions for tool arguments; prompt arguments (`table`, `sys_id`,
  `profile`) and the three resource templates (`{ list: undefined }`, `src/mcp/resources.ts:108,
152, 205`) have none, so clients cannot enumerate schemas or docs.
- **Design:** prompt args wrapped in `completable()` (table names from the schema cache, profiles
  from `listProfiles()`); templates get `list` callbacks — docs from `docs_list`, schema tables
  from the last `describe_table` calls + a fixed seed (`incident`, `sc_request`, …), profile
  template from `listProfiles()`; all lists capped at 100 entries.
- **Acceptance:** `resources/list` includes the docs files; `completion/complete` for
  `profile` returns the configured profiles.
- **Tests:** e2e completion; list callbacks.

### L5-04 — Elicitation fallback when the client lacks the capability is unspecified

- **Severity:** med · **Status:** VERIFIED (H-3 text: "When the client advertises elicitation…") · **Effort:** S · **Breaking:** no · **Target:** 3.0 · **→ H-3**
- **Gap:** H-3 says destructive apply asks for confirmation when elicitation is advertised, but
  not what happens when it is **not** (most clients today): silently proceed (current behaviour)
  or refuse? A prod profile (L3-03) needs a deterministic answer.
- **Design:** `SN_DESTRUCTIVE_CONFIRM=elicit|token|off` — `elicit` (default): ask when supported,
  otherwise fall back to `token` (the plan token itself is the confirmation, current H-3 flow);
  `token`: never elicit; `off`: neither (dev only, warn at start). Prod profiles force `elicit`
  and refuse destructive apply when the client lacks the capability (`code: "CONFIRM_REQUIRED"`).
- **Acceptance:** fetch-double client without elicitation: default mode applies with a valid
  token; prod profile refuses with `CONFIRM_REQUIRED`.
- **Tests:** three modes × elicitation on/off × prod/non-prod.

### L5-05 — Logging notifications are not rate-limited

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ M-8** (logging bridge)
- **Gap:** M-8 bridges the structured logger to `notifications/message`; at `debug` level a
  `fetchAll` over 100 pages emits hundreds of notifications, and some clients render each one.
- **Design:** token bucket per session — `SN_LOG_NOTIFY_RATE` (default 20/s, burst 50); dropped
  messages are counted and a single `warning` ("n log messages suppressed") is sent per minute;
  stderr logging is never throttled.
- **Acceptance:** 1,000 debug lines in one second produce ≤ 51 notifications plus one summary.
- **Tests:** bucket with fake timers.

### L5-06 — HTTP transport: no SSE keep-alive, no readiness endpoint

- **Severity:** low · **Status:** VERIFIED (SDK 1.30 `sseKeepAlive` option) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-7**
- **Gap:** H-7 adds `/healthz`; idle SSE streams through proxies/load balancers are cut after
  their idle timeout (typically 60 s) with no keep-alive, and there is no `/readyz` that says
  "credentials loaded and instance reachable" for orchestrators.
- **Design:** `StreamableHTTPServerTransport({ sseKeepAlive: SN_HTTP_KEEPALIVE_MS (default

25000. })`; `/readyz`= 200 when the env file parsed and the active profile has an instance +
auth configured (no network call;`?probe=1`adds a cached`sys_properties` read ≤ 10 s old);
       both endpoints unauthenticated but rate-limited (H-7).

- **Acceptance:** an idle SSE stream sees a comment frame every 25 s; `/readyz` is 503 before
  credentials exist.
- **Tests:** keep-alive frames with fake timers; readiness matrix.

## 7. L6 — Reliability and runtime

### L6-01 — A rotated OAuth refresh token is never persisted

- **Severity:** high · **Status:** VERIFIED (code) / CLAIM (ServiceNow rotates on
  `refresh_token` grant when the OAuth entity has rotation enabled) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ D-2**
- **Gap:** the token cache keeps `{token, expiresAt}` only (`src/core/auth.ts:366-403`); if the
  grant response includes a new `refresh_token` it is dropped, and once the old one is invalidated
  by the instance every subsequent refresh fails with `invalid_grant` until the operator re-runs
  the login.
- **Design:** when the grant response contains `refresh_token` ≠ the configured one, persist it
  through `saveCredentials` (atomic write, H-5) for the active profile and log `info` ("refresh
  token rotated"); when persistence fails (read-only env file, container), keep it in memory and
  `warn` once; `doctor` reports `refresh_token: configured|rotated-in-memory`.
- **Acceptance:** fetch-double grant with a new `refresh_token` → env file updated; second refresh
  uses the new one.
- **Tests:** rotation persisted; read-only fallback; no rotation → no write.

### L6-02 — Static bearer tokens have no expiry path

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ D-2**
- **Gap:** with `SN_AUTH=bearer`/`SN_TOKEN` a 401 is returned as a generic auth error
  (`src/core/http.ts:172` re-auths only in `oauth` mode); a short-lived token issued by an external
  IdP (SAML/OIDC gateway, Vault) cannot be rotated without restarting the server.
- **Design:** on 401 in bearer mode: re-read `SN_TOKEN_FILE` (L2-12) if configured and retry
  once; otherwise fail with `code: "AUTH_EXPIRED"` + `hint` ("rotate SN_TOKEN via
  set_credentials or SN_TOKEN_FILE"); `SN_TOKEN_EXPIRES_AT` (ISO) optional — `doctor` and
  `get_status` warn when < 24 h remain.
- **Acceptance:** 401 → file re-read → 200 on retry; without a file → `AUTH_EXPIRED`.
- **Tests:** both branches; expiry warning.

### L6-03 — Crash handlers are incomplete: a rejection keeps a possibly corrupt process alive

- **Severity:** low · **Status:** VERIFIED (corrected, C-7) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ E-9** (new)
- **Gap:** `src/index.ts:147-161` already registers SIGINT + SIGTERM and both crash handlers
  (`db4bd5c`), but `unhandledRejection` only logs and lets the process run on with possibly
  corrupt state (a background token refresh, a stray `withSlot` waiter after abort), the error
  lines carry no `pid`/`uptime`/`transport`, and `uncaughtException` calls `process.exit(1)`
  without flushing stderr — on macOS pipes are asynchronous, so the last line can be lost and
  the user sees only "server disconnected".
- **Design:** both handlers log one structured `error` line (redacted, with `pid`, `uptime`,
  `transport`) and exit `1` after flushing stderr (write callback, bounded by a short timer);
  `unhandledRejection` no longer keeps the process alive; SIGTERM keeps behaving like SIGINT;
  `--keep-alive-on-error` is deliberately **not** offered (state may be corrupt). E-9 also owns
  L6-04 and L2-08.
- **Acceptance:** injecting a rejected promise logs one JSON error line and exits 1 within 1 s.
- **Tests:** child-process test asserting the log line and exit code.

### L6-04 — No `dispose()`; profile switches leak dispatchers, timers and tokens

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 3.0 · **→ E-3** / **E-9**
- **Gap:** E-3's container is planned for testability; nothing specifies teardown. Today
  `use_instance` invalidates tokens and caches (`src/tools/admin.ts:178-180`) but not the TLS
  dispatcher (L1-04), pending semaphores (L1-09) or `withSlot` timers; in HTTP mode a closed
  session leaves its container alive.
- **Design:** `Container.dispose()` = close dispatcher, reject queued waiters with `BUSY`,
  clear caches/tokens/breaker, stop task store timers (M-9); called on session close (H-7), on
  SIGINT/SIGTERM and in every test's `afterEach`.
- **Acceptance:** the test suite runs with `--test-force-exit` removed and exits cleanly (no
  dangling handles).
- **Tests:** dispose idempotency; handle count before/after.

### L6-05 — Snapshot is sequential and cannot resume

- **Severity:** low · **Status:** VERIFIED · **Effort:** M · **Breaking:** no · **Target:** 3.x · **→ S-7** (with M-3)
- **Gap:** `snapshot_instance` walks tables one after another and writes at the end; a
  disconnect at table 80 of 100 loses everything; concurrency is 1 regardless of
  `SN_MAX_CONCURRENT`.
- **Design:** `p-limit`-style fan-out at `min(SN_MAX_CONCURRENT, 4)`, one file per table written
  as it completes plus an `index.json` with per-table status; `resume:true` skips tables present
  in the index; progress notifications per table (M-3); cancellation writes the partial index.
- **Acceptance:** cancel at 50 % → index shows 50 done; `resume:true` finishes the rest without
  re-fetching.
- **Tests:** fan-out bound; resume; cancellation.

### L6-06 — Plugin-state cache can poison for the process lifetime

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ S-13**
- **Gap:** `plugin-availability` is cached until `clearPluginAvailability()` (only on credential
  change); a probe that failed for a transient reason (503, timeout) marks the package unavailable
  for the whole session and every dependent tool refuses.
- **Design:** cache **negative** results for `SN_PLUGIN_NEGATIVE_TTL_MS` (default 60 s) and
  positive ones for `SN_CAPABILITY_TTL_MS` (L3-06); transport errors are not cached at all;
  `describe_capabilities({refresh:true})` clears both.
- **Acceptance:** a 503 on the first probe followed by 200 makes the package available on the
  next call after 60 s of fake time.
- **Tests:** negative TTL; transport error not cached; refresh.

## 8. L7 — Operations and observability

### L7-01 — One log sink, one format

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ E-5**
- **Gap:** `src/core/logging.ts` writes JSON to stderr only; a desktop user reading the client's
  log panel gets JSON lines; an operator who wants a persistent file must redirect stderr and
  handle rotation.
- **Design:** `SN_LOG_FORMAT=json|text` (text = `HH:MM:SS level msg key=value …`, default `text`
  when stderr is a TTY, `json` otherwise); `SN_LOG_FILE` with size rotation
  (`SN_LOG_FILE_MAX_BYTES`, keep 5) written through the same redaction; the M-8 MCP bridge is a
  third sink.
- **Acceptance:** with `SN_LOG_FILE` set, the file receives redacted lines; rotation at the cap.
- **Tests:** format switch; file rotation; redaction on the file sink.

### L7-02 — No metrics endpoint

- **Severity:** info · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 3.x · **→ E-5**
- **Gap:** E-5 plans latency percentiles in telemetry; in HTTP mode there is no way to scrape
  them.
- **Design:** `GET /metrics` (Prometheus text, behind the H-7 token, off by default
  `SN_METRICS=1`): requests total by status class, latency histogram, queue depth, breaker state,
  cache stats, write counters, sessions.
- **Acceptance:** `curl -H 'Authorization: Bearer …' /metrics` returns the families; without the
  flag → 404.
- **Tests:** e2e scrape.

### L7-03 — No support bundle

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ D-1**
- **Gap:** a bug report today is "run doctor and paste" — it omits versions of Node/SDK/undici,
  the effective settings (names + redacted values), the last 200 redacted log lines and the tool
  manifest.
- **Design:** `servicenow-mcp-ai support-bundle [--out file.zip]` = doctor `--json`, settings
  (secrets as `***`), `npm ls --depth=0`, manifest, last log-file tail (L7-01) — reviewed by the
  user before attaching; documented in SUPPORT.md (L9-10).
- **Acceptance:** bundle contains no value from the env file (grep assertion over all entries).
- **Tests:** bundle contents; secret scan.

## 9. L8 — Authentication

### L8-01 — `profiles` does not say how each profile authenticates

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ D-2** / **M-1**
- **Gap:** `profilesPayload` returns names and hosts (`src/mcp/status.ts:51-64`); the auth mode,
  OAuth grant, presence of a refresh token, environment (L3-03) and write mode per profile are
  only discoverable by switching to it.
- **Design:** `{name, host, auth: "basic|oauth(<grant>)|bearer|api_key|jwt", refresh_token:
true|false, env, write_mode, active}` — never a secret; same data in `doctor` and in L4-04.
- **Acceptance:** golden `profiles` output under a three-profile env file.
- **Tests:** golden; secret scan.

Other authentication gaps found by this lens are filed where their fix lives: OAuth token request
outside the client (L1-10), refresh-token rotation (L6-01), static-token expiry (L6-02), `*_FILE`
secrets (L2-12), env writer (L2-11).

## 10. L9 — Tests, CI and packaging

### L9-01 — The fetch double cannot express latency, streaming or response headers

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ E-6**
- **Gap:** `test/helpers/fetch-double.js` returns canned status/body per call; `Retry-After`,
  rate-limit headers (L1-07), `Content-Length`/`Content-Type` for the H-6 body cap, a delayed
  response (timeouts, deadline, queue tests) and a streamed body (S-11, L2-14) are not
  expressible, so those behaviours are untested or tested with hand-rolled stubs.
- **Design:** fetch double v2: `respond({status, headers, body|stream, delayMs, abortable})`,
  a `calls[]` record with headers and dispatcher, fake-timer integration (`node:test` mock
  timers), and a `route(method, pathRegex)` table so one double serves a whole scenario.
- **Acceptance:** the L1-06 deadline test and the L1-09 queue test run on the double with fake
  timers, no real waiting.
- **Tests:** the double's own contract tests.

### L9-02 — Property-test coverage stops at three targets

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ E-6**
- **Gap:** `test/property.test.js` covers the env round-trip, the host resolver and the query
  helper. Untested by property: `redactRecords` (deep, L2 in H-5), `toCsv` round-trip (L2-01),
  `resolveDocPath` (every generated path either resolves inside the docs dir or throws), the
  policy glob compiler (L3-01), `formatEnvValue` with the extended alphabet (L2-11), the journal
  chain (L2-02).
- **Design:** one property per item above, `fast-check` with `numRuns: 500` in CI and 100
  locally (`SN_FC_RUNS`).
- **Acceptance:** the six properties exist and pass; the docs-path one is the SSRF-equivalent
  guard for the filesystem.
- **Tests:** are the deliverable.

### L9-03 — Test discovery is a flat glob; c8 config inline

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ E-6**
- **Gap:** `"test": "node --test test/*.test.js"` (`package.json:34`) — a test placed in
  `test/core/` is silently not run; c8 thresholds live in the `test:coverage` script string
  (`:35`) and the coverage guard reads a separate file.
- **Design:** `node --test "test/**/*.test.js"`; `.c8rc.json` with reporters, thresholds and
  `exclude`; `coverage-guard.mjs` reads the same file; folders `test/{core,api,mcp,tools,e2e}`
  mirroring `src/` (move files gradually).
- **Acceptance:** a test in a sub-folder runs; thresholds have one definition.
- **Tests:** CI green after the move; a sentinel test in a sub-folder.

### L9-04 — The dark Jira build ships in the npm tarball

- **Severity:** med · **Status:** VERIFIED (`npm pack --dry-run` lists `build/api/jira/*`, `build/core/jira/*`) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-9** (pack guard) / **E-8** (ARCH-14)
- **Gap:** `"files": ["build", …]` (`package.json:21`) publishes the unregistered Jira client;
  users see `jira` in the tarball and assume support; the code is also in the CodeQL surface
  without tests behind an integration.
- **Design:** `files` negation `!build/**/jira/**` until ARCH-14 lands (E-8 either exposes it or
  moves it out); `npm run pack:check` = `npm pack --dry-run --json` asserted against an
  allowlist of top-level paths and a maximum unpacked size (500 KB), run in `npm run check` and
  CI; the check also fails on any `*.map` (H-9 keeps source maps out of the tarball) and any
  `test/` or `docs/instance/` file.
- **Acceptance:** the tarball has no `jira` path; the check fails when a new top-level directory
  appears in `build/` without being allow-listed.
- **Tests:** `pack:check` script itself.

### L9-05 — `package.json` lacks `exports`, `publishConfig`, `sideEffects`

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** **yes** for deep importers (none known) · **Target:** 3.0 · **→ D-6**
- **Gap:** `"main": "./build/index.js"` (`:20`) with no `exports` map — any path under `build/`
  is importable and therefore semver-relevant; no `publishConfig: {access, provenance: true}`
  (H-9 provenance is set in the workflow but not declared here); no `sideEffects: false`.
- **Design:** `exports: {".": "./build/index.js", "./package.json": "./package.json"}`
  (D-6's programmatic API adds `"./server"` when it lands); `publishConfig: {access: "public",
provenance: true}`; `sideEffects: false`; documented in the D-6 API section as the only
  supported entry points → register as **B10**-adjacent note (D-6).
- **Acceptance:** `import "servicenow-mcp-ai/build/core/http.js"` fails to resolve; the root
  import works; `npm publish --dry-run` shows provenance enabled.
- **Tests:** resolution test with `import.meta.resolve`.

### L9-06 — `ci.yml` has no `permissions`, `concurrency` or `timeout-minutes`

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-9**
- **Gap:** H-9 plans SHA pins and `permissions: read-all` for the release workflow; `ci.yml`
  (`.github/workflows/ci.yml`) runs five jobs with the default token permissions, no
  `concurrency` group (every push to a PR queues a full matrix), and no `timeout-minutes` (a hung
  `npm audit` holds a runner for 6 h).
- **Design:** top-level `permissions: {contents: read}`, `concurrency: {group:
ci-${{ github.ref }}, cancel-in-progress: true}`, `timeout-minutes: 20` per job, `actions/*`
  and `codecov/*` pinned to SHAs, `npm ci --ignore-scripts` where no build step is needed, and the
  `pack:check` job from L9-04.
- **Acceptance:** a second push to the same PR cancels the first run; the workflow lints clean
  under `actionlint`.
- **Tests:** `actionlint` in the lint step (via the pre-built binary, pinned).

### L9-07 — `.gitignore` does not cover `.env.<profile>` files

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-9**
- **Gap:** `.gitignore` lists `.env` and `.env.local`-style names; the multi-profile docs suggest
  copying `.env` per environment, and `.env.prod` / `.env.dev` / `.env.backup` (which
  `set_credentials`' atomic write may leave behind as `.env.tmp-*` on crash) match nothing and
  would be committed by `git add .`.
- **Design:** `.env.*` + `!.env.example`; `.env.tmp-*` explicitly; a CI step (`git ls-files |
grep -E '^\.env'` must return only `.env.example`); mention in CONTRIBUTING.
- **Acceptance:** `git status` ignores `.env.prod`; the CI step fails on a tracked `.env.x`.
- **Tests:** the CI step.

### L9-08 — Prettier idempotency is not enforced

- **Severity:** low · **Status:** VERIFIED (observed on `project/*.md`: `--write` needs two
  passes on tables) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-9**
- **Gap:** `npm run check` runs `format:check`; a contributor who ran `--write` once can still
  fail it; the cause is table re-alignment interacting with the default `proseWrap: preserve`.
- **Design:** `.prettierrc` gains `"proseWrap": "preserve"` explicitly and `"overrides":
[{files: "*.md", options: {printWidth: 100}}]`; `npm run format` runs `--write` twice; CI runs
  `format:check` after a `--write` on a temp copy and fails if the second pass changes anything
  (idempotency gate, 5 s).
- **Acceptance:** `npm run format && npm run format:check` passes on the first try on every file
  in the repo.
- **Tests:** the CI gate.

### L9-09 — `tsconfig` is not at the strictness the toolchain allows

- **Severity:** low · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 3.0 · **→ E-2**
- **Gap:** `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly` (TS 5.8+),
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are off; `scripts/ts-source-loader.mjs`
  exists only because the tree is not type-strip-clean, which also forces
  `--experimental-transform-types` in two npm scripts (`package.json:40,42`).
- **Design:** enable the five flags, fix the fallout (enums → `as const` objects, parameter
  properties → explicit fields), delete the loader, run `docs:readme`/`gen:manifest` with plain
  `--experimental-strip-types` (Node 22.6+) or on the built output.
- **Acceptance:** `tsc` clean with the flags; both scripts run without the custom loader; the
  launcher's Node-12 job still passes.
- **Tests:** existing suite; `npm run check`.

### L9-10 — No community standard files

- **Severity:** info · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ D-9** (new)
- **Gap:** no `CODEOWNERS`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `.github/ISSUE_TEMPLATE/*`,
  `PULL_REQUEST_TEMPLATE.md`, `.github/release.yml` (release-notes categories) or
  `FUNDING.yml`; GitHub's community profile shows the gaps and the D-6 "3.0 public API" goal
  implies external contributors.
- **Design:** the standard set, with the bug template asking for `doctor --json` (L4-05) and
  the support-bundle path (L7-03); PR template with the `npm run check` + manifest-regen
  checklist; `release.yml` categories matching the CHANGELOG headings.
- **Acceptance:** GitHub community profile 100 %; templates render.
- **Tests:** none (docs).

### L9-11 — SECURITY.md has no private reporting channel, supported-versions table or SLA

- **Severity:** med · **Status:** VERIFIED · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ D-9**
- **Gap:** SECURITY.md is a hardening guide; reporting a vulnerability is "open an issue" — public.
- **Design:** enable GitHub private vulnerability reporting; add "Supported versions" (2.x
  current, 1.x EOL date), "Reporting" (private advisory link, PGP optional), "Response targets"
  (ack 3 days, fix 30 days for high), "Scope" (what counts: SSRF, credential exposure, policy
  bypass; what doesn't: instance misconfiguration), and a "Threat model" summary linking
  DEEP-REVIEW §1.
- **Acceptance:** `SECURITY.md` follows the GitHub template; private reporting enabled
  (owner action, O-1 checklist).
- **Tests:** none (docs).

### L9-12 — Version sync already broken for the Claude plugin manifest

- **Severity:** low · **Status:** VERIFIED (C-5) · **Effort:** S · **Breaking:** no · **Target:** 2.x · **→ H-9**
- **Gap:** `.claude-plugin/plugin.json` says 2.0.0; H-9's version-sync test lists the VS Code
  extension and `server.json` — add the plugin manifest and `docs/` site badge to the same test
  so the next release cannot drift.
- **Design:** `test/version-sync.test.js` reads `package.json` version and asserts equality in
  `extension/package.json`, `server.json`, `.claude-plugin/plugin.json`, `docs/index.html` badge
  text (regex); `npm version` `postversion` hook rewrites them.
- **Acceptance:** the test is red on the current tree until the plugin manifest is bumped.
- **Tests:** the sync test.

## 11. Checked and OK (evidence added to existing items, no new finding)

| Area                              | What was checked                                                                                                                                                           | Result                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| HTTP bearer compare               | `src/mcp/transport.ts:22-25` uses `timingSafeEqual` with length guard                                                                                                      | OK — constant-time                                                               |
| Allowlist suffix match            | `src/core/host.ts:63-69` — `h === suffix \|\| h.endsWith("." + suffix)`                                                                                                    | OK — dot-anchored, `evil-service-now.com` cannot match                           |
| OAuth authorization-code callback | `src/core/oauth-login.ts:48-49` state compared; H-6 adds path + one-shot                                                                                                   | OK                                                                               |
| Retry backoff                     | `src/core/http-util.ts:123-126` exponential with 0–250 ms jitter, cap 8 s                                                                                                  | OK                                                                               |
| Retry policy                      | 429 any method; 502/503/504 GET only; `Retry-After` honoured ≤ 60 s                                                                                                        | OK (docs drift only — C-3)                                                       |
| Cache invalidation on credentials | `src/tools/admin.ts:132-134, 178-180` — tokens, schema cache, plugin availability cleared                                                                                  | OK (dispatcher not cleared → L1-04)                                              |
| Query logging                     | `src/tools/table.ts:78-202` `logFields: {table}` only                                                                                                                      | OK — README claim "raw queries are never logged" holds                           |
| Import-set policy                 | `src/api/importset.ts:23, 38` call `assertTableAllowed`                                                                                                                    | OK — C-1 correction                                                              |
| Journal-field redaction           | ROADMAP-V3 H-5 already extends redaction "to journal fields"                                                                                                               | Covered — L2-02 adds only version/chain/rotation                                 |
| Journal readable via `docs_read`  | `<docsDir>/<profile>/write-journal.md` resolves through `resolveDocPath` (`.md` allowed)                                                                                   | Acceptable once H-5 redacts journal fields; `docs_write` to it is refused by H-5 |
| Direct `snRequest` reads          | atf/diagnostics/capabilities/scripts                                                                                                                                       | Covered by H-4 (`ROADMAP-V3` bullet) — semantics refined in L3-05                |
| Destructive elicitation           | H-3 text already asks when the client advertises it                                                                                                                        | Covered — fallback specified in L5-04                                            |
| stdio transport EOF               | SDK 1.30 `StdioServerTransport` closes on read error; `SIGINT` handler present                                                                                             | OK (crash handlers → L6-03)                                                      |
| Tool annotations                  | 64/67 tools set all four hints; `destructiveHint` true only on delete/email/batch-with-writes                                                                              | OK (3 docs tools → L4-07)                                                        |
| `.env` file permissions           | `chmod 0600` best-effort on POSIX                                                                                                                                          | OK (win32 warning → L2-11)                                                       |
| Secret masking in `get_status`    | passwords/tokens never in the payload                                                                                                                                      | OK                                                                               |
| `docs_write` path traversal       | `resolveDocPath` rejects `..`, absolute, wrong extension; H-5 adds realpath                                                                                                | OK (reserved names → L2-10)                                                      |
| SDK 1.30 features used            | `registerTool` `title`, `outputSchema` support present in SDK; server `title`/`websiteUrl`/`icons`, `completable`, `sseKeepAlive`, experimental tasks available but unused | Planned: M-1, M-4, H-7, M-9                                                      |

## 12. Not checkable offline

| Item                                                                                             | Why                                                                     | How to verify when online                                                       |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| ServiceNow rate-limit headers (`X-RateLimit-*`) and their exact names per release family (L1-07) | needs an instance with a REST rate-limit rule                           | curl a rate-limited endpoint on a PDI with a rule; record headers in E-6 double |
| Refresh-token rotation behaviour of the ServiceNow OAuth provider (L6-01)                        | depends on the OAuth entity's "refresh token lifespan"/rotation setting | run `refresh_token` grant twice on a PDI; compare tokens                        |
| Whether the instance silently ignores unknown fields on PATCH in every family (L2-06)            | platform behaviour                                                      | PATCH with a bogus field on Washington/Xanadu/Yokohama PDIs                     |
| Batch API sub-request limit and body-size ceiling (L2-03)                                        | instance property                                                       | `sys_properties` `glide.rest.batch.*` on a PDI                                  |
| dotenv single-quote literal semantics across dotenv 16/17 (L2-11)                                | pinned dependency version at implementation time                        | property test in the repo (round-trip)                                          |
| undici `EnvHttpProxyAgent` + custom `connect` TLS options composition (L1-01/L1-03)              | needs a proxy test rig                                                  | local CONNECT proxy in the E-6 rig                                              |
| GitHub private vulnerability reporting availability on the repo (L9-11)                          | owner setting                                                           | repo Settings → Security                                                        |

## 13. Finding → roadmap item index

| Finding | Sev  | Item     | Finding | Sev  | Item          | Finding | Sev  | Item    |
| ------- | ---- | -------- | ------- | ---- | ------------- | ------- | ---- | ------- |
| L1-01   | med  | H-10     | L2-13   | med  | H-7/D-2 (B12) | L5-04   | med  | H-3     |
| L1-02   | low  | H-10     | L2-14   | info | S-8/S-11      | L5-05   | low  | M-8     |
| L1-03   | high | H-10     | L3-01   | high | H-11 (B11)    | L5-06   | low  | H-7     |
| L1-04   | low  | H-10/E-3 | L3-02   | med  | H-11          | L6-01   | high | D-2     |
| L1-05   | low  | H-10     | L3-03   | med  | H-11          | L6-02   | med  | D-2     |
| L1-06   | med  | H-10     | L3-04   | low  | H-11/M-7      | L6-03   | low  | E-9     |
| L1-07   | low  | H-10/E-5 | L3-05   | low  | H-11          | L6-04   | low  | E-3/E-9 |
| L1-08   | med  | H-10/M-2 | L3-06   | med  | S-13          | L6-05   | low  | S-7     |
| L1-09   | med  | H-10     | L3-07   | low  | S-10          | L6-06   | low  | S-13    |
| L1-10   | high | H-10     | L4-01   | low  | M-1           | L7-01   | low  | E-5     |
| L2-01   | med  | H-5      | L4-02   | med  | M-5/M-7       | L7-02   | info | E-5     |
| L2-02   | med  | H-5      | L4-03   | med  | M-7 (B13)     | L7-03   | low  | D-1     |
| L2-03   | med  | H-4/H-5  | L4-04   | med  | M-1/E-5       | L8-01   | low  | D-2/M-1 |
| L2-04   | med  | H-5      | L4-05   | low  | D-1           | L9-01   | med  | E-6     |
| L2-05   | med  | H-3      | L4-06   | low  | H-3/H-6       | L9-02   | low  | E-6     |
| L2-06   | med  | M-8/H-3  | L4-07   | info | M-8           | L9-03   | low  | E-6     |
| L2-07   | med  | M-8/M-6  | L4-08   | low  | D-3           | L9-04   | med  | H-9/E-8 |
| L2-08   | low  | E-9      | L5-01   | high | M-6/E-6       | L9-05   | low  | D-6     |
| L2-09   | med  | H-6      | L5-02   | low  | M-9           | L9-06   | med  | H-9     |
| L2-10   | low  | H-6      | L5-03   | low  | M-4           | L9-07   | med  | H-9     |
| L2-11   | med  | D-2/E-4  |         |      |               | L9-08   | low  | H-9     |
| L2-12   | low  | E-4/D-5  |         |      |               | L9-09   | low  | E-2     |
|         |      |          |         |      |               | L9-10   | info | D-9     |
|         |      |          |         |      |               | L9-11   | med  | D-9     |
|         |      |          |         |      |               | L9-12   | low  | H-9     |

## 14. Deltas applied to ROADMAP-V3 (2026-09-09)

**New items** (full definitions in [ROADMAP-V3.md](../ROADMAP-V3.md)):

| Id       | Title                                               | Findings                        | Effort | Target | Breaking |
| -------- | --------------------------------------------------- | ------------------------------- | ------ | ------ | -------- |
| **H-10** | HTTP client resilience and identity                 | L1-01 … L1-10                   | M      | 2.x    | no       |
| **H-11** | Policy model v2 (patterns, protected tables, caps)  | L3-01 … L3-05                   | M      | 3.0    | B11      |
| **S-13** | Capability preflight v2                             | L3-06, L6-06                    | M      | 2.x    | no       |
| **M-9**  | Long-running operations as MCP tasks (experimental) | L5-02 (+ S-7, S-10, S-11 hooks) | M      | 3.x    | no       |
| **D-9**  | Security policy and community standard              | L9-10, L9-11                    | S      | 2.x    | no       |
| **E-9**  | Process lifecycle and bounded state                 | L6-03, L6-04, L2-08             | S      | 2.x    | no       |

**Breaking register additions:** **B11** protected tables write-denied by default (H-11) ·
**B12** `use_instance` no longer persists `SN_ACTIVE_PROFILE` unless `persist:true` (L2-13) ·
**B13** profile-scoped resource templates move under `servicenow://profiles/…`; seven profile
names become reserved (L4-03).

**Extended definitions of done** (a `_(gap pass 2026-09-09)_` bullet in each): H-3, H-4, H-5,
H-6, H-7, H-9, M-1, M-4, M-5, M-6, M-7, M-8, S-7, S-8, S-10, S-11, D-1, D-2, D-3, D-5, D-6, E-2,
E-3, E-4, E-5, E-6, E-8.

**Corrected:** the H-4 import-set bullet (C-1); the Status line now records this pass.

**Recommended cut change:** H-10 and E-9 join the 2.x-line "hardening first" batch immediately
after H-2 (they are small, non-breaking and fix silent misconfigurations); H-11 joins the 3.0
breaking cluster behind O-4; S-13 precedes M-5 (the overview prompt depends on it); M-9 stays
stretch. The sequencing table in ROADMAP-V3 has the new rows.

**Not changed:** the four owner gates, the "Explicitly NOT in 3.0" list, and the exit criteria
except for one added bullet ("no finding of severity high in GAP-ANALYSIS-2026-09 remains open").
