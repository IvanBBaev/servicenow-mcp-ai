import { IntegrationError, type ServiceNowErrorOptions } from "./errors.js";

/**
 * Error-body shaping for the request primitive: HTML and hibernation
 * detection, text caps and the `ErrorBody` shape.
 */

/** Longest non-JSON (HTML/plain) error excerpt carried into an error message. */
export const MAX_TEXT_DETAIL_CHARS = 512;

/** Longest JSON error body (serialised) kept as structured detail. */
export const MAX_JSON_DETAIL_CHARS = 2048;

const UPSTREAM_HTML_HINT =
  "The response was an HTML page (proxy, WAF or login page) instead of an API body — check the host and the proxy settings.";

/**
 * Wording ServiceNow's hibernation / wake-up pages use (the PDI landing page
 * on the instance host and the developer-portal page it redirects to). Pinned
 * from recorded page shapes, not a contract — kept deliberately loose.
 */
const HIBERNATION_RE =
  /hibernat|instance is (?:asleep|sleeping|waking)|wake (?:up )?(?:your|the) instance/i;

/** Hint for a page that identifies itself as a hibernating developer instance. */
export const HIBERNATING_HINT =
  "The developer instance (PDI) is hibernating — wake it at https://developer.servicenow.com (sign in, then 'Wake up instance'), wait until it is running, and retry.";

/** Hint for any other HTML page returned in place of an API body. */
export const INSTANCE_HTML_HINT =
  "The instance answered with a web page instead of JSON. A PDI may be hibernating — wake it at https://developer.servicenow.com. Otherwise a login/SSO page or a proxy answered: check SN_INSTANCE, the auth method and the proxy settings.";

/** True when a body (or its content type) is an HTML page. */
export function looksLikeHtml(
  text: string,
  contentType: string | null,
): boolean {
  if ((contentType ?? "").toLowerCase().includes("html")) return true;
  return /^\s*<(!doctype|html|head|body|div|p)\b/i.test(text);
}

/** True when an HTML page reads like ServiceNow's hibernation / wake-up page. */
export function isHibernationPage(html: string): boolean {
  return HIBERNATION_RE.test(htmlToText(html));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Strip tags, scripts and styles from an HTML page and collapse whitespace. */
export function htmlToText(html: string): string {
  return collapse(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
  );
}

export interface ErrorBody {
  /** Structured detail for the error object (JSON body, or {raw: excerpt}). */
  detail: unknown;
  /** Human-readable summary, already capped. */
  summary: string;
  code?: ServiceNowErrorOptions["code"];
  hint?: string;
}

/**
 * Shape a non-2xx body for the error the caller throws (L1-06). JSON bodies
 * keep their structure (capped at MAX_JSON_DETAIL_CHARS serialised); an HTML
 * page — a proxy, WAF or SSO login page that never reached the API — is
 * reduced to a short text excerpt and flagged UPSTREAM_HTML; anything else is
 * whitespace-collapsed and capped. The raw body is only ever logged at debug.
 */
export function shapeErrorBody(
  text: string,
  contentType: string | null,
  extractDetail: (json: unknown) => string | undefined,
): ErrorBody {
  const type = (contentType ?? "").toLowerCase();
  const trimmed = text.trim();
  const looksJson =
    type.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (looksJson && trimmed) {
    try {
      const json: unknown = JSON.parse(trimmed);
      const summary = cap(
        collapse(extractDetail(json) ?? ""),
        MAX_JSON_DETAIL_CHARS,
      );
      const serialised = JSON.stringify(json) ?? "";
      const detail =
        serialised.length > MAX_JSON_DETAIL_CHARS
          ? { raw: cap(serialised, MAX_JSON_DETAIL_CHARS), truncated: true }
          : json;
      return { detail, summary };
    } catch {
      // Not JSON after all — fall through to the text handling.
    }
  }
  if (looksLikeHtml(trimmed, contentType) && trimmed) {
    const summary = cap(htmlToText(trimmed), MAX_TEXT_DETAIL_CHARS);
    // A hibernating PDI can answer with an error status too (H-8 C-3 / L1-08):
    // same shaping, but the specific code and the "wake it" hint.
    if (isHibernationPage(trimmed)) {
      return {
        detail: { raw: summary, html: true },
        summary,
        code: "INSTANCE_HTML_RESPONSE",
        hint: HIBERNATING_HINT,
      };
    }
    return {
      detail: { raw: summary, html: true },
      summary,
      code: "UPSTREAM_HTML",
      hint: UPSTREAM_HTML_HINT,
    };
  }
  const summary = cap(collapse(trimmed), MAX_TEXT_DETAIL_CHARS);
  return { detail: trimmed ? { raw: summary } : {}, summary };
}

export type ErrorFactory = (
  message: string,
  status?: number,
  detail?: unknown,
  options?: ServiceNowErrorOptions,
) => IntegrationError;
