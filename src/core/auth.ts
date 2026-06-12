import { ServiceNowError } from "./errors.js";
import { getCredentials } from "./config.js";
import { getTimeoutMs } from "./settings.js";
import { logger } from "./logging.js";

/**
 * Pluggable authentication for the ServiceNow client.
 *
 * `authorize(host)` returns the value for the HTTP `Authorization` header.
 * The host is already resolved and SSRF-checked by the caller, so an OAuth
 * provider can safely derive the token endpoint from it.
 */
export interface AuthProvider {
  readonly mode: "basic" | "oauth";
  authorize(host: string): Promise<string>;
}

function basicHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

class BasicAuthProvider implements AuthProvider {
  readonly mode = "basic" as const;

  authorize(): Promise<string> {
    const { user, password } = getCredentials();
    if (!user || !password) {
      throw new ServiceNowError(
        "ServiceNow Basic auth requires SN_USER and SN_PASSWORD. Use the servicenow_set_credentials tool first.",
      );
    }
    return Promise.resolve(basicHeader(user, password));
  }
}

type OAuthGrant = "password" | "client_credentials" | "refresh_token";

interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  grantType: OAuthGrant;
  username?: string;
  password?: string;
  refreshToken?: string;
}

function readOAuthConfig(): OAuthConfig {
  const clientId = process.env.SN_OAUTH_CLIENT_ID?.trim() ?? "";
  if (!clientId) {
    throw new ServiceNowError(
      "OAuth auth requires SN_OAUTH_CLIENT_ID (and usually SN_OAUTH_CLIENT_SECRET).",
    );
  }
  const rawGrant = process.env.SN_OAUTH_GRANT?.trim().toLowerCase() || "password";
  if (
    rawGrant !== "password" &&
    rawGrant !== "client_credentials" &&
    rawGrant !== "refresh_token"
  ) {
    throw new ServiceNowError(
      `Unsupported SN_OAUTH_GRANT "${rawGrant}". Use password, client_credentials or refresh_token.`,
    );
  }
  const grantType: OAuthGrant = rawGrant;

  const { user, password } = getCredentials();
  const cfg: OAuthConfig = {
    clientId,
    clientSecret: process.env.SN_OAUTH_CLIENT_SECRET?.trim() || undefined,
    grantType,
  };

  if (grantType === "password") {
    if (!user || !password) {
      throw new ServiceNowError(
        "OAuth password grant requires SN_USER and SN_PASSWORD.",
      );
    }
    cfg.username = user;
    cfg.password = password;
  } else if (grantType === "refresh_token") {
    const refreshToken = process.env.SN_OAUTH_REFRESH_TOKEN?.trim();
    if (!refreshToken) {
      throw new ServiceNowError(
        "OAuth refresh_token grant requires SN_OAUTH_REFRESH_TOKEN.",
      );
    }
    cfg.refreshToken = refreshToken;
  }

  return cfg;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Cached per host + client + grant + user. The password/secret is NOT part of
// the key, so a credential change must clear the cache explicitly (see
// invalidateTokens) or a token obtained with the old secrets would live on.
const tokenCache = new Map<string, CachedToken>();

/** Drop all cached OAuth tokens. Call whenever credentials change. */
export function invalidateTokens(): void {
  tokenCache.clear();
}

/**
 * Drop the cached tokens for one host — used by the 401 retry in http.ts when
 * a token is revoked server-side before its TTL runs out.
 */
export function invalidateToken(host: string): void {
  for (const key of tokenCache.keys()) {
    if (key.startsWith(`${host}|`)) tokenCache.delete(key);
  }
}

/** Skew applied before expiry so a token is refreshed slightly early. */
const TOKEN_SKEW_MS = 30_000;
const DEFAULT_TOKEN_TTL_SEC = 1800;

class OAuthProvider implements AuthProvider {
  readonly mode = "oauth" as const;

  async authorize(host: string): Promise<string> {
    return `Bearer ${await this.getToken(host)}`;
  }

  private async getToken(host: string): Promise<string> {
    const cfg = readOAuthConfig();
    const key = `${host}|${cfg.clientId}|${cfg.grantType}|${cfg.username ?? ""}`;
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + TOKEN_SKEW_MS) {
      return cached.token;
    }

    const body = new URLSearchParams();
    body.set("grant_type", cfg.grantType);
    body.set("client_id", cfg.clientId);
    if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
    if (cfg.grantType === "password") {
      body.set("username", cfg.username!);
      body.set("password", cfg.password!);
    } else if (cfg.grantType === "refresh_token") {
      body.set("refresh_token", cfg.refreshToken!);
    }

    const url = `https://${host}/oauth_token.do`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(getTimeoutMs()),
      });
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      throw new ServiceNowError(
        `OAuth token request to ${host} failed: ${err.message}`,
      );
    }

    const text = await res.text();
    let json: Record<string, unknown> = {};
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = {};
      }
    }

    if (!res.ok) {
      const detail =
        (typeof json.error_description === "string" && json.error_description) ||
        (typeof json.error === "string" && json.error) ||
        res.statusText ||
        "(no detail)";
      throw new ServiceNowError(
        `OAuth token request failed (${res.status}): ${detail}`,
        res.status,
        json,
      );
    }

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
    tokenCache.set(key, { token, expiresAt });
    logger.debug("Obtained OAuth access token", {
      host,
      grant: cfg.grantType,
      expiresInSec: Number.isFinite(ttlSec) ? ttlSec : undefined,
    });
    return token;
  }
}

/**
 * Resolve the configured auth mode. Defaults to OAuth when an OAuth client id
 * is present, otherwise Basic. Override explicitly with SN_AUTH=basic|oauth.
 */
export function getAuthMode(): "basic" | "oauth" {
  const explicit = process.env.SN_AUTH?.trim().toLowerCase();
  if (explicit === "basic" || explicit === "oauth") return explicit;
  return process.env.SN_OAUTH_CLIENT_ID?.trim() ? "oauth" : "basic";
}

const basicProvider = new BasicAuthProvider();
const oauthProvider = new OAuthProvider();

/** Return the auth provider for the current configuration. */
export function getAuthProvider(): AuthProvider {
  return getAuthMode() === "oauth" ? oauthProvider : basicProvider;
}
