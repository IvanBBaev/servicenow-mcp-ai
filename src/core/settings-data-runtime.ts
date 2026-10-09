/**
 * E-4 — settings manifest rows: policy, results, caching, docs, transport,
 * logging, validation and external, in documentation order. Assembled by
 * settings-manifest.ts.
 */

import {
  bool,
  filePath,
  int,
  list,
  nonNegative,
  oneOf,
  positive,
  secret,
  str,
  url,
  V100,
  V110,
  V200,
  NEXT,
  type SettingSpec,
} from "./settings-model.js";

export const RUNTIME_ROWS: readonly SettingSpec[] = [
  // --- policy -------------------------------------------------------------------
  list({
    key: "SN_TABLES_ALLOW",
    section: "policy",
    since: V110,
    profile: "override",
    example: "incident,change_request",
    description:
      "Comma-separated table allowlist; when set, only these tables are reachable.",
  }),
  list({
    key: "SN_TABLES_DENY",
    section: "policy",
    since: V110,
    profile: "override",
    example: "sys_user,sys_user_has_role",
    description:
      "Comma-separated table denylist; always wins over the allowlist.",
  }),
  bool({
    key: "SN_READONLY",
    section: "policy",
    since: V110,
    profile: "override",
    default: false,
    description: "When truthy, refuse every create/update/delete.",
  }),
  oneOf(["plan", "apply"], {
    key: "SN_WRITE_MODE",
    section: "policy",
    since: V200,
    profile: "override",
    default: "plan",
    description:
      "`plan` (default) previews a write as a before/after diff without mutating; `apply` executes; passing `apply:true` forces a single call.",
  }),
  oneOf(["off", "token", "elicit"], {
    key: "SN_DESTRUCTIVE_CONFIRM",
    section: "policy",
    since: NEXT,
    default: "token",
    example: "token",
    description:
      "H-3: confirmation for a destructive `apply:true` (`delete_record`, `delete_attachment`, a writing `batch`, `send_email`, `order_catalog_item`, `revert_write`, `upsert_artifact`, `check_change_conflicts` with `calculate:true`) in plan mode. `token` (the 3.0 default, B4): the plan preview returns a single-use `plan_token` and the apply must pass it back with the same arguments, else `PLAN_REQUIRED`; `elicit`: `token` plus a confirmation prompt on clients with elicitation (a decline is `CONFIRM_DECLINED`, journaled as refused). `SN_WRITE_MODE=apply` bypasses it, except on a profile marked `prod` (`SN_ENV`), which is always at least `elicit` and is confirmed in apply mode too. `off` is the explicit opt-out (the pre-3.0 behaviour).",
  }),
  int(
    { min: 30, max: 86_400, integer: true },
    {
      key: "SN_PLAN_TOKEN_TTL_SEC",
      section: "policy",
      since: NEXT,
      default: 600,
      description:
        "H-3: lifetime of a `plan_token` in seconds (30–86400). Tokens live only in the server process and are used up by the apply.",
    },
  ),
  oneOf(["allow", "deny"], {
    key: "SN_BATCH_UNMAPPED",
    section: "policy",
    since: NEXT,
    default: "deny",
    example: "allow",
    description:
      "H-4: a `servicenow_batch` sub-request whose REST path no tool package owns: `deny` (the 3.0 default, B8) refuses it (so a new plugin API cannot pass `SN_PACKAGES_DENY` / `SN_PACKAGES_READONLY` inside a batch); `allow` is the opt-out and checks it against the table and read-only axes only. A nested batch is always refused.",
  }),
  int(
    { min: 1, max: 1000, integer: true },
    {
      key: "SN_BATCH_MAX_REQUESTS",
      section: "policy",
      since: NEXT,
      default: 50,
      example: "50",
      description:
        "H-4: most sub-requests one `servicenow_batch` call may carry (1–1000; 50 since 3.0), checked before anything is sent.",
    },
  ),
  oneOf(["allow", "deny"], {
    key: "SN_PROTECTED_TABLES_WRITE",
    section: "policy",
    since: NEXT,
    profile: "override",
    default: "deny",
    example: "deny",
    description:
      "H-11: `deny` (the 3.0 default, B11) refuses writes to the built-in protected tables (identity, roles, ACLs, `sys_properties`, OAuth, scripts, LDAP, certificates, data sources, REST messages — `servicenow_explain_policy` lists them) with `POLICY_DENIED`; an exact `SN_TABLES_ALLOW` entry re-enables one; `allow` is the opt-out for all of them. Reads are unaffected.",
  }),
  list({
    key: "SN_IMPORT_SET_TABLES",
    section: "policy",
    since: NEXT,
    profile: "override",
    default: "u_*,imp_*",
    example: "u_*,imp_*,x_acme_*",
    description:
      "H-11: patterns (`*`, `?`) the import-set staging table must match (3.0 default `u_*,imp_*`); `*` is the opt-out (any table the table policy allows).",
  }),
  int(
    { min: 0, integer: true },
    {
      key: "SN_MAX_WRITES_PER_SESSION",
      section: "policy",
      since: NEXT,
      defaultText: "500 per HTTP session, none on stdio",
      example: "500",
      description:
        "H-11: most applied instance writes per session (the process on stdio, one MCP session over HTTP; a batch counts its write sub-requests). Past it, writes fail with `WRITE_CAP` before any request; `get_status.writes.caps` shows the usage. Unset = 500 per HTTP session and no cap on stdio (3.0 default); `0` = no cap.",
    },
  ),
  int(
    { min: 0, integer: true },
    {
      key: "SN_MAX_DELETES_PER_SESSION",
      section: "policy",
      since: NEXT,
      default: 100,
      example: "100",
      description:
        "H-11: most applied deletes per session (`WRITE_CAP`; 100 since 3.0). `0` = no cap.",
    },
  ),
  int(
    { min: 0, integer: true },
    {
      key: "SN_MAX_BATCH_WRITES",
      section: "policy",
      since: NEXT,
      default: 50,
      example: "50",
      description:
        "H-11: most write (non-GET) sub-requests in one `servicenow_batch` (`WRITE_CAP`; 50 since 3.0). `0` = no cap.",
    },
  ),
  oneOf(["prod", "test", "dev"], {
    key: "SN_ENV",
    section: "policy",
    since: NEXT,
    profile: "isolated",
    example: "prod",
    description:
      "H-11: marks the default profile `prod`, `test` or `dev` (`SN_PROFILE_<NAME>_ENV` for others). A `prod` profile stays in plan mode even when apply is configured unless `SN_PROD_WRITES` (`SN_PROFILE_<NAME>_PROD_WRITES`) is `I_UNDERSTAND`; its destructive applies are always confirmed (at least `SN_DESTRUCTIVE_CONFIRM=elicit`, also in apply mode — `CONFIRM_REQUIRED` for a client without elicitation); results carry `_meta.environment`; `use_instance` warns. `SN_PROFILE_<NAME>_WRITE_MODE` sets the write mode per profile.",
  }),
  oneOf(
    ["I_UNDERSTAND"],
    {
      key: "SN_PROD_WRITES",
      section: "policy",
      since: NEXT,
      profile: "isolated",
      example: "I_UNDERSTAND",
      description:
        "H-11: `I_UNDERSTAND` lets a `prod` default profile run in apply mode.",
    },
    true,
  ),
  str({
    key: "SN_UPDATE_SET",
    section: "policy",
    since: NEXT,
    profile: "fallback",
    example: "Sprint 12",
    description:
      "S-6: update set (sys_id or exact name) that applied Table-tool writes (create / update / upsert / delete) land in; a per-call `update_set` overrides it. The plan names the set; the user's current update set is switched for the write and restored after it. Data-row tables are written unchanged.",
  }),
  list({
    key: "SN_EMAIL_ALLOWED_DOMAINS",
    section: "policy",
    since: NEXT,
    example: "example.com",
    description:
      "Recipient domains `servicenow_send_email` may address (to/cc/bcc; a domain covers its subdomains, `*` allows any). When unset, every recipient must be the email of a user in the instance's own `sys_user` table; anything else fails with `RECIPIENT_NOT_ALLOWED`.",
  }),
  positive({
    key: "SN_MAX_UPLOAD_BYTES",
    section: "policy",
    since: NEXT,
    default: 10_485_760,
    description:
      "Largest decoded attachment upload, checked on the base64 length before decoding (`PAYLOAD_TOO_LARGE`).",
  }),
  list({
    key: "SN_UPLOAD_MIME_ALLOW",
    section: "policy",
    since: NEXT,
    example: "text/plain,image/*,application/pdf",
    description:
      "Optional allow-list of upload content types (exact, or `type/*`); others fail with `MIME_NOT_ALLOWED`.",
  }),
  list({
    key: "SN_SDK_MANAGED_SCOPES",
    section: "policy",
    since: NEXT,
    example: "x_acme_app",
    description:
      "P-3: comma/space-separated application scopes (namespace such as `x_acme_app`, or the `sys_scope` sys_id) you declare as managed by a ServiceNow SDK (Fluent) project. The highest source of authority for SDK-managed detection; listed in `get_status` / `check_capabilities` under `sdkManaged`.",
  }),
  oneOf(["allow", "warn", "deny"], {
    key: "SN_SDK_MANAGED_WRITES",
    section: "policy",
    since: NEXT,
    default: "warn",
    example: "deny",
    description:
      "P-22: writes into an SDK-managed scope (a record whose `sys_scope` P-3 detects as SDK-managed) from `create_record`, `update_record`, `upsert_record`, `delete_record`, `set_property`, `revert_write`, `upsert_artifact` (every record of the plan) and the Table API write sub-requests of `batch`; a create without `sys_scope` on a `sys_metadata` table is judged by the session's current application (`apps.current_app` preference; unreadable = a `sdkScopeWarning`, never a crash): `warn` previews and applies with an `sdkManaged` block naming the Fluent alternative; `deny` refuses the apply with `SDK_MANAGED_SCOPE` (the plan says `would_refuse`); `allow` skips the check. Runs after the table policy and costs nothing unless `SN_SDK_MANAGED_SCOPES` or `SN_SDK_PROJECT_DIRS` is set.",
  }),
  list({
    key: "SN_SDK_PROJECT_DIRS",
    section: "policy",
    since: NEXT,
    example: "../acme-app,../acme-portal",
    description:
      "P-3: directories (separated by commas or the platform path delimiter) scanned read-only for SDK projects: each `now.config.json` declares its `scope` / `scopeId` as SDK-managed. Bounded (depth 4, 2000 directories, 100 config files, 256 KiB per file), never follows symbolic links, skips hidden, `node_modules` and build folders, and reads nothing but `now.config.json`.",
  }),

  // --- results -------------------------------------------------------------------
  positive({
    key: "SN_MAX_RECORDS",
    section: "results",
    since: V110,
    default: 10_000,
    description: "Hard cap on records returned by a `fetchAll` query.",
  }),
  positive({
    key: "SN_MAX_RESULT_CHARS",
    section: "results",
    since: V110,
    default: 48_000,
    description:
      'Character budget for a tool result (48,000 since O-21 (b), under Claude Code\'s 50,000 threshold). A larger result goes to a file while `SN_OVERSIZE_TO_FILE` is on; otherwise it is shrunk with a note naming `format:"file"`, and a snapshot, compare or diagram result is returned in full with a `note`.',
  }),
  bool({
    key: "SN_OVERSIZE_TO_FILE",
    section: "results",
    since: NEXT,
    default: true,
    description:
      "S-11 / N-61 (default on since O-21 (b)): write a `query_table` (JSON lines), snapshot, compare or diagram result over `SN_MAX_RESULT_CHARS` to a file under `SN_DOCS_DIR` (`<profile>/exports/`, `<profile>/diagrams/`) and return `{path, bytes, preview}` instead.",
  }),
  bool(
    {
      key: "SN_INCLUDE_REF_LINKS",
      section: "results",
      since: V110,
      default: false,
      description:
        "Reference fields come back without their `link` URLs by default (token savings). Set `true` to include them.",
    },
    ["true"],
    ["false"],
  ),
  bool(
    {
      key: "SN_RESULT_PRETTY",
      section: "results",
      since: V110,
      default: false,
      description:
        "Tool results are compact JSON by default (pretty-printing ~doubles tokens). Set `true` for indented output.",
    },
    ["true"],
    ["false"],
  ),
  list({
    key: "SN_REDACT_FIELDS",
    section: "results",
    since: V200,
    example: "email,phone,ssn",
    description:
      "DF-5: mask these field values before records reach the model (comma/space-separated).",
  }),
  bool({
    key: "SN_REDACT_PII",
    section: "results",
    since: V200,
    default: false,
    description:
      "DF-5: also mask email/phone/national-id patterns inside string values. Since H-5 both redaction settings apply deeply to every tool result (success and error) and to the write journal.",
  }),
  positive({
    key: "SN_JOURNAL_MAX_BYTES",
    section: "results",
    since: NEXT,
    default: 20_971_520,
    description:
      "H-5: size (bytes, default 20 MiB) at which `write-journal.jsonl` rotates to `write-journal.<ISO-time>.jsonl`; the hash chain continues across files.",
  }),
  bool({
    key: "SN_CSV_FORMULA_GUARD",
    section: "results",
    since: NEXT,
    default: true,
    description:
      "H-5: prefix CSV text cells that start with `=`, `+`, `-`, `@`, tab or CR with `'` so spreadsheets never evaluate them (a text `-5` exports as `'-5`). `0` opts out.",
  }),
  bool({
    key: "SN_CSV_BOM",
    section: "results",
    since: NEXT,
    default: true,
    description:
      'H-5: prepend a UTF-8 BOM to `format:"csv"` exports so Excel decodes non-ASCII text. `0` opts out.',
  }),

  // --- caching -------------------------------------------------------------------
  int(
    { min: 30_000 },
    {
      key: "SN_RECORD_WATCH_INTERVAL_MS",
      section: "caching",
      since: NEXT,
      default: 30_000,
      description:
        "N-10: poll interval of a record-watch subscription (`servicenow://profiles/<profile>/records/<table>/<sys_id>`); each poll reads `sys_updated_on` / `sys_mod_count`. Floor 30000.",
    },
  ),
  positive({
    key: "SN_RECORD_WATCH_MAX_PER_SESSION",
    section: "caching",
    since: NEXT,
    default: 10,
    description:
      "N-10: record-watch subscriptions one client session may hold; one more is refused with `WATCH_LIMIT`.",
  }),
  positive({
    key: "SN_RECORD_WATCH_MAX",
    section: "caching",
    since: NEXT,
    default: 50,
    description:
      "N-10: record-watch subscriptions across the process (every session); one more is refused with `WATCH_LIMIT`.",
  }),
  nonNegative({
    key: "SN_SCHEMA_CACHE_TTL_SEC",
    section: "caching",
    since: V110,
    default: 300,
    description:
      "TTL for the near-static schema reads cache (`list_tables`, `describe_table`, `get_cmdb_meta`). `0` disables caching.",
  }),
  positive({
    key: "SN_SCHEMA_CACHE_MAX",
    section: "caching",
    since: NEXT,
    default: 256,
    description:
      "Maximum entries in the schema reads cache; when full, the least-recently-used entry is evicted. Counters (`size`, `hits`, `misses`, `evictions`) appear in `get_status` under `schemaCache`.",
  }),
  positive({
    key: "SN_CAPABILITY_TTL_MS",
    section: "caching",
    since: NEXT,
    default: 600_000,
    description:
      "How long a successful capability probe is cached — the `servicenow_check_capabilities` matrix and the plugin-API availability (CI/CD, Code Search, Batch…). Pass `refresh: true` to re-probe sooner.",
  }),
  positive({
    key: "SN_PLUGIN_NEGATIVE_TTL_MS",
    section: "caching",
    since: NEXT,
    default: 60_000,
    description:
      "How long a failed capability probe (HTTP 401/403/404/5xx) or a missing plugin API is cached before it is tried again. Transport errors are never cached.",
  }),

  // --- docs -----------------------------------------------------------------------
  filePath({
    key: "SN_DOCS_DIR",
    section: "docs",
    since: V100,
    defaultText: "`docs/instance`",
    example: "docs/instance",
    description:
      "Directory the `docs` package reads/writes Markdown in. Relative paths resolve against the working directory. It also holds the per-profile write journal — add `docs/instance/` to `.gitignore` in any repository you run the server from.",
  }),
  positive({
    key: "SN_DOCS_MAX_FILE_BYTES",
    section: "docs",
    since: NEXT,
    default: 5_242_880,
    description:
      "Per-file size cap for the docs tools: larger writes are refused, reads return the first bytes with `truncated: true`, search skips the file.",
  }),
  positive({
    key: "SN_DOCS_STALE_DAYS",
    section: "docs",
    since: NEXT,
    default: 30,
    description:
      "`servicenow_list_docs` flags a generated document `stale` when its `sn_generated_at` is older than this many days.",
  }),
  positive({
    key: "SN_DOCS_SEARCH_MAX",
    section: "docs",
    since: NEXT,
    default: 200,
    description:
      "Most matches `servicenow_search_docs` returns; past it the result carries `truncated: true`.",
  }),
  positive({
    key: "SN_DIAGRAM_MAX_NODES",
    section: "docs",
    since: NEXT,
    default: 200,
    description:
      "Node cap for the generated Mermaid diagrams (table flow, event trace, where-used; tables in a detailed ER diagram). Nodes past it fold into one `+N more` node.",
  }),

  // --- transport ---------------------------------------------------------------------
  oneOf(["stdio", "http"], {
    key: "SN_TRANSPORT",
    section: "transport",
    since: V200,
    default: "stdio",
    description:
      "DF-6: `stdio` (default) or `http` (Streamable HTTP for remote/agent clients).",
  }),
  int(
    { min: 1, max: 65_535, integer: true },
    {
      key: "SN_PORT",
      section: "transport",
      since: V200,
      default: 3000,
      description: "DF-6: TCP port for the http transport.",
    },
  ),
  str({
    key: "SN_HTTP_HOST",
    section: "transport",
    since: V200,
    default: "127.0.0.1",
    description:
      "DF-6: bind address for the http transport (loopback by default).",
  }),
  secret({
    key: "SN_HTTP_TOKEN",
    section: "transport",
    since: V200,
    fileSource: true,
    example: "change-me",
    description:
      "DF-6: when set, http requests must send `Authorization: Bearer <token>`. **Required** whenever `SN_HTTP_HOST` is not loopback (e.g. `0.0.0.0` in the Docker image) — without it every client that reaches the port is accepted, and a warning is logged.",
  }),
  bool({
    key: "SN_HTTP_REQUIRE_TOKEN",
    section: "transport",
    since: NEXT,
    default: false,
    defaultText: "off",
    example: "0",
    description:
      "H-7: refuse to start the http transport on a non-loopback `SN_HTTP_HOST` without `SN_HTTP_TOKEN` (instead of logging a warning).",
  }),
  nonNegative({
    key: "SN_HTTP_SESSION_TTL_SEC",
    section: "transport",
    since: NEXT,
    default: 1800,
    description:
      "H-7: idle TTL of an http session in seconds; an idle session is closed and its runtime disposed. `0` keeps sessions until the client sends DELETE.",
  }),
  positive({
    key: "SN_HTTP_MAX_SESSIONS",
    section: "transport",
    since: NEXT,
    default: 64,
    description:
      "H-7: cap on concurrent http sessions; a new session beyond it is refused with 503.",
  }),
  nonNegative({
    key: "SN_HTTP_KEEPALIVE_MS",
    section: "transport",
    since: NEXT,
    default: 25_000,
    description:
      "H-7: interval of the SSE keep-alive comment on an open stream (below common proxy idle timeouts). `0` disables it.",
  }),
  list({
    key: "SN_HTTP_ALLOWED_HOSTS",
    section: "transport",
    since: NEXT,
    example: "mcp.example.com",
    description:
      "H-7: `Host` header values the http transport accepts (DNS-rebinding guard); an entry without a port matches any port. Unset = loopback names on a loopback bind, no check otherwise (warned).",
  }),
  list({
    key: "SN_HTTP_ALLOWED_ORIGINS",
    section: "transport",
    since: NEXT,
    example: "https://app.example.com",
    description:
      "H-7: browser `Origin` values the http transport accepts (`*` = any). Unset = loopback origins only; a request without an Origin header is never refused by this check.",
  }),
  bool({
    key: "SN_METRICS",
    section: "transport",
    since: NEXT,
    default: false,
    defaultText: "off",
    example: "0",
    description:
      "E-5: HTTP transport only — serve Prometheus metrics at `GET /metrics`, behind `SN_HTTP_TOKEN` (disabled when no token is set).",
  }),

  // --- logging ------------------------------------------------------------------------
  oneOf(["error", "warn", "info", "debug"], {
    key: "SN_LOG_LEVEL",
    section: "logging",
    since: V110,
    default: "info",
    aliases: ["LOG_LEVEL"],
    description:
      "Log verbosity on stderr: `error`, `warn`, `info`, `debug`. The legacy `LOG_LEVEL` is read when this is unset.",
  }),
  oneOf(["json", "text"], {
    key: "SN_LOG_FORMAT",
    section: "logging",
    since: NEXT,
    default: "json",
    description:
      "E-5: stderr log line format — `json` (one object per line) or `text` (`HH:MM:SS level message key=value`).",
  }),
  filePath({
    key: "SN_LOG_FILE",
    section: "logging",
    since: NEXT,
    example: "/var/log/servicenow-mcp.log",
    description:
      "E-5: also append every log line (JSON Lines, redacted, mode 0600) to this file, with size-based rotation (`<file>.1` … `<file>.5`). Stderr keeps working.",
  }),
  positive({
    key: "SN_LOG_FILE_MAX_BYTES",
    section: "logging",
    since: NEXT,
    default: 10_485_760,
    description: "E-5: rotation threshold for `SN_LOG_FILE` (bytes).",
  }),
  nonNegative({
    key: "SN_LOG_NOTIFY_RATE",
    section: "logging",
    since: NEXT,
    default: 20,
    description:
      'M-8: log notifications per second and client session over the MCP logging capability (burst 50, or the rate if larger). Lines over it are counted and reported in one "N log messages suppressed" warning per minute; stderr is never throttled. `0` = no limit.',
  }),
  bool({
    key: "SN_OTEL",
    section: "logging",
    since: NEXT,
    default: false,
    defaultText: "off",
    example: "0",
    description:
      "N-55: map the tool-call and HTTP `diagnostics_channel` events to OpenTelemetry spans (MCP / GenAI semantic conventions). Needs the optional peer dependency `@opentelemetry/api` and an OpenTelemetry SDK registered in the process (e.g. `node --import`); without the package one warning is logged and nothing else changes.",
  }),
  bool({
    key: "SN_OTEL_PROPAGATE",
    section: "logging",
    since: NEXT,
    default: false,
    defaultText: "off",
    example: "0",
    description:
      "N-55: send W3C `traceparent` / `tracestate` headers on outbound ServiceNow REST requests — the HTTP client span's context when `SN_OTEL` is on, otherwise the context the client sent in `params._meta`. Off: trace ids never leave the server.",
  }),

  // --- validation ------------------------------------------------------------------------
  bool({
    key: "SN_STRICT_SETTINGS",
    section: "validation",
    since: NEXT,
    default: false,
    description:
      "E-4: make an invalid setting value (a non-number, an unknown enum value, an out-of-range port…) a startup error that names every offending key, instead of a warning plus the default. Unknown `SN_*` keys stay warnings. Planned to default on in 3.0 (owner decision O-4).",
  }),

  // --- external -----------------------------------------------------------------------------
  url({
    key: "HTTPS_PROXY",
    section: "external",
    since: NEXT,
    external: true,
    aliases: ["https_proxy"],
    description:
      "Standard proxy for HTTPS traffic, honoured when `SN_HTTPS_PROXY` is unset (with `NO_PROXY`).",
  }),
  url({
    key: "HTTP_PROXY",
    section: "external",
    since: NEXT,
    external: true,
    aliases: ["http_proxy"],
    description: "Fallback proxy when `HTTPS_PROXY` is unset.",
  }),
  list({
    key: "NO_PROXY",
    section: "external",
    since: NEXT,
    external: true,
    aliases: ["no_proxy"],
    description:
      "Hosts that bypass `HTTPS_PROXY` / `HTTP_PROXY` (never `SN_HTTPS_PROXY`).",
  }),
  filePath({
    key: "XDG_CONFIG_HOME",
    section: "external",
    since: V110,
    external: true,
    defaultText: "`~/.config`",
    description:
      "Base directory of the default env file (`$XDG_CONFIG_HOME/servicenow-mcp-ai/.env`).",
  }),
];
