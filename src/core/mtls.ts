import { getDispatcher } from "./dispatcher.js";

/**
 * Mutual-TLS (client-certificate) support. When SN_TLS_CLIENT_CERT/_KEY are set
 * the client presents a certificate on the TLS handshake — ServiceNow maps it to
 * a user (a mutual-auth profile). This can stand alone (SN_AUTH=none) or layer
 * under any header-based method.
 *
 * Since H-10 the dispatcher itself lives in core/dispatcher.ts, which also
 * handles proxies and CA/verification options; this module keeps the original
 * entry points for callers and tests that only care about the client cert.
 */

/**
 * The undici dispatcher for ServiceNow requests (client certificate, custom
 * CA, verification flag, proxy), or undefined when none of that is configured.
 * Throws a clear error if undici is not installed.
 */
export async function getTlsDispatcher(host = ""): Promise<unknown> {
  return getDispatcher(host);
}
