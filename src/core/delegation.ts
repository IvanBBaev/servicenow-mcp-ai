import { createHash } from "node:crypto";
import { readBool } from "./settings-manifest.js";
import { currentSession } from "./request-context.js";

/**
 * N-17 phase 2 — the OAuth subject the current request calls ServiceNow as,
 * when `SN_HTTP_OAUTH_USER_TOKENS` is on and the request was authorized with
 * an OAuth access token. Undefined otherwise (stdio, the static
 * `SN_HTTP_TOKEN`, or the setting off): the profile's shared credential is
 * used, as before.
 *
 * Kept free of auth/config imports so http.ts, config.ts and cache.ts can
 * all ask without an import cycle.
 */
export function delegatedSubject(): string | undefined {
  if (!readBool("SN_HTTP_OAUTH_USER_TOKENS")) return undefined;
  return currentSession()?.subject;
}

/** A short, stable, non-reversible id for a subject (cache and lock keys). */
export function subjectId(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 16);
}

/**
 * The user name `getCredentials()` reports while delegated. It carries `^`,
 * so every encoded-query use of the configured user name treats it as unsafe
 * and falls back to `gs.getUserID()` — the linked account — while keys built
 * from `instance|user` stay per subject.
 */
export function delegatedUserMarker(): string | undefined {
  const subject = delegatedSubject();
  return subject ? `^subject:${subjectId(subject)}` : undefined;
}
