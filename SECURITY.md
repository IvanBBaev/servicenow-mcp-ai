# Security

## Reporting

Report vulnerabilities privately to <ivanbbaev@gmail.com> or via
[GitHub issues](https://github.com/LeassTaTT/servicenow-mcp/issues).

## Security model (summary)

- **Transport:** stdio only; logs go to stderr as structured JSON. The
  password/token is never logged and never returned by any tool.
- **Credentials:** a git-ignored env file (`SN_ENV_FILE`, then
  `~/.config/servicenow-mcp/.env`, then the project `.env`); real environment
  variables take precedence. Runtime updates go through
  `servicenow_set_credentials`.
- **Two-axis policy:** `SN_TABLES_ALLOW`/`SN_TABLES_DENY` + `SN_READONLY`
  govern the Table API; `SN_PACKAGES_DENY`/`SN_PACKAGES_READONLY` govern the
  plugin-backed APIs. **A table deny does not restrict the plugin APIs** — use
  the package axis for those (see the README security notes).
- **Network:** HTTPS to the instance, an SSRF guard for internal/loopback
  hosts, an optional `SN_ALLOWED_HOSTS` allowlist, per-request timeout, retry
  with backoff, and a result-size guard.

## Accepted risks (owner decisions)

Recorded in [TODO.md](TODO.md) under "Decisions (won't-fix)":

- The env file is written with default permissions (0644) — a single-user
  machine assumption.
- `servicenow_set_credentials` may point Basic auth at an arbitrary
  non-internal host; the SSRF guard and `SN_ALLOWED_HOSTS` still apply.

If you deploy this server for third parties, revisit both — the conservative
variants are sketched next to each decision.
