# Security

## Reporting

Report vulnerabilities privately to <ivanbbaev@gmail.com> or via
[GitHub issues](https://github.com/IvanBBaev/servicenow-mcp-ai/issues).

## Security model (summary)

- **Transport:** stdio by default; logs go to stderr as structured JSON. The
  optional Streamable HTTP transport (`SN_TRANSPORT=http`, DF-6) binds to
  loopback (`127.0.0.1`) by default and supports an `SN_HTTP_TOKEN` bearer
  guard (constant-time check); widening the bind (`SN_HTTP_HOST`) and TLS
  termination are the operator's responsibility. The password/token is never
  logged and never returned by any tool.
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
