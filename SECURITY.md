# Security policy

This policy covers `servicenow-mcp-ai` — the MCP server and CLI published to npm,
the VS Code extension and the Claude Code plugin with its skills. It tells you
which versions get security fixes, how to report a vulnerability privately,
what to expect after you do, and which safety rails the server already has.

## Supported versions

| Version | Status                                                         | Security fixes                           |
| ------- | -------------------------------------------------------------- | ---------------------------------------- |
| 3.x     | Planned ([ROADMAP-V3.md](project/ROADMAP-V3.md)); not released | —                                        |
| 2.x     | Current line                                                   | Yes — fixes ship in the next 2.x release |
| < 2.0   | Superseded by 2.0.0 (2026-06-22)                               | No — upgrade to the latest 2.x           |

Only the latest published release of a supported line receives fixes; there
are no backports to older patch releases. The VS Code extension and the
Claude Code plugin carry the same version as the npm package
(`scripts/sync-version.mjs`) and follow the same table. When 3.0.0 ships, this
table will state how long 2.x keeps receiving security fixes.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately through GitHub:
[Security → Advisories → Report a vulnerability](https://github.com/IvanBBaev/servicenow-mcp-ai/security/advisories/new).
The report is visible only to you and the maintainer, the fix can be prepared
in a private fork, and a CVE can be requested through the advisory. If that
form is not available, write to the maintainer at <ivanbbaev@gmail.com> with
"servicenow-mcp-ai security" in the subject.

Please include:

- the affected version (`servicenow-mcp-ai --version`) and how it is installed
  (npm / `npx`, VS Code extension, Claude Code plugin);
- the transport (stdio or `SN_TRANSPORT=http`) and the MCP client;
- the relevant settings — names and non-secret values only (the output of
  `servicenow-mcp-ai support-bundle` has secrets masked; review it before
  sharing);
- the steps to reproduce, the impact you expect, and a proof of concept if you
  have one.

Never send real credentials, tokens or production data. Test against a
personal developer instance (PDI) where you can.

## Response targets

These are **targets** for a single-maintainer project, not a contractual SLA:

| Step                                                   | Target                               |
| ------------------------------------------------------ | ------------------------------------ |
| Acknowledge the report                                 | within 3 business days               |
| Triage — confirm, assess severity, agree on next steps | within 7 days of the acknowledgement |
| Fix released — critical / high severity                | within 30 days of triage             |
| Fix released — medium / low severity                   | in the next planned release          |

You will be kept informed while the report is open. The fix is released first,
then the advisory is published with credit to the reporter unless you prefer to
stay anonymous. Please allow the fix to ship before disclosing publicly; if a
target slips, you will be told why and when to expect the fix.

## Scope

In scope — vulnerabilities in the code of this repository:

- the MCP server and CLI (`src/`, `bin/`; the npm package `servicenow-mcp-ai`),
  including both transports, the env-file writer, the OAuth login flow, the
  docs store, the write journal and `support-bundle`;
- the VS Code extension (`extension/`);
- the Claude Code plugin and its skills (`.claude-plugin/`, `skills/`);
- the release pipeline (`.github/workflows/`) — anything that could tamper
  with a published artefact.

Typical examples: a bypass of the host guard / SSRF guard, the table or package
policy, `SN_READONLY` or plan mode; credential or secret exposure (logs, tool
results, errors, the journal, the support bundle); path traversal out of the
docs store; a redaction bypass; an authentication bypass on the HTTP transport;
tampering with the write journal.

Out of scope:

- the ServiceNow platform itself — report those to ServiceNow;
- the configuration of your instance (ACLs, roles, OAuth application
  settings, instance properties) and what a correctly authenticated user is
  allowed to do there;
- behaviour after an operator explicitly opts out of a safety default
  (`SN_WRITE_MODE=apply`, `SN_TLS_REJECT_UNAUTHORIZED=false`,
  `SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1`, a broad `SN_ALLOWED_HOSTS` entry,
  a non-loopback `SN_HTTP_HOST` without `SN_HTTP_TOKEN`);
- the MCP client or the model — a prompt injection is in scope only where it
  defeats one of the rails below;
- vulnerabilities in dependencies with no demonstrated impact on this project
  (report those upstream; the production audit gate below catches published
  advisories);
- the Jira client scaffold, which exposes no tools yet;
- the limitations this document already lists as not covered.

## Threat model

The server acts on a ServiceNow instance with the configured user's rights, on
behalf of a model whose input may include untrusted instance data. The main
threats are credential exfiltration to an unintended host, writes the operator
did not intend (including prompt-injected ones), reads of data the operator
excluded by policy, and leaking secrets or PII through results, logs or local
files. The layered model is described in
[ARCHITECTURE.md § 4 Security model](project/ARCHITECTURE.md#4-security-model-two-axes--network-guards);
the audit behind the current hardening — findings, verified-good controls and
open items — is in
[DEEP-REVIEW-2026-09.md § 3](project/archive/DEEP-REVIEW-2026-09.md#3-security--write-safety-audit).

## Security rails at a glance

- **Plan mode** — writes preview as a before/after diff and do not mutate
  unless `apply: true` is passed or `SN_WRITE_MODE=apply` is set; a
  destructive apply needs the single-use `plan_token` of its preview by
  default (`SN_DESTRUCTIVE_CONFIRM=token`, 3.0), optionally with a client
  confirmation (`elicit`)
  ([README → Environment variables](README.md#environment-variables)).
- **Write journal** — every applied write is recorded locally in a hash-chained
  `write-journal.jsonl` (redacted, rotated at `SN_JOURNAL_MAX_BYTES`) and can
  be listed and reverted
  ([README → Undo a write](README.md#undo-a-write-journal-based-revert)).
- **Redaction** — `SN_REDACT_FIELDS` / `SN_REDACT_PII` apply to every tool
  result and to the journal (see the hardened defaults below).
- **Secret columns are always masked** — a column whose dictionary type is
  `password`, `password2` or `glide_encrypted` is masked as `[redacted]` in
  every tool result and in the journal, whatever `SN_REDACT_FIELDS` says; it
  cannot be turned off (N-21, see the hardened defaults below).
- **Host guard** — only `*.service-now.com` without `SN_ALLOWED_HOSTS`; an SSRF
  guard for internal and loopback addresses; no redirects; capped bodies
  ([README → Security notes](README.md#security-notes)).
- **Credential host binding** — a profile cannot be moved to another instance
  without that instance's own credentials, and credential changes need client
  confirmation (see the security model below).
- **Two-axis policy** — tables (`SN_TABLES_ALLOW` / `SN_TABLES_DENY`,
  `SN_READONLY`) and packages (`SN_PACKAGES_DENY` / `SN_PACKAGES_READONLY`)
  ([README → Two-axis access policy](README.md#two-axis-access-policy)).

The details follow.

## Security model (summary)

- **Transport:** stdio by default; logs go to stderr as structured JSON. The
  optional Streamable HTTP transport (`SN_TRANSPORT=http`, DF-6) binds to
  loopback (`127.0.0.1`) by default and supports an `SN_HTTP_TOKEN` bearer
  guard (constant-time check); widening the bind (`SN_HTTP_HOST`) and TLS
  termination are the operator's responsibility. The password/token is never
  logged and never returned by any tool.
- **HTTP sessions and DNS rebinding (H-7):** every MCP session over HTTP has
  its own server and state (packages, logging level, plan tokens, write caps,
  the profile chosen with `use_instance`), so one client's switch or toggle
  never reaches another; a session ends on DELETE or after
  `SN_HTTP_SESSION_TTL_SEC` idle, and at most `SN_HTTP_MAX_SESSIONS` are open.
  The `Host` header is checked against `SN_HTTP_ALLOWED_HOSTS` (default: the
  loopback names on a loopback bind) and a browser `Origin` against
  `SN_HTTP_ALLOWED_ORIGINS` (default: loopback origins) before the token check,
  so a web page that rebinds its name to 127.0.0.1 is refused with 403. On a
  non-loopback bind without `SN_HTTP_ALLOWED_HOSTS` the Host is not checked
  and a warning is logged. `/healthz` and `/readyz` answer without the token
  and reveal only up / configured; `/readyz?probe=1` calls the instance and
  needs the token. `SN_HTTP_REQUIRE_TOKEN=1` turns the open-bind warning into
  a refusal to start (planned default in 3.0). A session-scoped
  `use_instance` writes nothing; `persist: true` writes the env file and a
  journal entry.
- **Credentials:** a git-ignored env file (`SN_ENV_FILE`, then
  `~/.config/servicenow-mcp-ai/.env`, then the project `.env`); real environment
  variables take precedence. Runtime updates go through
  `servicenow_set_credentials`; moving a configured profile to another
  instance requires the user and password for that host in the same call
  (`CREDENTIALS_INCOMPLETE` otherwise, nothing written), and every change must
  be confirmed by the MCP client through elicitation — a client that cannot
  confirm is refused unless the operator sets
  `SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1`.
- **Two-axis policy:** `SN_TABLES_ALLOW`/`SN_TABLES_DENY` + `SN_READONLY`
  govern the Table API; `SN_PACKAGES_DENY`/`SN_PACKAGES_READONLY` govern the
  plugin-backed APIs. **A table deny does not restrict the plugin APIs** — use
  the package axis for those (see the README security notes).
- **Network:** HTTPS to the instance, an SSRF guard for internal/loopback
  hosts, and a host-suffix restriction — without `SN_ALLOWED_HOSTS`, only
  `*.service-now.com` instances are contacted, so a redirected or mistyped host
  cannot silently receive credentials. Per-request timeout, retry with backoff,
  and a result-size guard round it out. Outbound traffic can go through a proxy
  (`SN_HTTPS_PROXY`, else `HTTPS_PROXY` / `HTTP_PROXY` with `NO_PROXY`); proxy
  credentials are never logged or returned. Every request carries an identifying
  `User-Agent` (`servicenow-mcp-ai/<version> (node/<major>; <transport>; <client>)`,
  extendable with `SN_USER_AGENT_SUFFIX`) so the instance transaction log can
  attribute it. A total deadline (`SN_DEADLINE_MS`) and a bounded per-host queue
  (`SN_MAX_QUEUE`, `SN_QUEUE_TIMEOUT_MS` → `BUSY`) keep a slow or saturated
  instance from pinning the process. Redirects are never followed
  (`REDIRECT_BLOCKED` names the target host) and every response body is capped
  (`SN_MAX_BODY_BYTES`, default 50 MiB). Mail from `servicenow_send_email` only
  reaches `SN_EMAIL_ALLOWED_DOMAINS`, or by default users in the instance's own
  directory.
- **Env file:** written owner-only (`0600`); it holds a plaintext password and
  is never group/world-readable.
- **Secrets from files** (D-5): every secret setting (`SN_PASSWORD`,
  `SN_API_KEY`, `SN_BEARER_TOKEN`, `SN_OAUTH_CLIENT_SECRET`,
  `SN_OAUTH_REFRESH_TOKEN`, `SN_HTTP_TOKEN` and the `SN_PROFILE_<NAME>_*`
  forms) can come from `<KEY>_FILE` — Docker / Kubernetes secrets — so it
  never sits in the process environment of the launcher or in an env file.
  Both `<KEY>` and `<KEY>_FILE` set, or an unreadable / empty file, stops the
  server at startup with a message that names the setting and never the value;
  a file-sourced value is never written back to the env file. The server does
  not check the file's mode (Docker secrets are mounted `0444`); restrict
  access with the mount and the container user.

## Hardened defaults

Earlier single-user builds accepted two risks; for the public release the
conservative defaults win, and both are now enforced in code (with tests):

- **Env-file mode `0600`** instead of the default `0644` (`config.ts`).
- **3.0 write-safety defaults** (O-4, breaking B4 / B8 / B11): a destructive
  `apply:true` needs the preview's `plan_token` (`SN_DESTRUCTIVE_CONFIRM=token`;
  `off` opts out); a batch sub-request to a REST path no tool package owns is
  refused (`SN_BATCH_UNMAPPED=deny`; `allow` opts out) and a batch holds at
  most 50 sub-requests (`SN_BATCH_MAX_REQUESTS`); writes to the protected
  system tables (identity, roles, ACLs, `sys_properties`, OAuth, scripts,
  LDAP, certificates, data sources, REST messages) are refused
  (`SN_PROTECTED_TABLES_WRITE=deny`; `allow` or an exact `SN_TABLES_ALLOW`
  entry opts out); import-set staging tables must match `u_*,imp_*`
  (`SN_IMPORT_SET_TABLES=*` opts out); and the write caps are on — 100 deletes
  per session, 50 write sub-requests per batch, 500 writes per HTTP session
  (`0` lifts a cap). The Claude Code plugin also ships a `PreToolUse` hook
  that refuses a token-less destructive apply at the client. Its
  `SessionStart` hook reads only an allowlist of non-secret keys from the
  local env file (no network call) and never prints a user name, password or
  token; its two subagents are limited to read-only tools.
- **Host must be `*.service-now.com`** unless `SN_ALLOWED_HOSTS` is set
  (`host.ts`). Set `SN_ALLOWED_HOSTS` to opt in a custom or sovereign-cloud
  domain; the SSRF guard and X-2 elicitation confirmation still apply on top.
- **Credential changes fail closed** (`admin.ts`, H-2): a new instance needs
  its own user + password in the same call, and a client without elicitation
  support cannot change credentials unless
  `SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1` is set. An explicit decline is
  always refused.
- **Crash lines are bounded and secret-free** (`lifecycle.ts`, E-9): an unhandled
  rejection or uncaught exception logs one structured line (pid, uptime, transport, error
  name, message capped at 2000 chars — never a stack or the raw reason object, which could
  carry payloads or credentials) and exits 1, so a possibly corrupt process does not keep
  serving.
- **Explicit ports and IPv6 literals are allow-list only** (`host.ts`, H-10): an
  instance value with a non-443 port or a bracketed IPv6 address is accepted only
  when an `SN_ALLOWED_HOSTS` entry names it, so a crafted `host:port` cannot steer
  credentials to an unexpected service. TLS settings (`SN_TLS_CA[_FILE]`,
  `SN_TLS_REJECT_UNAUTHORIZED`) now apply without a client certificate — earlier
  builds silently ignored them — and `SN_TLS_REJECT_UNAUTHORIZED=false` logs a
  warning the first time a connection is built. Upstream HTML error pages are
  tag-stripped and capped (`UPSTREAM_HTML`) so a proxy or login page cannot flood
  a tool result.
- **Outbound hardening** (H-6): an `SN_ALLOWED_HOSTS` suffix entry never opens an
  internal/loopback host (IPv4 and IPv6 ranges, including IPv4-mapped forms) —
  list the host exactly to reach it. Redirects fail with `REDIRECT_BLOCKED`;
  response bodies stop at `SN_MAX_BODY_BYTES`. `send_email` recipients must be
  inside `SN_EMAIL_ALLOWED_DOMAINS` or, without it, match a `sys_user` email (a
  failed lookup fails closed). Uploads are capped before decoding
  (`SN_MAX_UPLOAD_BYTES`), file names are reduced to a sanitised leaf name and
  `SN_UPLOAD_MIME_ALLOW` restricts content types. The docs store rejects Windows
  device names, `:` streams and symlink escapes, and caps files at
  `SN_DOCS_MAX_FILE_BYTES`. The OAuth callback checks path and `state` before
  exchanging a code, and TLS verification off is reported at startup and in
  `get_status`. Not covered: a public name that resolves to an internal address
  (no connect-time DNS check yet).
- **Container image is non-root and warns on an open bind** (`Dockerfile`,
  `transport.ts`, D-5): the image runs distroless Node as uid 65532 with no
  shell and serves HTTP on `0.0.0.0`; binding any non-loopback host without
  `SN_HTTP_TOKEN` logs a warning at startup (`SN_HTTP_REQUIRE_TOKEN=1` makes
  it a refusal). `SN_HTTP_TOKEN` is required for any non-loopback bind —
  without it every client that reaches the port acts with the configured
  ServiceNow credentials.
- **Redaction reaches display-value pairs** (`redact.ts`, H-8): with
  `sysparm_display_value=all` or reference links, PII is masked in every
  string of a `{ value, display_value, link }` field object, not only in
  plain string fields.
- **Type-based secret masking** (`api/secret-columns.ts`,
  `core/secret-columns.ts`, N-21): every Table API read and write (direct or
  in a batch) resolves which of its columns are secret from a cached
  `sys_dictionary` index (`internal_type` `password`, `password2`,
  `glide_encrypted`) and the table's inheritance chain. Those columns are
  masked as `[redacted]` at the result boundary and in the write journal,
  dot-walked keys and `{ value, display_value }` pairs included, and their
  values are masked wherever a tool re-embeds them in the same call (a diff,
  a document, an export). Password-type system properties are masked the same
  way. When the dictionary cannot be read (ACL, policy, error) the read is
  never blocked: a list of OOTB secret column names (`password`,
  `user_password`, `client_secret`, …) applies, as it always does as a floor.
  No setting turns this off. Limits: other REST surfaces (CMDB, import set,
  plugin APIs) are masked by those names only; values shorter than four
  characters are masked by their key only; catalog `masked` variables are not
  dictionary columns and are out of scope.

## Supply chain

- The production dependency tree is audited on every gate run and in CI:
  `npm audit --omit=dev --audit-level=high` is the last step of `npm run check`,
  which `prepublishOnly` runs as well, so a release cannot ship with a known
  HIGH advisory in what gets installed. Fixes are lock-only (no `overrides`,
  no `--force`); the procedure is in
  [CONTRIBUTING.md](CONTRIBUTING.md#dependencies-and-the-audit-gate).
- The runtime dependency set is deliberately three packages —
  `@modelcontextprotocol/sdk`, `zod` and `acorn` (the S-12 script parser, no
  dependencies of its own; it only parses script text read from the instance
  and never evaluates it; the env file is read by Node's own
  `process.loadEnvFile` since E-2) — with the SDK floor tracking the release
  the suite was last verified against (`^1.31.0`).
- Dependabot (weekly: npm root, `extension/`, GitHub Actions) and CodeQL run on
  the repository; npm publishes are made from CI on a version tag with
  `--provenance`.
- GitHub Actions are pinned to commit SHAs (the version rides in a comment;
  Dependabot moves the pins), every workflow declares least-privilege
  `permissions` (`contents: read`, plus `id-token: write` only where a publish
  needs OIDC), and the MCP Registry publisher binary is a versioned release
  verified against its `sha256` checksums file before it runs.
- `npm run pack:check` (part of the gate and of CI) fails when the tarball would
  contain anything outside `build/`, `bin/`, `README.md`, `LICENSE` and
  `package.json` — source maps, tests and the dark Jira client never ship.

## OWASP MCP Top 10 mapping

How each risk in the
[OWASP MCP Top 10 (2025)](https://owasp.org/www-project-mcp-top-10/) is met by
controls in this repository, the tests that pin them, and what is still open.
"Out of scope" marks a risk that belongs to the MCP client or the host
environment rather than to this server. `test/scan-surface.test.js` checks that
the table names all ten risks and that every file cited here exists.

| Risk                                                       | Controls in this repository                                                                                                                                                                                                                                                                                                                                                                                                                    | Tests                                                                                                                                                | Gaps / out of scope                                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP01 Token Mismanagement & Secret Exposure                | Secrets come from the env file or `*_FILE` secret files (`src/core/secret-files.ts`, `src/core/config.ts`), never from tool arguments except the confirmed admin credentials tool; field and PII redaction on every result and in the journal (`src/core/redaction.ts`, `src/mcp/redact.ts`); credentials are bound to their instance host (`src/core/host.ts`).                                                                               | `test/secret-files.test.js`, `test/redact.test.js`, `test/support-bundle.test.js`, `test/admin-credentials.test.js`                                  | Secrets at rest in the env file are protected only by file permissions; no OS keychain integration.                                        |
| MCP02 Privilege Escalation via Scope Creep                 | Two-axis policy — tables and packages, read-only modes (`src/core/policy.ts`, `src/mcp/packages.ts`); plan mode by default and a single-use `plan_token` for destructive applies (`src/mcp/write-mode.ts`, `src/mcp/plan-token.ts`).                                                                                                                                                                                                           | `test/policy.test.js`, `test/dynamic-packages.test.js`, `test/write-mode.test.js`, `test/plan-token.test.js`                                         | The server acts with the configured ServiceNow user's rights; least privilege on the instance (roles, ACLs) is the operator's job.         |
| MCP03 Tool Poisoning                                       | `npm run scan:surface` (`scripts/scan-surface.mjs`, N-56) scans every tool, parameter, prompt and resource text plus `skills/`, `agents/`, `hooks/` and `.claude-plugin/` for invisible Unicode, hidden instructions, cross-tool directives and unlisted URLs, and checks descriptions against the pinned `description_sha256`; the manifest snapshot pins the whole surface.                                                                  | `test/scan-surface.test.js`, `test/manifest-snapshot.test.js`, `test/plugin-skills.test.js`, `test/plugin-hook.test.js`                              | No third-party scanner (for example mcp-scan) runs in CI yet; the rules are pattern based and cannot judge intent.                         |
| MCP04 Software Supply Chain Attacks & Dependency Tampering | Three runtime dependencies; `npm audit` in the gate; Dependabot and CodeQL (`.github/dependabot.yml`, `.github/workflows/codeql.yml`); SHA-pinned actions with least-privilege permissions (`.github/workflows/ci.yml`); provenance publishes (`.github/workflows/publish.yml`); tarball allow-list (`scripts/pack-check.mjs`). See [Supply chain](#supply-chain).                                                                             | `test/dependencies.test.js`, `test/security-scan.test.js`                                                                                            | No SBOM is published; the VS Code extension is a separate dependency tree.                                                                 |
| MCP05 Command Injection & Execution                        | No `eval` or dynamic code: instance scripts are only parsed (`src/api/script-ast.ts`, acorn). The two child processes use argument arrays, not a shell — the OAuth browser open (`src/core/oauth-login.ts`; on Windows `rundll32 url.dll,FileProtocolHandler`, not `cmd /c start`, and http(s) URLs only) and the support bundle's `npm ls` (`src/api/support-bundle.ts`, a shell on Windows only, with fixed arguments).                      | `test/scripts.test.js`, `test/oauth.test.js`, `test/support-bundle.test.js`                                                                          | None open. The Windows `cmd /c start` URL split was closed in N-56.                                                                        |
| MCP06 Prompt Injection via Contextual Payloads             | Instance data reaching the model through prompts, resources and server info is wrapped in an untrusted-content boundary (`src/mcp/boundary.ts`); writes cannot mutate without plan → token → apply, so an injected write still needs the preview's token (`src/mcp/plan-token.ts`).                                                                                                                                                            | `test/server-info.test.js`, `test/completions.test.js`, `test/plan-token.test.js`                                                                    | Tool results (record fields) are returned as data without a boundary marker; the client and model remain the last line of defence.         |
| MCP07 Insufficient Authentication & Authorization          | stdio by default; the HTTP transport binds to loopback, requires a constant-time-checked bearer token (`SN_HTTP_TOKEN`) for any non-loopback bind, checks `Host` against an allow-list (DNS rebinding) and isolates sessions (`src/mcp/transport.ts`, `src/mcp/http-sessions.ts`); outbound requests go only to allowed instance hosts, with an SSRF guard and no redirects (`src/core/host.ts`); credential changes need client confirmation. | `test/transport.test.js`, `test/http-transport-v2.test.js`, `test/auth.test.js`, `test/outbound-hardening.test.js`, `test/admin-credentials.test.js` | The HTTP token is one shared secret, not per-user authorization (no OAuth resource-server role); the server cannot tell MCP clients apart. |
| MCP08 Lack of Audit and Telemetry                          | Hash-chained, redacted write journal with revert (`src/core/write-journal.ts`); structured JSON logs and metrics (`src/core/logging.ts`, `src/core/metrics.ts`, `src/mcp/observability.ts`).                                                                                                                                                                                                                                                   | `test/write-journal.test.js`, `test/journal-v2.test.js`, `test/observability.test.js`                                                                | Reads are logged but not journaled; OpenTelemetry spans are pending (N-55).                                                                |
| MCP09 Shadow MCP Servers                                   | Mostly out of scope (inventory of servers is the client's and the organisation's job). The server is published under one name with provenance and a registry entry (`.github/workflows/publish-mcp.yml`, `server.json`), so an installed copy can be traced to its source.                                                                                                                                                                     | `test/distribution.test.js`, `test/version-sync.test.js`                                                                                             | No runtime self-attestation (for example a signed server identity) beyond the npm provenance.                                              |
| MCP10 Context Injection & Over-Sharing                     | Field and PII redaction (`src/core/redaction.ts`); capped response bodies and paged results; table deny-lists keep excluded data out of the context (`src/core/policy.ts`); HTTP sessions do not share state (`src/mcp/http-sessions.ts`).                                                                                                                                                                                                     | `test/redact.test.js`, `test/policy.test.js`, `test/http-transport-v2.test.js`                                                                       | What a granted read returns is still visible to the model; redaction is opt-in beyond the default secret fields.                           |

## Trademark

`servicenow-mcp-ai` is an independent, community-built project and is **not
affiliated with, endorsed by, or sponsored by ServiceNow, Inc.** "ServiceNow",
the ServiceNow logo, "Now", and related marks are trademarks or registered
trademarks of ServiceNow, Inc., used here only nominatively to indicate
compatibility with the ServiceNow platform. See the README for the full notice.
