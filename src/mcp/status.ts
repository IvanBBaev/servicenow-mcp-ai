import { getCredentials, hasCredentials } from "../core/config.js";
import { getAuthMode } from "../core/auth.js";
import { isReadOnly, getAllowedTables, getDeniedTables } from "../core/policy.js";
import { effectivePackages } from "./registry.js";
import { pluginAvailability } from "../api/plugin.js";
import { getTelemetry } from "../core/http.js";

/**
 * The single source of the connection-status payload, shared by the
 * servicenow_get_status tool and the servicenow://status resource so the two
 * can never drift apart. The password is never included.
 */
export function buildStatusPayload() {
  const c = getCredentials();
  const packages = effectivePackages();
  return {
    configured: hasCredentials(),
    instance: c.instance || "(not set)",
    user: c.user || "(not set)",
    passwordSet: Boolean(c.password),
    authMode: getAuthMode(),
    readOnly: isReadOnly(),
    allowedTables: getAllowedTables(),
    deniedTables: getDeniedTables(),
    enabledPackages: packages.enabled,
    deniedPackages: packages.denied,
    readOnlyPackages: packages.readOnly,
    // Plugin APIs observed this session: available / unavailable / unknown.
    pluginApis: pluginAvailability(),
    // In-process counters since startup: why is it slow / what is failing.
    telemetry: getTelemetry(),
  };
}
