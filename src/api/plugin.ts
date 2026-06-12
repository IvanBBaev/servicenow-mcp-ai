import { ServiceNowError } from "../core/errors.js";
import { logger } from "../core/logging.js";

/**
 * Wrap a call to a plugin-scoped API. ServiceNow returns 404 for the whole
 * namespace when the backing plugin is not installed/active, which is easy to
 * misread as "record not found". When a 404 surfaces we append a hint that the
 * API may simply be inactive on this instance, without hiding the original
 * message or status.
 *
 * A *namespace* 404 (as opposed to a record-level one) additionally marks the
 * API unavailable for a few minutes, so repeated calls fail fast without
 * hitting the instance again. Successful calls mark it available; the map is
 * exposed in the status payload.
 */

/** How long a namespace 404 keeps an API marked unavailable. */
const UNAVAILABLE_TTL_MS = 5 * 60_000;

/**
 * ServiceNow's 404 body for a missing REST namespace says the URI does not
 * map to a resource; a 404 for a missing record says "No Record found".
 * Only the former proves the plugin is absent.
 */
const NAMESPACE_404 = /does not represent any resource|invalid uri/i;

type ApiState =
  | { status: "available" }
  | { status: "unavailable"; until: number };

const states = new Map<string, ApiState>();

/** Availability of every plugin API touched so far (for the status payload). */
export function pluginAvailability(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [label, s] of states) {
    out[label] =
      s.status === "available"
        ? "available"
        : s.until > Date.now()
          ? "unavailable"
          : "unknown";
  }
  return out;
}

/** Test hook: forget all probed availability. */
export function _resetPluginAvailability(): void {
  states.clear();
}

export async function pluginCall<T>(
  apiLabel: string,
  fn: () => Promise<T>,
): Promise<T> {
  const state = states.get(apiLabel);
  if (state?.status === "unavailable" && state.until > Date.now()) {
    throw new ServiceNowError(
      `${apiLabel} API is not available on this instance (a namespace 404 was cached in the last ${Math.round(UNAVAILABLE_TTL_MS / 60_000)} minutes; the backing plugin is probably inactive).`,
      404,
    );
  }
  try {
    const result = await fn();
    states.set(apiLabel, { status: "available" });
    return result;
  } catch (err) {
    if (err instanceof ServiceNowError && err.status === 404) {
      const haystack = `${err.message} ${JSON.stringify(err.detail ?? "")}`;
      if (NAMESPACE_404.test(haystack)) {
        states.set(apiLabel, {
          status: "unavailable",
          until: Date.now() + UNAVAILABLE_TTL_MS,
        });
        logger.info("Plugin API marked unavailable", { api: apiLabel });
      }
      throw new ServiceNowError(
        `${err.message} (If every ${apiLabel} request fails this way, the ${apiLabel} API/plugin may not be active on this instance.)`,
        err.status,
        err.detail,
      );
    }
    throw err;
  }
}
