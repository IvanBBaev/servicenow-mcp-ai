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

/** Optional comma-separated allowlist of permitted hosts (SN_ALLOWED_HOSTS). */
function getAllowedHosts(): string[] {
  return (process.env.SN_ALLOWED_HOSTS ?? "")
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
 * Normalise and validate an instance value into a hostname.
 * Accepts "dev12345", "dev12345.service-now.com" or a full https URL, and
 * rejects malformed hosts, embedded credentials, and internal/loopback
 * targets (unless explicitly permitted through SN_ALLOWED_HOSTS).
 */
export function resolveHost(instance: string): string {
  let host = instance.trim().replace(/^https?:\/\//i, "");
  // Drop any path, query or fragment.
  host = host.split(/[/?#]/, 1)[0] ?? "";
  if (host.includes("@")) {
    throw new ServiceNowError(
      "Invalid ServiceNow instance: embedded credentials are not allowed.",
    );
  }
  // Drop a trailing port.
  host = host.replace(/:\d+$/, "");
  if (!host) {
    throw new ServiceNowError("ServiceNow instance is empty or invalid.");
  }
  if (!host.includes(".")) {
    host = `${host}.service-now.com`;
  }
  if (
    !/^[A-Za-z0-9.-]+$/.test(host) ||
    host.includes("..") ||
    host.startsWith(".") ||
    host.endsWith(".") ||
    host.startsWith("-")
  ) {
    throw new ServiceNowError(`Invalid ServiceNow host: "${host}".`);
  }

  const allowed = getAllowedHosts();
  if (allowed.length > 0) {
    if (!isAllowed(host, allowed)) {
      throw new ServiceNowError(
        `Host "${host}" is not permitted by SN_ALLOWED_HOSTS.`,
      );
    }
  } else {
    if (isBlockedHost(host)) {
      throw new ServiceNowError(
        `Refusing to connect to internal/loopback host "${host}". Set SN_ALLOWED_HOSTS to override.`,
      );
    }
    // Without an explicit allowlist, only canonical ServiceNow instances are
    // reachable. A custom or sovereign-cloud domain must be opted in through
    // SN_ALLOWED_HOSTS, so a redirected/typo'd host cannot silently send Basic
    // credentials to an arbitrary server.
    if (!host.toLowerCase().endsWith(".service-now.com")) {
      throw new ServiceNowError(
        `Host "${host}" is not a *.service-now.com instance. Set SN_ALLOWED_HOSTS to allow a custom or sovereign-cloud domain.`,
      );
    }
  }
  return host;
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
