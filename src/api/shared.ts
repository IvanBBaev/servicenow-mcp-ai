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
    );
  }
  return data.result;
}

/**
 * Coerce a ServiceNow record value to a string. With sysparm_display_value=all
 * a field arrives as `{ value, display_value }` — stringifying that blindly
 * yields "[object Object]", so non-scalar values map to "" instead.
 */
export function snString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/** Like {@link expectResult}, but requires `result` to be an array. */
export function expectResultArray<T>(
  data: { result?: T[] } | null | undefined,
  api: string,
): T[] {
  if (!data || !Array.isArray(data.result)) {
    throw new ServiceNowError(
      `Unexpected response from ServiceNow ${api}: missing 'result' array.`,
    );
  }
  return data.result;
}
