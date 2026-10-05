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
 * required field) survives. When no array is left to shrink, it shortens the
 * longest string values: a CSV payload (`format: "csv"`, `content`) keeps its
 * header and whole rows, any other string keeps a prefix. The payload then
 * says `truncated: true` and a `note` names what was cut; output schemas are
 * loose objects, so the two keys validate without being declared.
 *
 * A top-level array or non-JSON text (Markdown, CSV) has no object to carry
 * the note: the array keeps its leading items, the text its leading lines,
 * and the note follows as a second text block. Error results pass unchanged.
 */

/** Arrays and strings below this depth are not considered (bounded walk). */
const MAX_DEPTH = 6;

/** At most this many arrays (then strings) are shrunk before giving up. */
const MAX_PASSES = 4;

/** Strings shorter than this are never shortened (ids, names, tokens). */
const MIN_STRING = 256;

/**
 * Keys whose string value is never shortened. A cut `mermaid` diagram does
 * not render: S-11 returns it whole with a `format:"file"` note instead.
 */
const KEEP_STRINGS = new Set(["note", "plan_token", "mermaid"]);

interface Ref<T> {
  path: string;
  holder: Record<string, unknown> | unknown[];
  key: string | number;
  value: T;
  size: number;
}

/** A unit the cap can shorten: `cut(k)` keeps the first k of `total` units. */
interface Cuttable {
  path: string;
  total: number;
  unit: string;
  floor: number;
  cut: (kept: number) => void;
}

function stringify(data: unknown): string {
  return resultPretty() ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

/** Every non-empty array and every long string under `root`, largest first. */
function collect(root: Record<string, unknown>): {
  arrays: Ref<unknown[]>[];
  strings: Ref<string>[];
} {
  const arrays: Ref<unknown[]>[] = [];
  const strings: Ref<string>[] = [];
  const walk = (
    value: unknown,
    holder: Ref<unknown>["holder"],
    key: string | number,
    path: string,
    depth: number,
  ): void => {
    if (depth > MAX_DEPTH) return;
    if (typeof value === "string") {
      if (value.length >= MIN_STRING && !KEEP_STRINGS.has(String(key))) {
        strings.push({ path, holder, key, value, size: value.length });
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (value.length) {
        arrays.push({
          path,
          holder,
          key,
          value,
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
  const bySize = (a: { size: number }, b: { size: number }): number =>
    b.size - a.size;
  return { arrays: arrays.sort(bySize), strings: strings.sort(bySize) };
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

function setAt(ref: Ref<unknown>, value: unknown): void {
  (ref.holder as Record<string | number, unknown>)[ref.key] = value;
}

/**
 * The end offset of every CSV row (RFC 4180: a newline inside quotes is part
 * of the cell). Row 0 is the header.
 */
export function csvRowEnds(text: string): number[] {
  const ends: number[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (c === "\n" && !quoted) ends.push(i);
  }
  ends.push(text.length);
  return ends;
}

/** The first `kept` characters, never splitting a surrogate pair. */
function prefix(text: string, kept: number): string {
  const code = text.charCodeAt(kept - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? kept - 1 : kept);
}

/** A string ref as a Cuttable: CSV rows for a CSV payload, else characters. */
function stringCut(ref: Ref<string>, csv: boolean): Cuttable {
  if (csv) {
    const ends = csvRowEnds(ref.value);
    return {
      path: ref.path,
      total: ends.length - 1,
      unit: "rows",
      floor: 0,
      cut: (kept) => setAt(ref, ref.value.slice(0, ends[kept])),
    };
  }
  return {
    path: ref.path,
    total: ref.value.length,
    unit: "chars",
    floor: 0,
    cut: (kept) => setAt(ref, prefix(ref.value, kept)),
  };
}

/**
 * Binary search for the most units of `target` that keep `fits()` true, with
 * `widen` called first so the search runs with the widest note it can print.
 * Returns the kept count; `target.cut` is left at that count.
 */
function shrink(
  target: Cuttable,
  fits: () => boolean,
  widen: () => void,
): number {
  widen();
  let lo = target.floor;
  let hi = target.total;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    target.cut(mid);
    if (fits()) lo = mid;
    else hi = mid - 1;
  }
  target.cut(lo);
  return lo;
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

  const cuts: string[] = [];
  const entry = (t: Cuttable, kept: number): string =>
    `${t.path}: ${kept} of ${t.total} ${t.unit}`;
  const noteFor = (prior: string, list: string[]): string =>
    `${prior}Result too large (${chars} chars > ${max}); kept ${list.join(", ")}. Narrow the request (filters, fields, limit)${options.fileHint ? ' or pass format:"file" to write the full result to a file under SN_DOCS_DIR' : ""}.`;

  const source = result.content[0]!.text;
  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch {
    payload = undefined;
  }
  if (payload === null || typeof payload !== "object") {
    if (result.structuredContent !== undefined) return result;
    return capText(result, source, max, noteFor);
  }
  if (Array.isArray(payload)) {
    if (result.structuredContent !== undefined) return result;
    return capTopLevelArray(result, payload, max, noteFor);
  }

  const root = payload as Record<string, unknown>;
  const fits = (): boolean => stringify(root).length <= max;
  const prior = typeof root.note === "string" ? `${root.note} ` : "";
  const done = new Set<string>();
  root.truncated = true;

  const pass = (target: Cuttable): boolean => {
    done.add(target.path);
    const widest = [...cuts, entry(target, target.total)];
    const kept = shrink(target, fits, () => {
      root.note = noteFor(prior, widest);
    });
    cuts.push(entry(target, kept));
    root.note = noteFor(prior, cuts);
    return fits();
  };

  let fitted = false;
  for (let i = 0; i < MAX_PASSES && !fitted; i++) {
    // Re-walk each pass: items cut by the previous pass drop out.
    const ref = collect(root).arrays.find((r) => !done.has(r.path));
    if (!ref) break;
    fitted = pass({
      path: ref.path,
      total: ref.value.length,
      unit: "items",
      // An array of containers keeps one item, so a self-capped payload
      // (explain_artifact's `children`) keeps its shape and the next pass
      // shrinks the nested array instead.
      floor: holdsArrays(ref.value) ? 1 : 0,
      cut: (kept) => setAt(ref, ref.value.slice(0, kept)),
    });
  }
  for (let i = 0; i < MAX_PASSES && !fitted; i++) {
    const ref = collect(root).strings.find((r) => !done.has(r.path));
    if (!ref) break;
    const csv = root.format === "csv" && ref.holder === root;
    fitted = pass(stringCut(ref, csv && ref.key === "content"));
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

type NoteFor = (prior: string, list: string[]) => string;

/** The capped body plus the note as a second text block. */
function withNote(result: ToolResult, body: string, note: string): ToolResult {
  return {
    ...result,
    content: [
      { type: "text", text: body },
      { type: "text", text: note },
    ],
  };
}

/** A top-level array keeps its leading items; the note follows it. */
function capTopLevelArray(
  result: ToolResult,
  items: unknown[],
  max: number,
  noteFor: NoteFor,
): ToolResult {
  let body = "";
  let note = "";
  const target: Cuttable = {
    path: "(array)",
    total: items.length,
    unit: "items",
    floor: 0,
    cut: (kept) => {
      body = stringify(items.slice(0, kept));
    },
  };
  const kept = shrink(
    target,
    () => body.length + note.length <= max,
    () => {
      note = noteFor("", [
        `${target.path}: ${items.length} of ${items.length} items`,
      ]);
    },
  );
  note = noteFor("", [`${target.path}: ${kept} of ${items.length} items`]);
  return withNote(result, body, note);
}

/** The end offset of every line of `text`. */
function lineEnds(text: string): number[] {
  const ends: number[] = [];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    ends.push(i);
  }
  ends.push(text.length);
  return ends;
}

/**
 * Non-JSON text keeps its leading lines; a text whose first line alone is too
 * long keeps a prefix.
 */
function capText(
  result: ToolResult,
  text: string,
  max: number,
  noteFor: NoteFor,
): ToolResult {
  let body = "";
  let note = "";
  const ends = lineEnds(text);
  const lines: Cuttable = {
    path: "(text)",
    total: ends.length,
    unit: "lines",
    floor: 0,
    cut: (kept) => {
      body = kept ? text.slice(0, ends[kept - 1]) : "";
    },
  };
  const chars: Cuttable = {
    path: "(text)",
    total: text.length,
    unit: "chars",
    floor: 0,
    cut: (kept) => {
      body = prefix(text, kept);
    },
  };
  const fits = (): boolean => body.length + note.length <= max;
  let target = lines;
  let kept = shrink(lines, fits, () => {
    note = noteFor("", [`(text): ${lines.total} of ${lines.total} lines`]);
  });
  if (kept === 0) {
    target = chars;
    kept = shrink(chars, fits, () => {
      note = noteFor("", [`(text): ${chars.total} of ${chars.total} chars`]);
    });
  }
  note = noteFor("", [
    `${target.path}: ${kept} of ${target.total} ${target.unit}`,
  ]);
  return withNote(result, body, note);
}
