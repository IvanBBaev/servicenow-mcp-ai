import { ServiceNowError } from "./errors.js";

/** Hosts the client refuses to contact to avoid SSRF to internal services. */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a = -1, b = -1] = h.split(".").map(Number);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  if (h.includes(":")) {
    if (
      h === "::1" ||
      h.startsWith("fe80:") ||
      h.startsWith("fc") ||
      h.startsWith("fd")
    ) {
      return true;
    }
  }
  return false;
}

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
  makeError: (message: string) => Error;
}

/** Optional comma-separated allowlist of permitted hosts from `envVar`. */
function getAllowedHosts(envVar: string): string[] {
  return (process.env[envVar] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const suffix = a.replace(/^\./, "");
    return h === suffix || h.endsWith(`.${suffix}`);
  });
}

/**
 * Normalise and validate a host value under the given policy.
 * Accepts a bare name (gets the canonical suffix appended), a fully qualified
 * host or a full https URL, and rejects malformed hosts, embedded credentials,
 * and internal/loopback targets (unless explicitly permitted through the
 * policy's allowlist env var).
 */
export function resolveHostWithPolicy(raw: string, policy: HostPolicy): string {
  let host = raw.trim().replace(/^https?:\/\//i, "");
  // Drop any path, query or fragment.
  host = host.split(/[/?#]/, 1)[0] ?? "";
  if (host.includes("@")) {
    throw policy.makeError(
      `Invalid ${policy.subject}: embedded credentials are not allowed.`,
    );
  }
  // Drop a trailing port.
  host = host.replace(/:\d+$/, "");
  if (!host) {
    throw policy.makeError(`${policy.subject} is empty or invalid.`);
  }
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
    throw policy.makeError(`Invalid ${policy.system} host: "${host}".`);
  }

  const allowed = getAllowedHosts(policy.allowedHostsEnv);
  if (allowed.length > 0) {
    if (!isAllowed(host, allowed)) {
      throw policy.makeError(
        `Host "${host}" is not permitted by ${policy.allowedHostsEnv}.`,
      );
    }
  } else {
    if (isBlockedHost(host)) {
      throw policy.makeError(
        `Refusing to connect to internal/loopback host "${host}". Set ${policy.allowedHostsEnv} to override.`,
      );
    }
    // Without an explicit allowlist, only hosts under the canonical domain are
    // reachable. A custom domain must be opted in through the allowlist env
    // var, so a redirected/typo'd host cannot silently receive credentials.
    if (!host.toLowerCase().endsWith(policy.canonicalSuffix)) {
      throw policy.makeError(policy.nonCanonicalError(host));
    }
  }
  return host;
}

const SN_HOST_POLICY: HostPolicy = {
  subject: "ServiceNow instance",
  system: "ServiceNow",
  canonicalSuffix: ".service-now.com",
  allowedHostsEnv: "SN_ALLOWED_HOSTS",
  nonCanonicalError: (host) =>
    `Host "${host}" is not a *.service-now.com instance. Set SN_ALLOWED_HOSTS to allow a custom or sovereign-cloud domain.`,
  makeError: (message) => new ServiceNowError(message),
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
