import { promises as fs } from "node:fs";
import { getCredentials } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";
import { sha256Hex } from "../core/write-journal.js";
import { errorCode } from "./docs-paths.js";

/**
 * Docs store v2 (S-14): frontmatter, manual blocks and ownership.
 */

/**
 * Default layout version of generated documents. Bump it when a generator's
 * output changes shape, so an unchanged source still rewrites the file once.
 * A writer with its own template declares `DocMeta.generatorVersion` instead
 * (ID-18), so bumping one writer does not rewrite every other writer's files.
 */
export const DOCS_GENERATOR_VERSION = "1";

export const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export const MANUAL_RE =
  /<!-- sn:manual:start(?:\s+([\w-]+))?\s*-->[\s\S]*?<!-- sn:manual:end\s*-->/g;

/** The `sn_*` fields of a document, as strings. */
export type DocFields = Record<string, string>;

/** Split a leading `---` frontmatter block from a Markdown body. */
export function parseFrontmatter(content: string): {
  fields?: DocFields;
  body: string;
} {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return { body: content };
  const fields: DocFields = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):[ \t]?(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value.startsWith('"')) {
      try {
        value = String(JSON.parse(value));
      } catch {
        // keep the raw text
      }
    }
    fields[kv[1]!] = value;
  }
  return { fields, body: content.slice(m[0].length) };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The `sn_*` fields of a document: frontmatter, or a JSON file's top level. */
export function fieldsOf(content: string, ext: string): DocFields | undefined {
  if (ext !== ".json") return parseFrontmatter(content).fields;
  try {
    const obj: unknown = JSON.parse(content);
    if (!isPlainObject(obj)) return undefined;
    const fields: DocFields = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        k.startsWith("sn_") &&
        ["string", "boolean", "number"].includes(typeof v)
      ) {
        fields[k] = String(v);
      }
    }
    return Object.keys(fields).length > 0 ? fields : undefined;
  } catch {
    return undefined;
  }
}

export const isGenerated = (
  fields: DocFields | undefined,
): fields is DocFields => fields?.sn_generated === "true";

/**
 * Carry the manual blocks of the previous version into a regenerated body.
 * A block in the new body is replaced by the previous block with the same id
 * (`<!-- sn:manual:start notes -->`), or — for anonymous blocks — by the next
 * unused anonymous one, in order. Previous blocks with no slot are appended,
 * so hand-written text is never lost.
 */
export function mergeManualBlocks(next: string, previous: string): string {
  const old = [...previous.matchAll(MANUAL_RE)].map((m) => ({
    id: m[1],
    text: m[0],
    used: false,
  }));
  if (old.length === 0) return next;
  let merged = next.replace(MANUAL_RE, (block, id?: string) => {
    const hit = old.find((b) => !b.used && b.id === id);
    if (!hit) return block;
    hit.used = true;
    return hit.text;
  });
  const orphans = old.filter((b) => !b.used).map((b) => b.text);
  if (orphans.length > 0) {
    merged = `${merged.replace(/\n*$/, "")}\n\n${orphans.join("\n\n")}\n`;
  }
  return merged;
}

/** JSON with sorted keys, so a hash does not depend on insertion order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** `sha256:<hex>` of a generator's source data (or of a body string). */
export function sourceHash(source: unknown): string {
  return `sha256:${sha256Hex(typeof source === "string" ? source : stableJson(source))}`;
}

/** What a generator passes to docsWriteRaw to own the file it writes. */
export interface DocMeta {
  /** Tool or generator name, e.g. `servicenow_snapshot_instance`. */
  generator: string;
  /** Open-ended document kind (`tables`, `schema`, `compare`, …). */
  kind?: string;
  /** Default: the active profile. */
  profile?: string;
  /** Default: the profile's instance host. */
  instance?: string;
  /** Default: now. */
  generatedAt?: string;
  /**
   * Structured source data the document was rendered from. Its hash decides
   * whether a re-run is `unchanged`; leave timestamps out of it. Without it
   * the body (minus manual blocks) is hashed.
   */
  source?: unknown;
  /** Take over a hand-written file. */
  overwrite?: boolean;
  /**
   * Recognises a file this generator wrote before the store had frontmatter,
   * so the upgrade does not trip DOC_GENERATED. A JSON file with a top-level
   * `generatedAt` key is always treated as legacy generated output.
   */
  legacy?: RegExp;
  /**
   * The document records an interrupted run (S-7): written as `sn_partial`
   * and surfaced as `partial: true` in index.json.
   */
  partial?: boolean;
  /**
   * The writer's own layout version (ID-18), written as
   * `sn_generator_version`. Default: DOCS_GENERATOR_VERSION.
   */
  generatorVersion?: string;
}

export type DocWriteStatus = "created" | "updated" | "unchanged";

export interface DocWriteResult {
  path: string;
  bytes: number;
  /** Set for generator writes (with `meta`). */
  status?: DocWriteStatus;
  source_hash?: string;
}

export function docGenerated(
  relPath: string,
  generatedBy: string | undefined,
): ServiceNowError {
  return generatedBy !== undefined
    ? new ServiceNowError(
        `Document ${relPath} is generated by ${generatedBy || "a generator"}; it is not replaced without overwrite: true.`,
        409,
        undefined,
        {
          code: "DOC_GENERATED",
          hint: "Pass overwrite: true to replace it, or regenerate it — text inside <!-- sn:manual:start --> … <!-- sn:manual:end --> survives regeneration.",
        },
      )
    : new ServiceNowError(
        `Document ${relPath} is hand-written; a generator does not replace it without overwrite: true.`,
        409,
        undefined,
        {
          code: "DOC_GENERATED",
          hint: "Pass overwrite: true to let the generator take the file over, or move the hand-written file.",
        },
      );
}

export function instanceHost(profile: string): string {
  try {
    return getCredentials(profile)
      .instance.replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "");
  } catch {
    return "";
  }
}

export function yamlValue(v: string): string {
  return /^[\w.:+\-/@]+$/.test(v) ? v : JSON.stringify(v);
}

export async function readIfExists(abs: string): Promise<string | undefined> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return undefined;
    throw e;
  }
}

/** Up to `max` leading bytes of a file, plus its size; undefined if missing. */
export async function readHead(
  abs: string,
  max: number,
): Promise<{ text: string; size: number; mtimeMs: number } | undefined> {
  let handle;
  try {
    handle = await fs.open(abs, "r");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return undefined;
    throw e;
  }
  try {
    const { size, mtimeMs } = await handle.stat();
    const n = Math.min(size, max);
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    // A cut can split a multi-byte character; drop the partial tail.
    return {
      text: n < size ? text.replace(/\uFFFD+$/, "") : text,
      size,
      mtimeMs,
    };
  } finally {
    await handle.close();
  }
}
