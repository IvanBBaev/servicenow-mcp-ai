import { z } from "zod";
import { getMaxResultChars, resultPretty } from "../core/settings.js";
import type { ToolResult } from "./result.js";

/**
 * N-61 — the universal, shape-preserving result cap. runSpec applies it to
 * every successful result before the structuredContent step, so a tool
 * without an output schema (`list_changes`, the explainers…) is capped too,
 * not only the `okQueryResult` path.
 *
 * The cap never cuts the serialized text: the SDK validates structuredContent
 * against the tool's output schema, and a cut payload is not JSON. It shrinks
 * the largest array in the JSON object instead — binary search on the number
 * of items kept — and re-serializes, so every key (a `plan_token`, a count, a
 * required field) survives. The payload then says `truncated: true` and a
 * `note` names what was cut; output schemas are loose objects, so the two keys
 * validate without being declared. Error results, non-JSON text (CSV,
 * Markdown) and top-level arrays pass unchanged.
 */

/** Arrays below this depth are not considered (bounded walk). */
const MAX_DEPTH = 6;

/** At most this many arrays are shrunk before the cap gives up. */
const MAX_PASSES = 4;

interface ArrayRef {
  path: string;
  holder: Record<string, unknown> | unknown[];
  key: string | number;
  items: unknown[];
  size: number;
}

function stringify(data: unknown): string {
  return resultPretty() ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

/** Every non-empty array under `root`, the largest (serialized) first. */
function arraysOf(root: Record<string, unknown>): ArrayRef[] {
  const found: ArrayRef[] = [];
  const walk = (
    value: unknown,
    holder: ArrayRef["holder"],
    key: string | number,
    path: string,
    depth: number,
  ): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      if (value.length) {
        found.push({
          path,
          holder,
          key,
          items: value,
          size: JSON.stringify(value).length,
        });
      }
      value.forEach((item, i) =>
        walk(item, value, i, `${path}[${i}]`, depth + 1),
      );
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      walk(
        v,
        value as Record<string, unknown>,
        k,
        path ? `${path}.${k}` : k,
        depth + 1,
      );
    }
  };
  for (const [k, v] of Object.entries(root)) walk(v, root, k, k, 1);
  return found.sort((a, b) => b.size - a.size);
}

/** Whether an array holds arrays one level down (directly or in objects). */
function holdsArrays(items: unknown[]): boolean {
  return items.some(
    (item) =>
      Array.isArray(item) ||
      (item !== null &&
        typeof item === "object" &&
        Object.values(item).some(Array.isArray)),
  );
}

function setAt(ref: ArrayRef, items: unknown[]): void {
  (ref.holder as Record<string | number, unknown>)[ref.key] = items;
}

const fileFormatCache = new WeakMap<object, boolean>();

/** Whether the tool's `format` parameter offers `"file"` (S-11). */
export function supportsFileFormat(input: z.ZodRawShape | undefined): boolean {
  const format = input?.format;
  if (!format) return false;
  const cached = fileFormatCache.get(format);
  if (cached !== undefined) return cached;
  let supported: boolean;
  try {
    supported = JSON.stringify(z.toJSONSchema(format)).includes('"file"');
  } catch {
    supported = false;
  }
  fileFormatCache.set(format, supported);
  return supported;
}

/** The size the cap measures: the structured payload, else the text. */
export function resultChars(result: ToolResult): number {
  const text = result.content.reduce((n, c) => n + c.text.length, 0);
  return result.structuredContent === undefined
    ? text
    : Math.max(text, JSON.stringify(result.structuredContent).length);
}

/**
 * Cap a successful result at SN_MAX_RESULT_CHARS without changing its shape
 * (see the module comment). `fileHint` adds the `format:"file"` advice for a
 * tool that supports it.
 */
export function capResult(
  result: ToolResult,
  options: { fileHint?: boolean; maxChars?: number } = {},
): ToolResult {
  if (result.isError || result.content.length !== 1) return result;
  const max = options.maxChars ?? getMaxResultChars();
  const chars = resultChars(result);
  if (chars <= max) return result;

  let payload: unknown;
  try {
    payload = JSON.parse(result.content[0]!.text);
  } catch {
    return result;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return result;
  }
  const root = payload as Record<string, unknown>;
  const fits = (): boolean => stringify(root).length <= max;
  const prior = typeof root.note === "string" ? `${root.note} ` : "";
  const noteFor = (cuts: string[]): string =>
    `${prior}Result too large (${chars} chars > ${max}); kept ${cuts.join(", ")} items. Narrow the request (filters, fields, limit)${options.fileHint ? ' or pass format:"file" to write the full result to a file under SN_DOCS_DIR' : ""}.`;

  const cuts: string[] = [];
  const done = new Set<string>();
  root.truncated = true;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // Re-walk each pass: items cut by the previous pass drop out.
    const ref = arraysOf(root).find((r) => !done.has(r.path));
    if (!ref) break;
    done.add(ref.path);
    const n = ref.items.length;
    // An array of containers keeps one item, so a self-capped payload
    // (explain_artifact's `children`) keeps its shape and the next pass
    // shrinks the nested array instead.
    const floor = holdsArrays(ref.items) ? 1 : 0;
    // The search runs with the widest note this pass can print (the kept
    // count has at most as many digits as n), so the final payload fits.
    root.note = noteFor([...cuts, `${ref.path}: ${n} of ${n}`]);
    let lo = floor;
    let hi = n;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      setAt(ref, ref.items.slice(0, mid));
      if (fits()) lo = mid;
      else hi = mid - 1;
    }
    setAt(ref, ref.items.slice(0, lo));
    cuts.push(`${ref.path}: ${lo} of ${n}`);
    root.note = noteFor(cuts);
    if (fits()) break;
  }
  if (!cuts.length) return result;

  const text = stringify(root);
  return {
    ...result,
    content: [{ type: "text", text }],
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: JSON.parse(text) as Record<string, unknown> }),
  };
}
