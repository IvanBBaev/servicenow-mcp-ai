import { z } from "zod";
import {
  listAttachments,
  getAttachmentMeta,
  getWritableAttachmentMeta,
  uploadPrepared,
  downloadAttachment,
  deleteAttachment,
  fetchAttachmentBytes,
  prepareUploadSource,
  describeUpload,
  isTextType,
  type AttachmentMeta,
} from "../api/attachment.js";
import { ok } from "../mcp/result.js";
import { assertTableWriteAllowed } from "../core/policy.js";
import { sha256Hex } from "../core/write-journal.js";
import {
  PREVIEW_CHARS,
  previewOf,
  writeExportBytes,
} from "../mcp/file-result.js";
import {
  defineTool,
  shortText,
  sysId,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";
import {
  shouldApply,
  planPreview,
  applyInput,
  captureBefore,
} from "../mcp/write-mode.js";
import { journaledWrite } from "../core/write-journal.js";

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_attachments",
    title: "List ServiceNow attachments",
    description: "List attachment metadata, optionally for one record.",
    package: "attachment",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      table: tableName().optional().describe("Record table."),
      sys_id: sysId().optional().describe("Record sys_id."),
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, sys_id }) => {
      const records = await listAttachments(table, sys_id);
      return ok({ count: records.length, records });
    },
  }),

  defineTool({
    name: "servicenow_get_attachment",
    title: "Get ServiceNow attachment metadata",
    description: "Read one attachment's metadata.",
    package: "attachment",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    legacyParams: { attachment_sys_id: "sys_id" },
    input: {
      sys_id: sysId().describe("Attachment sys_id."),
    },
    handler: async ({ sys_id }) => ok(await getAttachmentMeta(sys_id)),
  }),

  defineTool({
    name: "servicenow_download_attachment",
    title: "Download ServiceNow attachment",
    description:
      "Download an attachment as base64, or (format 'file') to a file under SN_DOCS_DIR.",
    package: "attachment",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    legacyParams: { attachment_sys_id: "sys_id" },
    input: {
      sys_id: sysId().describe("Attachment sys_id."),
      format: z
        .enum(["base64", "file"])
        .optional()
        .describe("file: write to exports/."),
    },
    handler: async ({ sys_id, format }) => {
      if (format !== "file") return ok(await downloadAttachment(sys_id));
      // N-66: the bytes go to the docs store, never through the chat; a text
      // file still gets the usual preview so the agent can judge the content.
      const { meta, bytes, contentType } = await fetchAttachmentBytes(sys_id);
      const content_type = contentType ?? meta.content_type;
      const delivery = await writeExportBytes(meta.file_name || sys_id, bytes);
      return ok({
        attachment_sys_id: sys_id,
        file_name: meta.file_name,
        content_type,
        sha256: sha256Hex(bytes),
        format: "file",
        ...delivery,
        ...(isTextType(content_type)
          ? previewOf(
              bytes.subarray(0, (PREVIEW_CHARS + 1) * 4).toString("utf8"),
            )
          : {}),
      });
    },
  }),

  defineTool({
    name: "servicenow_upload_attachment",
    title: "Upload ServiceNow attachment",
    description:
      "Attach a file to a record: content_base64 inline, or a local file_path.",
    package: "attachment",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: {
      table: tableName().describe("Record table."),
      sys_id: sysId().describe("Record sys_id."),
      file_name: shortText()
        .optional()
        .describe("File name (default: the file_path leaf)."),
      content_base64: z
        .string()
        .optional()
        .describe("File contents, base64-encoded."),
      file_path: z
        .string()
        .max(1024)
        .optional()
        .describe("Path under SN_DOCS_DIR."),
      content_type: shortText()
        .optional()
        .describe("MIME type (default by extension)."),
      apply: applyInput,
    },
    logFields: (args) => ({
      table: args.table,
      file_name: args.file_name,
      file_path: args.file_path,
    }),
    handler: async ({
      table,
      sys_id,
      file_name,
      content_base64,
      file_path,
      content_type,
      apply,
    }) => {
      const source = {
        fileName: file_name,
        contentBase64: content_base64,
        filePath: file_path,
        contentType: content_type,
      };
      if (!shouldApply(apply)) {
        // Never echo the base64 payload — preview the validated envelope only
        // (sanitised name, effective type, decoded size, sha256). H-11: the
        // preview fails like apply when the parent table is not writable.
        assertTableWriteAllowed(table, "preview");
        const upload = await prepareUploadSource(source);
        return planPreview({
          action: "create",
          table,
          sys_id,
          after: {
            ...describeUpload(upload),
            ...(upload.filePath !== undefined
              ? { file_path: upload.filePath }
              : { base64_chars: content_base64?.length ?? 0 }),
          },
        });
      }
      // The source is validated (and a local file read) before the journal
      // entry, so the entry carries the effective name, type and path.
      const upload = await prepareUploadSource(source);
      const record = await journaledWrite(
        {
          action: "create",
          table,
          sys_id,
          fields: {
            file_name: upload.fileName,
            content_type: upload.contentType,
            ...(upload.filePath !== undefined
              ? { file_path: upload.filePath }
              : {}),
          },
        },
        () => uploadPrepared(table, sys_id, upload),
      );
      return ok({ message: "Attachment uploaded", record });
    },
  }),

  defineTool({
    name: "servicenow_delete_attachment",
    title: "Delete ServiceNow attachment",
    description: "Delete an attachment.",
    package: "attachment",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    confirm: {
      target: (args) => ({
        action: "delete",
        table: "sys_attachment",
        sys_id: String(args.sys_id),
      }),
    },
    legacyParams: { attachment_sys_id: "sys_id" },
    input: {
      sys_id: sysId().describe("Attachment sys_id."),
      apply: applyInput,
    },
    handler: async ({ sys_id, apply }) => {
      if (!shouldApply(apply)) {
        const before = await getWritableAttachmentMeta(sys_id);
        return planPreview({
          action: "delete",
          table: "sys_attachment",
          sys_id,
          before,
        });
      }
      // H-4 (g): one metadata read serves the journal and the policy check.
      const before = (await captureBefore(() =>
        getWritableAttachmentMeta(sys_id),
      )) as AttachmentMeta | undefined;
      const result = await journaledWrite(
        {
          action: "delete",
          table: "sys_attachment",
          sys_id,
          before,
        },
        () => deleteAttachment(sys_id, before),
      );
      return ok({ message: "Attachment deleted", ...result });
    },
  }),
];
