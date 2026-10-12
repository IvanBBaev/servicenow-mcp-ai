import {
  constants,
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";

/**
 * N-17 (O-15) — the HTTP transport as an OAuth 2.1 resource server.
 *
 * An external OpenID Connect / OAuth 2.1 authorization server issues the
 * access tokens; this server only validates them. It publishes RFC 9728
 * protected-resource metadata naming that issuer, answers an unauthenticated
 * request with a `WWW-Authenticate` challenge that points at the metadata,
 * and accepts a JWT access token only when its signature verifies against
 * the issuer's JWKS and its `iss`, `aud` (RFC 8707: this server's resource
 * URI), `exp`, `nbf` and scopes hold. An opaque token is checked with the
 * issuer's RFC 7662 introspection endpoint when one is configured, under the
 * same rules. The token goes nowhere else: ServiceNow is called with the
 * configured instance credentials (phase 1 of the custody model).
 *
 * The static `SN_HTTP_TOKEN` stays the simple mode and is still accepted
 * next to OAuth, for a scraper or a single operator.
 */

/** Seconds of clock skew allowed on `exp` and `nbf`. */
export const CLOCK_LEEWAY_SEC = 60;
/** How long a fetched JWKS is trusted before it is fetched again. */
export const JWKS_TTL_MS = 10 * 60_000;
/** The least time between two refetches forced by an unknown `kid`. */
export const JWKS_REFETCH_MIN_MS = 30_000;

/** How long an active introspection answer is reused (capped by `exp`). */
export const INTROSPECTION_TTL_MS = 60_000;
/** The most introspection answers kept; the oldest goes first. */
export const INTROSPECTION_CACHE_MAX = 1_000;

/** The RFC 9728 well-known path segment. */
export const PRM_WELL_KNOWN = "/.well-known/oauth-protected-resource";

/** Asymmetric JWS algorithms accepted; `none` and HMAC never are. */
interface AlgorithmSpec {
  hash: string;
  pss?: boolean;
  /** The EC curve the key must be on. */
  curve?: string;
  ed?: boolean;
}

const ALGORITHMS: Record<string, AlgorithmSpec> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  PS256: { hash: "sha256", pss: true },
  PS384: { hash: "sha384", pss: true },
  PS512: { hash: "sha512", pss: true },
  ES256: { hash: "sha256", curve: "prime256v1" },
  ES384: { hash: "sha384", curve: "secp384r1" },
  ES512: { hash: "sha512", curve: "secp521r1" },
  EdDSA: { hash: "", ed: true },
};

/** Refresh tokens are not a resource requirement (auth-22). */
const OFFLINE_ACCESS = "offline_access";

export interface OAuthResourceConfig {
  /** The authorization server's issuer identifier. */
  issuer: string;
  /** This server's canonical resource URI (RFC 8707). */
  resource: string;
  /** Extra `aud` values accepted besides the resource URI. */
  audiences?: string[];
  /** The issuer's JWKS URI; discovered from the issuer metadata when unset. */
  jwksUri?: string;
  /** Scopes every request needs. */
  scopes?: string[];
  /**
   * N-17 phase 2: a claim copied to `extra.login` when it is a non-empty
   * string — the value a linked ServiceNow account must match.
   */
  userClaim?: string;
  /** RFC 7662 introspection of opaque tokens; unset = JWT tokens only. */
  introspection?: IntrospectionConfig;
}

/** The issuer's introspection endpoint and this server's client there. */
export interface IntrospectionConfig {
  uri: string;
  clientId: string;
  clientSecret: string;
}

/** The outcome of checking one request's `Authorization` header. */
export type AuthOutcome =
  | { ok: true; auth?: AuthInfo; subject?: string }
  | {
      ok: false;
      status: 401 | 403 | 503;
      challenge?: string;
      message: string;
    };

type Fetch = typeof fetch;

/**
 * The canonical form of a resource URI: lowercase scheme and host, no
 * fragment, and no trailing slash on an empty path (auth-14, auth-15).
 * Returns undefined for anything that is not an absolute http(s) URI.
 */
export function canonicalResource(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hash || url.username || url.password) return undefined;
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/** True for `localhost` and the loopback addresses. */
function isLoopbackUrl(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/**
 * Check a configuration before the listener starts; throws with a message
 * an operator can act on. The issuer and the JWKS must be https unless they
 * are loopback (OAuth 2.1 §1.5, auth-35).
 */
export function validateOAuthConfig(config: OAuthResourceConfig): void {
  const resource = canonicalResource(config.resource);
  if (!resource) {
    throw new Error(
      `SN_HTTP_OAUTH_RESOURCE must be an absolute http(s) URI without a fragment (got ${JSON.stringify(config.resource)})`,
    );
  }
  for (const [key, value] of [
    ["SN_HTTP_OAUTH_ISSUER", config.issuer],
    ["SN_HTTP_OAUTH_JWKS_URI", config.jwksUri],
    ["SN_HTTP_OAUTH_INTROSPECTION_URI", config.introspection?.uri],
  ] as const) {
    if (value === undefined) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${key} must be an absolute URI (got ${value})`);
    }
    if (url.protocol !== "https:" && !isLoopbackUrl(url)) {
      throw new Error(`${key} must use https (got ${value})`);
    }
  }
}

function base64url(part: string): Buffer {
  return Buffer.from(part, "base64url");
}

function parseJson(buf: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(buf.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The token's scopes from `scope` (RFC 9068, space-separated) or `scp`. */
function scopesOf(claims: Record<string, unknown>): string[] {
  const raw = claims.scope ?? claims.scp;
  if (typeof raw === "string") return raw.split(" ").filter(Boolean);
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string");
  }
  return [];
}

/** Constant-time check that `header` is exactly `Bearer <token>`. */
export function staticBearerMatches(
  header: string | undefined,
  token: string,
): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Thrown when the authorization server's keys cannot be fetched. */
class KeySourceError extends Error {}

/**
 * Validates bearer tokens for one resource. Holds the issuer's JWKS in
 * memory; a token signed with an unknown `kid` forces one refetch, at most
 * every JWKS_REFETCH_MIN_MS, so key rotation works without a restart and a
 * flood of forged `kid`s cannot hammer the issuer.
 */
export class OAuthResourceServer {
  readonly resource: string;
  private readonly audiences: Set<string>;
  private readonly scopes: string[];
  private keys: Map<string, KeyObject> | null = null;
  private keysAt = 0;
  private lastFetch = -Infinity;
  private inflight: Promise<void> | null = null;
  private jwksUri: string | undefined;
  /** sha256(token) → the active introspection answer and its reuse limit. */
  private readonly introspected = new Map<
    string,
    { claims: Record<string, unknown>; until: number }
  >();

  constructor(
    private readonly config: OAuthResourceConfig,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    validateOAuthConfig(config);
    this.resource = canonicalResource(config.resource) as string;
    this.audiences = new Set(
      [this.resource, ...(config.audiences ?? [])].map(
        (a) => canonicalResource(a) ?? a,
      ),
    );
    this.scopes = (config.scopes ?? []).filter((s) => s !== OFFLINE_ACCESS);
    this.jwksUri = config.jwksUri;
  }

  /**
   * The paths the metadata document is served at: the RFC 9728 form with
   * the resource path inserted after the well-known segment, and the root
   * form clients fall back to.
   */
  metadataPaths(): string[] {
    const path = new URL(this.resource).pathname.replace(/\/$/, "");
    return path ? [PRM_WELL_KNOWN + path, PRM_WELL_KNOWN] : [PRM_WELL_KNOWN];
  }

  /** The absolute URL of the metadata document, for the challenge. */
  metadataUrl(): string {
    const url = new URL(this.resource);
    return `${url.origin}${this.metadataPaths()[0]}`;
  }

  /** The RFC 9728 protected-resource metadata document. */
  metadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.config.issuer],
      bearer_methods_supported: ["header"],
      ...(this.scopes.length ? { scopes_supported: this.scopes } : {}),
      resource_name: "ServiceNow MCP server",
    };
  }

  /** A `WWW-Authenticate` value (RFC 6750 §3) for this resource. */
  challenge(error?: string, description?: string): string {
    const params = [`resource_metadata="${this.metadataUrl()}"`];
    if (this.scopes.length) params.push(`scope="${this.scopes.join(" ")}"`);
    if (error) params.push(`error="${error}"`);
    if (description) params.push(`error_description="${description}"`);
    return `Bearer ${params.join(", ")}`;
  }

  /** Check one request's `Authorization` header. */
  async authenticate(header: string | undefined): Promise<AuthOutcome> {
    const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header ?? "");
    if (!match) {
      return {
        ok: false,
        status: 401,
        challenge: this.challenge(),
        message: "Unauthorized",
      };
    }
    const token = match[1] as string;
    const invalid = (description: string): AuthOutcome => ({
      ok: false,
      status: 401,
      challenge: this.challenge("invalid_token", description),
      message: `Unauthorized: ${description}`,
    });

    const parts = token.split(".");
    if (parts.length !== 3) {
      return this.config.introspection
        ? this.introspect(token, invalid)
        : invalid("not a JWT access token");
    }
    const [h, p, s] = parts as [string, string, string];
    const head = parseJson(base64url(h));
    const claims = parseJson(base64url(p));
    if (!head || !claims) return invalid("malformed token");
    const alg = typeof head.alg === "string" ? head.alg : "";
    const spec = ALGORITHMS[alg];
    if (!spec) return invalid("unsupported signing algorithm");
    if (typeof head.crit !== "undefined") {
      return invalid("unsupported critical header");
    }

    let key: KeyObject | undefined;
    try {
      key = await this.keyFor(
        typeof head.kid === "string" ? head.kid : undefined,
      );
    } catch (error) {
      return {
        ok: false,
        status: 503,
        message: `Authorization server keys unavailable: ${(error as Error).message}`,
      };
    }
    if (!key) return invalid("unknown signing key");
    if (!keyFits(key, spec)) return invalid("key does not match algorithm");

    const signed = Buffer.from(`${h}.${p}`);
    const signature = base64url(s);
    let valid: boolean;
    try {
      valid = verifySignature(
        spec.ed ? null : spec.hash,
        signed,
        {
          key,
          ...(spec.pss
            ? {
                padding: constants.RSA_PKCS1_PSS_PADDING,
                saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
              }
            : {}),
          ...(spec.curve ? { dsaEncoding: "ieee-p1363" as const } : {}),
        },
        signature,
      );
    } catch {
      valid = false;
    }
    if (!valid) return invalid("bad signature");
    if (claims.iss !== this.config.issuer) return invalid("wrong issuer");
    return this.accept(token, claims, invalid);
  }

  /**
   * The checks every token passes, signed or introspected: audience,
   * expiry, subject and scopes; then the request's AuthInfo.
   */
  private accept(
    token: string,
    claims: Record<string, unknown>,
    invalid: (description: string) => AuthOutcome,
  ): AuthOutcome {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const forUs = aud.some(
      (a) =>
        typeof a === "string" && this.audiences.has(canonicalResource(a) ?? a),
    );
    if (!forUs) return invalid("token not issued for this resource");

    const nowSec = Math.floor(this.now() / 1000);
    if (typeof claims.exp !== "number") return invalid("token has no expiry");
    if (claims.exp + CLOCK_LEEWAY_SEC <= nowSec)
      return invalid("token expired");
    if (
      typeof claims.nbf === "number" &&
      claims.nbf - CLOCK_LEEWAY_SEC > nowSec
    ) {
      return invalid("token not yet valid");
    }
    if (typeof claims.sub !== "string" || claims.sub === "") {
      return invalid("token has no subject");
    }

    const granted = scopesOf(claims);
    const missing = this.scopes.filter((scope) => !granted.includes(scope));
    if (missing.length) {
      return {
        ok: false,
        status: 403,
        challenge: this.challenge(
          "insufficient_scope",
          `requires ${this.scopes.join(" ")}`,
        ),
        message: "Forbidden: insufficient scope",
      };
    }

    const clientId =
      typeof claims.client_id === "string"
        ? claims.client_id
        : typeof claims.azp === "string"
          ? claims.azp
          : "";
    const login = this.config.userClaim
      ? claims[this.config.userClaim]
      : undefined;
    return {
      ok: true,
      subject: claims.sub,
      auth: {
        token,
        clientId,
        scopes: granted,
        expiresAt: claims.exp,
        resource: new URL(this.resource),
        extra: {
          subject: claims.sub,
          ...(typeof login === "string" && login ? { login } : {}),
        },
      },
    };
  }

  /**
   * RFC 7662: ask the issuer about an opaque token. An active answer is
   * reused for INTROSPECTION_TTL_MS at most (never past its `exp`), so a
   * revoked token stays usable for up to that long; an inactive one is not
   * cached. An answer naming another issuer is refused.
   */
  private async introspect(
    token: string,
    invalid: (description: string) => AuthOutcome,
  ): Promise<AuthOutcome> {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = this.introspected.get(key);
    if (hit && hit.until > this.now()) {
      return this.accept(token, hit.claims, invalid);
    }
    this.introspected.delete(key);
    let claims: Record<string, unknown>;
    try {
      claims = await this.postIntrospection(token);
    } catch (error) {
      return {
        ok: false,
        status: 503,
        message: `Token introspection unavailable: ${(error as Error).message}`,
      };
    }
    if (claims.active !== true) return invalid("token is not active");
    if (claims.iss !== undefined && claims.iss !== this.config.issuer) {
      return invalid("wrong issuer");
    }
    const outcome = this.accept(token, claims, invalid);
    if (outcome.ok) {
      const exp = (claims.exp as number) * 1000;
      if (this.introspected.size >= INTROSPECTION_CACHE_MAX) {
        const oldest = this.introspected.keys().next().value;
        if (oldest !== undefined) this.introspected.delete(oldest);
      }
      this.introspected.set(key, {
        claims,
        until: Math.min(exp, this.now() + INTROSPECTION_TTL_MS),
      });
    }
    return outcome;
  }

  /** POST the token to the introspection endpoint (client_secret_basic). */
  private async postIntrospection(
    token: string,
  ): Promise<Record<string, unknown>> {
    const { uri, clientId, clientSecret } = this.config
      .introspection as IntrospectionConfig;
    // RFC 6749 §2.3.1: both halves are form-encoded before base64.
    const basic = Buffer.from(
      `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
    ).toString("base64");
    const res = await this.fetchImpl(uri, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        token,
        token_type_hint: "access_token",
      }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new KeySourceError(`${uri} answered ${res.status}`);
    const body: unknown = await res.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new KeySourceError(`${uri} is not a JSON object`);
    }
    return body as Record<string, unknown>;
  }

  /** The key for `kid`, fetching the JWKS when it is stale or lacks it. */
  private async keyFor(
    kid: string | undefined,
  ): Promise<KeyObject | undefined> {
    const now = this.now();
    if (!this.keys || now - this.keysAt > JWKS_TTL_MS) {
      await this.refresh();
    }
    let key = this.pick(kid);
    if (!key && now - this.lastFetch >= JWKS_REFETCH_MIN_MS) {
      await this.refresh();
      key = this.pick(kid);
    }
    return key;
  }

  private pick(kid: string | undefined): KeyObject | undefined {
    if (!this.keys) return undefined;
    if (kid !== undefined) return this.keys.get(kid);
    // A token without `kid` is accepted only when the set is unambiguous.
    return this.keys.size === 1 ? [...this.keys.values()][0] : undefined;
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    this.lastFetch = this.now();
    const uri = this.jwksUri ?? (await this.discoverJwksUri());
    this.jwksUri = uri;
    const body = await this.getJson(uri);
    const list = Array.isArray(body.keys) ? body.keys : [];
    const keys = new Map<string, KeyObject>();
    list.forEach((jwk: unknown, i: number) => {
      if (!jwk || typeof jwk !== "object") return;
      const k = jwk as JsonWebKey & { kid?: string; use?: string };
      if (k.use !== undefined && k.use !== "sig") return;
      try {
        keys.set(
          typeof k.kid === "string" ? k.kid : `#${i}`,
          createPublicKey({ key: k, format: "jwk" }),
        );
      } catch {
        // A key this runtime cannot import is skipped, not fatal.
      }
    });
    this.keys = keys;
    this.keysAt = this.now();
  }

  /**
   * The issuer's `jwks_uri` from its OpenID Connect discovery document, or
   * the RFC 8414 one; the document must name the same issuer.
   */
  private async discoverJwksUri(): Promise<string> {
    const issuer = new URL(this.config.issuer);
    const path = issuer.pathname.replace(/\/$/, "");
    const candidates = [
      `${this.config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
      `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    ];
    let last: unknown;
    for (const url of candidates) {
      try {
        const doc = await this.getJson(url);
        if (doc.issuer !== this.config.issuer) {
          throw new KeySourceError(`issuer mismatch in ${url}`);
        }
        if (typeof doc.jwks_uri !== "string") {
          throw new KeySourceError(`no jwks_uri in ${url}`);
        }
        validateOAuthConfig({ ...this.config, jwksUri: doc.jwks_uri });
        return doc.jwks_uri;
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new KeySourceError("discovery failed");
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new KeySourceError(`${url} answered ${res.status}`);
    const body: unknown = await res.json();
    if (!body || typeof body !== "object") {
      throw new KeySourceError(`${url} is not a JSON object`);
    }
    return body as Record<string, unknown>;
  }
}

/** True when `key` is of the family `alg` needs. */
function keyFits(key: KeyObject, spec: AlgorithmSpec): boolean {
  const type = key.asymmetricKeyType;
  if (spec.ed) return type === "ed25519" || type === "ed448";
  if (spec.curve) {
    return type === "ec" && key.asymmetricKeyDetails?.namedCurve === spec.curve;
  }
  return type === "rsa" || (spec.pss === true && type === "rsa-pss");
}
