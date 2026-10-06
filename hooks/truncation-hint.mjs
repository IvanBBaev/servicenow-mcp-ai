#!/usr/bin/env node
// N-48 — Claude Code plugin PostToolUse hook: when a ServiceNow tool result
// says `truncated: true`, add one short hint naming the knobs that tool
// really has (fields, offset, format:"file") so the assistant narrows the
// next call instead of reasoning over a partial set as if it were complete.
// Inside a subagent (`agent_id` in the hook input) format:"file" is left out.
//
// It only reads the tool result the client hands it — no network, no
// dependency, no file access — and only the top-level `truncated`, `returned`
// and `count` of a JSON payload; nothing from the records reaches the hint.
// Anything it does not understand (another tool, an error, a result shape it
// cannot parse) prints nothing.
import { pathToFileURL } from "node:url";

/**
 * Tools whose `format` input accepts `file` (the full result goes to a file
 * under SN_DOCS_DIR). `test/plugin-hooks-v2.test.js` pins the three lists to
 * the tool manifest.
 */
export const FILE_FORMAT_TOOLS = [
  "servicenow_compare_instances",
  "servicenow_document_instance",
  "servicenow_explain_flow",
  "servicenow_explain_portal",
  "servicenow_explain_ui_experience",
  "servicenow_generate_er_diagram",
  "servicenow_generate_fluent",
  "servicenow_generate_table_flow",
  "servicenow_query_table",
  "servicenow_snapshot_instance",
];

/** Tools with a `fields` input (select fewer columns). */
export const FIELDS_TOOLS = [
  "servicenow_get_record",
  "servicenow_get_record_history",
  "servicenow_list_changes",
  "servicenow_query_table",
  "servicenow_search_knowledge",
];

/** Tools with an `offset` input (page through the rest). */
export const OFFSET_TOOLS = [
  "servicenow_list_catalog_items",
  "servicenow_list_changes",
  "servicenow_list_cis",
  "servicenow_list_scripts",
  "servicenow_list_update_sets",
  "servicenow_query_table",
  "servicenow_search_knowledge",
];

/** The MCP tool name without the client's `mcp__<server>__` prefix. */
export function bareToolName(toolName) {
  if (typeof toolName !== "string") return "";
  const i = toolName.lastIndexOf("__");
  return i === -1 ? toolName : toolName.slice(i + 2);
}

function parseJson(text) {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The JSON payloads in a `tool_response`, whatever shape the client used: a
 * JSON string, an array of content blocks, a `{content, structuredContent}`
 * result, a single `{type:"text", text}` block, or the payload itself.
 */
export function payloads(response) {
  if (typeof response === "string") {
    const value = parseJson(response);
    return value ? payloads(value) : [];
  }
  if (Array.isArray(response)) return response.flatMap((b) => payloads(b));
  if (!response || typeof response !== "object") return [];
  if (response.isError === true) return [];
  const found = [];
  if (response.type === "text" && typeof response.text === "string") {
    const value = parseJson(response.text);
    if (value) found.push(value);
  }
  if (Array.isArray(response.content)) {
    found.push(...response.content.flatMap((b) => payloads(b)));
  }
  if (
    response.structuredContent &&
    typeof response.structuredContent === "object"
  ) {
    found.push(response.structuredContent);
  }
  if (found.length === 0 && !("type" in response) && !("content" in response)) {
    found.push(response);
  }
  return found;
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The hint for a truncated result, or `undefined` to stay silent. */
export function truncationHint(event) {
  const name = bareToolName(event?.tool_name);
  if (!name.startsWith("servicenow_")) return undefined;
  const truncated = payloads(event?.tool_response).find(
    (p) => p.truncated === true,
  );
  if (!truncated) return undefined;

  const returned = count(truncated.returned);
  const total = count(truncated.count);
  const size =
    returned !== undefined && total !== undefined
      ? ` (${returned} of ${total} shown)`
      : "";
  const knobs = [];
  if (FIELDS_TOOLS.includes(name)) knobs.push("select fewer `fields`");
  knobs.push("tighten the filter or lower `limit`");
  if (OFFSET_TOOLS.includes(name)) knobs.push("page with `offset`");
  // SF-6: a subagent (Claude Code sets `agent_id` only inside one) cannot
  // hand a file it writes back to its caller, and the plugin's subagents are
  // told never to use format:"file" — so it is not suggested there.
  const subagent = typeof event?.agent_id === "string" && event.agent_id !== "";
  const file =
    FILE_FORMAT_TOOLS.includes(name) && !subagent
      ? ' — or pass `format: "file"` to write the full result to a file'
      : "";
  return (
    `${name} returned a truncated result${size}; do not treat it as complete. ` +
    `To see the rest: ${knobs.join(", ")}${file}.`
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    return; // not a hook event we understand: stay silent
  }
  const hint = truncationHint(event);
  if (!hint) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: hint,
      },
    }) + "\n",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await main();
  } catch {
    // fail silently: a hint is never worth a broken tool call
  }
}
