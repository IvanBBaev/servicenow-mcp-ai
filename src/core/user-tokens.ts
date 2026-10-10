import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ServiceNowError, notConfiguredError } from "./errors.js";
import { activeProfile, getEnvPath, profileAuthEnv } from "./config.js";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  DEFAULT_TOKEN_TTL_SEC,
  TOKEN_SKEW_MS,
  type TokenSet,
} from "./auth.js";
import { delegatedSubject } from "./delegation.js";
import { getDispatcher } from "./dispatcher.js";
import { rawRequest, readJsonBody } from "./http-util.js";
import { logger } from "./logging.js";
import { currentSession } from "./request-context.js";
import { currentRuntime, defineRuntimePart } from "./runtime.js";
import {
  getHttpOAuth,
  getHttpUserTokens,
  type HttpUserTokenSettings,
} from "./settings.js";

/**
 * N-17 phase 2 — per-user ServiceNow tokens (`SN_HTTP_OAUTH_USER_TOKENS`).
 *
 * A request authorized with an OAuth access token calls ServiceNow as its
 * subject: each subject links its own ServiceNow account once, per profile
 * and host, through the Authorization Code + PKCE flow with the profile's
 * OAuth client. The link URL is the instance's own authorize URL; the
 * instance redirects back to `/oauth/servicenow/callback` on this server,
 * which exchanges the code, checks that the account is the subject's own
 * (`SN_HTTP_OAUTH_USER_MATCH`) and stores the refresh token, AES-256-GCM
 * encrypted, in the token store. Access tokens are cached in memory only.
 *
 * Limits (documented): pending links live in this process, so the callback
 * must reach the instance that issued the link; a link is dropped by the
 * instance rejecting its refresh token or by rotating the key.
 */

/** How long a link URL stays redeemable. */
export const LINK_TTL_MS = 10 * 60 * 1000;
/** Pending links kept at most (the oldest is dropped beyond it). */
export const MAX_PENDING_LINKS = 1000;
export const CALLBACK_PATH = "/oauth/servicenow/callback";

/**
 * A tool call needs a ServiceNow account the subject has not linked yet. The
 * tool layer turns it into a URL elicitation when the client supports one,
 * else into an error result that carries the link.
 */
export class AccountLinkRequiredError extends ServiceNowError {
  constructor(
    readonly url: string,
    readonly elicitationId: string,
    readonly host: string,
  ) {
    super(
      `Link your ServiceNow account on ${host} to continue: open ${url} , sign in as yourself, then retry.`,
      undefined,
      undefined,
      {
        code: "NOT_CONFIGURED",
        hint: "This server calls ServiceNow as you (SN_HTTP_OAUTH_USER_TOKENS); the link is valid for 10 minutes and is needed once per instance.",
        source: "server",
      },
    );
    this.name = "AccountLinkRequiredError";
  }

  /** The text shown to the user next to the link. */
  get prompt(): string {
    return `Sign in to ServiceNow (${this.host}) to let this server act as you.`;
  }
}

// ---------------------------------------------------------------------------
// The encrypted store
// ---------------------------------------------------------------------------

interface SealedEntry {
  iv: string;
  tag: string;
  data: string;
  /** When the entry was written (ISO). */
  at: string;
}

interface StoreFile {
  v: 1;
  entries: Record<string, SealedEntry>;
}

interface LinkedAccount {
  refreshToken: string;
  /** The `sys_user` field value the account was verified against. */
  login: string;
}

/** The store key of one link: never the subject itself. */
export function linkKey(
  subject: string,
  profile: string,
  host: string,
): string {
  const id = createHash("sha256").update(subject).digest("hex");
  return `${id}|${profile}|${host}`;
}

/** The store path: `SN_HTTP_OAUTH_TOKEN_STORE` or next to the env file. */
export function tokenStorePath(
  settings: HttpUserTokenSettings | undefined = getHttpUserTokens(),
): string {
  return (
    settings?.storePath ?? join(dirname(getEnvPath()), "oauth-user-tokens.json")
  );
}

function readStore(path: string): StoreFile {
  if (!existsSync(path)) return { v: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoreFile;
    if (parsed?.v === 1 && parsed.entries && typeof parsed.entries === "object")
      return parsed;
  } catch {
    // fall through
  }
  logger.warn(
    "The OAuth user-token store is unreadable — treating it as empty",
    {
      path,
    },
  );
  return { v: 1, entries: {} };
}

/** Atomic write: a 0600 temp file renamed over the store (dir 0700). */
function writeStore(path: string, store: StoreFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function seal(key: Buffer, aad: string, value: LinkedAccount): SealedEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    at: new Date().toISOString(),
  };
}

/** The entry's plaintext, or undefined when it does not decrypt (key rotated). */
function unseal(
  key: Buffer,
  aad: string,
  entry: SealedEntry,
): LinkedAccount | undefined {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(entry.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(entry.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const value = JSON.parse(plain) as LinkedAccount;
    return typeof value.refreshToken === "string" &&
      typeof value.login === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function loadAccount(
  settings: HttpUserTokenSettings,
  key: string,
): LinkedAccount | undefined {
  const entry = readStore(tokenStorePath(settings)).entries[key];
  return entry ? unseal(settings.key, key, entry) : undefined;
}

function saveAccount(
  settings: HttpUserTokenSettings,
  key: string,
  account: LinkedAccount,
): void {
  const path = tokenStorePath(settings);
  const store = readStore(path);
  store.entries[key] = seal(settings.key, key, account);
  writeStore(path, store);
}

function dropAccount(settings: HttpUserTokenSettings, key: string): void {
  const path = tokenStorePath(settings);
  const store = readStore(path);
  if (!(key in store.entries)) return;
  delete store.entries[key];
  writeStore(path, store);
}

// ---------------------------------------------------------------------------
// In-memory state: access tokens, in-flight refreshes, pending links
// ---------------------------------------------------------------------------

interface PendingLink {
  key: string;
  login: string;
  profile: string;
  host: string;
  verifier: string;
  url: string;
  elicitationId: string;
  expiresAt: number;
}

interface UserTokenState {
  tokens: Map<string, { token: string; expiresAt: number }>;
  inflight: Map<string, Promise<string>>;
  /** Keyed by the OAuth `state` parameter. */
  pending: Map<string, PendingLink>;
}

const userTokensPart = defineRuntimePart(
  "user-tokens",
  (): UserTokenState => ({
    tokens: new Map(),
    inflight: new Map(),
    pending: new Map(),
  }),
  (s) => {
    s.tokens.clear();
    s.inflight.clear();
    s.pending.clear();
  },
  { scope: "process" },
);

const state = (): UserTokenState => currentRuntime().get(userTokensPart);

const base64url = (b: Buffer): string => b.toString("base64url");

function cacheToken(key: string, set: TokenSet): string {
  const ttl =
    set.expiresIn && set.expiresIn > 0 ? set.expiresIn : DEFAULT_TOKEN_TTL_SEC;
  state().tokens.set(key, {
    token: set.accessToken,
    expiresAt: Date.now() + ttl * 1000,
  });
  return set.accessToken;
}

/** The profile's OAuth client — the one the instance issues user tokens to. */
function clientFor(profile: string): {
  clientId: string;
  clientSecret?: string;
} {
  const clientId = profileAuthEnv("OAUTH_CLIENT_ID", profile)?.trim();
  if (!clientId) {
    throw notConfiguredError(
      "Per-user ServiceNow tokens need an OAuth client registered on the instance (Application Registry) with this server's callback as its redirect URL.",
      ["SN_OAUTH_CLIENT_ID", "SN_OAUTH_CLIENT_SECRET"],
      profile,
    );
  }
  const clientSecret = profileAuthEnv("OAUTH_CLIENT_SECRET", profile)?.trim();
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/** `<SN_HTTP_OAUTH_RESOURCE origin>/oauth/servicenow/callback`. */
export function callbackUrl(): string {
  const oauth = getHttpOAuth();
  if (!oauth) {
    throw new Error("SN_HTTP_OAUTH_USER_TOKENS needs SN_HTTP_OAUTH_ISSUER");
  }
  return new URL(CALLBACK_PATH, oauth.resource).href;
}

function sweepPending(pending: Map<string, PendingLink>): void {
  const now = Date.now();
  for (const [s, link] of pending) {
    if (link.expiresAt <= now) pending.delete(s);
  }
  while (pending.size >= MAX_PENDING_LINKS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

/**
 * The link the current subject must open for (profile, host): an unexpired
 * pending one is reused, so retries do not mint a new URL each time.
 */
function linkRequired(
  key: string,
  login: string,
  profile: string,
  host: string,
): AccountLinkRequiredError {
  const { pending } = state();
  const now = Date.now();
  for (const link of pending.values()) {
    if (link.key === key && link.login === login && link.expiresAt > now) {
      return new AccountLinkRequiredError(link.url, link.elicitationId, host);
    }
  }
  const { clientId } = clientFor(profile);
  const verifier = base64url(randomBytes(32));
  const oauthState = base64url(randomBytes(24));
  const url = buildAuthorizeUrl(host, {
    clientId,
    redirectUri: callbackUrl(),
    codeChallenge: base64url(createHash("sha256").update(verifier).digest()),
    state: oauthState,
  });
  sweepPending(pending);
  const link: PendingLink = {
    key,
    login,
    profile,
    host,
    verifier,
    url,
    elicitationId: randomUUID(),
    expiresAt: now + LINK_TTL_MS,
  };
  pending.set(oauthState, link);
  return new AccountLinkRequiredError(link.url, link.elicitationId, host);
}

/** The delegated request's subject and login, or a NOT_CONFIGURED error. */
function delegatedIdentity(settings: HttpUserTokenSettings): {
  subject: string;
  login: string;
} {
  const subject = delegatedSubject();
  const login = currentSession()?.login;
  if (!subject) throw new Error("not a delegated request");
  if (!login) {
    throw new ServiceNowError(
      `The access token carries no "${settings.claim}" claim, so its ServiceNow account cannot be verified (SN_HTTP_OAUTH_USER_MATCH).`,
      undefined,
      undefined,
      { code: "NOT_CONFIGURED", source: "server" },
    );
  }
  return { subject, login };
}

const sameLogin = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** A refresh the instance refused for the token itself (not the client). */
function refreshRejected(error: unknown): boolean {
  if (!(error instanceof ServiceNowError)) return false;
  if (error.status !== 400 && error.status !== 401) return false;
  return !/invalid_client/i.test(`${error.message} ${String(error.detail)}`);
}

/**
 * The `Authorization` header for the delegated subject on `host`. Throws
 * AccountLinkRequiredError when the subject has no usable link.
 */
export async function userTokenHeaders(
  host: string,
): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await userAccessToken(host)}` };
}

async function userAccessToken(host: string): Promise<string> {
  const settings = getHttpUserTokens();
  if (!settings) throw new Error("SN_HTTP_OAUTH_USER_TOKENS is off");
  const { subject, login } = delegatedIdentity(settings);
  const profile = activeProfile();
  const key = linkKey(subject, profile, host);
  const s = state();
  const hit = s.tokens.get(key);
  if (hit && hit.expiresAt > Date.now() + TOKEN_SKEW_MS) return hit.token;
  // One refresh per link at a time: a rotating refresh token replayed by a
  // concurrent call would be refused and drop the link.
  const running = s.inflight.get(key);
  if (running) return running;
  const task = (async () => {
    const account = loadAccount(settings, key);
    if (!account || !sameLogin(account.login, login)) {
      throw linkRequired(key, login, profile, host);
    }
    let set: TokenSet;
    try {
      set = await refreshAccessToken(host, {
        ...clientFor(profile),
        refreshToken: account.refreshToken,
      });
    } catch (error) {
      if (!refreshRejected(error)) throw error;
      dropAccount(settings, key);
      logger.info(
        "A linked ServiceNow account's refresh token was refused — link dropped",
        {
          profile,
          host,
        },
      );
      throw linkRequired(key, login, profile, host);
    }
    if (set.refreshToken && set.refreshToken !== account.refreshToken) {
      saveAccount(settings, key, {
        ...account,
        refreshToken: set.refreshToken,
      });
    }
    return cacheToken(key, set);
  })();
  s.inflight.set(key, task);
  try {
    return await task;
  } finally {
    s.inflight.delete(key);
  }
}

/** Drop the delegated subject's cached access token for `host` (401 retry). */
export function invalidateUserToken(host: string): void {
  const subject = delegatedSubject();
  if (subject) state().tokens.delete(linkKey(subject, activeProfile(), host));
}

// ---------------------------------------------------------------------------
// The callback
// ---------------------------------------------------------------------------

export type LinkOutcome =
  | { ok: true; host: string }
  | { ok: false; status: number; message: string };

/**
 * The `sys_user.<field>` of the account `accessToken` belongs to, read with
 * that token — the instance itself says whose token it issued.
 */
async function accountLogin(
  host: string,
  accessToken: string,
  field: string,
): Promise<string | undefined> {
  const safeUrl = `https://${host}/api/now/table/sys_user`;
  const q = new URLSearchParams({
    sysparm_query: "sys_id=javascript:gs.getUserID()",
    sysparm_fields: `sys_id,${field}`,
    sysparm_limit: "1",
  });
  const res = await rawRequest({
    url: `${safeUrl}?${q.toString()}`,
    safeUrl,
    method: "GET",
    host,
    telemetryKey: "auth",
    system: "ServiceNow",
    headers: () => ({
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    }),
    dispatcher: await getDispatcher(host),
    extractDetail: () => undefined,
    maxRetries: 1,
  });
  const json = (await readJsonBody(res, { system: "ServiceNow", safeUrl })) as {
    result?: Record<string, unknown>[];
  } | null;
  const value = json?.result?.[0]?.[field];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Complete a link from the instance's redirect: `state` binds it to the
 * subject that asked, the code is single-use, and the account must be the
 * subject's own. Nothing is stored on any failure.
 */
export async function completeLink(
  params: URLSearchParams,
): Promise<LinkOutcome> {
  const settings = getHttpUserTokens();
  if (!settings) return { ok: false, status: 404, message: "Not found" };
  const oauthState = params.get("state") ?? "";
  const { pending } = state();
  const link = pending.get(oauthState);
  if (!link || link.expiresAt <= Date.now()) {
    if (link) pending.delete(oauthState);
    return {
      ok: false,
      status: 400,
      message:
        "This link is unknown or has expired — run the tool again for a new one.",
    };
  }
  pending.delete(oauthState);
  const error = params.get("error");
  const code = params.get("code");
  if (error || !code) {
    return {
      ok: false,
      status: 400,
      message: `ServiceNow did not authorize the link (${error ?? "no code"}).`,
    };
  }
  try {
    const set = await exchangeAuthorizationCode(link.host, {
      ...clientFor(link.profile),
      code,
      codeVerifier: link.verifier,
      redirectUri: callbackUrl(),
    });
    if (!set.refreshToken) {
      return {
        ok: false,
        status: 502,
        message:
          "ServiceNow issued no refresh token — enable refresh tokens on the OAuth client (Refresh Token Lifespan > 0).",
      };
    }
    const login = await accountLogin(
      link.host,
      set.accessToken,
      settings.field,
    );
    if (!login || !sameLogin(login, link.login)) {
      logger.warn(
        "ServiceNow account link refused — the account is not the subject's",
        {
          profile: link.profile,
          host: link.host,
          field: settings.field,
        },
      );
      return {
        ok: false,
        status: 403,
        message: `The ServiceNow account you signed in with is not yours (its ${settings.field} does not match your sign-in). Sign out of ServiceNow and link again.`,
      };
    }
    saveAccount(settings, link.key, {
      refreshToken: set.refreshToken,
      login: link.login,
    });
    cacheToken(link.key, set);
    logger.info("ServiceNow account linked", {
      profile: link.profile,
      host: link.host,
    });
    return { ok: true, host: link.host };
  } catch (e) {
    logger.warn("ServiceNow account link failed", {
      profile: link.profile,
      host: link.host,
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      status: 502,
      message:
        "ServiceNow refused the link — try again, and check the OAuth client's redirect URL.",
    };
  }
}
