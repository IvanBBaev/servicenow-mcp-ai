import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { activeProfile } from "./config.js";
import { ServiceNowError } from "./errors.js";
import { logger } from "./logging.js";
import { currentRuntime, defineRuntimePart } from "./runtime.js";

/**
 * Outbound connection policy for the HTTP twins (H-10 / L1-01, L1-08):
 * corporate proxy and TLS options resolved from the environment into ONE
 * undici dispatcher per effective configuration.
 *
 * - Proxy: SN_HTTPS_PROXY (explicit, always honoured) beats the conventional
 *   HTTPS_PROXY / HTTP_PROXY (either case), which in turn respect NO_PROXY.
 * - TLS: SN_TLS_CA[_FILE] and SN_TLS_REJECT_UNAUTHORIZED apply on their own;
 *   SN_TLS_CLIENT_CERT/_KEY add mutual TLS on top.
 *
 * `undici` stays an OPTIONAL dependency: it is imported dynamically and only
 * when a proxy or TLS option is actually configured, so the default install
 * keeps using Node's global fetch untouched. The pure "env → options" half is
 * exported separately so it can be unit-tested without undici installed.
 */

export type ProxySource = "SN_HTTPS_PROXY" | "HTTPS_PROXY" | "HTTP_PROXY";

export interface ProxyChoice {
  source: ProxySource;
  /** Full proxy URL — may carry credentials; never log or return it. */
  url: string;
  /** Redacted `host:port` form, safe for status output. */
  host: string;
}

export interface TlsOptions {
  cert?: string;
  key?: string;
  ca?: string;
  rejectUnauthorized: boolean;
}

export interface DispatcherOptions {
  proxy?: ProxyChoice;
  tls?: TlsOptions;
}

type Env = Record<string, string | undefined>;

function firstSet(env: Env, names: string[]): [string, string] | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return [name, value];
  }
  return undefined;
}

function hostOnly(entry: string): string {
  // Strip an optional :port (or [v6]:port) from a NO_PROXY entry.
  const bracket = entry.match(/^\[(.+)\](?::\d+)?$/);
  if (bracket?.[1]) return bracket[1];
  return entry.replace(/:\d+$/, "");
}

/**
 * Does `host` fall under a NO_PROXY list? Entries are comma-separated suffixes
 * (`corp.example.com`, `.example.com`), exact hosts, or `*` for everything.
 * Matching ignores case and any port on either side.
 */
export function noProxyMatches(
  host: string,
  noProxy: string | undefined,
): boolean {
  if (!noProxy?.trim()) return false;
  const target = hostOnly(host.trim().toLowerCase());
  for (const raw of noProxy.split(",")) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    entry = hostOnly(entry);
    if (entry.startsWith(".")) entry = entry.slice(1);
    if (!entry) continue;
    if (target === entry || target.endsWith(`.${entry}`)) return true;
  }
  return false;
}

function describeProxyUrl(
  source: string,
  raw: string,
): { url: string; host: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ServiceNowError(
      `${source} is not a valid URL — expected http://host:port or https://host:port (credentials as user:pass@ are allowed).`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ServiceNowError(
      `${source} must use http:// or https:// (got ${parsed.protocol.replace(/:$/, "")}).`,
    );
  }
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return { url: parsed.toString(), host: `${parsed.hostname}:${port}` };
}

/**
 * Which proxy (if any) should carry requests to `host`. Pure: reads only the
 * `env` it is given. Throws ServiceNowError for a malformed proxy URL without
 * echoing the value (it may embed credentials).
 */
export function resolveProxyForHost(
  host: string,
  env: Env = process.env,
): ProxyChoice | undefined {
  const explicit = firstSet(env, ["SN_HTTPS_PROXY"]);
  if (explicit) {
    return {
      source: "SN_HTTPS_PROXY",
      ...describeProxyUrl(explicit[0], explicit[1]),
    };
  }
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (noProxyMatches(host, noProxy)) return undefined;
  const https = firstSet(env, ["HTTPS_PROXY", "https_proxy"]);
  if (https) {
    return { source: "HTTPS_PROXY", ...describeProxyUrl(https[0], https[1]) };
  }
  const http = firstSet(env, ["HTTP_PROXY", "http_proxy"]);
  if (http) {
    return { source: "HTTP_PROXY", ...describeProxyUrl(http[0], http[1]) };
  }
  return undefined;
}

function readPem(
  inlineVar: string,
  fileVar: string,
  env: Env,
): string | undefined {
  const inline = env[inlineVar];
  if (inline && inline.trim()) return inline;
  const file = env[fileVar]?.trim();
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      throw new ServiceNowError(
        `${fileVar} points to a file that cannot be read (${(err as Error).message}).`,
      );
    }
  }
  return undefined;
}

/** True when SN_TLS_REJECT_UNAUTHORIZED is not the literal "false". */
export function tlsVerifyEnabled(env: Env = process.env): boolean {
  return env.SN_TLS_REJECT_UNAUTHORIZED?.trim().toLowerCase() !== "false";
}

/**
 * TLS connect options from the environment, or undefined when nothing beyond
 * Node's defaults is configured. `clientCert: false` ignores the client
 * certificate (the Jira twin talks to Atlassian, where the ServiceNow mTLS
 * identity must not be presented) while still honouring CA and verification.
 */
export function buildTlsOptions(
  env: Env = process.env,
  opts: { clientCert?: boolean } = {},
): TlsOptions | undefined {
  let cert: string | undefined;
  let key: string | undefined;
  if (opts.clientCert !== false) {
    cert = readPem("SN_TLS_CLIENT_CERT", "SN_TLS_CLIENT_CERT_FILE", env);
    key = readPem("SN_TLS_CLIENT_KEY", "SN_TLS_CLIENT_KEY_FILE", env);
    if ((cert && !key) || (!cert && key)) {
      throw new ServiceNowError(
        "Mutual TLS needs both SN_TLS_CLIENT_CERT[_FILE] and SN_TLS_CLIENT_KEY[_FILE]; only one is set.",
      );
    }
  }
  const ca = readPem("SN_TLS_CA", "SN_TLS_CA_FILE", env);
  const rejectUnauthorized = tlsVerifyEnabled(env);
  if (!cert && !ca && rejectUnauthorized) return undefined;
  const out: TlsOptions = { rejectUnauthorized };
  if (cert && key) {
    out.cert = cert;
    out.key = key;
  }
  if (ca) out.ca = ca;
  return out;
}

/**
 * Everything the dispatcher factory needs for `host`, or undefined when the
 * request can go through Node's default fetch. Pure apart from reading files
 * named by *_FILE variables.
 */
export function dispatcherOptions(
  host: string,
  opts: { clientCert?: boolean; env?: Env } = {},
): DispatcherOptions | undefined {
  const env = opts.env ?? process.env;
  const proxy = resolveProxyForHost(host, env);
  const tls = buildTlsOptions(env, { clientCert: opts.clientCert });
  if (!proxy && !tls) return undefined;
  const out: DispatcherOptions = {};
  if (proxy) out.proxy = proxy;
  if (tls) out.tls = tls;
  return out;
}

/** Redacted view of the connection policy for get_status / doctor. */
export interface DispatcherSummary {
  proxy: { source: ProxySource; host: string } | null;
  tls: {
    ca: "file" | "inline" | "system";
    clientCert: boolean;
    verify: "on" | "off";
  };
}

export function describeDispatcher(
  host: string,
  env: Env = process.env,
): DispatcherSummary {
  let proxy: DispatcherSummary["proxy"] = null;
  try {
    const choice = resolveProxyForHost(host, env);
    if (choice) proxy = { source: choice.source, host: choice.host };
  } catch {
    proxy = null;
  }
  const ca = env.SN_TLS_CA_FILE?.trim()
    ? "file"
    : env.SN_TLS_CA?.trim()
      ? "inline"
      : "system";
  const clientCert = Boolean(
    (env.SN_TLS_CLIENT_CERT?.trim() || env.SN_TLS_CLIENT_CERT_FILE?.trim()) &&
    (env.SN_TLS_CLIENT_KEY?.trim() || env.SN_TLS_CLIENT_KEY_FILE?.trim()),
  );
  return {
    proxy,
    tls: { ca, clientCert, verify: tlsVerifyEnabled(env) ? "on" : "off" },
  };
}

/**
 * The cache key for a configuration: a digest of the effective material (so
 * two different certificates never share an agent) plus the active profile
 * (so switching profiles never reuses a connection pool bound to the other
 * instance's identity). Never contains the material itself.
 */
export function dispatcherCacheKey(
  options: DispatcherOptions,
  profile: string = activeProfile(),
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        proxy: options.proxy?.url ?? null,
        cert: options.tls?.cert ?? null,
        key: options.tls?.key ?? null,
        ca: options.tls?.ca ?? null,
        verify: options.tls?.rejectUnauthorized ?? true,
      }),
    )
    .digest("hex");
  return `${digest}|${profile}`;
}

// --- undici loading and the agent cache -----------------------------------

interface Closeable {
  close?: () => Promise<void> | void;
}

interface UndiciLike {
  Agent: new (opts: unknown) => Closeable;
  ProxyAgent: new (opts: unknown) => Closeable;
}

async function importUndici(): Promise<UndiciLike> {
  // Non-literal specifier so the type-checker keeps undici optional.
  const moduleName = "undici";
  return (await import(moduleName)) as UndiciLike;
}

let undiciLoader: () => Promise<UndiciLike> = importUndici;

/** Test hook: substitute the undici module (or restore the real loader with null). */
export function _setUndiciLoader(
  loader: (() => Promise<UndiciLike>) | null,
): void {
  undiciLoader = loader ?? importUndici;
}

interface DispatcherState {
  /** One agent per effective configuration and profile. */
  agents: Map<string, Closeable>;
  /** The TLS-verification-off warning was logged (survives dispose()). */
  warnedVerifyOff: boolean;
}

// E-3: the agent cache lives in the runtime container; dispose() closes every
// pool. The one-shot warning flag is reset only by a fresh runtime.
const dispatchersPart = defineRuntimePart(
  "dispatchers",
  (): DispatcherState => ({ agents: new Map(), warnedVerifyOff: false }),
  (state) => closeAgents(state.agents),
);

const dispatchers = (): DispatcherState =>
  currentRuntime().get(dispatchersPart);

/** Operator-facing text for the TLS-verification-off condition. */
export const TLS_VERIFY_OFF_WARNING =
  "TLS certificate verification is OFF (SN_TLS_REJECT_UNAUTHORIZED=false) — the connection can be intercepted; use only against lab instances";

/**
 * Log the TLS-verification-off warning once per process (H-6 / SEC-16).
 * Called at startup, so the operator sees it before any request is made, and
 * again when the first dispatcher is built; the shared flag keeps it to one
 * line. Returns true when verification is off.
 */
export function warnIfTlsVerifyOff(env: Env = process.env): boolean {
  if (tlsVerifyEnabled(env)) return false;
  const state = dispatchers();
  if (!state.warnedVerifyOff) {
    state.warnedVerifyOff = true;
    logger.warn(TLS_VERIFY_OFF_WARNING);
  }
  return true;
}

function needsUndiciReason(options: DispatcherOptions): string {
  if (options.proxy) return `An HTTPS proxy (${options.proxy.source})`;
  if (options.tls?.cert) return "Mutual TLS (SN_TLS_CLIENT_CERT/_KEY)";
  return "Custom TLS settings (SN_TLS_CA/SN_TLS_REJECT_UNAUTHORIZED)";
}

/**
 * The undici dispatcher for requests to `host`, or undefined when Node's
 * default fetch should be used. One agent per effective configuration and
 * profile; agents are closed by disposeDispatchers().
 */
export async function getDispatcher(
  host: string,
  opts: { clientCert?: boolean } = {},
): Promise<unknown> {
  const options = dispatcherOptions(host, { clientCert: opts.clientCert });
  if (!options) return undefined;

  const key = dispatcherCacheKey(options);
  const cache = dispatchers().agents;
  const hit = cache.get(key);
  if (hit) return hit;

  let undici: UndiciLike;
  try {
    undici = await undiciLoader();
  } catch {
    throw new ServiceNowError(
      `${needsUndiciReason(options)} needs the optional 'undici' package — install it with: npm install undici`,
    );
  }

  if (options.tls && !options.tls.rejectUnauthorized) warnIfTlsVerifyOff();

  const connect = options.tls
    ? {
        cert: options.tls.cert,
        key: options.tls.key,
        ca: options.tls.ca,
        rejectUnauthorized: options.tls.rejectUnauthorized,
      }
    : undefined;

  const agent = options.proxy
    ? new undici.ProxyAgent({
        uri: options.proxy.url,
        ...(connect ? { requestTls: connect } : {}),
      })
    : new undici.Agent({ connect });

  cache.set(key, agent);
  return agent;
}

/**
 * Close and forget every cached agent. Called when credentials or the active
 * profile change so the next request builds a pool for the new identity.
 */
export function disposeDispatchers(): void {
  closeAgents(dispatchers().agents);
}

function closeAgents(cache: Map<string, Closeable>): void {
  const agents = [...cache.values()];
  cache.clear();
  for (const agent of agents) {
    try {
      const result = agent.close?.();
      if (result) result.catch(() => undefined);
    } catch {
      // Best effort — a pool that refuses to close is simply dropped.
    }
  }
}

/** Test hook: number of live cached agents. */
export function _dispatcherCacheSize(): number {
  return dispatchers().agents.size;
}
