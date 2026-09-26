import { readFileSync } from "node:fs";
import { ServiceNowError, notConfiguredError } from "./errors.js";
import {
  getCredentials,
  activeProfile,
  profileAuthEnv,
  authModeFor,
  authEnvKey,
  persistEnv,
  envFileAclWarning,
  credentialStatus,
  type AuthMode,
} from "./config.js";
import { getDispatcher } from "./dispatcher.js";
import { rawRequest, readJsonBody } from "./http-util.js";
import { logger } from "./logging.js";
import { signJwtRS256 } from "./jwt.js";
import { currentRuntime, defineRuntimePart } from "./runtime.js";

/**
 * Read an auth env var with the active profile's override winning over the
 * global key: SN_PROFILE_<NAME>_<SUFFIX> first, then SN_<SUFFIX>. Mirrors
 * core/policy.ts so per-profile auth follows the same precedence as per-profile
 * policy — the MI-1 convention lets a profile set its own _AUTH / _OAUTH_*
 * (e.g. "prod is OAuth, dev is Basic" in one server). An empty override is
 * treated as unset and falls through to the global key.
 */
export function authEnv(suffix: string): string | undefined {
  return profileAuthEnv(suffix, activeProfile());
}

export type { AuthMode };

/**
 * Pluggable authentication for the ServiceNow client.
 *
 * `headers(host)` returns the HTTP headers to merge into the request — an
 * `Authorization` value for Basic/OAuth/Bearer, an `x-sn-apikey` for API keys,
 * or nothing for `none` (certificate-only mutual TLS). The host is already
 * resolved and SSRF-checked by the caller, so an OAuth provider can safely
 * derive the token endpoint from it.
 */
export interface AuthProvider {
  readonly mode: AuthMode;
  headers(host: string): Promise<Record<string, string>>;
}

/**
 * M-1: a credential the active profile's auth method needs is absent — the
 * message keeps its wording and gains code NOT_CONFIGURED plus a hint that
 * names the missing fields (roles only, never values).
 */
function missingCredential(message: string): ServiceNowError {
  return notConfiguredError(
    message,
    credentialStatus().missing,
    activeProfile(),
  );
}

function basicHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

class BasicAuthProvider implements AuthProvider {
  readonly mode = "basic" as const;

  headers(): Promise<Record<string, string>> {
    const { user, password } = getCredentials();
    if (!user || !password) {
      throw missingCredential(
        "ServiceNow Basic auth requires SN_USER and SN_PASSWORD. Use the servicenow_set_credentials tool first.",
      );
    }
    return Promise.resolve({ Authorization: basicHeader(user, password) });
  }
}

/** API Key auth: ServiceNow Inbound API Keys, sent as the `x-sn-apikey` header. */
class ApiKeyAuthProvider implements AuthProvider {
  readonly mode = "apikey" as const;

  headers(): Promise<Record<string, string>> {
    const key = authEnv("API_KEY")?.trim();
    if (!key) {
      throw missingCredential("API key auth requires SN_API_KEY.");
    }
    return Promise.resolve({ "x-sn-apikey": key });
  }
}

// L6-02: bearer tokens read from SN_TOKEN_FILE, cached per file path so a
// request does not hit the disk; a 401 re-reads the file once (see
// reloadBearerTokenFile). E-3: held by the runtime container.
const bearerFilePart = defineRuntimePart(
  "bearer-token-files",
  () => new Map<string, string>(),
  (files) => files.clear(),
);

function readTokenFile(path: string): string {
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new ServiceNowError(
      `Cannot read SN_TOKEN_FILE (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!token) throw new ServiceNowError("SN_TOKEN_FILE is empty.");
  return token;
}

/**
 * The bearer token for the active profile: SN_TOKEN_FILE (a file an external
 * IdP / Vault agent rotates) wins over the inline SN_BEARER_TOKEN.
 */
function bearerToken(): string {
  const file = authEnv("TOKEN_FILE")?.trim();
  if (file) {
    const files = currentRuntime().get(bearerFilePart);
    let token = files.get(file);
    if (token === undefined) {
      token = readTokenFile(file);
      files.set(file, token);
    }
    return token;
  }
  const token = authEnv("BEARER_TOKEN")?.trim();
  if (!token) {
    throw missingCredential(
      "Token auth requires SN_BEARER_TOKEN or SN_TOKEN_FILE.",
    );
  }
  return token;
}

/**
 * L6-02 — re-read the active profile's SN_TOKEN_FILE after a 401. Returns true
 * only when the file now holds a different token (a retry is worthwhile);
 * false without a file, on a read error or when the token is unchanged.
 */
export function reloadBearerTokenFile(): boolean {
  const file = authEnv("TOKEN_FILE")?.trim();
  if (!file) return false;
  const files = currentRuntime().get(bearerFilePart);
  const previous = files.get(file);
  let next: string;
  try {
    next = readTokenFile(file);
  } catch {
    return false;
  }
  files.set(file, next);
  return next !== previous;
}

/** A caller-supplied bearer token used verbatim (no token exchange). */
class BearerAuthProvider implements AuthProvider {
  readonly mode = "token" as const;

  headers(): Promise<Record<string, string>> {
    return Promise.resolve({ Authorization: `Bearer ${bearerToken()}` });
  }
}

/** Hint carried by every AUTH_EXPIRED error (L6-02). */
export const AUTH_EXPIRED_HINT =
  "The bearer token was rejected (expired or revoked). Rotate it — update SN_BEARER_TOKEN, or point SN_TOKEN_FILE at a file your token issuer refreshes (it is re-read once on a 401).";

/** Warn this long before SN_TOKEN_EXPIRES_AT. */
const TOKEN_EXPIRY_WARN_MS = 24 * 60 * 60 * 1000;

/**
 * L6-02 — a warning when `profile`'s bearer token (SN_TOKEN_EXPIRES_AT, ISO
 * 8601) has expired or expires within 24 hours; undefined otherwise.
 */
export function tokenExpiryWarning(
  profile: string = activeProfile(),
  now: number = Date.now(),
): string | undefined {
  const raw = profileAuthEnv("TOKEN_EXPIRES_AT", profile)?.trim();
  if (!raw || authModeFor(profile) !== "token") return undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) {
    return `SN_TOKEN_EXPIRES_AT "${raw}" is not an ISO 8601 date — the bearer token expiry cannot be checked.`;
  }
  const left = at - now;
  if (left <= 0) {
    return `The bearer token expired at ${new Date(at).toISOString()} — rotate SN_BEARER_TOKEN / SN_TOKEN_FILE.`;
  }
  if (left < TOKEN_EXPIRY_WARN_MS) {
    const hours = Math.max(1, Math.round(left / 3_600_000));
    return `The bearer token expires in about ${hours}h (${new Date(at).toISOString()}) — rotate SN_BEARER_TOKEN / SN_TOKEN_FILE soon.`;
  }
  return undefined;
}

/** No auth header — for certificate-only mutual TLS (the cert maps to a user). */
class NoneAuthProvider implements AuthProvider {
  readonly mode = "none" as const;
  headers(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }
}

type OAuthGrant =
  | "password"
  | "client_credentials"
  | "refresh_token"
  | "jwt_bearer";

interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  grantType: OAuthGrant;
  username?: string;
  password?: string;
  refreshToken?: string;
}

function readOAuthConfig(): OAuthConfig {
  const clientId = authEnv("OAUTH_CLIENT_ID")?.trim() ?? "";
  if (!clientId) {
    throw missingCredential(
      "OAuth auth requires SN_OAUTH_CLIENT_ID (and usually SN_OAUTH_CLIENT_SECRET).",
    );
  }
  const rawGrant = authEnv("OAUTH_GRANT")?.trim().toLowerCase() || "password";
  if (
    rawGrant !== "password" &&
    rawGrant !== "client_credentials" &&
    rawGrant !== "refresh_token" &&
    rawGrant !== "jwt_bearer"
  ) {
    throw new ServiceNowError(
      `Unsupported SN_OAUTH_GRANT "${rawGrant}". Use password, client_credentials, refresh_token or jwt_bearer.`,
    );
  }
  const grantType: OAuthGrant = rawGrant;

  const { user, password } = getCredentials();
  const cfg: OAuthConfig = {
    clientId,
    clientSecret: authEnv("OAUTH_CLIENT_SECRET")?.trim() || undefined,
    grantType,
  };

  if (grantType === "password") {
    if (!user || !password) {
      throw missingCredential(
        "OAuth password grant requires SN_USER and SN_PASSWORD.",
      );
    }
    cfg.username = user;
    cfg.password = password;
  } else if (grantType === "refresh_token") {
    const refreshToken = authEnv("OAUTH_REFRESH_TOKEN")?.trim();
    if (!refreshToken) {
      throw missingCredential(
        "OAuth refresh_token grant requires SN_OAUTH_REFRESH_TOKEN.",
      );
    }
    cfg.refreshToken = refreshToken;
  } else if (grantType === "jwt_bearer") {
    // The subject identifies the cached token; the signed assertion is built per
    // refresh in getToken().
    cfg.username = jwtSubject();
  }

  return cfg;
}

/** The subject (impersonated user) for the JWT-bearer grant. */
function jwtSubject(): string {
  return authEnv("OAUTH_JWT_SUB")?.trim() || getCredentials().user;
}

/**
 * Build the signed JWT assertion for the OAuth 2.0 JWT-bearer grant. The private
 * key comes from SN_OAUTH_JWT_KEY (PEM) or SN_OAUTH_JWT_KEY_FILE; its public
 * certificate is registered on the ServiceNow JWT provider.
 */
function buildJwtAssertion(host: string, clientId: string): string {
  const inlineKey = authEnv("OAUTH_JWT_KEY");
  const keyFile = authEnv("OAUTH_JWT_KEY_FILE")?.trim();
  const keyPem = (
    inlineKey ?? (keyFile ? readFileSync(keyFile, "utf8") : "")
  ).trim();
  if (!keyPem) {
    throw missingCredential(
      "OAuth jwt_bearer grant requires SN_OAUTH_JWT_KEY or SN_OAUTH_JWT_KEY_FILE (a PEM private key).",
    );
  }
  const sub = jwtSubject();
  if (!sub) {
    throw missingCredential(
      "OAuth jwt_bearer grant requires SN_OAUTH_JWT_SUB or SN_USER (the subject).",
    );
  }
  const iss = authEnv("OAUTH_JWT_ISS")?.trim() || clientId;
  const aud =
    authEnv("OAUTH_JWT_AUD")?.trim() || `https://${host}/oauth_token.do`;
  const kid = authEnv("OAUTH_JWT_KID")?.trim() || undefined;
  const expRaw = Number(authEnv("OAUTH_JWT_EXP_SEC"));
  const expSec =
    Number.isFinite(expRaw) && expRaw > 0 ? Math.floor(expRaw) : 300;
  const now = Math.floor(Date.now() / 1000);
  return signJwtRS256(
    { iss, sub, aud, iat: now, exp: now + expSec },
    keyPem,
    kid,
  );
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Cached per host + client + grant + user. The password/secret is NOT part of
// the key, so a credential change must clear the cache explicitly (see
// invalidateTokens) or a token obtained with the old secrets would live on.
// E-3: held by the runtime container; dispose() drops every token.
const tokensPart = defineRuntimePart(
  "tokens",
  () => new Map<string, CachedToken>(),
  (tokens) => tokens.clear(),
);

const tokenCache = (): Map<string, CachedToken> =>
  currentRuntime().get(tokensPart);

// L6-01: env keys whose rotated refresh token could not be written to the env
// file and lives only in process.env (warned once per key).
const rotatedInMemoryPart = defineRuntimePart(
  "refresh-rotated-in-memory",
  () => new Set<string>(),
);

/** The env key the active profile's refresh token was read from. */
function refreshTokenKey(profile: string): string {
  const scoped = authEnvKey("OAUTH_REFRESH_TOKEN", profile);
  const value = process.env[scoped];
  return profile !== "default" && value !== undefined && value.trim() !== ""
    ? scoped
    : "SN_OAUTH_REFRESH_TOKEN";
}

/**
 * L6-01 — persist a refresh token the instance rotated on a refresh_token
 * grant. The old one is typically invalidated server-side, so dropping the new
 * one would break every later refresh. A failed write (read-only env file,
 * container) keeps it in memory for this process and warns once.
 */
function persistRotatedRefreshToken(token: string): void {
  const profile = activeProfile();
  const key = refreshTokenKey(profile);
  const inMemory = currentRuntime().get(rotatedInMemoryPart);
  try {
    persistEnv({ [key]: token });
    inMemory.delete(key);
    logger.info("OAuth refresh token rotated — persisted to the env file", {
      profile,
      key,
    });
  } catch (error) {
    process.env[key] = token;
    if (!inMemory.has(key)) {
      inMemory.add(key);
      logger.warn(
        "OAuth refresh token rotated but the env file could not be written — keeping it in memory; it is lost on restart",
        {
          profile,
          key,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}

/**
 * The state of `profile`'s refresh token: `configured`, `rotated-in-memory`
 * (a rotation could not be persisted, L6-01) or `none`.
 */
export function refreshTokenState(
  profile: string = activeProfile(),
): "configured" | "rotated-in-memory" | "none" {
  if (!profileAuthEnv("OAUTH_REFRESH_TOKEN", profile)?.trim()) return "none";
  return currentRuntime().get(rotatedInMemoryPart).has(refreshTokenKey(profile))
    ? "rotated-in-memory"
    : "configured";
}

/**
 * Non-secret credential warnings for `profile`, shared by doctor and
 * get_status (D-2): bearer-token expiry (L6-02), a rotated refresh token kept
 * only in memory (L6-01), `none` mode without a client certificate, and the
 * Windows env-file ACL note (L2-11).
 */
export function credentialWarnings(
  profile: string = activeProfile(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const warnings: string[] = [];
  const expiry = tokenExpiryWarning(profile);
  if (expiry) warnings.push(expiry);
  if (refreshTokenState(profile) === "rotated-in-memory") {
    warnings.push(
      "The OAuth refresh token was rotated but could not be written to the env file — it is kept in memory only and is lost on restart; make the env file writable or update SN_OAUTH_REFRESH_TOKEN.",
    );
  }
  if (
    authModeFor(profile) === "none" &&
    !(
      process.env.SN_TLS_CLIENT_CERT?.trim() ||
      process.env.SN_TLS_CLIENT_CERT_FILE?.trim()
    )
  ) {
    warnings.push(
      "Auth mode is none but no client certificate is configured (SN_TLS_CLIENT_CERT[_FILE]) — requests are sent unauthenticated.",
    );
  }
  const acl = envFileAclWarning(platform);
  if (acl) warnings.push(acl);
  return warnings;
}

/** Drop all cached OAuth tokens. Call whenever credentials change. */
export function invalidateTokens(): void {
  tokenCache().clear();
}

/**
 * Drop the cached tokens for one host — used by the 401 retry in http.ts when
 * a token is revoked server-side before its TTL runs out.
 */
export function invalidateToken(host: string): void {
  const tokens = tokenCache();
  for (const key of tokens.keys()) {
    if (key.startsWith(`${host}|`)) tokens.delete(key);
  }
}

/**
 * POST to the ServiceNow token endpoint and return the parsed JSON, mapping a
 * non-2xx response or a transport error to a ServiceNowError. Shared by the
 * runtime grants and the Authorization Code + PKCE exchange.
 */
async function requestToken(
  host: string,
  body: URLSearchParams,
  opts: { replayable: boolean },
): Promise<Record<string, unknown>> {
  const url = `https://${host}/oauth_token.do`;
  // The token endpoint goes through the same primitive as every API call
  // (H-10 / L1-07): proxy/TLS dispatcher, User-Agent, timeout + deadline,
  // transport error mapping, telemetry under the "auth" bucket. Runtime grants
  // (client credentials, password, JWT, refresh) are replayable, so a 503 or a
  // dropped connection gets one more try; the Authorization Code exchange is
  // not — a code is single-use and a replay would only produce a misleading
  // "invalid_grant". The form body is never logged.
  const res = await rawRequest({
    url,
    safeUrl: url,
    method: "POST",
    host,
    telemetryKey: "auth",
    system: "ServiceNow OAuth",
    errorPrefix: "OAuth token request failed",
    headers: () => ({
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    }),
    body: body.toString(),
    dispatcher: await getDispatcher(host),
    extractDetail: (json) => {
      const o = (json ?? {}) as Record<string, unknown>;
      return (
        (typeof o.error_description === "string" && o.error_description) ||
        (typeof o.error === "string" && o.error) ||
        undefined
      );
    },
    idempotent: opts.replayable,
    maxRetries: opts.replayable ? 1 : 0,
  });

  const json = await readJsonBody(res, {
    system: "ServiceNow OAuth",
    safeUrl: url,
  });
  return json && typeof json === "object" && !("raw" in json)
    ? (json as Record<string, unknown>)
    : {};
}

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string;
}

/**
 * Build the OAuth 2.1 Authorization Code + PKCE authorization URL for the
 * ServiceNow authorization endpoint (`/oauth_auth.do`).
 */
export function buildAuthorizeUrl(host: string, p: AuthorizeUrlParams): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  });
  if (p.scope) q.set("scope", p.scope);
  return `https://${host}/oauth_auth.do?${q.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

/**
 * Exchange an authorization code (with its PKCE verifier) for tokens — the
 * second leg of the OAuth 2.1 Authorization Code + PKCE flow. Returns the
 * refresh token used for subsequent non-interactive runs.
 */
export async function exchangeAuthorizationCode(
  host: string,
  p: {
    clientId: string;
    clientSecret?: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: p.clientId,
    code: p.code,
    code_verifier: p.codeVerifier,
    redirect_uri: p.redirectUri,
  });
  if (p.clientSecret) body.set("client_secret", p.clientSecret);
  const json = await requestToken(host, body, { replayable: false });
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new ServiceNowError(
      "Authorization Code exchange did not return an access_token.",
    );
  }
  const ttl = Number(json.expires_in);
  return {
    accessToken,
    refreshToken:
      typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresIn: Number.isFinite(ttl) ? ttl : undefined,
  };
}

/** Skew applied before expiry so a token is refreshed slightly early. */
const TOKEN_SKEW_MS = 30_000;
const DEFAULT_TOKEN_TTL_SEC = 1800;

class OAuthProvider implements AuthProvider {
  readonly mode = "oauth" as const;

  async headers(host: string): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getToken(host)}` };
  }

  private async getToken(host: string): Promise<string> {
    const cfg = readOAuthConfig();
    const key = `${host}|${cfg.clientId}|${cfg.grantType}|${cfg.username ?? ""}`;
    const cached = tokenCache().get(key);
    if (cached && cached.expiresAt > Date.now() + TOKEN_SKEW_MS) {
      return cached.token;
    }

    const body = new URLSearchParams();
    body.set("client_id", cfg.clientId);
    if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
    if (cfg.grantType === "jwt_bearer") {
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
      body.set("assertion", buildJwtAssertion(host, cfg.clientId));
    } else {
      body.set("grant_type", cfg.grantType);
      if (cfg.grantType === "password") {
        body.set("username", cfg.username!);
        body.set("password", cfg.password!);
      } else if (cfg.grantType === "refresh_token") {
        body.set("refresh_token", cfg.refreshToken!);
      }
    }

    const json = await requestToken(host, body, { replayable: true });

    const token = json.access_token;
    if (typeof token !== "string" || !token) {
      throw new ServiceNowError(
        "OAuth token response did not contain an access_token.",
      );
    }
    const ttlSec = Number(json.expires_in);
    const expiresAt =
      Date.now() +
      (Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : DEFAULT_TOKEN_TTL_SEC) *
        1000;
    tokenCache().set(key, { token, expiresAt });
    if (
      cfg.grantType === "refresh_token" &&
      typeof json.refresh_token === "string" &&
      json.refresh_token.trim() &&
      json.refresh_token.trim() !== cfg.refreshToken
    ) {
      persistRotatedRefreshToken(json.refresh_token.trim());
    }
    logger.debug("Obtained OAuth access token", {
      host,
      grant: cfg.grantType,
      expiresInSec: Number.isFinite(ttlSec) ? ttlSec : undefined,
    });
    return token;
  }
}

/**
 * Resolve the configured auth mode for the active profile. An explicit
 * SN_AUTH wins; otherwise it is inferred from the present keys: API key →
 * bearer token (SN_BEARER_TOKEN / SN_TOKEN_FILE) → OAuth client id → Basic.
 * Use SN_AUTH=none for certificate-only mutual TLS.
 */
export function getAuthMode(): AuthMode {
  return authModeFor(activeProfile());
}

const basicProvider = new BasicAuthProvider();
const oauthProvider = new OAuthProvider();
const apiKeyProvider = new ApiKeyAuthProvider();
const bearerProvider = new BearerAuthProvider();
const noneProvider = new NoneAuthProvider();

/** Return the auth provider for the current configuration. */
export function getAuthProvider(): AuthProvider {
  switch (getAuthMode()) {
    case "oauth":
      return oauthProvider;
    case "apikey":
      return apiKeyProvider;
    case "token":
      return bearerProvider;
    case "none":
      return noneProvider;
    default:
      return basicProvider;
  }
}
