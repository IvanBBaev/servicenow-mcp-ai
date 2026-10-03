import { z } from "zod";
import {
  listAttachments,
  getAttachmentMeta,
  uploadAttachment,
  downloadAttachment,
  deleteAttachment,
  prepareUpload,
  describeUpload,
  sanitizeFileName,
} from "../api/attachment.js";
import { ok } from "../mcp/result.js";
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
    description:
      "List attachment metadata, optionally scoped to a specific record (table + sys_id).",
    package: "attachment",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      table: tableName()
        .optional()
        .describe("Table the record belongs to, e.g. 'incident'."),
      sys_id: sysId()
        .optional()
        .describe("sys_id of the record whose attachments to list."),
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
    description: "Read a single attachment's metadata by its sys_id.",
    package: "attachment",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    legacyParams: { attachment_sys_id: "sys_id" },
    input: {
      sys_id: sysId().describe("The sys_id of the attachment record."),
    },
    handler: async ({ sys_id }) => ok(await getAttachmentMeta(sys_id)),
  }),

  defineTool({
    name: "servicenow_download_attachment",
    title: "Download ServiceNow attachment",
    description:
      "Download an attachment's bytes, returned as base64. Large files are refused (see SN_MAX_RESULT_CHARS).",
    package: "attachment",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    legacyParams: { attachment_sys_id: "sys_id" },
    input: {
      sys_id: sysId().describe("The sys_id of the attachment to download."),
    },
    handler: async ({ sys_id }) => ok(await downloadAttachment(sys_id)),
  }),

  defineTool({
    name: "servicenow_upload_attachment",
    title: "Upload ServiceNow attachment",
    description:
      "Attach a file (provided as base64) to a record identified by table + sys_id.",
    package: "attachment",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: {
      table: tableName().describe("Table the record belongs to."),
      sys_id: sysId().describe("sys_id of the record to attach to."),
      file_name: shortText().describe("File name to store, e.g. 'log.txt'."),
      content_base64: z.string().describe("File contents, base64-encoded."),
      content_type: shortText()
        .optional()
        .describe("MIME type, e.g. 'text/plain'. Defaults to octet-stream."),
      apply: applyInput,
    },
    logFields: (args) => ({ table: args.table, file_name: args.file_name }),
    handler: async ({
      table,
      sys_id,
      file_name,
      content_base64,
      content_type,
      apply,
    }) => {
      if (!shouldApply(apply)) {
        // Never echo the base64 payload — preview the validated envelope only
        // (sanitised name, effective type, decoded size, sha256).
        const upload = prepareUpload({
          fileName: file_name,
          contentBase64: content_base64,
          contentType: content_type,
        });
        return planPreview({
          action: "create",
          table,
          sys_id,
          after: {
            ...describeUpload(upload),
            base64_chars: content_base64.length,
          },
        });
      }
      const record = await journaledWrite(
        {
          action: "create",
          table,
          sys_id,
          fields: {
            file_name: sanitizeFileName(file_name),
            content_type: content_type ?? "application/octet-stream",
          },
        },
        () =>
          uploadAttachment({
            table,
            sysId: sys_id,
            fileName: file_name,
            contentBase64: content_base64,
            contentType: content_type,
          }),
      );
      return ok({ message: "Attachment uploaded", record });
    },
  }),

  defineTool({
    name: "servicenow_delete_attachment",
    title: "Delete ServiceNow attachment",
    description: "Delete an attachment by its sys_id.",
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
      sys_id: sysId().describe("The sys_id of the attachment to delete."),
      apply: applyInput,
    },
    handler: async ({ sys_id, apply }) => {
      if (!shouldApply(apply)) {
        const before = await getAttachmentMeta(sys_id);
        return planPreview({
          action: "delete",
          table: "sys_attachment",
          sys_id,
          before,
        });
      }
      const before = await captureBefore(() => getAttachmentMeta(sys_id));
      const result = await journaledWrite(
        {
          action: "delete",
          table: "sys_attachment",
          sys_id,
          before,
        },
        () => deleteAttachment(sys_id),
      );
      return ok({ message: "Attachment deleted", ...result });
    },
  }),
];
