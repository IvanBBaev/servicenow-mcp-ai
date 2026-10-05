/**
 * E-4 — the declarative settings manifest.
 *
 * Every environment variable the server reads is declared here once: its
 * type (a zod schema over the raw string), default, section, the release it
 * appeared in, whether it is a secret, whether a `<KEY>_FILE` source may
 * supply it (D-5) and how a named profile scopes it. The getters in
 * settings.ts, policy.ts, config.ts, auth.ts, logging.ts and friends read
 * through {@link readSetting} / {@link rawSetting}, so parsing and the
 * "invalid value" behaviour live in one place, and `npm run docs:env`
 * renders the README table, `.env.example` and the `server.json` env block
 * from the same data (D-3).
 *
 * Values are read live from `process.env` on every call — never cached — so
 * `servicenow_use_instance`, `servicenow_set_credentials` and tests that
 * mutate the environment keep working.
 *
 * Invalid values: a value the schema rejects is reported once per key and
 * value (a logged warning) and the setting keeps its default — the pre-E-4
 * behaviour, now visible. With `SN_STRICT_SETTINGS=1` the startup validation
 * ({@link applySettingsAtStartup}) turns every invalid value into a startup
 * error instead. Secret values are never echoed in a message.
 */

import { z } from "zod";
import { logger } from "./logging.js";
import { activeProfile, PROFILE_RE } from "./profile.js";

/** The release a setting first shipped in; bump this one constant at release. */
export const UNRELEASED = "unreleased";

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export type SettingSectionId =
  | "connection"
  | "secret-files"
  | "profiles"
  | "network"
  | "packages"
  | "policy"
  | "results"
  | "caching"
  | "docs"
  | "transport"
  | "logging"
  | "validation"
  | "external";

export interface SettingSection {
  id: SettingSectionId;
  title: string;
  /** Plain-text introduction (rendered above the section's settings). */
  blurb: string;
}

export const SETTING_SECTIONS: readonly SettingSection[] = [
  {
    id: "connection",
    title: "Connection and authentication",
    blurb:
      "The instance and its credentials. Only SN_INSTANCE is always required; the auth method is auto-detected from the keys present (API key -> bearer token -> OAuth -> Basic) unless SN_AUTH names it.",
  },
  {
    id: "secret-files",
    title: "Secrets from files",
    blurb:
      "Container secrets (D-5): <KEY>_FILE=/path loads <KEY> from that file at startup (one trailing newline is trimmed). Setting both <KEY> and <KEY>_FILE is a startup error; so is an unreadable or empty file. A value loaded this way is never written back to the env file. Per profile: SN_PROFILE_<NAME>_<KEY>_FILE for the ServiceNow secrets.",
  },
  {
    id: "profiles",
    title: "Profiles and the env file",
    blurb:
      "The bare SN_INSTANCE / SN_USER / SN_PASSWORD keys are the 'default' profile. More instances live under SN_PROFILE_<NAME>_* keys; switch with SN_ACTIVE_PROFILE or the servicenow_use_instance tool.",
  },
  {
    id: "network",
    title: "Network, TLS and resilience",
    blurb:
      "Timeouts, retries, the host allow-list, the outbound proxy, mutual TLS and the per-host queue and circuit breaker. They govern every REST client of the server. The proxy and mutual TLS need the optional undici package.",
  },
  {
    id: "packages",
    title: "Tool packages",
    blurb:
      "Which tools are registered. The admin tools (set_credentials, get_status, use_instance) are always on.",
  },
  {
    id: "policy",
    title: "Access policy and write safety",
    blurb:
      "Least-privilege table policy, plan-and-apply writes, destructive-write confirmation, per-session caps, prod profiles, update-set binding and the upload / email / SDK-managed-scope guards.",
  },
  {
    id: "results",
    title: "Results, redaction and exports",
    blurb:
      "Result size budgets, output shaping, redaction of record values, the write journal and CSV export safety.",
  },
  {
    id: "caching",
    title: "Caching",
    blurb: "The schema reads cache and the capability / plugin-API probes.",
  },
  {
    id: "docs",
    title: "Docs store and diagrams",
    blurb:
      "The local Markdown docs store (also home of the write journal — keep it out of version control) and the generated Mermaid diagrams.",
  },
  {
    id: "transport",
    title: "HTTP transport",
    blurb:
      "stdio (default, one local client) or Streamable HTTP for remote and agent clients. Securing the HTTP endpoint (TLS, auth, network) is the operator's job.",
  },
  {
    id: "logging",
    title: "Logging",
    blurb:
      "The stderr log, the optional log file and the log lines mirrored to the MCP client.",
  },
  {
    id: "validation",
    title: "Settings validation",
    blurb:
      "Every setting is validated at startup. An invalid value is logged as a warning and the setting keeps its default; strict mode makes it a startup error instead.",
  },
  {
    id: "external",
    title: "Standard variables",
    blurb:
      "Conventional variables outside the SN_ namespace that the server also honours.",
  },
];

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export type SettingKind =
  | "int"
  | "bool"
  | "enum"
  | "string"
  | "secret"
  | "path"
  | "list"
  | "url"
  | "date";

/**
 * How a named profile scopes a setting:
 * - `override` — `SN_PROFILE_<NAME>_<X>` wins whenever it is defined, even
 *   empty (the table policy, the write mode);
 * - `fallback` — the profile key wins only when non-empty, else `SN_<X>`
 *   (auth settings, the update set);
 * - `isolated` — the default profile reads only `SN_<X>`, any other profile
 *   only `SN_PROFILE_<NAME>_<X>` (the connection, prod marking).
 */
export type ProfileScope = "override" | "fallback" | "isolated";

type Schema = z.ZodType<unknown, string>;

export interface SettingSpec {
  key: string;
  section: SettingSectionId;
  kind: SettingKind;
  /** Markdown; the README renders it as is, `.env.example` strips the markup. */
  description: string;
  since: string;
  /** The parsed default; undefined = unset / computed (see defaultText). */
  default?: unknown;
  /** Human text for the default when it is computed or unset. */
  defaultText?: string;
  required?: boolean;
  /** The value is a secret: never echoed, masked in support bundles. */
  secret?: boolean;
  /** D-5: `<KEY>_FILE` may supply the value. */
  fileSource?: boolean;
  /** Extra text for the generated `<KEY>_FILE` entry. */
  fileNote?: string;
  profile?: ProfileScope;
  /** Legacy names read when the key is unset (e.g. LOG_LEVEL). */
  aliases?: readonly string[];
  /** Outside the SN_ namespace (proxy, XDG). */
  external?: boolean;
  /** A documentation-only pattern row (SN_PROFILE_<NAME>_*), never read. */
  pattern?: boolean;
  /** Example value for `.env.example` (defaults to the default). */
  example?: string;
  /** Short plain-text description: the key is published in server.json. */
  registry?: string;
  /**
   * `isRequired` in server.json. Only a key needed by every auth method is
   * required there (SN_USER / SN_PASSWORD are not needed for apikey / token).
   */
  registryRequired?: boolean;
  /** Enum values, for docs. */
  values?: readonly string[];
  schema: Schema;
}

// --- kind helpers ----------------------------------------------------------

function fail(ctx: z.RefinementCtx, message: string): typeof z.NEVER {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  return z.NEVER;
}

interface IntOpts {
  /** Lowest accepted value (inclusive). */
  min: number;
  max?: number;
  /** Require an integer instead of flooring a decimal. */
  integer?: boolean;
  /** `min` is exclusive before flooring (the legacy "positive" parse). */
  positive?: boolean;
}

function intSchema(o: IntOpts): Schema {
  return z.string().transform((raw, ctx) => {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return fail(ctx, "expected a number");
    if (o.integer && !Number.isInteger(n)) {
      return fail(ctx, "expected an integer");
    }
    if (o.positive ? n <= 0 : n < o.min) {
      return fail(ctx, `expected a number >= ${o.positive ? 1 : o.min}`);
    }
    if (o.max !== undefined && n > o.max) {
      return fail(ctx, `expected a number <= ${o.max}`);
    }
    return Math.floor(n);
  });
}

const TRUTHY = ["1", "true", "yes", "on"] as const;
const FALSY = ["0", "false", "no", "off"] as const;

function boolSchema(
  on: readonly string[] = TRUTHY,
  off: readonly string[] = FALSY,
): Schema {
  return z.string().transform((raw, ctx) => {
    const v = raw.trim().toLowerCase();
    if (on.includes(v)) return true;
    if (off.includes(v)) return false;
    return fail(ctx, `expected one of ${[...on, ...off].join(", ")}`);
  });
}

function enumSchema(values: readonly string[], caseSensitive = false): Schema {
  return z.string().transform((raw, ctx) => {
    const v = caseSensitive ? raw.trim() : raw.trim().toLowerCase();
    if (values.includes(v)) return v;
    return fail(ctx, `expected one of ${values.join(", ")}`);
  });
}

const stringSchema: Schema = z.string();

const urlSchema: Schema = z.string().transform((raw, ctx) => {
  try {
    const url = new URL(raw.trim());
    if (url.protocol === "http:" || url.protocol === "https:") return raw;
  } catch {
    // fall through
  }
  return fail(ctx, "expected an http:// or https:// URL");
});

const dateSchema: Schema = z.string().transform((raw, ctx) => {
  if (Number.isNaN(Date.parse(raw.trim()))) {
    return fail(ctx, "expected an ISO 8601 date-time");
  }
  return raw.trim();
});

const profileNameSchema: Schema = z.string().transform((raw, ctx) => {
  const v = raw.trim().toLowerCase();
  if (PROFILE_RE.test(v)) return v;
  return fail(ctx, "expected a profile name (letters, digits, _)");
});

type Common = Omit<SettingSpec, "kind" | "schema" | "values">;

const int = (o: IntOpts, s: Common): SettingSpec => ({
  ...s,
  kind: "int",
  schema: intSchema(o),
});
/** The legacy "positive number, floored" parse used by most knobs. */
const positive = (s: Common): SettingSpec => int({ min: 1, positive: true }, s);
/** A non-negative number, floored (0 is meaningful). */
const nonNegative = (s: Common): SettingSpec => int({ min: 0 }, s);
const bool = (
  s: Common,
  on?: readonly string[],
  off?: readonly string[],
): SettingSpec => ({ ...s, kind: "bool", schema: boolSchema(on, off) });
const oneOf = (
  values: readonly string[],
  s: Common,
  caseSensitive = false,
): SettingSpec => ({
  ...s,
  kind: "enum",
  values,
  schema: enumSchema(values, caseSensitive),
});
const str = (s: Common): SettingSpec => ({
  ...s,
  kind: "string",
  schema: stringSchema,
});
const secret = (s: Common): SettingSpec => ({
  ...s,
  kind: "secret",
  secret: true,
  schema: stringSchema,
});
const filePath = (s: Common): SettingSpec => ({
  ...s,
  kind: "path",
  schema: stringSchema,
});
const list = (s: Common): SettingSpec => ({
  ...s,
  kind: "list",
  schema: stringSchema,
});
const url = (s: Common): SettingSpec => ({
  ...s,
  kind: "url",
  schema: urlSchema,
});
const date = (s: Common): SettingSpec => ({
  ...s,
  kind: "date",
  schema: dateSchema,
});

// Release markers.
const V100 = "1.0.0";
const V110 = "1.1.0";
const V200 = "2.0.0";
const NEXT = UNRELEASED;

// --- the manifest ------------------------------------------------------------

const BASE_SETTINGS: SettingSpec[] = [
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
        'M-9, **experimental**: `1` adds an optional `run_as_task:true` argument to `snapshot_instance`, `compare_instances`, `run_atf_test`, `run_atf_suite`, `check_code_health` and `query_table` (`format:"file"` only). Such a call returns an MCP task handle at once (`_meta["io.modelcontextprotocol/related-task"]`); the client polls `tasks/get`, reads `tasks/result` (kept 1 h, redacted) or stops it with `tasks/cancel`. Off: schemas unchanged. Built on the SDK\'s experimental task API.',
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
    default: 100_000,
    description:
      'Character budget for a query result before it is truncated for the client; the truncation note names `format:"file"`. A snapshot, compare or diagram result over the budget is returned in full with a `note`.',
  }),
  bool({
    key: "SN_OVERSIZE_TO_FILE",
    section: "results",
    since: NEXT,
    default: false,
    description:
      "S-11: write a snapshot, compare or diagram result over `SN_MAX_RESULT_CHARS` to a file under `SN_DOCS_DIR` (`<profile>/exports/`, `<profile>/diagrams/`) and return `{path, bytes, preview}` instead.",
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

/** The `<KEY>_FILE` entries derived from every `fileSource` setting (D-5). */
function fileSourceSpecs(specs: readonly SettingSpec[]): SettingSpec[] {
  return specs
    .filter((s) => s.fileSource)
    .map((s) =>
      filePath({
        key: `${s.key}_FILE`,
        section: "secret-files",
        since: NEXT,
        example: `/run/secrets/${s.key.toLowerCase()}`,
        description: `D-5: read \`${s.key}\` from this file (Docker / Kubernetes secrets).${s.fileNote ?? ""}`,
      }),
    );
}

/** Every declared setting, in documentation order. */
export const SETTINGS: readonly SettingSpec[] = (() => {
  const all = [...BASE_SETTINGS];
  const insertAt = all.findIndex((s) => s.section === "profiles");
  all.splice(insertAt, 0, ...fileSourceSpecs(BASE_SETTINGS));
  return all;
})();

const BY_KEY = new Map<string, SettingSpec>(
  SETTINGS.filter((s) => !s.pattern).map((s) => [s.key, s]),
);

/** The spec for `key`; throws for an undeclared key (a programming error). */
export function settingSpec(key: string): SettingSpec {
  const spec = BY_KEY.get(key);
  if (!spec) throw new Error(`Undeclared setting ${key}`);
  return spec;
}

/** True when `key` is declared in the manifest. */
export function isDeclaredSetting(key: string): boolean {
  return BY_KEY.has(key);
}

// ---------------------------------------------------------------------------
// Profile scoping
// ---------------------------------------------------------------------------

/**
 * `SN_<KEY>` → `SN_PROFILE_<NAME>_<KEY>`; the default profile keeps the
 * global key.
 */
export function profileEnvKey(key: string, profile: string): string {
  return profile === "default"
    ? key
    : `SN_PROFILE_${profile.toUpperCase()}_${key.slice("SN_".length)}`;
}

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface ReadOptions {
  env?: Env;
  /** Profile for a profile-scoped setting (default: the active profile). */
  profile?: string;
}

interface Located {
  /** The env key the raw value came from (for messages). */
  source: string;
  raw: string | undefined;
}

function locate(spec: SettingSpec, opts: ReadOptions): Located {
  const env = opts.env ?? process.env;
  const global = (): Located => {
    if (env[spec.key] !== undefined || !spec.aliases) {
      return { source: spec.key, raw: env[spec.key] };
    }
    for (const alias of spec.aliases) {
      if (env[alias] !== undefined) return { source: alias, raw: env[alias] };
    }
    return { source: spec.key, raw: undefined };
  };
  if (!spec.profile) return global();
  const profile = opts.profile ?? activeProfile();
  if (profile === "default") return global();
  const scopedKey = profileEnvKey(spec.key, profile);
  const scoped = env[scopedKey];
  switch (spec.profile) {
    case "override":
      return scoped !== undefined
        ? { source: scopedKey, raw: scoped }
        : global();
    case "fallback":
      return scoped !== undefined && scoped.trim() !== ""
        ? { source: scopedKey, raw: scoped }
        : global();
    case "isolated":
      return { source: scopedKey, raw: scoped };
  }
}

/**
 * The raw string of a setting, profile scope applied — undefined when unset.
 * Unlike {@link readSetting} it neither trims nor validates: secrets and
 * values with meaningful whitespace are returned verbatim.
 */
export function rawSetting(
  key: string,
  opts: ReadOptions = {},
): string | undefined {
  return locate(settingSpec(key), opts).raw;
}

/** The env key a setting resolves from for `profile` (for messages). */
export function settingSource(key: string, opts: ReadOptions = {}): string {
  return locate(settingSpec(key), opts).source;
}

// ---------------------------------------------------------------------------
// Parsing and warnings
// ---------------------------------------------------------------------------

export interface ParseResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Parse a raw value against a spec; an empty value counts as unset. */
export function parseSetting(
  spec: SettingSpec,
  raw: string | undefined,
): ParseResult {
  if (raw === undefined || raw.trim() === "") return { ok: true };
  const parsed = spec.schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues.map((i) => i.message).join("; "),
  };
}

/** Human text of a setting's default. */
export function defaultText(spec: SettingSpec): string {
  if (spec.defaultText !== undefined) return spec.defaultText;
  if (spec.default === undefined) return "—";
  if (Array.isArray(spec.default)) return `\`${spec.default.join(",")}\``;
  const value = spec.default;
  const text =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
  return `\`${text}\``;
}

function shownValue(spec: SettingSpec, raw: string): string {
  return spec.secret ? "<redacted>" : JSON.stringify(raw);
}

/** A one-line message for an invalid value (a secret's value is never shown). */
export function invalidMessage(
  spec: SettingSpec,
  source: string,
  raw: string,
  error: string,
): string {
  return `Invalid ${source}=${shownValue(spec, raw)}: ${error}; using the default (${defaultText(spec).replaceAll("`", "")})`;
}

const warned = new Set<string>();

/** Forget which invalid values were already reported (tests). */
export function resetSettingWarnings(): void {
  warned.clear();
}

function warnOnce(id: string, message: string): void {
  if (warned.has(id)) return;
  // Mark first: the logger reads SN_LOG_LEVEL through this module.
  warned.add(id);
  logger.warn(message);
}

/**
 * A setting's parsed value, profile scope applied. Unset → the manifest
 * default (undefined for computed defaults, which the caller supplies).
 * Invalid → a one-time warning and the default.
 */
export function readSetting<T = unknown>(
  key: string,
  opts: ReadOptions = {},
): T | undefined {
  const spec = settingSpec(key);
  const { source, raw } = locate(spec, opts);
  const parsed = parseSetting(spec, raw);
  if (parsed.ok) {
    return (parsed.value !== undefined ? parsed.value : spec.default) as
      | T
      | undefined;
  }
  warnOnce(
    `${source}\u0000${raw}`,
    invalidMessage(spec, source, raw ?? "", parsed.error ?? "invalid"),
  );
  return spec.default as T | undefined;
}

/** A numeric setting (the caller supplies a computed default). */
export function readInt(key: string, opts?: ReadOptions): number | undefined {
  return readSetting<number>(key, opts);
}

/** A boolean setting. */
export function readBool(key: string, opts?: ReadOptions): boolean {
  return readSetting<boolean>(key, opts) === true;
}

/** An enum setting. */
export function readEnum<T extends string>(
  key: string,
  opts?: ReadOptions,
): T | undefined {
  return readSetting<T>(key, opts);
}

/** A string setting, trimmed; empty → undefined. */
export function readString(
  key: string,
  opts?: ReadOptions,
): string | undefined {
  const raw = rawSetting(key, opts)?.trim();
  return raw ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Secrets and D-5 file sources
// ---------------------------------------------------------------------------

const FILE_SOURCE_SPECS = SETTINGS.filter((s) => s.fileSource);

/**
 * True when `name` is a D-5 `<KEY>_FILE` secret source: `<KEY>` is a
 * `fileSource` setting, or `SN_PROFILE_<NAME>_<X>_FILE` for a profile-scoped
 * one. SN_TOKEN_FILE, SN_OAUTH_JWT_KEY_FILE and the SN_TLS_*_FILE paths keep
 * their own meaning and are not sources.
 */
export function isSecretFileSource(name: string): boolean {
  if (!name.endsWith("_FILE")) return false;
  const base = name.slice(0, -"_FILE".length);
  for (const spec of FILE_SOURCE_SPECS) {
    if (base === spec.key) return true;
    if (!spec.profile) continue;
    const suffix = `_${spec.key.slice("SN_".length)}`;
    if (base.startsWith("SN_PROFILE_") && base.endsWith(suffix)) {
      const name = base.slice("SN_PROFILE_".length, -suffix.length);
      if (/^[A-Z0-9_]+$/.test(name)) return true;
    }
  }
  return false;
}

/** The base keys a `<KEY>_FILE` source may supply (global forms). */
export function fileSourceKeys(): string[] {
  return FILE_SOURCE_SPECS.map((s) => s.key);
}

/** Resolve an env key (possibly profile-scoped) to its declared spec. */
function specForEnvKey(name: string): SettingSpec | undefined {
  const direct = BY_KEY.get(name);
  if (direct) return direct;
  if (name.endsWith("_FILE") && isSecretFileSource(name)) {
    return BY_KEY.get(`${name.slice(0, -"_FILE".length)}`) ?? undefined;
  }
  if (name.startsWith("SN_PROFILE_")) {
    for (const spec of SETTINGS) {
      if (!spec.profile) continue;
      const suffix = `_${spec.key.slice("SN_".length)}`;
      if (
        name.endsWith(suffix) &&
        name.length > "SN_PROFILE_".length + suffix.length
      ) {
        return spec;
      }
    }
  }
  return undefined;
}

/** True when the manifest declares `name` (or its profile form) a secret. */
export function isSecretKey(name: string): boolean {
  const spec = specForEnvKey(name);
  if (!spec) return false;
  // A `<KEY>_FILE` source holds a path, not the secret itself.
  return spec.secret === true && !name.endsWith("_FILE");
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

export interface SettingIssue {
  key: string;
  level: "error" | "warning";
  message: string;
}

export interface ValidatedSettings {
  /** Resolved global values (defaults applied; secrets shown as "<set>"). */
  settings: Record<string, unknown>;
  issues: SettingIssue[];
  strict: boolean;
}

/** Profile-scoped keys: every SN_PROFILE_<NAME>_<X> in `env` with a spec. */
function profileScopedKeys(env: Env): Array<[string, SettingSpec]> {
  const out: Array<[string, SettingSpec]> = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith("SN_PROFILE_") || name.endsWith("_FILE")) continue;
    const spec = specForEnvKey(name);
    if (spec) out.push([name, spec]);
  }
  return out;
}

/**
 * Validate every declared setting in `env` (global and profile-scoped
 * forms) and report unknown `SN_*` keys. Pure: no logging, no throwing.
 */
export function validateSettings(env: Env = process.env): ValidatedSettings {
  const issues: SettingIssue[] = [];
  const settings: Record<string, unknown> = {};
  const check = (
    spec: SettingSpec,
    source: string,
    raw: string | undefined,
  ) => {
    const parsed = parseSetting(spec, raw);
    if (!parsed.ok) {
      issues.push({
        key: source,
        level: "error",
        message: invalidMessage(
          spec,
          source,
          raw ?? "",
          parsed.error ?? "invalid",
        ),
      });
    }
    return parsed;
  };
  for (const spec of SETTINGS) {
    if (spec.pattern) continue;
    const { source, raw } = locate(spec, { env, profile: "default" });
    const parsed = check(spec, source, raw);
    const value =
      parsed.ok && parsed.value !== undefined ? parsed.value : spec.default;
    if (value !== undefined) {
      settings[spec.key] =
        spec.secret && raw !== undefined && raw.trim() !== "" ? "<set>" : value;
    }
  }
  for (const [name, spec] of profileScopedKeys(env)) {
    check(spec, name, env[name]);
  }
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith("SN_") || specForEnvKey(name)) continue;
    issues.push({
      key: name,
      level: "warning",
      message: `Unknown setting ${name} — not read by this server (a typo?)`,
    });
  }
  const strict =
    parseSetting(settingSpec("SN_STRICT_SETTINGS"), env.SN_STRICT_SETTINGS)
      .value === true;
  return { settings, issues, strict };
}

let startup: ValidatedSettings | undefined;

/** The result of the last {@link applySettingsAtStartup} (doctor). */
export function startupSettings(): ValidatedSettings | undefined {
  return startup;
}

/**
 * E-4 — validate the environment once at startup (after the env file and
 * the D-5 secret files are loaded). Every issue is logged as a warning; with
 * SN_STRICT_SETTINGS on, invalid values throw one error naming them all.
 * Runtime reads keep going through the live accessors above, so a later
 * `use_instance` / `set_credentials` change is honoured.
 */
export function applySettingsAtStartup(
  env: Env = process.env,
): ValidatedSettings {
  const result = validateSettings(env);
  startup = result;
  const errors = result.issues.filter((i) => i.level === "error");
  if (result.strict && errors.length > 0) {
    throw new Error(
      `Invalid settings (SN_STRICT_SETTINGS is on): ${errors.map((e) => e.message).join(" | ")}`,
    );
  }
  for (const issue of result.issues) {
    const spec = BY_KEY.get(issue.key);
    const raw = env[issue.key];
    warnOnce(
      issue.level === "error" && spec
        ? `${issue.key}\u0000${raw}`
        : `unknown\u0000${issue.key}`,
      issue.message,
    );
  }
  return result;
}
