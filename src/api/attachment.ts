import { snRequest } from "../http.js";
import { assertTableAllowed, assertWriteAllowed } from "../policy.js";
import { getMaxResultChars } from "../settings.js";
import { ServiceNowError } from "../errors.js";
import type { SnRecord } from "../servicenow.js";

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
  if (!Array.isArray(data?.result)) {
    throw new ServiceNowError(
      "Unexpected response from ServiceNow Attachment API: missing 'result' array.",
    );
  }
  return data.result;
}

/** Read a single attachment's metadata by its sys_id. */
export async function getAttachmentMeta(
  attachmentSysId: string,
): Promise<AttachmentMeta> {
  const { data } = await snRequest<{ result: AttachmentMeta }>({
    method: "GET",
    path: `/api/now/attachment/${encodeURIComponent(attachmentSysId)}`,
  });
  if (!data || data.result == null) {
    throw new ServiceNowError(
      "Unexpected response from ServiceNow Attachment API: missing 'result'.",
    );
  }
  return data.result;
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
  let bytes: Buffer;
  try {
    bytes = Buffer.from(args.contentBase64, "base64");
  } catch {
    throw new ServiceNowError("contentBase64 is not valid base64 data.");
  }
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
  if (!data || data.result == null) {
    throw new ServiceNowError(
      "Unexpected response from ServiceNow Attachment API: missing 'result'.",
    );
  }
  return data.result;
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
  const { data, contentType } = await snRequest<string>({
    method: "GET",
    path: `/api/now/attachment/${encodeURIComponent(attachmentSysId)}/file`,
    accept: "*/*",
    responseType: "binary",
  });
  const maxChars = getMaxResultChars();
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
