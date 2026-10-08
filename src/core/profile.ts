/**
 * The active-profile lookup on its own, with no dependency on the config
 * store, so settings.ts can resolve per-profile settings (H-11) without an
 * import cycle through config.ts → runtime.ts. config.ts re-exports it. The
 * implementation lives in settings-manifest.ts, whose reader scopes settings
 * by the active profile (E-7: that keeps the pair out of an import cycle).
 */
export { activeProfile, PROFILE_RE } from "./settings-manifest.js";
