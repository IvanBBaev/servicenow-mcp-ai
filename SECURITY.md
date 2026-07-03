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
  `servicenow_set_credentials`.
- **Two-axis policy:** `SN_TABLES_ALLOW`/`SN_TABLES_DENY` + `SN_READONLY`
  govern the Table API; `SN_PACKAGES_DENY`/`SN_PACKAGES_READONLY` govern the
  plugin-backed APIs. **A table deny does not restrict the plugin APIs** — use
  the package axis for those (see the README security notes).
- **Network:** HTTPS to the instance, an SSRF guard for internal/loopback
  hosts, and a host-suffix restriction — without `SN_ALLOWED_HOSTS`, only
  `*.service-now.com` instances are contacted, so a redirected or mistyped host
  cannot silently receive credentials. Per-request timeout, retry with backoff,
  and a result-size guard round it out.
- **Env file:** written owner-only (`0600`); it holds a plaintext password and
  is never group/world-readable.

## Hardened defaults

Earlier single-user builds accepted two risks; for the public release the
conservative defaults win, and both are now enforced in code (with tests):

- **Env-file mode `0600`** instead of the default `0644` (`config.ts`).
- **Host must be `*.service-now.com`** unless `SN_ALLOWED_HOSTS` is set
  (`host.ts`). Set `SN_ALLOWED_HOSTS` to opt in a custom or sovereign-cloud
  domain; the SSRF guard and X-2 elicitation confirmation still apply on top.

## Trademark

`servicenow-mcp-ai` is an independent, community-built project and is **not
affiliated with, endorsed by, or sponsored by ServiceNow, Inc.** "ServiceNow",
the ServiceNow logo, "Now", and related marks are trademarks or registered
trademarks of ServiceNow, Inc., used here only nominatively to indicate
compatibility with the ServiceNow platform. See the README for the full notice.
