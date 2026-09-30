import { currentRequestProfile, currentSession } from "./request-context.js";
import { readSetting } from "./settings-manifest.js";

/**
 * The active-profile lookup on its own, with no dependency on the config
 * store, so settings.ts can resolve per-profile settings (H-11) without an
 * import cycle through config.ts → runtime.ts. config.ts re-exports it.
 */

/** A profile name: lowercase letters, digits and `_`. */
export const PROFILE_RE = /^[a-z0-9_]+$/;

/**
 * The profile for the current call: an explicit per-request profile (MI-3
 * AsyncLocalStorage context) wins, then the HTTP session's own selection
 * (H-7 — `use_instance` in HTTP mode), then SN_ACTIVE_PROFILE.
 */
export function activeProfile(): string {
  const fromRequest = currentRequestProfile();
  if (fromRequest) return fromRequest;
  const fromSession = currentSession()?.profile;
  if (fromSession) return fromSession;
  // E-4: parsed (trimmed, lowercased, PROFILE_RE) by the manifest; an
  // invalid name warns once and falls back to the default profile.
  return readSetting<string>("SN_ACTIVE_PROFILE") ?? "default";
}
