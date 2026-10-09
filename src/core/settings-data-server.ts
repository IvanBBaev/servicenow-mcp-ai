/**
 * E-4 — settings manifest rows: connection, profiles, network and packages,
 * in documentation order. Assembled by settings-manifest.ts.
 */

import {
  bool,
  date,
  filePath,
  list,
  nonNegative,
  oneOf,
  positive,
  secret,
  str,
  url,
  profileNameSchema,
  V100,
  V110,
  NEXT,
  type SettingSpec,
} from "./settings-model.js";

export const SERVER_ROWS: readonly SettingSpec[] = [
  // --- connection ---------------------------------------------------------
  str({
    key: "SN_INSTANCE",
    section: "connection",
    since: V100,
    required: true,
    profile: "isolated",
    example: "your-instance.service-now.com",
    description:
      "Instance name, host, or `https://` URL (`dev12345`, `dev12345.service-now.com`).",
    registry: "ServiceNow instance host, e.g. dev12345.service-now.com.",
    registryRequired: true,
  }),
  str({
    key: "SN_USER",
    section: "connection",
    since: V100,
    required: true,
    profile: "isolated",
    example: "your.username@example.com",
    description: "ServiceNow username for Basic auth.",
    registry: "Username for basic auth or the OAuth password grant.",
  }),
  secret({
    key: "SN_PASSWORD",
    section: "connection",
    since: V100,
    required: true,
    profile: "isolated",
    fileSource: true,
    example: "your-password",
    description: "ServiceNow password. Never logged or returned by any tool.",
    registry: "Password for basic auth or the OAuth password grant.",
  }),
  oneOf(["basic", "oauth", "apikey", "token", "none"], {
    key: "SN_AUTH",
    section: "connection",
    since: V110,
    profile: "fallback",
    defaultText: "auto",
    example: "basic",
    description:
      "Auth method: `basic`, `oauth`, `apikey`, `token` or `none` (cert-only mTLS). Auto-detected from the keys present (API key → bearer → OAuth → Basic).",
    registry:
      "Auth mode: basic | oauth | apikey | token | none. Auto-detected from the keys present if omitted.",
  }),
  secret({
    key: "SN_API_KEY",
    section: "connection",
    since: V110,
    profile: "fallback",
    fileSource: true,
    description:
      "ServiceNow Inbound API Key, sent as the `x-sn-apikey` header (enables `apikey` mode).",
    registry:
      "ServiceNow API key, sent as the x-sn-apikey header (apikey auth).",
  }),
  secret({
    key: "SN_BEARER_TOKEN",
    section: "connection",
    since: V110,
    profile: "fallback",
    fileSource: true,
    fileNote:
      " Read once at startup (`SN_TOKEN_FILE`, re-read on a 401, still wins).",
    description:
      "A pre-obtained bearer token, sent verbatim as `Authorization: Bearer …` (enables `token` mode).",
  }),
  filePath({
    key: "SN_TOKEN_FILE",
    section: "connection",
    since: NEXT,
    profile: "fallback",
    description:
      "File holding the bearer token (enables `token` mode; wins over `SN_BEARER_TOKEN`). Re-read once when the instance rejects the token with 401, so an external issuer can rotate it; otherwise the call fails with `AUTH_EXPIRED`.",
  }),
  date({
    key: "SN_TOKEN_EXPIRES_AT",
    section: "connection",
    since: NEXT,
    profile: "fallback",
    example: "2026-12-31T23:59:59Z",
    description:
      "ISO 8601 expiry of the bearer token. `get_status` / `doctor` warn when less than 24 h remain, when it has passed, or when it cannot be parsed.",
  }),
  str({
    key: "SN_OAUTH_CLIENT_ID",
    section: "connection",
    since: V110,
    profile: "fallback",
    description: "OAuth client id (its presence enables OAuth).",
  }),
  secret({
    key: "SN_OAUTH_CLIENT_SECRET",
    section: "connection",
    since: V110,
    profile: "fallback",
    fileSource: true,
    description: "OAuth client secret.",
  }),
  oneOf(["password", "client_credentials", "refresh_token", "jwt_bearer"], {
    key: "SN_OAUTH_GRANT",
    section: "connection",
    since: V110,
    profile: "fallback",
    default: "password",
    example: "refresh_token",
    description:
      "OAuth grant: `password` (**deprecated** — ROPC), `client_credentials`, `refresh_token` or `jwt_bearer`. The `login` command sets this to `refresh_token` for you. Any other value fails every OAuth request.",
  }),
  secret({
    key: "SN_OAUTH_REFRESH_TOKEN",
    section: "connection",
    since: V110,
    profile: "fallback",
    fileSource: true,
    fileNote:
      " A rotated refresh token is then kept in memory only (update the file yourself).",
    description:
      "Refresh token for the `refresh_token` grant. Obtained automatically by `npx servicenow-mcp-ai login` (Authorization Code + PKCE).",
  }),
  url({
    key: "SN_OAUTH_REDIRECT_URI",
    section: "connection",
    since: V110,
    profile: "fallback",
    defaultText: "http://localhost:53682/callback",
    description:
      "Loopback redirect URL for the PKCE `login` flow. Must match the redirect registered on the OAuth endpoint.",
  }),
  str({
    key: "SN_OAUTH_SCOPE",
    section: "connection",
    since: V110,
    profile: "fallback",
    description: "Optional OAuth scope requested during `login`.",
  }),
  secret({
    key: "SN_OAUTH_JWT_KEY",
    section: "connection",
    since: V110,
    profile: "fallback",
    description:
      "PEM private key for the `jwt_bearer` grant (or `SN_OAUTH_JWT_KEY_FILE`); the public certificate is registered on the ServiceNow JWT provider.",
  }),
  filePath({
    key: "SN_OAUTH_JWT_KEY_FILE",
    section: "connection",
    since: V110,
    profile: "fallback",
    description: "Path to the PEM private key for the `jwt_bearer` grant.",
  }),
  str({
    key: "SN_OAUTH_JWT_ISS",
    section: "connection",
    since: V110,
    profile: "fallback",
    defaultText: "client id",
    description: "`iss` claim of the JWT-bearer assertion.",
  }),
  str({
    key: "SN_OAUTH_JWT_SUB",
    section: "connection",
    since: V110,
    profile: "fallback",
    defaultText: "`SN_USER`",
    description: "`sub` claim (the user) of the JWT-bearer assertion.",
  }),
  str({
    key: "SN_OAUTH_JWT_AUD",
    section: "connection",
    since: V110,
    profile: "fallback",
    defaultText: "`https://<host>/oauth_token.do`",
    description: "`aud` claim of the JWT-bearer assertion.",
  }),
  str({
    key: "SN_OAUTH_JWT_KID",
    section: "connection",
    since: V110,
    profile: "fallback",
    description:
      "`kid` header of the JWT-bearer assertion, when the provider requires one.",
  }),
  positive({
    key: "SN_OAUTH_JWT_EXP_SEC",
    section: "connection",
    since: V110,
    profile: "fallback",
    default: 300,
    description: "Lifetime of the JWT-bearer assertion in seconds.",
  }),
  bool({
    key: "SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE",
    section: "connection",
    since: NEXT,
    default: false,
    description:
      "H-2: operator opt-out — lets `servicenow_set_credentials` proceed on MCP clients without elicitation support (no confirmation prompt, no live server). An explicit decline is still refused. Off by default.",
  }),

  // --- profiles -------------------------------------------------------------
  str({
    key: "SN_PROFILE_<NAME>_*",
    section: "profiles",
    since: V110,
    pattern: true,
    example: [
      "SN_PROFILE_DEV_INSTANCE=dev12345.service-now.com",
      "SN_PROFILE_DEV_USER=admin",
      "SN_PROFILE_DEV_PASSWORD=dev-password",
    ].join("\n"),
    description:
      "Named connection profiles: `SN_PROFILE_DEV_INSTANCE` / `_USER` / `_PASSWORD` define profile `dev`. The bare `SN_INSTANCE`/`SN_USER`/`SN_PASSWORD` keys are the `default` profile. The auth, policy, write-mode, `ENV`, `PROD_WRITES` and `UPDATE_SET` settings take the same prefix.",
  }),
  {
    key: "SN_ACTIVE_PROFILE",
    section: "profiles",
    kind: "string",
    since: V110,
    default: "default",
    description:
      "Which profile tools use. Switch at runtime with `servicenow_use_instance` (persisted to the env file).",
    schema: profileNameSchema,
  },
  filePath({
    key: "SN_ENV_FILE",
    section: "profiles",
    since: V110,
    defaultText: "`~/.config/servicenow-mcp-ai/.env`",
    description:
      "Explicit path to the env file to read/write. Otherwise the server uses `$XDG_CONFIG_HOME/servicenow-mcp-ai/.env` (`~/.config/…`); a project-root `.env` next to the installed package is still read when the XDG file is missing, with a deprecation warning — that fallback is removed in 3.0. `doctor` prints the chosen file and why.",
  }),

  // --- network ----------------------------------------------------------------
  positive({
    key: "SN_TIMEOUT_MS",
    section: "network",
    since: V110,
    default: 30_000,
    description: "Per-request timeout in milliseconds.",
  }),
  nonNegative({
    key: "SN_MAX_RETRIES",
    section: "network",
    since: V110,
    default: 2,
    description:
      "Retries for transient failures (429/5xx, network errors). Non-idempotent writes are only retried on connect errors.",
  }),
  positive({
    key: "SN_RETRY_AFTER_MAX_MS",
    section: "network",
    since: NEXT,
    default: 60_000,
    description:
      "Upper bound honoured for a `Retry-After` header on 429/503; a larger value is clamped so a misbehaving upstream cannot park the client for minutes.",
  }),
  positive({
    key: "SN_DEADLINE_MS",
    section: "network",
    since: NEXT,
    defaultText: "max(120000, 2 × `SN_TIMEOUT_MS`)",
    example: "120000",
    description:
      "Total wall-clock budget for one logical request across retries, backoff, queue wait and OAuth re-auth. A retry that cannot fit into the remaining budget is not attempted — the call fails with code `DEADLINE_EXCEEDED`.",
  }),
  list({
    key: "SN_ALLOWED_HOSTS",
    section: "network",
    since: V110,
    example: "service-now.com",
    description:
      "Comma-separated allow-list of permitted hosts (for custom or sovereign-cloud domains). When set, only matching hosts are contacted. When unset, only `*.service-now.com` instances are allowed and internal/loopback hosts are blocked (SSRF guard). An entry may carry a port (`host:8443`) or be a bracketed IPv6 literal (`[2001:db8::1]`); an explicit non-443 port or an IPv6 literal in the instance value is accepted only when such an entry matches it — never under the default policy.",
  }),
  positive({
    key: "SN_MAX_BODY_BYTES",
    section: "network",
    since: NEXT,
    default: 52_428_800,
    description:
      "Largest response body (bytes) read into memory; a larger declared or streamed body fails with `RESPONSE_TOO_LARGE`. Redirects are never followed — a 3xx fails with `REDIRECT_BLOCKED` naming the target host.",
  }),
  url({
    key: "SN_HTTPS_PROXY",
    section: "network",
    since: NEXT,
    example: "http://user:pass@proxy.example.com:3128",
    description:
      "Outbound HTTPS proxy URL (`http://user:pass@proxy:3128`) for all ServiceNow and OAuth traffic; needs the optional `undici` package. When unset, the ambient `HTTPS_PROXY` / `HTTP_PROXY` variables are honoured together with `NO_PROXY`; `SN_HTTPS_PROXY` itself is explicit and ignores `NO_PROXY`. Proxy credentials are never logged.",
  }),
  str({
    key: "SN_USER_AGENT_SUFFIX",
    section: "network",
    since: NEXT,
    example: "team-platform",
    description:
      "Extra token appended to the `User-Agent` sent on every request (`servicenow-mcp-ai/<version> (node/<major>; <transport>; <client>)`), e.g. a team or ticket id for correlation in the instance's transaction log. Printable ASCII, up to 80 characters.",
  }),
  str({
    key: "SN_TLS_CLIENT_CERT",
    section: "network",
    since: V110,
    description:
      "Client certificate (PEM) for **mutual TLS** (or `SN_TLS_CLIENT_CERT_FILE`). With `SN_TLS_CLIENT_KEY` it presents a client cert; ServiceNow's mutual-auth profile maps it to a user. Needs the optional `undici` package (`npm i undici`). Cert and key must be set together — only one of them is a configuration error.",
  }),
  filePath({
    key: "SN_TLS_CLIENT_CERT_FILE",
    section: "network",
    since: V110,
    description: "Path to the client certificate (PEM) for mutual TLS.",
  }),
  secret({
    key: "SN_TLS_CLIENT_KEY",
    section: "network",
    since: V110,
    description:
      "Private key (PEM) for the client certificate (or `SN_TLS_CLIENT_KEY_FILE`).",
  }),
  filePath({
    key: "SN_TLS_CLIENT_KEY_FILE",
    section: "network",
    since: V110,
    description: "Path to the private key (PEM) for the client certificate.",
  }),
  str({
    key: "SN_TLS_CA",
    section: "network",
    since: V110,
    description:
      "Optional CA bundle (PEM) to trust (or `SN_TLS_CA_FILE`) — applied with or without a client certificate; needs the optional `undici` package.",
  }),
  filePath({
    key: "SN_TLS_CA_FILE",
    section: "network",
    since: V110,
    description: "Path to the CA bundle (PEM) to trust.",
  }),
  bool(
    {
      key: "SN_TLS_REJECT_UNAUTHORIZED",
      section: "network",
      since: V110,
      default: true,
      description:
        "`false` disables TLS certificate verification (not recommended; warned once at startup).",
    },
    ["true"],
    ["false"],
  ),
  positive({
    key: "SN_MAX_CONCURRENT",
    section: "network",
    since: V110,
    default: 4,
    description:
      "Maximum parallel HTTP requests to the instance (simple in-process semaphore).",
  }),
  positive({
    key: "SN_MAX_QUEUE",
    section: "network",
    since: NEXT,
    default: 64,
    description:
      "Maximum requests waiting per host for a free slot beyond `SN_MAX_CONCURRENT`. Overflow fails immediately with code `BUSY` instead of piling up. Diagnostics (`servicenow_test_connection`, `doctor`) bypass the queue so they still answer while it is stalled.",
  }),
  positive({
    key: "SN_QUEUE_TIMEOUT_MS",
    section: "network",
    since: NEXT,
    defaultText: "`SN_TIMEOUT_MS`",
    example: "30000",
    description:
      "Longest a request waits for a slot before failing with code `BUSY`. Wait time is not billed to the per-attempt timeout, only to `SN_DEADLINE_MS`.",
  }),
  nonNegative({
    key: "SN_BREAKER_THRESHOLD",
    section: "network",
    since: NEXT,
    default: 0,
    defaultText: "`0` (off)",
    description:
      "Opt-in per-host circuit breaker: after this many consecutive failed requests (transport error, deadline, 5xx) further requests fail fast with code `CIRCUIT_OPEN` until `SN_BREAKER_RESET_MS` passes. Diagnostics are never blocked.",
  }),
  positive({
    key: "SN_BREAKER_RESET_MS",
    section: "network",
    since: NEXT,
    default: 30_000,
    description:
      "How long an open circuit breaker rejects requests before letting a trial request through; the first failure re-opens it, the first success closes it.",
  }),

  // --- packages ----------------------------------------------------------------
  list({
    key: "SN_TOOL_PACKAGES",
    section: "packages",
    since: V100,
    default: ["core"],
    example: "core",
    description:
      "Comma/space-separated tool packages or profiles to enable. Profiles: `core` (default), `all` and the presets `reader` \\| `developer` \\| `admin` (see [Presets](#presets)). Packages: `table`, `schema`, `aggregate`, `attachment`, `importset`, `batch`, `catalog`, `change`, `knowledge`, `cmdb`, `scripts`, `flows`, `codecheck`, `docs`, `instance`, `email`, `atf`, `revert`, `artifacts`, `updatesets`, `ops`, `history`, `properties`, `directory`, `ui`. The admin tools are always on. `atf` runs tests on the instance — enable it only on a non-production instance.",
    registry:
      "Which tool packages to expose, e.g. core (default), all, or a comma-separated list.",
  }),
  list({
    key: "SN_PACKAGES_DENY",
    section: "packages",
    since: V100,
    example: "change,catalog",
    description:
      "Comma/space-separated packages to exclude even if enabled by `SN_TOOL_PACKAGES`. The only way to block plugin APIs (catalog, change, knowledge…) — the table policy does not see them.",
  }),
  list({
    key: "SN_PACKAGES_READONLY",
    section: "packages",
    since: V100,
    example: "cmdb",
    description:
      "Comma/space-separated packages whose write tools are not registered; their read tools stay. Per-package complement to the global `SN_READONLY`.",
  }),
  bool(
    {
      key: "SN_CODESEARCH",
      section: "packages",
      since: V110,
      default: false,
      description:
        "Opt in to the Code Search API (`sn_codesearch`) for `servicenow_search_code` (FT-7). When `true` and the plugin is active it replaces the LIKE iteration; falls back to LIKE on any failure.",
    },
    ["true"],
    ["false"],
  ),
  bool(
    {
      key: "SN_EXPERIMENTAL_TASKS",
      section: "packages",
      since: NEXT,
      default: false,
      defaultText: "`0`",
      example: "0",
      description:
        'M-9, **experimental**: `1` adds an optional `run_as_task:true` argument to `snapshot_instance`, `compare_instances`, `run_atf_test`, `run_atf_suite`, `check_code_health`, `document_app`, `document_instance` and `query_table` (`format:"file"` only). Such a call returns an MCP task handle at once (`_meta["io.modelcontextprotocol/related-task"]`); the client polls `tasks/get`, reads `tasks/result` (kept 1 h, redacted) or stops it with `tasks/cancel`. Off: schemas unchanged. Built on the SDK\'s experimental task API.',
    },
    ["1", "true"],
    ["0", "false"],
  ),
  bool(
    {
      key: "SN_MCP_APPS",
      section: "packages",
      since: NEXT,
      default: false,
      defaultText: "`0`",
      example: "0",
      description:
        "N-50, MCP Apps (SEP-1865): `1` registers four self-contained `ui://servicenow-mcp/…` HTML views (`text/html;profile=mcp-app`: plan diff, Mermaid diagram, flow explainer, UI Builder page tree) and links the write tools with `apply`, the Mermaid generators, `explain_flow` and `explain_ui_experience` to them through `_meta.ui.resourceUri` — only for a client that advertises the `io.modelcontextprotocol/ui` extension. The views render the tool's own result (no network, strict CSP). Off: `tools/list`, resources and every result unchanged.",
    },
    ["1", "true"],
    ["0", "false"],
  ),
  bool(
    {
      key: "SN_LEGACY_TOOL_NAMES",
      section: "packages",
      since: NEXT,
      default: false,
      defaultText: "`0`",
      example: "0",
      description:
        "M-7 (B2), **deprecated bridge for one minor cycle**: `1` registers every tool name and parameter name renamed by the v3 naming convention as an alias of its new name (the alias dispatches to the new tool and logs a one-time deprecation warning). Off: the old names do not exist and are absent from `tools/list`. See the rename table in the README.",
    },
    ["1", "true"],
    ["0", "false"],
  ),
];
