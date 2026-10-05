/**
 * N-13 (NX-17) — the versioned hardening rule table: system properties the
 * platform's security hardening guidance asks to be set, with the expected
 * value or range, the platform default that applies when no sys_properties row
 * exists, a severity and a rationale.
 *
 * Every property name, expectation and default is unverified until O-5 (PDI);
 * `since` / `until` mark the release families a rule applies to once that is
 * known. Bump HARDENING_RULES_VERSION on any change to the table.
 */

export const HARDENING_RULES_VERSION = "1";

export type HardeningSeverity = "high" | "medium" | "low";

export type HardeningExpect =
  | { equals: string }
  | { max: number }
  | { min: number };

export interface HardeningRule {
  property: string;
  expect: HardeningExpect;
  /** The value the platform uses when the property has no row; unknown when absent. */
  default?: string;
  severity: HardeningSeverity;
  rationale: string;
  /** Where the rule comes from. */
  source: string;
  /** First release family the rule applies to (lower-case, e.g. "washingtondc"). */
  since?: string;
  /** Last release family the rule applies to. */
  until?: string;
}

const HSH = "ServiceNow Instance Security Hardening Settings";

export const HARDENING_RULES: readonly HardeningRule[] = [
  {
    property: "glide.security.use_csrf_token",
    expect: { equals: "true" },
    default: "true",
    severity: "high",
    rationale: "Requires an anti-CSRF token on state-changing UI requests.",
    source: `${HSH} — CSRF protection`,
  },
  {
    property: "glide.sm.default_mode",
    expect: { equals: "deny" },
    default: "deny",
    severity: "high",
    rationale:
      "With no matching ACL the security manager denies access instead of allowing it.",
    source: `${HSH} — default security manager behaviour`,
  },
  {
    property: "glide.script.use.sandbox",
    expect: { equals: "true" },
    default: "true",
    severity: "high",
    rationale:
      "Runs client-supplied scripts (filters, ranges) in the restricted script sandbox.",
    source: `${HSH} — script sandbox`,
  },
  {
    property: "glide.stax.allow_entity_resolution",
    expect: { equals: "false" },
    default: "false",
    severity: "high",
    rationale: "Blocks XML external entity (XXE) resolution in parsed XML.",
    source: `${HSH} — XML external entity processing`,
  },
  {
    property: "glide.script.allow.ajaxevaluate",
    expect: { equals: "false" },
    severity: "high",
    rationale:
      "Stops clients from evaluating arbitrary server-side expressions through AJAXEvaluate.",
    source: `${HSH} — AJAXEvaluate`,
  },
  {
    property: "glide.security.strict_elevate_privilege",
    expect: { equals: "true" },
    severity: "medium",
    rationale:
      "Elevated-privilege roles grant their access only after the session elevates.",
    source: `${HSH} — strict elevated privilege`,
  },
  {
    property: "glide.ui.escape_text",
    expect: { equals: "true" },
    default: "true",
    severity: "medium",
    rationale: "Escapes text fields rendered in the UI (stored XSS).",
    source: `${HSH} — HTML escaping`,
  },
  {
    property: "glide.html.escape_script",
    expect: { equals: "true" },
    default: "true",
    severity: "medium",
    rationale: "Escapes script tags in HTML fields (stored XSS).",
    source: `${HSH} — HTML escaping`,
  },
  {
    property: "glide.ui.security.allow_codetags",
    expect: { equals: "false" },
    default: "false",
    severity: "medium",
    rationale: "Disallows [code] tags that render raw HTML in journal fields.",
    source: `${HSH} — code tags`,
  },
  {
    property: "glide.set_x_frame_options",
    expect: { equals: "true" },
    default: "true",
    severity: "medium",
    rationale:
      "Sends X-Frame-Options so other sites cannot frame the UI (clickjacking).",
    source: `${HSH} — clickjacking`,
  },
  {
    property: "glide.cookies.http_only",
    expect: { equals: "true" },
    default: "true",
    severity: "medium",
    rationale:
      "Marks session cookies HttpOnly so page scripts cannot read them.",
    source: `${HSH} — cookies`,
  },
  {
    property: "glide.ui.secure_cookies",
    expect: { equals: "true" },
    severity: "medium",
    rationale: "Marks cookies Secure so they never travel over plain HTTP.",
    source: `${HSH} — cookies`,
  },
  {
    property: "glide.ui.rotate_sessions",
    expect: { equals: "true" },
    severity: "medium",
    rationale: "Issues a new session id at login (session fixation).",
    source: `${HSH} — session rotation`,
  },
  {
    property: "glide.security.file.mime_type.validation",
    expect: { equals: "true" },
    severity: "medium",
    rationale:
      "Checks that an uploaded attachment's content matches its extension.",
    source: `${HSH} — attachment MIME type validation`,
  },
  {
    property: "glide.login.no_blank_password",
    expect: { equals: "true" },
    severity: "medium",
    rationale: "Refuses logins with a blank password.",
    source: `${HSH} — blank passwords`,
  },
  {
    property: "glide.basicauth.required.scriptedprocessor",
    expect: { equals: "true" },
    default: "true",
    severity: "medium",
    rationale: "Requires authentication for scripted processors.",
    source: `${HSH} — processor authentication`,
  },
  {
    property: "glide.ui.session_timeout",
    expect: { max: 30 },
    default: "30",
    severity: "low",
    rationale: "Ends idle UI sessions within 30 minutes.",
    source: `${HSH} — session timeout`,
  },
  {
    property: "glide.ui.forgetme",
    expect: { equals: "true" },
    severity: "low",
    rationale: 'Hides the "Remember me" option that keeps a login for days.',
    source: `${HSH} — remember me`,
  },
];
