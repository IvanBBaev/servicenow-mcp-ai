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
[DEEP-REVIEW-2026-09.md § 3](project/DEEP-REVIEW-2026-09.md#3-security--write-safety-audit).

## Security rails at a glance

- **Plan mode** — writes preview as a before/after diff and do not mutate
  unless `apply: true` is passed or `SN_WRITE_MODE=apply` is set;
  `SN_DESTRUCTIVE_CONFIRM` adds a single-use `plan_token` and / or a client
  confirmation for destructive writes
  ([README → Environment variables](README.md#environment-variables)).
- **Write journal** — every applied write is recorded locally in a hash-chained
  `write-journal.jsonl` (redacted, rotated at `SN_JOURNAL_MAX_BYTES`) and can
  be listed and reverted
  ([README → Undo a write](README.md#undo-a-write-journal-based-revert)).
- **Redaction** — `SN_REDACT_FIELDS` / `SN_REDACT_PII` apply to every tool
  result and to the journal (see the hardened defaults below).
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

## Supply chain

- The production dependency tree is audited on every gate run and in CI:
  `npm audit --omit=dev --audit-level=high` is the last step of `npm run check`,
  which `prepublishOnly` runs as well, so a release cannot ship with a known
  HIGH advisory in what gets installed. Fixes are lock-only (no `overrides`,
  no `--force`); the procedure is in
  [CONTRIBUTING.md](CONTRIBUTING.md#dependencies-and-the-audit-gate).
- The runtime dependency set is deliberately three packages —
  `@modelcontextprotocol/sdk`, `zod`, `dotenv` — with the SDK floor tracking
  the release the suite was last verified against (`^1.30.0`).
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

## Trademark

`servicenow-mcp-ai` is an independent, community-built project and is **not
affiliated with, endorsed by, or sponsored by ServiceNow, Inc.** "ServiceNow",
the ServiceNow logo, "Now", and related marks are trademarks or registered
trademarks of ServiceNow, Inc., used here only nominatively to indicate
compatibility with the ServiceNow platform. See the README for the full notice.
