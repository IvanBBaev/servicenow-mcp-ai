import { isIPv6 } from "node:net";
import { ServiceNowError, type ServiceNowErrorOptions } from "./errors.js";
import { isDeclaredSetting, rawSetting } from "./settings-manifest.js";

/** True for an IPv4 dotted quad in a loopback/private/link-local range. */
function isBlockedIPv4(h: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
  const [a = -1, b = -1] = h.split(".").map(Number);
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * True for an IPv6 literal (no brackets) that is unspecified, loopback,
 * link-local (fe80::/10), unique-local (fc00::/7) or an IPv4-mapped /
 * IPv4-compatible form of a blocked IPv4 address (`::ffff:127.0.0.1`,
 * `::ffff:7f00:1`).
 */
function isBlockedIPv6(h: string): boolean {
  if (!isIPv6(h)) return false;
  if (h === "::" || h === "::1") return true;
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;
  const mapped = h.match(
    /^(?:0{0,4}:){0,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/,
  );
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]) || mapped[1] === "0.0.0.0";
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

/**
 * Hosts the client refuses to contact to avoid SSRF to internal services:
 * localhost names, mDNS/internal suffixes, private/loopback/link-local IPv4
 * and their IPv6 counterparts. Accepts a bare name, an IPv4 dotted quad or an
 * IPv6 literal with or without brackets.
 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  return isBlockedIPv4(h) || isBlockedIPv6(h);
}

export { isBlockedHost as _isBlockedHost };

/**
 * Per-system host policy: the canonical domain suffix, the allowlist env var,
 * the error wording and the error type. The ServiceNow and Jira resolvers are
 * thin wrappers over one shared algorithm (resolveHostWithPolicy), so the
 * normalisation and SSRF rules cannot silently drift apart.
 */
export interface HostPolicy {
  /** Subject for validation errors, e.g. "ServiceNow instance" / "Jira site". */
  subject: string;
  /** System name for the malformed-host error, e.g. "ServiceNow" / "Jira". */
  system: string;
  /** Suffix appended to a bare (dot-less) name, e.g. ".service-now.com". */
  canonicalSuffix: string;
  /** Env var holding the optional comma-separated host allowlist. */
  allowedHostsEnv: string;
  /** Error for a non-canonical host when no allowlist is configured. */
  nonCanonicalError: (host: string) => string;
  /** Error constructor, so each system throws its own error class. */
  makeError: (message: string, options?: ServiceNowErrorOptions) => Error;
}

/** Optional comma-separated allowlist of permitted hosts from `envVar`. */
function getAllowedHosts(envVar: string): string[] {
  const raw = isDeclaredSetting(envVar)
    ? rawSetting(envVar)
    : process.env[envVar];
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** A host value split into its name (or IPv6 literal) and optional port. */
export interface ParsedHost {
  host: string;
  /** Explicit port, already normalised: undefined when absent or 443. */
  port?: string;
  ipv6: boolean;
}

/**
 * Split `host[:port]` or `[v6][:port]`. Returns undefined for anything that is
 * not one of those two shapes (a bare `::1`, `host:abc`, an invalid literal)
 * or for a port outside 1–65535. Port 443 is the https default and is dropped
 * so `host:443` and `host` resolve to the same canonical form.
 */
export function parseHostPort(value: string): ParsedHost | undefined {
  const v6 = value.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  let host: string;
  let port: string | undefined;
  let ipv6 = false;
  if (v6) {
    host = (v6[1] ?? "").toLowerCase();
    if (!isIPv6(host)) return undefined;
    port = v6[2];
    ipv6 = true;
  } else {
    const m = value.match(/^([^:[\]]*)(?::(\d{1,5}))?$/);
    if (!m) return undefined;
    host = m[1] ?? "";
    port = m[2];
  }
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
    port = n === 443 ? undefined : String(n);
  }
  const out: ParsedHost = { host, ipv6 };
  if (port !== undefined) out.port = port;
  return out;
}

function canonicalForm(p: ParsedHost): string {
  const name = p.ipv6 ? `[${p.host}]` : p.host;
  return p.port ? `${name}:${p.port}` : name;
}

/**
 * Allowlist match (L1-05). An entry is `host`, `.suffix`, `host:port`,
 * `[v6]` or `[v6]:port`. A name matches an entry exactly or as a subdomain; an
 * explicit port is only permitted when an entry carries that same port (a
 * plain `example.com` entry does not open `example.com:8443`); an IPv6 literal
 * must be listed verbatim.
 */
function isAllowed(target: ParsedHost, allowed: string[]): boolean {
  return allowed.some((raw) => matchEntry(target, raw) !== "none");
}

/**
 * How one allowlist entry matches a target: "exact" (same host and port, or
 * the same IPv6 literal), "suffix" (the target is a subdomain of the entry)
 * or "none".
 */
function matchEntry(
  target: ParsedHost,
  raw: string,
): "exact" | "suffix" | "none" {
  const h = target.host.toLowerCase();
  const entry = parseHostPort(raw.replace(/^\./, ""));
  if (!entry || !entry.host) return "none";
  if (entry.port !== target.port) return "none";
  if (entry.ipv6 || target.ipv6) {
    return entry.ipv6 && target.ipv6 && entry.host === h ? "exact" : "none";
  }
  if (h === entry.host) return "exact";
  return h.endsWith(`.${entry.host}`) ? "suffix" : "none";
}

/**
 * H-6 / SEC-18: an internal or loopback target is reachable only through an
 * allowlist entry that names it exactly. A suffix entry (`corp`, `com`,
 * `internal`) never opens an internal host, so a broad allowlist cannot be
 * turned into an SSRF path to 127.0.0.1, the metadata address or *.internal.
 */
function isExplicitlyAllowed(target: ParsedHost, allowed: string[]): boolean {
  return allowed.some((raw) => matchEntry(target, raw) === "exact");
}

/** M-2: a malformed host value — INVALID_INPUT. */
function invalidHost(policy: HostPolicy, message: string): Error {
  return policy.makeError(message, { code: "INVALID_INPUT" });
}

/** M-2: a host the SSRF / allowlist policy refuses — POLICY_DENIED. */
function deniedHost(policy: HostPolicy, message: string): Error {
  return policy.makeError(message, {
    code: "POLICY_DENIED",
    hint: `List the host exactly in ${policy.allowedHostsEnv} to allow it.`,
  });
}

/**
 * Normalise and validate a host value under the given policy.
 * Accepts a bare name (gets the canonical suffix appended), a fully qualified
 * host or a full https URL, and rejects malformed hosts, embedded credentials,
 * and internal/loopback targets (unless the policy's allowlist env var names
 * that exact host — a suffix entry is not enough). An explicit non-443 port or an IPv6 literal is
 * kept in the canonical `host[:port]` form but only accepted when the
 * allowlist names it — the default `*.service-now.com` policy never does.
 */
export function resolveHostWithPolicy(raw: string, policy: HostPolicy): string {
  let value = raw.trim().replace(/^https?:\/\//i, "");
  // Drop any path, query or fragment.
  value = value.split(/[/?#]/, 1)[0] ?? "";
  if (value.includes("@")) {
    throw invalidHost(
      policy,
      `Invalid ${policy.subject}: embedded credentials are not allowed.`,
    );
  }
  if (!value) {
    throw invalidHost(policy, `${policy.subject} is empty or invalid.`);
  }
  const parsed = parseHostPort(value);
  if (!parsed) {
    throw invalidHost(policy, `Invalid ${policy.system} host: "${value}".`);
  }
  let host = parsed.host;
  if (!host) {
    throw invalidHost(policy, `${policy.subject} is empty or invalid.`);
  }
  if (!parsed.ipv6) {
    if (!host.includes(".")) {
      host = `${host}${policy.canonicalSuffix}`;
    }
    if (
      !/^[A-Za-z0-9.-]+$/.test(host) ||
      host.includes("..") ||
      host.startsWith(".") ||
      host.endsWith(".") ||
      host.startsWith("-")
    ) {
      throw invalidHost(policy, `Invalid ${policy.system} host: "${host}".`);
    }
  }
  const target: ParsedHost = { ...parsed, host };
  const canonical = canonicalForm(target);

  const allowed = getAllowedHosts(policy.allowedHostsEnv);
  if (allowed.length > 0) {
    if (!isAllowed(target, allowed)) {
      throw deniedHost(
        policy,
        `Host "${canonical}" is not permitted by ${policy.allowedHostsEnv}.`,
      );
    }
    if (isBlockedHost(host) && !isExplicitlyAllowed(target, allowed)) {
      throw deniedHost(
        policy,
        `Refusing to connect to internal/loopback host "${canonical}": ${policy.allowedHostsEnv} matches it only by suffix. List "${canonical}" there exactly to allow it.`,
      );
    }
  } else {
    if (target.ipv6) {
      throw deniedHost(
        policy,
        `IPv6 literal "${canonical}" is not permitted without ${policy.allowedHostsEnv}; list it there verbatim to allow it.`,
      );
    }
    if (target.port) {
      throw deniedHost(
        policy,
        `Explicit port ${target.port} on "${host}" is not permitted without ${policy.allowedHostsEnv}; list "${canonical}" there to allow it.`,
      );
    }
    if (isBlockedHost(host)) {
      throw deniedHost(
        policy,
        `Refusing to connect to internal/loopback host "${host}". Set ${policy.allowedHostsEnv} to override.`,
      );
    }
    // Without an explicit allowlist, only hosts under the canonical domain are
    // reachable. A custom domain must be opted in through the allowlist env
    // var, so a redirected/typo'd host cannot silently receive credentials.
    if (!host.toLowerCase().endsWith(policy.canonicalSuffix)) {
      throw deniedHost(policy, policy.nonCanonicalError(host));
    }
  }
  return canonical;
}

const SN_HOST_POLICY: HostPolicy = {
  subject: "ServiceNow instance",
  system: "ServiceNow",
  canonicalSuffix: ".service-now.com",
  allowedHostsEnv: "SN_ALLOWED_HOSTS",
  nonCanonicalError: (host) =>
    `Host "${host}" is not a *.service-now.com instance. Set SN_ALLOWED_HOSTS to allow a custom or sovereign-cloud domain.`,
  makeError: (message, options) =>
    new ServiceNowError(message, undefined, undefined, options),
};

/**
 * Normalise and validate an instance value into a hostname.
 * Accepts "dev12345", "dev12345.service-now.com" or a full https URL, and
 * rejects malformed hosts, embedded credentials, and internal/loopback
 * targets (unless explicitly permitted through SN_ALLOWED_HOSTS).
 */
export function resolveHost(instance: string): string {
  return resolveHostWithPolicy(instance, SN_HOST_POLICY);
}

/** Base origin for an instance, e.g. "https://dev12345.service-now.com". */
export function instanceBaseUrl(instance: string): string {
  return `https://${resolveHost(instance)}`;
}

/** Legacy Table API base, kept for unit tests of host normalisation/SSRF. */
function buildBaseUrl(instance: string): string {
  return `${instanceBaseUrl(instance)}/api/now/table`;
}

export { buildBaseUrl as _buildBaseUrl };
