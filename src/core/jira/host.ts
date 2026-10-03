import { JiraError } from "../errors.js";
import { resolveHostWithPolicy, type HostPolicy } from "../host.js";

/**
 * Host resolution and SSRF guard for the Jira client — the Jira-flavoured twin
 * of core/host.ts, sharing the exact same algorithm (resolveHostWithPolicy)
 * and internal/loopback block. Instead of *.service-now.com, the canonical
 * allowlist is *.atlassian.net (Jira Cloud). A custom or Server/Data-Center
 * host must be opted in through JIRA_ALLOWED_HOSTS, so a redirected/typo'd
 * host cannot silently receive the API token.
 */
const JIRA_HOST_POLICY: HostPolicy = {
  subject: "Jira site",
  system: "Jira",
  canonicalSuffix: ".atlassian.net",
  allowedHostsEnv: "JIRA_ALLOWED_HOSTS",
  nonCanonicalError: (host) =>
    `Host "${host}" is not a *.atlassian.net site. Set JIRA_ALLOWED_HOSTS to allow a Server/Data-Center or custom domain.`,
  makeError: (message, options) =>
    new JiraError(message, undefined, undefined, options),
};

/**
 * Normalise and validate a Jira site value into a hostname.
 * Accepts "mycompany", "mycompany.atlassian.net" or a full https URL, and
 * rejects malformed hosts, embedded credentials, and internal/loopback targets
 * (unless explicitly permitted through JIRA_ALLOWED_HOSTS).
 */
export function resolveJiraHost(site: string): string {
  return resolveHostWithPolicy(site, JIRA_HOST_POLICY);
}

/** Base origin for a Jira site, e.g. "https://mycompany.atlassian.net". */
export function jiraBaseUrl(site: string): string {
  return `https://${resolveJiraHost(site)}`;
}
