/**
 * N-65 — client result hints (O-21 (c)). The deliberately large readers
 * declare `_meta["anthropic/maxResultSizeChars"]` in tools/list, tied to the
 * N-61 cap (SN_MAX_RESULT_CHARS), so a client that honours the hint keeps
 * their result inline instead of spilling it to a file. SN_RESULT_SIZE_HINTS=0
 * drops the hints.
 */
import { getMaxResultChars, resultSizeHints } from "../core/settings.js";

/** The `_meta` key Claude Code reads for a tool's inline result size. */
export const MAX_RESULT_SIZE_KEY = "anthropic/maxResultSizeChars";

/** The tools whose result is large by design. */
export const RESULT_HINT_TOOLS: ReadonlySet<string> = new Set([
  "servicenow_document_app",
  "servicenow_document_instance",
  "servicenow_document_table",
  "servicenow_snapshot_instance",
  "servicenow_compare_instances",
  "servicenow_compare_update_set",
  "servicenow_get_script",
]);

/** The tool's `_meta` hint, or undefined (not a large reader, or hints off). */
export function resultHintMeta(
  name: string,
): Record<string, unknown> | undefined {
  if (!RESULT_HINT_TOOLS.has(name) || !resultSizeHints()) return undefined;
  return { [MAX_RESULT_SIZE_KEY]: getMaxResultChars() };
}
