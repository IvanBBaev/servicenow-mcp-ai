import { ServiceNowError } from "../errors.js";

/**
 * Wrap a call to a plugin-scoped API. ServiceNow returns 404 for the whole
 * namespace when the backing plugin is not installed/active, which is easy to
 * misread as "record not found". When a 404 surfaces we append a hint that the
 * API may simply be inactive on this instance, without hiding the original
 * message or status.
 */
export async function pluginCall<T>(
  apiLabel: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceNowError && err.status === 404) {
      throw new ServiceNowError(
        `${err.message} (If every ${apiLabel} request fails this way, the ${apiLabel} API/plugin may not be active on this instance.)`,
        err.status,
        err.detail,
      );
    }
    throw err;
  }
}
