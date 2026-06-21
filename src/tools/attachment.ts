import { z } from "zod";
import {
  listAttachments,
  getAttachmentMeta,
  uploadAttachment,
  downloadAttachment,
  deleteAttachment,
} from "../api/attachment.js";
import { ok } from "../mcp/result.js";
import { defineTool, type AnyToolSpec } from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";
import { appendWriteJournal } from "../core/write-journal.js";

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_attachments",
    title: "List ServiceNow attachments",
    description:
      "List attachment metadata, optionally scoped to a specific record (table + sys_id).",
    package: "attachment",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      table: z
        .string()
        .optional()
        .describe("Table the record belongs to, e.g. 'incident'."),
      sys_id: z
        .string()
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
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      attachment_sys_id: z
        .string()
        .describe("The sys_id of the attachment record."),
    },
    handler: async ({ attachment_sys_id }) =>
      ok(await getAttachmentMeta(attachment_sys_id)),
  }),

  defineTool({
    name: "servicenow_download_attachment",
    title: "Download ServiceNow attachment",
    description:
      "Download an attachment's bytes, returned as base64. Large files are refused (see SN_MAX_RESULT_CHARS).",
    package: "attachment",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      attachment_sys_id: z
        .string()
        .describe("The sys_id of the attachment to download."),
    },
    handler: async ({ attachment_sys_id }) =>
      ok(await downloadAttachment(attachment_sys_id)),
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
      table: z.string().describe("Table the record belongs to."),
      sys_id: z.string().describe("sys_id of the record to attach to."),
      file_name: z.string().describe("File name to store, e.g. 'log.txt'."),
      content_base64: z.string().describe("File contents, base64-encoded."),
      content_type: z
        .string()
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
        // Never echo the base64 payload — preview the envelope only.
        return planPreview({
          action: "create",
          table,
          sys_id,
          after: {
            file_name,
            content_type: content_type ?? "application/octet-stream",
            base64_chars: content_base64.length,
          },
        });
      }
      const record = await uploadAttachment({
        table,
        sysId: sys_id,
        fileName: file_name,
        contentBase64: content_base64,
        contentType: content_type,
      });
      appendWriteJournal({
        action: "create",
        table,
        sys_id,
        fields: {
          file_name,
          content_type: content_type ?? "application/octet-stream",
        },
      });
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
    input: {
      attachment_sys_id: z
        .string()
        .describe("The sys_id of the attachment to delete."),
      apply: applyInput,
    },
    handler: async ({ attachment_sys_id, apply }) => {
      if (!shouldApply(apply)) {
        const before = await getAttachmentMeta(attachment_sys_id);
        return planPreview({
          action: "delete",
          table: "sys_attachment",
          sys_id: attachment_sys_id,
          before,
        });
      }
      const result = await deleteAttachment(attachment_sys_id);
      appendWriteJournal({
        action: "delete",
        table: "sys_attachment",
        sys_id: attachment_sys_id,
      });
      return ok({ message: "Attachment deleted", ...result });
    },
  }),
];
