import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { activeProfile } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";
import { getDocsDir, getDocsMaxFileBytes } from "../core/settings.js";
import { appendWriteJournal, sha256Hex } from "../core/write-journal.js";
import {
  type DocFields,
  docGenerated,
  type DocMeta,
  DOCS_GENERATOR_VERSION,
  type DocWriteResult,
  fieldsOf,
  instanceHost,
  isGenerated,
  isPlainObject,
  MANUAL_RE,
  mergeManualBlocks,
  parseFrontmatter,
  readHead,
  readIfExists,
  sourceHash,
  yamlValue,
} from "./docs-frontmatter.js";
import {
  assertRealPathInside,
  INDEX_FILE,
  JOURNAL_FILE,
  resolveDocPath,
  scoped,
  tooLarge,
} from "./docs-paths.js";
import { LIST_HEAD_BYTES } from "./docs-inspect.js";
import { MANIFEST_FILE, regenerateIndex } from "./docs-manifest.js";

/**
 * Local self-documentation store. These tools read and write Markdown files in
 * a single directory (SN_DOCS_DIR, default `docs/instance/`) so the model can
 * accumulate durable knowledge about an instance across sessions. They touch
 * the local filesystem only — never ServiceNow — and are strictly confined to
 * the docs directory to prevent path traversal.
 *
 * Store v2 (S-14): a file written by a generator carries a frontmatter block
 * (`sn_generated`, `sn_generator`, `sn_generator_version`, `sn_profile`,
 * `sn_instance`, `sn_generated_at`, `sn_source_hash`) — a JSON companion
 * carries the same fields at its top level. Text between
 * `<!-- sn:manual:start -->` and `<!-- sn:manual:end -->` survives
 * regeneration byte for byte. `write_doc` refuses to replace a generated
 * file (and a generator refuses a hand-written one) without `overwrite`
 * (DOC_GENERATED). Every write rebuilds `index.json` (the manifest) and the
 * `index.md` rendered from it.
 *
 * Metadata-only invariant: the generators that write here (snapshot, ER,
 * table flow, compare, code health) read instance *metadata* — dictionary,
 * scripts, plugins, apps, ACL / flow / notification definitions and aggregate
 * counts — never business records. test/docs-goldens.test.js walks their
 * fetch calls against an allow-list of tables to keep it that way.
 *
 * Layout (E-7): this file holds the writes; the path checks and profile
 * scoping live in `docs-paths.ts`, frontmatter and manual blocks in
 * `docs-frontmatter.ts`, the reads in `docs-inspect.ts` and the manifest in
 * `docs-manifest.ts`.
 */

export { resolveDocsProfile } from "./docs-paths.js";
export {
  DOCS_GENERATOR_VERSION,
  type DocFields,
  parseFrontmatter,
  mergeManualBlocks,
  sourceHash,
  type DocMeta,
  type DocWriteStatus,
  type DocWriteResult,
} from "./docs-frontmatter.js";
export {
  type DocEntry,
  type DocsListOptions,
  docsList,
  type DocMimeType,
  docsRead,
  type DocMatch,
  type DocsSearchOptions,
  docsSearch,
} from "./docs-inspect.js";
export {
  type ManifestEntry,
  type ManifestRun,
  docsRunBegin,
  docsRunEnd,
  docsManifest,
} from "./docs-manifest.js";

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface DocsWriteOptions {
  /** Replace a generated document. */
  overwrite?: boolean;
  /** Write under `<profile>/` (`current` or a profile name). */
  profile?: string;
}

/**
 * Create or overwrite a Markdown document, then regenerate index.md. The
 * store's own index.md / index.json are refused (E-6 F3). Content
 * over SN_DOCS_MAX_FILE_BYTES is refused (the tool path; the internal
 * snapshot writer is not capped). A generated document is only replaced with
 * `overwrite: true` (DOC_GENERATED).
 */
export async function docsWrite(
  relPath: string,
  content: string,
  opts: DocsWriteOptions = {},
): Promise<DocWriteResult> {
  const rel = scoped(relPath, opts.profile);
  const bytes = Buffer.byteLength(content, "utf8");
  const max = getDocsMaxFileBytes();
  if (bytes > max) throw tooLarge(rel, bytes, max);
  if (!opts.overwrite) {
    const head = await readHead(resolveDocPath(rel), LIST_HEAD_BYTES);
    const fields = head ? parseFrontmatter(head.text).fields : undefined;
    if (isGenerated(fields)) throw docGenerated(rel, fields.sn_generator);
  }
  return docsWriteRaw(rel, content);
}

/**
 * Read a file of the docs store verbatim (no frontmatter parsing), with the
 * same confinement as docsWriteRaw; undefined when it does not exist. The
 * Fluent emitter (P-26) uses it to spot hand-edited generated sources.
 */
export async function docsReadRaw(
  relPath: string,
  extensions = [".md"],
): Promise<string | undefined> {
  return readIfExists(resolveDocPath(relPath, extensions));
}

/**
 * Same confinement and index upkeep as docsWrite, but with a caller-chosen
 * extension whitelist — the instance snapshot (MI-6) writes .json companions
 * next to its Markdown. Not exposed as a tool; tools keep the .md-only rule.
 *
 * With `meta` the caller is a generator: the file gets frontmatter (JSON: top
 * level `sn_*` fields), manual blocks of the previous version are carried
 * over, a hand-written file is refused without `meta.overwrite`
 * (DOC_GENERATED), and a re-run whose source hash, generator and profile
 * match is reported `unchanged` without touching the file.
 */
export async function docsWriteRaw(
  relPath: string,
  content: string,
  extensions = [".md"],
  meta?: DocMeta,
): Promise<DocWriteResult> {
  const abs = resolveDocPath(relPath, extensions);
  // H-5: a docs write must not be able to overwrite (and so launder) the
  // audit trail that sits in the same directory.
  if (JOURNAL_FILE.test(path.basename(abs))) {
    throw new ServiceNowError(
      `The write journal cannot be written through the docs store: ${relPath}`,
      400,
    );
  }
  // E-6 F3: the store's own index.md / index.json are rebuilt after every
  // write, so a write to them would be silently replaced.
  const rootRel = path.relative(getDocsDir(), abs).toLowerCase();
  if (rootRel === INDEX_FILE || rootRel === MANIFEST_FILE) {
    throw new ServiceNowError(
      `The docs store index is generated and cannot be written: ${relPath}`,
      400,
      undefined,
      {
        hint: "Write a document under another name; the index rebuilds itself.",
      },
    );
  }
  if (!meta) {
    const bytes = await persist(abs, content);
    await regenerateIndex();
    return { path: relPath, bytes };
  }

  const ext = path.extname(abs).toLowerCase();
  const previous = await readIfExists(abs);
  const prevFields =
    previous === undefined ? undefined : fieldsOf(previous, ext);
  if (
    previous !== undefined &&
    !isGenerated(prevFields) &&
    !meta.overwrite &&
    !isLegacyOutput(previous, ext, meta)
  ) {
    throw docGenerated(relPath, undefined);
  }

  const profile = meta.profile ?? activeProfile();
  const version = meta.generatorVersion ?? DOCS_GENERATOR_VERSION;
  const hash = sourceHash(meta.source ?? content.replace(MANUAL_RE, ""));
  if (
    isGenerated(prevFields) &&
    prevFields.sn_generator === meta.generator &&
    prevFields.sn_generator_version === version &&
    prevFields.sn_profile === profile &&
    prevFields.sn_source_hash === hash &&
    (prevFields.sn_partial === "true") === (meta.partial === true)
  ) {
    return {
      path: relPath,
      bytes: Buffer.byteLength(previous!, "utf8"),
      status: "unchanged",
      source_hash: hash,
    };
  }

  const fields: [string, string][] = [
    ["sn_generated", "true"],
    ["sn_generator", meta.generator],
    ["sn_generator_version", version],
    ...(meta.kind ? [["sn_kind", meta.kind] as [string, string]] : []),
    ["sn_profile", profile],
    ["sn_instance", meta.instance ?? instanceHost(profile)],
    ["sn_generated_at", meta.generatedAt ?? new Date().toISOString()],
    ["sn_source_hash", hash],
    ...(meta.partial ? [["sn_partial", "true"] as [string, string]] : []),
  ];
  let out: string;
  if (ext === ".json") {
    out = withJsonFields(relPath, content, fields);
  } else {
    const body =
      previous === undefined
        ? content
        : mergeManualBlocks(content, parseFrontmatter(previous).body);
    out = `---\n${fields.map(([k, v]) => `${k}: ${yamlValue(v)}`).join("\n")}\n---\n\n${body}`;
  }
  const bytes = await persist(abs, out);
  await regenerateIndex();
  return {
    path: relPath,
    bytes,
    status: previous === undefined ? "created" : "updated",
    source_hash: hash,
  };
}

/**
 * The `sn_*` fields of a stored document, or undefined when it is missing or
 * carries none — how a resumed snapshot (S-7) checks a file still holds the
 * source hash it recorded.
 */
export async function docFields(
  relPath: string,
): Promise<DocFields | undefined> {
  const abs = resolveDocPath(relPath, [".md", ".json"]);
  const text = await readIfExists(abs);
  return text === undefined
    ? undefined
    : fieldsOf(text, path.extname(abs).toLowerCase());
}

/** A file this generator wrote before frontmatter existed. */
function isLegacyOutput(previous: string, ext: string, meta: DocMeta): boolean {
  if (ext === ".json") {
    try {
      const obj: unknown = JSON.parse(previous);
      return isPlainObject(obj) && "generatedAt" in obj;
    } catch {
      return false;
    }
  }
  return meta.legacy?.test(previous) ?? false;
}

/** Put the `sn_*` fields first in a generated JSON object. */
function withJsonFields(
  relPath: string,
  content: string,
  fields: [string, string][],
): string {
  const obj: unknown = JSON.parse(content);
  if (!isPlainObject(obj)) {
    throw new ServiceNowError(
      `Generated JSON document ${relPath} must be an object.`,
      400,
    );
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of fields)
    out[k] = k === "sn_generated" || k === "sn_partial" ? true : v;
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith("sn_")) out[k] = v;
  }
  return JSON.stringify(out, null, 2);
}

/** Write a file and journal it (L2-04). */
async function persist(abs: string, content: string): Promise<number> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  // L2-04: local file writes are journalled too, so the audit trail covers
  // every side effect of a tool call, not only instance mutations.
  appendWriteJournal({
    action: "local_write",
    table: "local",
    target: `docs/${path.relative(getDocsDir(), abs).split(path.sep).join("/")}`,
    bytes,
    sha256: sha256Hex(content),
  });
  return bytes;
}

/** A streaming write into the docs store (S-11 file delivery). */
export interface DocStream {
  /** The docs-relative path the file lands at on close. */
  readonly path: string;
  /** Append a chunk (UTF-8). */
  write(chunk: string): Promise<void>;
  /** Finish: move the file into place and journal it. */
  close(): Promise<{ path: string; abs: string; bytes: number }>;
  /** Give up: delete the partial file; nothing lands at `path`. */
  abort(): Promise<void>;
}

/**
 * Open a file in the docs store for streaming (S-11 — `format:"file"`
 * exports). Same confinement as docsWriteRaw — lexical containment, portable
 * segments, the symlink check and the write-journal refusal — but the content
 * arrives in chunks, so a large export never sits in memory whole. Chunks go to
 * a sibling `.part` file that is renamed into place on close (a failed or
 * cancelled export leaves nothing at `path`); the close is journalled as a
 * `local_write` with the byte count and sha256, like every docs write. Not
 * size-capped (SN_DOCS_MAX_FILE_BYTES governs `write_doc`), not indexed (the
 * index covers Markdown only), and not exposed as a tool.
 */
export async function openDocStream(
  relPath: string,
  extensions: string[],
): Promise<DocStream> {
  const abs = resolveDocPath(relPath, extensions);
  if (JOURNAL_FILE.test(path.basename(abs))) {
    throw new ServiceNowError(
      `The write journal cannot be written through the docs store: ${relPath}`,
      400,
    );
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Re-check after mkdir: a directory created above cannot be a link, but an
  // existing ancestor could have been swapped for one in the meantime.
  assertRealPathInside(getDocsDir(), abs, relPath);
  const part = `${abs}.${randomBytes(4).toString("hex")}.part`;
  const handle = await fs.open(part, "wx");
  const hash = createHash("sha256");
  let bytes = 0;
  let done = false;
  const finish = async () => {
    if (done) return false;
    done = true;
    await handle.close();
    return true;
  };
  return {
    path: relPath,
    async write(chunk: string) {
      if (done) throw new Error(`Stream already closed: ${relPath}`);
      if (!chunk) return;
      const buf = Buffer.from(chunk, "utf8");
      hash.update(buf);
      bytes += buf.length;
      await handle.write(buf);
    },
    async close() {
      if (!(await finish())) {
        throw new Error(`Stream already closed: ${relPath}`);
      }
      await fs.rename(part, abs);
      appendWriteJournal({
        action: "local_write",
        table: "local",
        target: `docs/${path.relative(getDocsDir(), abs).split(path.sep).join("/")}`,
        bytes,
        sha256: hash.digest("hex"),
      });
      return { path: relPath, abs, bytes };
    },
    async abort() {
      if (!(await finish())) return;
      await fs.rm(part, { force: true });
    },
  };
}
