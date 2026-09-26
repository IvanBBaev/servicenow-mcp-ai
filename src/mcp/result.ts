import { ServiceNowError } from "../core/errors.js";
import { getMaxResultChars, resultPretty } from "../core/settings.js";
import { redactRecords } from "./redact.js";
import { redactValue } from "../core/redaction.js";
import type { SnRecord } from "../api/table.js";

/** The shape every tool handler returns to the MCP client. */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Compact by default; SN_RESULT_PRETTY=true switches to indented output. */
function stringify(data: unknown): string {
  return resultPretty() ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

function asText(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: stringify(data) }],
  };
}

/**
 * H-5 — the one redaction boundary for every tool result. `SN_REDACT_FIELDS`
 * and `SN_REDACT_PII` are applied (deep) to whatever a handler returns through
 * ok()/okStructured()/fail(), not only to query_table records; a no-op, same
 * reference, when redaction is off.
 */
function safe<T>(data: T): T {
  return redactValue(data).value;
}

/** Success result carrying a JSON payload. */
export function ok(data: unknown): ToolResult {
  return asText(safe(data));
}

/**
 * Success result that also carries structuredContent — only for tools that
 * declare an outputSchema (the duplication costs tokens, so it is opt-in).
 */
export function okStructured(data: Record<string, unknown>): ToolResult {
  const masked = safe(data);
  return { ...asText(masked), structuredContent: masked };
}

/** Pull the useful part out of a ServiceNow error body, if present. */
function snDetail(detail: unknown): unknown {
  if (detail && typeof detail === "object" && "error" in detail) {
    return (detail as { error?: unknown }).error;
  }
  return undefined;
}

/**
 * Error result. ServiceNow errors keep their structure (`status`, `snDetail`)
 * so the model can react differently to 401 (credentials), 403 (ACL/policy),
 * 429 (rate limit) and so on, instead of parsing a flat string.
 */
export function fail(error: unknown): ToolResult {
  if (error instanceof ServiceNowError) {
    const payload = safe({
      error: {
        message: error.message,
        status: error.status,
        snDetail: snDetail(error.detail),
        // Client-side conditions (BUSY, DEADLINE_EXCEEDED, UPSTREAM_HTML)
        // carry a code and a one-line hint; absent otherwise.
        ...(error.code ? { code: error.code } : {}),
        ...(error.hint ? { hint: error.hint } : {}),
      },
    });
    return {
      content: [{ type: "text", text: stringify(payload) }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: stringify(safe({ error: { message } })) }],
    isError: true,
  };
}

/**
 * Serialise query results, truncating the record set if it would exceed
 * SN_MAX_RESULT_CHARS so a large table read cannot overwhelm the client. The
 * truncation is never silent: the payload says `truncated: true`, how many
 * records were kept, and that `format:"file"` delivers the full set (S-11).
 *
 * `capped` propagates the QueryResult.truncated signal (a fetchAll that stopped
 * at SN_MAX_RECORDS): the returned set is then a *partial* read of the matching
 * rows, so it is flagged explicitly — a caller must never treat the capped set
 * as the whole table (the ARCH-3 completeness signal, carried to the primary
 * query path, not just snapshot/compare).
 */
/** Extra completeness facts from a `fetchAll` read (see QueryResult). */
export interface QueryCompleteness {
  truncatedReason?: "cap" | "scan_limit";
  /** Rows counted by the instance but withheld (ACLs / data filters). */
  filtered?: number;
}

/**
 * The completeness fields for a query payload: `truncated` + a `note` that
 * names the real cause (H-8 C-1) — the SN_MAX_RECORDS cap, the scan budget,
 * or rows the instance withheld — plus `filtered` when rows were withheld.
 * Shared by the JSON and CSV output paths.
 */
export function queryCompleteness(
  returned: number,
  total: number | undefined,
  capped: boolean | undefined,
  info: QueryCompleteness = {},
): Record<string, unknown> {
  const filtered = info.filtered ?? 0;
  const withheld =
    filtered > 0
      ? ` The instance withheld ${filtered} matching row(s) it counted (row-level ACLs or data filters): X-Total-Count includes rows this user cannot read.`
      : "";
  if (capped) {
    const note =
      info.truncatedReason === "scan_limit"
        ? `Stopped after scanning ${String(returned + filtered)} row positions: the instance withheld most matching rows (row-level ACLs), so ${returned} of ${total ?? "more"} counted records were read. Narrow the query to rows this user can read.${withheld}`
        : `Stopped at the SN_MAX_RECORDS cap: ${returned} of ${total ?? "more"} matching records. Narrow the query or raise SN_MAX_RECORDS to read the rest.${withheld}`;
    return {
      truncated: true as const,
      note,
      ...(filtered > 0 ? { filtered } : {}),
    };
  }
  if (filtered > 0) {
    return {
      filtered,
      note: `Complete read of the rows this user can see: ${returned} returned.${withheld}`,
    };
  }
  return {};
}

export function okQueryResult(
  records: SnRecord[],
  total?: number,
  capped?: boolean,
  info?: QueryCompleteness,
): ToolResult {
  // DF-5: mask sensitive values before anything is serialised for the model.
  const redaction = redactRecords(records);
  records = redaction.records;
  const maxChars = getMaxResultChars();
  const meta = {
    ...(total === undefined ? {} : { total }),
    ...(redaction.redacted > 0 ? { redacted: redaction.redacted } : {}),
  };
  const capInfo = queryCompleteness(records.length, total, capped, info);
  const fullText = stringify({
    count: records.length,
    ...meta,
    ...capInfo,
    records,
  });
  if (fullText.length <= maxChars) {
    return { content: [{ type: "text", text: fullText }] };
  }

  let kept = records.length;
  while (kept > 0) {
    kept = Math.floor(kept / 2);
    const payload = {
      count: records.length,
      ...meta,
      returned: kept,
      truncated: true,
      note: `Result too large (${fullText.length} chars > ${maxChars}). Showing the first ${kept} of ${records.length} records.${capped ? (info?.truncatedReason === "scan_limit" ? " The full set was itself partial (scan limit reached)." : " The full set was itself capped at SN_MAX_RECORDS.") : ""} Narrow the query, select fewer fields, or lower the limit — or pass format:"file" to write the full result to a file under SN_DOCS_DIR.`,
      records: records.slice(0, kept),
    };
    const text = stringify(payload);
    if (text.length <= maxChars) {
      return { content: [{ type: "text", text }] };
    }
  }

  return ok({
    count: records.length,
    ...meta,
    returned: 0,
    truncated: true,
    note: 'Result too large to display. Narrow the query or select fewer fields — or pass format:"file" to write the full result to a file under SN_DOCS_DIR.',
  });
}
