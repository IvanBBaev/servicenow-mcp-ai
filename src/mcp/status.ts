import {
  getCredentials,
  hasCredentials,
  activeProfile,
  listProfiles,
} from "../core/config.js";
import { getAuthMode } from "../core/auth.js";
import {
  isReadOnly,
  getAllowedTables,
  getDeniedTables,
} from "../core/policy.js";
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
    activeProfile: activeProfile(),
    profiles: listProfiles(),
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

/**
 * The single source of the profile inventory, shared by the
 * servicenow_list_instances tool and the servicenow://instances resource
 * (MI-8). Passwords are never included.
 */
export function profilesPayload() {
  const active = activeProfile();
  const profiles = listProfiles().map((name) => {
    const c = getCredentials(name);
    return {
      name,
      active: name === active,
      instance: c.instance || "(not set)",
      user: c.user || "(not set)",
      readOnly: isReadOnly(name),
      hasCredentials: hasCredentials(name),
    };
  });
  return { count: profiles.length, activeProfile: active, profiles };
}
