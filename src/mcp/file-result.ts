import path from "node:path";
import { activeProfile } from "../core/config.js";
import { redactValue } from "../core/redaction.js";
import {
  getDocsDir,
  getMaxResultChars,
  oversizeToFile,
} from "../core/settings.js";
import { docsWriteRaw, openDocStream, type DocStream } from "../api/docs.js";
import { ok, type ToolResult } from "./result.js";

/**
 * S-11 — file-based delivery for large results. A `format:"file"` read (and,
 * with SN_OVERSIZE_TO_FILE, any snapshot / compare / diagram result over
 * SN_MAX_RESULT_CHARS) is written to the docs store instead of the chat:
 *
 * - data (query rows, snapshot and compare results) goes to
 *   `<SN_DOCS_DIR>/<profile>/exports/<name>-<timestamp>.<ext>`, a new file per
 *   call;
 * - Mermaid diagrams go to `<SN_DOCS_DIR>/<profile>/diagrams/<name>.mmd`,
 *   replaced on a re-run (ID-14) — raw Mermaid, no frontmatter, so the file
 *   renders and lints as is.
 *
 * The tool then returns `{ path, file, bytes, preview }`: `path` is relative
 * to SN_DOCS_DIR (like every docs-store path), `file` is the absolute path,
 * and `preview` the first PREVIEW_CHARS characters (`preview_truncated` when
 * the file is longer). Content is redacted (SN_REDACT_FIELDS / SN_REDACT_PII)
 * before it is written, so the file never holds more than the inline result
 * would have. Paths go through the docs store's confinement checks.
 */

/** Characters of a delivered file echoed back in the result (ID-14). */
export const PREVIEW_CHARS = 2000;

/** The result fields of a file delivery. */
export interface FileDelivery {
  path: string;
  file: string;
  bytes: number;
  preview: string;
  preview_truncated?: true;
}

/** File-name-safe form of a caller-derived name (table, profile, ...). */
export function safeFileName(name: string, max = 80): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, max)
    .replace(/[._]+$/, "");
  return cleaned || "export";
}

/** `2026-09-25T10-11-12-345Z` — sortable, and free of `:` (H-6 portability). */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** The docs-relative path of a new export file for the active profile. */
export function exportPath(name: string, ext: string): string {
  return `${activeProfile()}/exports/${safeFileName(name)}-${stamp()}.${ext}`;
}

/** The docs-relative path of a diagram file for the active profile. */
export function diagramPath(name: string): string {
  return `${activeProfile()}/diagrams/${safeFileName(name)}.mmd`;
}

/** First PREVIEW_CHARS characters, flagged when the text is longer. */
export function previewOf(text: string): {
  preview: string;
  preview_truncated?: true;
} {
  return text.length > PREVIEW_CHARS
    ? { preview: text.slice(0, PREVIEW_CHARS), preview_truncated: true }
    : { preview: text };
}

/**
 * Collects the head of a streamed file for the preview while chunks pass
 * through, so a streamed export needs no read-back.
 */
export class PreviewSink {
  private head = "";
  private longer = false;

  constructor(private readonly stream: DocStream) {}

  async write(chunk: string): Promise<void> {
    if (this.head.length < PREVIEW_CHARS + 1) {
      this.head += chunk.slice(0, PREVIEW_CHARS + 1 - this.head.length);
    }
    if (this.head.length > PREVIEW_CHARS) this.longer = true;
    await this.stream.write(chunk);
  }

  async close(): Promise<FileDelivery> {
    const { path: rel, abs, bytes } = await this.stream.close();
    const preview = this.head.slice(0, PREVIEW_CHARS);
    return {
      path: rel,
      file: abs,
      bytes,
      preview,
      ...(this.longer ? { preview_truncated: true as const } : {}),
    };
  }

  abort(): Promise<void> {
    return this.stream.abort();
  }
}

/** Open a new export file (`exports/`) with a preview sink in front. */
export async function openExport(
  name: string,
  ext: "csv" | "jsonl" | "json",
): Promise<PreviewSink> {
  return new PreviewSink(
    await openDocStream(exportPath(name, ext), [`.${ext}`]),
  );
}

/** Write a whole (already redacted) text to a new export file. */
export async function writeExport(
  name: string,
  ext: "csv" | "jsonl" | "json",
  text: string,
): Promise<FileDelivery> {
  const sink = await openExport(name, ext);
  try {
    await sink.write(text);
  } catch (e) {
    await sink.abort();
    throw e;
  }
  return sink.close();
}

/** Serialised size of a result as ok() would send it (compact JSON). */
function resultChars(data: unknown): number {
  return JSON.stringify(redactValue(data).value).length;
}

/** The note an over-budget inline result carries (never silent, S-11). */
export function oversizeNote(chars: number, max: number): string {
  return `Result is ${chars} chars, over SN_MAX_RESULT_CHARS (${max}); it is returned in full. Pass format:"file" (or set SN_OVERSIZE_TO_FILE=true) to have it written to a file under SN_DOCS_DIR with a preview instead.`;
}

/**
 * The small, scalar part of a result for a file delivery: short strings,
 * numbers and booleans are kept, arrays become `<key>_count`, and objects and
 * long strings are left to the file.
 */
export function summarize(data: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) out[`${key}_count`] = value.length;
    else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string" && value.length <= 200) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Deliver a JSON result (snapshot, compare): inline by default; written to
 * `exports/<name>-<timestamp>.json` with `format:"file"`, or when it is over
 * SN_MAX_RESULT_CHARS and SN_OVERSIZE_TO_FILE is on. An over-budget inline
 * result gains a `note` saying so — its content is unchanged.
 */
export async function deliverJson(
  data: object,
  name: string,
  format: "json" | "file" | undefined,
): Promise<ToolResult> {
  const max = getMaxResultChars();
  const chars = format === "file" ? 0 : resultChars(data);
  const auto = format !== "file" && chars > max && oversizeToFile();
  if (format === "file" || auto) {
    const { value, redacted } = redactValue(data);
    const delivery = await writeExport(
      name,
      "json",
      JSON.stringify(value, null, 2),
    );
    return ok({
      ...summarize(data),
      format: "file",
      ...delivery,
      ...(redacted > 0 ? { redacted } : {}),
      ...(auto
        ? {
            note: `Result was ${chars} chars, over SN_MAX_RESULT_CHARS (${max}): written to a file (SN_OVERSIZE_TO_FILE).`,
          }
        : {}),
    });
  }
  return ok(chars > max ? { ...data, note: oversizeNote(chars, max) } : data);
}

/**
 * Deliver a Mermaid generator result (`{ mermaid, ... }`): inline by default;
 * with `format:"file"` — or over SN_MAX_RESULT_CHARS with SN_OVERSIZE_TO_FILE —
 * the diagram goes to `diagrams/<name>.mmd` and the result carries the other
 * (small) fields plus `{ path, file, bytes, preview }` in place of `mermaid`.
 */
export async function deliverDiagram<T extends { mermaid: string }>(
  result: T,
  name: string,
  format: "inline" | "file" | undefined,
): Promise<ToolResult> {
  const max = getMaxResultChars();
  const chars = format === "file" ? 0 : resultChars(result);
  const auto = format !== "file" && chars > max && oversizeToFile();
  if (format === "file" || auto) {
    const { mermaid, ...rest } = result;
    const text = redactValue(mermaid).value;
    const written = await docsWriteRaw(diagramPath(name), text, [".mmd"]);
    return ok({
      ...rest,
      format: "file",
      path: written.path,
      file: path.resolve(getDocsDir(), written.path),
      bytes: written.bytes,
      ...previewOf(text),
      ...(auto
        ? {
            note: `Diagram result was ${chars} chars, over SN_MAX_RESULT_CHARS (${max}): written to a file (SN_OVERSIZE_TO_FILE).`,
          }
        : {}),
    });
  }
  return ok(
    chars > max ? { ...result, note: oversizeNote(chars, max) } : result,
  );
}
