import { ServiceNowError } from "../core/errors.js";
import { getMaxResultChars, resultPretty } from "../core/settings.js";
import type { SnRecord } from "../api/table.js";

/** The shape every tool handler returns to the MCP client. */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Compact by default; SN_RESULT_PRETTY=true switches to indented output. */
function stringify(data: unknown): string {
  return resultPretty()
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);
}

function asText(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: stringify(data) }],
  };
}

/** Success result carrying a JSON payload. */
export function ok(data: unknown): ToolResult {
  return asText(data);
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
    const payload = {
      error: {
        message: error.message,
        status: error.status,
        snDetail: snDetail(error.detail),
      },
    };
    return {
      content: [{ type: "text", text: stringify(payload) }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: stringify({ error: { message } }) }],
    isError: true,
  };
}

/**
 * Serialise query results, truncating the record set if it would exceed
 * SN_MAX_RESULT_CHARS so a large table read cannot overwhelm the client.
 */
export function okQueryResult(records: SnRecord[], total?: number): ToolResult {
  const maxChars = getMaxResultChars();
  const meta = total === undefined ? {} : { total };
  const fullText = stringify({ count: records.length, ...meta, records });
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
      note: `Result too large (${fullText.length} chars > ${maxChars}). Showing the first ${kept} of ${records.length} records. Narrow the query, select fewer fields, or lower the limit.`,
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
    note: "Result too large to display. Narrow the query or select fewer fields.",
  });
}
