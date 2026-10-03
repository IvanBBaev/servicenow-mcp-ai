import { ServiceNowError } from "../core/errors.js";

/**
 * Unwrap the `result` envelope every ServiceNow REST API uses, with one shared
 * error message instead of a copy per call site.
 */
export function expectResult<T>(
  data: { result?: T } | null | undefined,
  api: string,
): T {
  if (!data || data.result == null) {
    throw new ServiceNowError(
      `Unexpected response from ServiceNow ${api}: missing 'result'.`,
      undefined,
      undefined,
      { code: "UNEXPECTED_RESPONSE" },
    );
  }
  return data.result;
}

/**
 * Coerce a ServiceNow record value to a string. With sysparm_display_value=all
 * a field arrives as `{ value, display_value }` — stringifying that blindly
 * yields "[object Object]", so such a pair maps to its raw `value`; any other
 * non-scalar maps to "".
 */
export function snString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // `sysparm_display_value=all` gives `{ display_value, value }` and reference
  // links give `{ link, value }` (H-8 C-4): the raw `value` is what code keys
  // on (names, sys_ids, flags), so unwrap it instead of losing the field.
  if (typeof value === "object" && value !== null && "value" in value) {
    const inner = value.value;
    if (typeof inner === "object") return "";
    return snString(inner);
  }
  return "";
}

/**
 * User-supplied fragments are embedded into encoded queries, where `^` acts as
 * the condition separator and ServiceNow has no escape for it inside LIKE — a
 * stray `^` would silently distort the filter (or inject extra clauses), so it
 * is rejected up front. Shared so every query builder enforces it identically.
 */
export function assertNoCaret(value: string, field: string): void {
  if (value.includes("^")) {
    throw new ServiceNowError(
      `The ${field} filter cannot contain '^' (it is the encoded-query separator and cannot be escaped).`,
      400,
    );
  }
}

/**
 * A single mailbox address (`local@domain`), deliberately stricter than RFC
 * 5322: no display name, no quoted local part, no whitespace, and none of the
 * characters that are separators elsewhere — `,` (the Email API's recipient
 * list), `^` and `=` (encoded queries). Used by the `email()` schema builder
 * and re-checked by the Email API wrapper (H-6 / GAP L4-06).
 */
export const EMAIL_ADDRESS_RE =
  /^[A-Za-z0-9.!#$%&'*+/?_`{|}~-]{1,64}@(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Escape a value for a Markdown table cell so a `|` cannot break the column layout. */
export function mdEscape(value: string): string {
  return value.replaceAll("|", "\\|");
}

/**
 * Render a GitHub-flavoured Markdown table. Header and cell values are escaped
 * so a ServiceNow identifier containing `|` (e.g. a business-rule name) cannot
 * corrupt the row layout — shared so snapshot and compare reports stay
 * consistent (snapshot escaped, compare did not).
 */
export function mdTable(header: string[], rows: string[][]): string {
  return [
    `| ${header.map(mdEscape).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(mdEscape).join(" | ")} |`),
  ].join("\n");
}

/** Like {@link expectResult}, but requires `result` to be an array. */
export function expectResultArray<T>(
  data: { result?: T[] } | null | undefined,
  api: string,
): T[] {
  if (!data || !Array.isArray(data.result)) {
    throw new ServiceNowError(
      `Unexpected response from ServiceNow ${api}: missing 'result' array.`,
      undefined,
      undefined,
      { code: "UNEXPECTED_RESPONSE" },
    );
  }
  return data.result;
}

/** A query-parameter value {@link snParams} accepts. */
export type SnParamValue =
  | string
  | number
  | boolean
  | readonly string[]
  | null
  | undefined;

/**
 * Build `sysparm_*` query parameters from optional values (E-7): a missing,
 * empty or `false` value is left out, a number (0 included) and `true` are
 * stringified, and a list is comma-joined. Insertion order is kept.
 */
export function snParams(
  values: Record<string, SnParamValue>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === "string" && value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(","));
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}
