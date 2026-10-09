import { ServiceNowError } from "./errors.js";
import { getMaxBodyBytes } from "./settings.js";
import { type ErrorFactory } from "./http-error-body.js";

/**
 * Redirect handling and bounded response-body reads (H-6 / SEC-19).
 */

export const TOO_LARGE_HINT =
  "Narrow the request (fewer fields, a smaller page, a tighter query) or raise SN_MAX_BODY_BYTES.";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** True for the statuses fetch would follow under `redirect: "follow"`. */
export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/** Host (with port) a redirect points at, resolved against the request URL. */
export function redirectTarget(res: Response, requestUrl: string): string {
  const location = res.headers.get("location");
  if (!location) return "(no Location header)";
  try {
    return new URL(location, requestUrl).host || "(unparseable Location)";
  } catch {
    return "(unparseable Location)";
  }
}

/** Longest error body read from the wire before it is shaped and capped. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** The Content-Length header as a number, when present and well-formed. */
export function declaredLength(res: Response): number | undefined {
  const raw = res.headers.get("content-length");
  return raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
}

/** Drop a body we will not read so the connection is released. */
export async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already consumed or errored — nothing to release.
  }
}

/**
 * Read at most `limit` bytes of a body. Stops reading (and cancels the rest of
 * the stream) as soon as the limit is crossed, so an endless or oversized body
 * never lands in memory. `overflow` tells whether more bytes were available.
 */
async function readUpTo(
  res: Response,
  limit: number,
): Promise<{ bytes: Buffer; overflow: boolean }> {
  const body = res.body;
  if (!body) {
    // A body-less Response (or a non-streaming stand-in): read what exists.
    const all = Buffer.from(await res.arrayBuffer());
    return all.length > limit
      ? { bytes: all.subarray(0, limit), overflow: true }
      : { bytes: all, overflow: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks, total), overflow: true };
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { bytes: Buffer.concat(chunks, total), overflow: false };
}

/** The first `limit` bytes of a body as UTF-8 text (never throws). */
export async function readTextPrefix(
  res: Response,
  limit: number,
): Promise<string> {
  try {
    return (await readUpTo(res, limit)).bytes.toString("utf8");
  } catch {
    return "";
  }
}

/** Where a capped body read came from, for the error it raises. */
export interface BodyReadContext {
  system: string;
  safeUrl: string;
  makeError?: ErrorFactory;
  /** Byte limit; defaults to SN_MAX_BODY_BYTES. */
  limit?: number;
}

/**
 * Read a whole OK body, refusing with RESPONSE_TOO_LARGE once it passes
 * SN_MAX_BODY_BYTES (a missing or lying Content-Length is caught while
 * streaming). Every REST client reads its success bodies through this.
 */
export async function readBodyBytes(
  res: Response,
  ctx: BodyReadContext,
): Promise<Buffer> {
  const limit = ctx.limit ?? getMaxBodyBytes();
  const { bytes, overflow } = await readUpTo(res, limit);
  if (overflow) {
    const makeError: ErrorFactory =
      ctx.makeError ??
      ((message, status, detail, options) =>
        new ServiceNowError(message, status, detail, options));
    throw makeError(
      `${ctx.system} response for ${ctx.safeUrl} exceeded the SN_MAX_BODY_BYTES limit of ${limit} bytes.`,
      res.status,
      undefined,
      { code: "RESPONSE_TOO_LARGE", hint: TOO_LARGE_HINT },
    );
  }
  return bytes;
}

/** readBodyBytes decoded as UTF-8. */
export async function readBodyText(
  res: Response,
  ctx: BodyReadContext,
): Promise<string> {
  return (await readBodyBytes(res, ctx)).toString("utf8");
}

/** Parse a response body as JSON, tolerating an empty or non-JSON body. */
export async function readJsonBody(
  res: Response,
  ctx: BodyReadContext = { system: "HTTP", safeUrl: "(response)" },
): Promise<unknown> {
  const text = await readBodyText(res, ctx);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}
