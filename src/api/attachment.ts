import { snRequest } from "../core/http.js";
import {
  assertTableAllowed,
  assertTableWriteAllowed,
  assertWriteAllowed,
  isTableAllowed,
} from "../core/policy.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getDocsDir,
  getMaxResultChars,
  getMaxUploadBytes,
  getUploadMimeAllow,
} from "../core/settings.js";
import { ServiceNowError } from "../core/errors.js";
import { errorCode, JOURNAL_FILE, resolveDocPath } from "./docs-paths.js";
import { assertNoCaret, expectResult, expectResultArray } from "./shared.js";
import type { SnRecord } from "./table.js";

/**
 * ServiceNow Attachment API. File contents cross the tool channel as base64,
 * or (N-66) stay on disk: an upload can read a file under SN_DOCS_DIR
 * (`file_path`) and a download can be written there (`format:"file"`), so a
 * binary never has to pass through the model. Inline downloads are
 * size-guarded against SN_MAX_RESULT_CHARS to avoid flooding the client.
 */

export interface AttachmentMeta extends SnRecord {
  sys_id?: string;
  file_name?: string;
  content_type?: string;
  size_bytes?: string;
  table_name?: string;
  table_sys_id?: string;
}

/** List attachment metadata, optionally scoped to a record. */
export async function listAttachments(
  table?: string,
  sysId?: string,
): Promise<AttachmentMeta[]> {
  if (table) assertTableAllowed(table);
  if (table) assertNoCaret(table, "table");
  if (sysId) assertNoCaret(sysId, "sysId");
  const params = new URLSearchParams();
  const clauses: string[] = [];
  if (table) clauses.push(`table_name=${table}`);
  if (sysId) clauses.push(`table_sys_id=${sysId}`);
  if (clauses.length) params.set("sysparm_query", clauses.join("^"));

  const { data } = await snRequest<{ result: AttachmentMeta[] }>({
    method: "GET",
    path: "/api/now/attachment",
    params,
  });
  // H-4: an unscoped list must not surface attachments of a denied table.
  return expectResultArray<AttachmentMeta>(data, "Attachment API").filter(
    (a) => !a.table_name || isTableAllowed(a.table_name),
  );
}

/** Read a single attachment's metadata by its sys_id. */
export async function getAttachmentMeta(
  attachmentSysId: string,
): Promise<AttachmentMeta> {
  const { data } = await snRequest<{ result: AttachmentMeta }>({
    method: "GET",
    path: `/api/now/attachment/${encodeURIComponent(attachmentSysId)}`,
  });
  const meta = expectResult<AttachmentMeta>(data, "Attachment API");
  // H-4: an attachment is governed by the table of the record it hangs on,
  // so get / download / delete cannot reach a denied table's files.
  if (meta.table_name) assertTableAllowed(meta.table_name);
  return meta;
}

/**
 * H-11: adding or removing an attachment is a write to the parent record's
 * table, so the table's write policy (deny/allow lists and the protected-
 * tables default) applies, not only the read check.
 */
export async function getWritableAttachmentMeta(
  attachmentSysId: string,
): Promise<AttachmentMeta> {
  const meta = await getAttachmentMeta(attachmentSysId);
  if (meta.table_name) assertTableWriteAllowed(meta.table_name);
  return meta;
}

/** Standard base64: 4-char groups, '=' padding only at the end. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode base64 strictly. `Buffer.from(s, "base64")` never throws — it
 * silently skips invalid characters — so malformed input must be rejected
 * explicitly or a corrupted file would be uploaded without any error.
 */
function decodeBase64Strict(input: string): Buffer {
  const compact = input.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
    throw new ServiceNowError(
      "contentBase64 is not valid base64 data (check for stray characters or truncation).",
      undefined,
      undefined,
      { code: "INVALID_INPUT" },
    );
  }
  return Buffer.from(compact, "base64");
}

/**
 * Clients often hand over a data URL (`data:image/png;base64,iVBOR...`) where
 * plain base64 is expected (H-8 C-9). Strip the prefix and keep its media type
 * as a fallback content type instead of rejecting the payload as malformed.
 */
const DATA_URL_RE = /^\s*data:([^;,]*)(?:;[^;,]*)*;base64,/i;

function splitDataUrl(input: string): { base64: string; mediaType?: string } {
  const m = DATA_URL_RE.exec(input);
  if (!m) return { base64: input };
  return {
    base64: input.slice(m[0].length),
    ...(m[1] ? { mediaType: m[1] } : {}),
  };
}

// --- upload guards (H-6 / GAP L2-09) ---------------------------------------

/** Longest stored file name, in UTF-8 bytes (common filesystem limit). */
const MAX_FILE_NAME_BYTES = 255;

/**
 * Reduce a caller-supplied file name to a safe leaf name: drop any directory
 * part (`/` or `\`), strip control and bidi-override characters, trim, cap
 * at 255 UTF-8 bytes (keeping a short extension). An empty result, `.` or `..` is refused.
 */
export function sanitizeFileName(raw: string): string {
  const leaf = raw.split(/[/\\]/).pop() ?? "";
  let name = leaf
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  if (Buffer.byteLength(name, "utf8") > MAX_FILE_NAME_BYTES) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    const stem = ext ? name.slice(0, dot) : name;
    const budget = MAX_FILE_NAME_BYTES - Buffer.byteLength(ext, "utf8");
    // Cut on a byte budget, then drop a code point split by the cut.
    const cut = Buffer.from(stem, "utf8")
      .subarray(0, budget)
      .toString("utf8")
      .replace(/\uFFFD+$/, "");
    name = cut + ext;
  }
  if (!name || name === "." || name === "..") {
    throw new ServiceNowError(
      `file_name "${raw.slice(0, 80)}" is empty after removing directory parts and control characters.`,
      undefined,
      undefined,
      { code: "INVALID_INPUT" },
    );
  }
  return name;
}

/**
 * Decoded size of a base64 string, computed from its length without decoding
 * (whitespace ignored, padding subtracted).
 */
export function estimateDecodedBytes(base64: string): number {
  let chars = 0;
  let padding = 0;
  for (let i = 0; i < base64.length; i++) {
    const c = base64.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) continue;
    chars++;
    padding = c === 61 ? padding + 1 : 0; // trailing "="
  }
  return Math.max(0, Math.floor((chars * 3) / 4) - Math.min(padding, 2));
}

/** True when `type` is permitted by an allow-list of exact types or `type/*`. */
function mimeAllowed(type: string, allow: string[]): boolean {
  const t = type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return allow.some((entry) =>
    entry.endsWith("/*") ? t.startsWith(entry.slice(0, -1)) : t === entry,
  );
}

/** A validated upload, ready to send (or to preview). */
export interface PreparedUpload {
  fileName: string;
  contentType: string;
  bytes: Buffer;
  /** The docs-relative source path when the bytes came from a local file. */
  filePath?: string;
}

function uploadTooLarge(bytes: number, max: number, about = false) {
  return new ServiceNowError(
    `Attachment of ${about ? "about " : ""}${bytes} bytes exceeds the SN_MAX_UPLOAD_BYTES limit of ${max}.`,
    undefined,
    undefined,
    {
      code: "PAYLOAD_TOO_LARGE",
      hint: "Upload a smaller file or raise SN_MAX_UPLOAD_BYTES.",
    },
  );
}

function assertMimeAllowed(contentType: string): void {
  const allow = getUploadMimeAllow();
  if (allow.length > 0 && !mimeAllowed(contentType, allow)) {
    throw new ServiceNowError(
      `Content type "${contentType}" is not permitted by SN_UPLOAD_MIME_ALLOW.`,
      undefined,
      undefined,
      {
        code: "MIME_NOT_ALLOWED",
        hint: `Allowed: ${allow.join(", ")}.`,
      },
    );
  }
}

/**
 * Validate an upload before anything is sent: the size cap is checked on the
 * base64 length before decoding (so an oversized payload is never
 * materialised twice), then the name is sanitised, the content type checked
 * against SN_UPLOAD_MIME_ALLOW and the payload strictly decoded.
 */
export function prepareUpload(args: {
  fileName: string;
  contentBase64: string;
  contentType?: string;
}): PreparedUpload {
  const { base64, mediaType } = splitDataUrl(args.contentBase64);
  const max = getMaxUploadBytes();
  const estimated = estimateDecodedBytes(base64);
  if (estimated > max) throw uploadTooLarge(estimated, max, true);
  const fileName = sanitizeFileName(args.fileName);
  const contentType =
    args.contentType || mediaType || "application/octet-stream";
  assertMimeAllowed(contentType);
  return { fileName, contentType, bytes: decodeBase64Strict(base64) };
}

// --- file sources (N-66) ----------------------------------------------------

/** Content types for the extensions an agent commonly hands over. */
const MIME_BY_EXT: Record<string, string> = {
  csv: "text/csv",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  log: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
};

/** The content type a file name's extension implies, if a common one. */
export function guessContentType(fileName: string): string | undefined {
  return MIME_BY_EXT[path.extname(fileName).slice(1).toLowerCase()];
}

function invalidPath(message: string, hint?: string): ServiceNowError {
  return new ServiceNowError(message, undefined, undefined, {
    code: "INVALID_INPUT",
    ...(hint ? { hint } : {}),
  });
}

const FILE_PATH_HINT =
  "file_path is relative to SN_DOCS_DIR (an absolute path must lie inside it).";

/**
 * Resolve an upload source to a file inside SN_DOCS_DIR. The store's
 * confinement applies as for a docs write — lexical containment, portable
 * segments, the symlink check — so the server never reads a file outside
 * the directory the operator exposed, whichever client asks (H-5).
 */
export function resolveUploadPath(filePath: string): {
  abs: string;
  rel: string;
} {
  if (!filePath.trim()) throw invalidPath("file_path is empty.");
  let rel = filePath.trim();
  if (path.isAbsolute(rel)) {
    const inside = path.relative(getDocsDir(), rel);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
      throw new ServiceNowError(
        `Path escapes the docs directory: ${filePath}`,
        400,
        undefined,
        { hint: FILE_PATH_HINT },
      );
    }
    rel = inside;
  }
  const abs = resolveDocPath(rel, [path.extname(rel).toLowerCase()]);
  if (JOURNAL_FILE.test(path.basename(abs))) {
    throw new ServiceNowError(
      `The write journal cannot be uploaded: ${filePath}`,
      400,
    );
  }
  return {
    abs,
    rel: path.relative(getDocsDir(), abs).split(path.sep).join("/"),
  };
}

/**
 * Validate an upload read from a local file (N-66): the path is confined to
 * SN_DOCS_DIR, the size is checked on the stat before the file is read, the
 * name defaults to the file's own and the content type to one its extension
 * implies; the SN_UPLOAD_MIME_ALLOW check is the same as for base64.
 */
export async function prepareUploadFromFile(args: {
  filePath: string;
  fileName?: string;
  contentType?: string;
}): Promise<PreparedUpload> {
  const { abs, rel } = resolveUploadPath(args.filePath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (e) {
    if (errorCode(e) === "ENOENT") {
      throw invalidPath(`File not found: ${rel}`, FILE_PATH_HINT);
    }
    throw e;
  }
  if (!stat.isFile()) throw invalidPath(`Not a regular file: ${rel}`);
  const max = getMaxUploadBytes();
  if (stat.size > max) throw uploadTooLarge(stat.size, max);
  const fileName = sanitizeFileName(args.fileName ?? path.basename(abs));
  const contentType =
    args.contentType ||
    guessContentType(fileName) ||
    "application/octet-stream";
  assertMimeAllowed(contentType);
  const bytes = await fs.readFile(abs);
  // The file may have grown between the stat and the read.
  if (bytes.length > max) throw uploadTooLarge(bytes.length, max);
  return { fileName, contentType, bytes, filePath: rel };
}

/** An upload's source: base64 in the call, or a file under SN_DOCS_DIR. */
export interface UploadSource {
  fileName?: string;
  contentBase64?: string;
  filePath?: string;
  contentType?: string;
}

/** Validate either upload source; exactly one of them must be given. */
export async function prepareUploadSource(
  args: UploadSource,
): Promise<PreparedUpload> {
  const { fileName, contentBase64, filePath, contentType } = args;
  if ((contentBase64 === undefined) === (filePath === undefined)) {
    throw invalidPath(
      "Give exactly one of content_base64 and file_path.",
      FILE_PATH_HINT,
    );
  }
  if (filePath !== undefined) {
    return prepareUploadFromFile({ filePath, fileName, contentType });
  }
  if (fileName === undefined) {
    throw invalidPath("file_name is required with content_base64.");
  }
  return prepareUpload({
    fileName,
    contentBase64: contentBase64 as string,
    contentType,
  });
}

/** The envelope a plan preview shows for an upload — never the payload. */
export function describeUpload(p: PreparedUpload): {
  file_name: string;
  content_type: string;
  bytes: number;
  sha256: string;
} {
  return {
    file_name: p.fileName,
    content_type: p.contentType,
    bytes: p.bytes.length,
    sha256: createHash("sha256").update(p.bytes).digest("hex"),
  };
}

/**
 * Send a prepared upload and attach it to a record. A 0-byte file is a legal
 * upload (empty body). The file name travels in the `file_name` query
 * parameter, percent-encoded as UTF-8, so non-ASCII names round-trip.
 */
export async function uploadPrepared(
  table: string,
  sysId: string,
  upload: PreparedUpload,
): Promise<AttachmentMeta> {
  // H-11: an upload is a write to the parent record's table.
  assertTableWriteAllowed(table);
  assertWriteAllowed("attachment upload");
  const params = new URLSearchParams({
    table_name: table,
    table_sys_id: sysId,
    file_name: upload.fileName,
  });
  const { data } = await snRequest<{ result: AttachmentMeta }>({
    method: "POST",
    path: "/api/now/attachment/file",
    params,
    rawBody: upload.bytes,
    contentType: upload.contentType,
  });
  return expectResult(data, "Attachment API");
}

/**
 * Upload a file (base64, or a path under SN_DOCS_DIR) and attach it to a
 * record. The source passes prepareUploadSource first (size cap, name,
 * content type, path confinement).
 */
export async function uploadAttachment(
  args: UploadSource & { table: string; sysId: string },
): Promise<AttachmentMeta> {
  assertTableWriteAllowed(args.table);
  assertWriteAllowed("attachment upload");
  return uploadPrepared(
    args.table,
    args.sysId,
    await prepareUploadSource(args),
  );
}

export interface AttachmentDownload {
  attachmentSysId: string;
  contentType?: string;
  /** Decoded byte count (0 for an empty file). */
  sizeBytes: number;
  base64: string;
}

/** Download an attachment's bytes as base64, guarded against oversized payloads. */
export async function downloadAttachment(
  attachmentSysId: string,
): Promise<AttachmentDownload> {
  const maxChars = getMaxResultChars();

  // Check the recorded size first, so an oversized file is refused without
  // ever pulling its bytes into memory.
  const meta = await getAttachmentMeta(attachmentSysId);
  const sizeBytes = Number(meta.size_bytes);
  if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
    const estBase64Chars = Math.ceil(sizeBytes / 3) * 4;
    if (estBase64Chars > maxChars) {
      throw new ServiceNowError(
        `Attachment ${meta.file_name ?? attachmentSysId} is too large to return inline (~${estBase64Chars} base64 chars > ${maxChars}). Increase SN_MAX_RESULT_CHARS or download it out of band.`,
        undefined,
        undefined,
        { code: "RESPONSE_TOO_LARGE" },
      );
    }
  }

  const { data, contentType } = await snRequest<string>({
    method: "GET",
    path: `/api/now/attachment/${encodeURIComponent(attachmentSysId)}/file`,
    accept: "*/*",
    responseType: "binary",
  });
  // Belt-and-braces: size_bytes can be missing or stale on the instance.
  // base64 inflates by 4/3 (rounded up to a 4-char group): a file of exactly
  // SN_MAX_RESULT_CHARS base64 chars is returned, one group more is refused.
  if (data.length > maxChars) {
    throw new ServiceNowError(
      `Attachment is too large to return inline (${data.length} base64 chars > ${maxChars}). Increase SN_MAX_RESULT_CHARS or download it out of band.`,
      undefined,
      undefined,
      { code: "RESPONSE_TOO_LARGE" },
    );
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const decodedBytes = (data.length / 4) * 3 - padding;
  return {
    attachmentSysId,
    contentType,
    sizeBytes: decodedBytes,
    base64: data,
  };
}

/**
 * N-66: an attachment's raw bytes for a file delivery. No inline cap applies
 * (the bytes go to disk, not to the chat); the response is still bounded by
 * SN_MAX_BODY_BYTES like every other.
 */
export async function fetchAttachmentBytes(attachmentSysId: string): Promise<{
  meta: AttachmentMeta;
  bytes: Buffer;
  contentType?: string;
}> {
  const meta = await getAttachmentMeta(attachmentSysId); // H-4 policy check
  const { data, contentType } = await snRequest<string>({
    method: "GET",
    path: `/api/now/attachment/${encodeURIComponent(attachmentSysId)}/file`,
    accept: "*/*",
    responseType: "binary",
  });
  return { meta, bytes: Buffer.from(data, "base64"), contentType };
}

/** True for content a text preview makes sense of (text/*, JSON, XML...). */
export function isTextType(contentType: string | undefined): boolean {
  const t = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    t.startsWith("text/") ||
    /^application\/(json|xml|javascript|x-ndjson|yaml|x-yaml)$/.test(t) ||
    /\+(json|xml)$/.test(t)
  );
}

/** Delete an attachment by its sys_id. */
export async function deleteAttachment(
  attachmentSysId: string,
  /** Metadata already returned by {@link getWritableAttachmentMeta}; skips a second read. */
  checked?: AttachmentMeta,
): Promise<{ deleted: true; sys_id: string }> {
  assertWriteAllowed("attachment delete");
  // H-4 / H-11: read the metadata first so the parent table's write policy
  // applies before the DELETE is sent.
  if (checked?.sys_id !== attachmentSysId) {
    await getWritableAttachmentMeta(attachmentSysId);
  }
  await snRequest<unknown>({
    method: "DELETE",
    path: `/api/now/attachment/${encodeURIComponent(attachmentSysId)}`,
  });
  return { deleted: true, sys_id: attachmentSysId };
}
