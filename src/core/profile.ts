import { currentRequestProfile } from "./request-context.js";

/**
 * The active-profile lookup on its own, with no dependency on the config
 * store, so settings.ts can resolve per-profile settings (H-11) without an
 * import cycle through config.ts → runtime.ts. config.ts re-exports it.
 */

/** A profile name: lowercase letters, digits and `_`. */
export const PROFILE_RE = /^[a-z0-9_]+$/;

/**
 * The profile for the current call: an explicit per-request profile (MI-3
 * AsyncLocalStorage context) wins over SN_ACTIVE_PROFILE.
 */
export function activeProfile(): string {
  const fromRequest = currentRequestProfile();
  if (fromRequest) return fromRequest;
  const raw = process.env.SN_ACTIVE_PROFILE?.trim().toLowerCase();
  return raw && PROFILE_RE.test(raw) ? raw : "default";
}
