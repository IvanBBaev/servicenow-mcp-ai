import { snRequest } from "../core/http.js";
import { assertTableAllowed, assertWriteAllowed } from "../core/policy.js";
import { getMaxResultChars } from "../core/settings.js";
import { ServiceNowError } from "../core/errors.js";
import { expectResult, expectResultArray } from "./shared.js";
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
  return expectResultArray(data, "Attachment API");
}

/** Read a single attachment's metadata by its sys_id. */
export async function getAttachmentMeta(
  attachmentSysId: string,
): Promise<AttachmentMeta> {
  const { data } = await snRequest<{ result: AttachmentMeta }>({
    method: "GET",
    path: `/api/now/attachment/${encodeURIComponent(attachmentSysId)}`,
  });
  return expectResult(data, "Attachment API");
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
    );
  }
  return Buffer.from(compact, "base64");
}

/** Upload a file (given as base64) and attach it to a record. */
export async function uploadAttachment(args: {
  table: string;
  sysId: string;
  fileName: string;
  contentBase64: string;
  contentType?: string;
}): Promise<AttachmentMeta> {
  assertTableAllowed(args.table);
  assertWriteAllowed("attachment upload");
  const bytes = decodeBase64Strict(args.contentBase64);
  const params = new URLSearchParams({
    table_name: args.table,
    table_sys_id: args.sysId,
    file_name: args.fileName,
  });
  const { data } = await snRequest<{ result: AttachmentMeta }>({
    method: "POST",
    path: "/api/now/attachment/file",
    params,
    rawBody: bytes,
    contentType: args.contentType || "application/octet-stream",
  });
  return expectResult(data, "Attachment API");
}

export interface AttachmentDownload {
  attachmentSysId: string;
  contentType?: string;
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
  if (data.length > maxChars) {
    throw new ServiceNowError(
      `Attachment is too large to return inline (${data.length} base64 chars > ${maxChars}). Increase SN_MAX_RESULT_CHARS or download it out of band.`,
    );
  }
  return { attachmentSysId, contentType, base64: data };
}

/** Delete an attachment by its sys_id. */
export async function deleteAttachment(
  attachmentSysId: string,
): Promise<{ deleted: true; sys_id: string }> {
  assertWriteAllowed("attachment delete");
  await snRequest<unknown>({
    method: "DELETE",
    path: `/api/now/attachment/${encodeURIComponent(attachmentSysId)}`,
  });
  return { deleted: true, sys_id: attachmentSysId };
}
