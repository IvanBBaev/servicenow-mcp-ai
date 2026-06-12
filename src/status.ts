import { getCredentials, hasCredentials } from "./config.js";
import { getAuthMode } from "./auth.js";
import { isReadOnly, getAllowedTables, getDeniedTables } from "./policy.js";
import { getRequestedPackages } from "./settings.js";
import { resolveEnabledPackages } from "./registry.js";
import { pluginAvailability } from "./api/plugin.js";

/**
 * The single source of the connection-status payload, shared by the
 * servicenow_get_status tool and the servicenow://status resource so the two
 * can never drift apart. The password is never included.
 */
export function buildStatusPayload() {
  const c = getCredentials();
  return {
    configured: hasCredentials(),
    instance: c.instance || "(not set)",
    user: c.user || "(not set)",
    passwordSet: Boolean(c.password),
    authMode: getAuthMode(),
    readOnly: isReadOnly(),
    allowedTables: getAllowedTables(),
    deniedTables: getDeniedTables(),
    enabledPackages: [...resolveEnabledPackages(getRequestedPackages())].sort(),
    // Plugin APIs observed this session: available / unavailable / unknown.
    pluginApis: pluginAvailability(),
  };
}
