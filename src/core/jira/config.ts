import { persistEnv } from "../config.js";

/**
 * Jira Cloud connection credentials. v1 is a single default connection (named
 * Jira profiles are a deliberate follow-up); the values are read environment-
 * first so an MCP client can inject them, and the setter reuses the same
 * atomic, owner-only (0600) .env writer as the ServiceNow credentials.
 */
export interface JiraCredentials {
  /** Site host or shorthand, e.g. "mycompany" or "mycompany.atlassian.net". */
  site: string;
  /** Atlassian account email (the Basic-auth username). */
  email: string;
  /** Atlassian API token (the Basic-auth password). */
  apiToken: string;
}

/** Read the Jira credentials from the environment (no caching needed for one connection). */
export function getJiraCredentials(): JiraCredentials {
  return {
    site: process.env.JIRA_SITE?.trim() ?? "",
    email: process.env.JIRA_EMAIL?.trim() ?? "",
    apiToken: process.env.JIRA_API_TOKEN?.trim() ?? "",
  };
}

/** True when site, email and API token are all present. */
export function hasJiraCredentials(): boolean {
  const c = getJiraCredentials();
  return Boolean(c.site && c.email && c.apiToken);
}

/**
 * Persist the provided Jira fields to the .env file and process.env so they
 * take effect immediately. Only the supplied fields are changed.
 */
export function saveJiraCredentials(
  partial: Partial<JiraCredentials>,
): JiraCredentials {
  const updates: Record<string, string> = {};
  if (partial.site !== undefined) updates.JIRA_SITE = partial.site.trim();
  if (partial.email !== undefined) updates.JIRA_EMAIL = partial.email.trim();
  if (partial.apiToken !== undefined)
    updates.JIRA_API_TOKEN = partial.apiToken.trim();
  persistEnv(updates);
  return getJiraCredentials();
}
