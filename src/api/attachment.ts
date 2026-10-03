import { snRequest } from "../core/http.js";
import {
  assertTableAllowed,
  assertWriteAllowed,
  isTableAllowed,
} from "../core/policy.js";
import { createHash } from "node:crypto";
import {
  getMaxResultChars,
  getMaxUploadBytes,
  getUploadMimeAllow,
} from "../core/settings.js";
import { ServiceNowError } from "../core/errors.js";
import { assertNoCaret, expectResult, expectResultArray } from "./shared.js";
import type { SnRecord } from "./table.js";

/**
 * ServiceNow Attachment API. File contents cross the wire as base64 so they
 * fit the text-only tool channel; downloads are size-guarded against
 * SN_MAX_RESULT_CHARS to avoid flooding the client.
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
  if (estimated > max) {
    throw new ServiceNowError(
      `Attachment of about ${estimated} bytes exceeds the SN_MAX_UPLOAD_BYTES limit of ${max}.`,
      undefined,
      undefined,
      {
        code: "PAYLOAD_TOO_LARGE",
        hint: "Upload a smaller file or raise SN_MAX_UPLOAD_BYTES.",
      },
    );
  }
  const fileName = sanitizeFileName(args.fileName);
  const contentType =
    args.contentType || mediaType || "application/octet-stream";
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
  return { fileName, contentType, bytes: decodeBase64Strict(base64) };
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
 * Upload a file (given as base64) and attach it to a record. A 0-byte file is
 * a legal upload (empty body). The file name travels in the `file_name` query
 * parameter, percent-encoded as UTF-8, so non-ASCII names round-trip. The
 * payload passes prepareUpload first (size cap, name, content type).
 */
export async function uploadAttachment(args: {
  table: string;
  sysId: string;
  fileName: string;
  contentBase64: string;
  contentType?: string;
}): Promise<AttachmentMeta> {
  assertTableAllowed(args.table);
  assertWriteAllowed("attachment upload");
  const upload = prepareUpload(args);
  const params = new URLSearchParams({
    table_name: args.table,
    table_sys_id: args.sysId,
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

/** Delete an attachment by its sys_id. */
export async function deleteAttachment(
  attachmentSysId: string,
): Promise<{ deleted: true; sys_id: string }> {
  assertWriteAllowed("attachment delete");
  // H-4: read the metadata first so the parent table's policy applies.
  await getAttachmentMeta(attachmentSysId);
  await snRequest<unknown>({
    method: "DELETE",
    path: `/api/now/attachment/${encodeURIComponent(attachmentSysId)}`,
  });
  return { deleted: true, sys_id: attachmentSysId };
}
