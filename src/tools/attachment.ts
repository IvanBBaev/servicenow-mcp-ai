import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listAttachments,
  getAttachmentMeta,
  uploadAttachment,
  downloadAttachment,
  deleteAttachment,
} from "../api/attachment.js";
import { ok } from "../mcp/result.js";
import { runTool } from "./util.js";

export function registerAttachmentTools(server: McpServer): void {
  server.registerTool(
    "servicenow_list_attachments",
    {
      title: "List ServiceNow attachments",
      description:
        "List attachment metadata, optionally scoped to a specific record (table + sys_id).",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        table: z
          .string()
          .optional()
          .describe("Table the record belongs to, e.g. 'incident'."),
        sys_id: z
          .string()
          .optional()
          .describe("sys_id of the record whose attachments to list."),
      },
    },
    async ({ table, sys_id }) =>
      runTool("servicenow_list_attachments", { table }, async () => {
        const records = await listAttachments(table, sys_id);
        return ok({ count: records.length, records });
      }),
  );

  server.registerTool(
    "servicenow_get_attachment",
    {
      title: "Get ServiceNow attachment metadata",
      description: "Read a single attachment's metadata by its sys_id.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        attachment_sys_id: z
          .string()
          .describe("The sys_id of the attachment record."),
      },
    },
    async ({ attachment_sys_id }) =>
      runTool("servicenow_get_attachment", {}, async () => {
        const record = await getAttachmentMeta(attachment_sys_id);
        return ok(record);
      }),
  );

  server.registerTool(
    "servicenow_download_attachment",
    {
      title: "Download ServiceNow attachment",
      description:
        "Download an attachment's bytes, returned as base64. Large files are refused (see SN_MAX_RESULT_CHARS).",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        attachment_sys_id: z
          .string()
          .describe("The sys_id of the attachment to download."),
      },
    },
    async ({ attachment_sys_id }) =>
      runTool("servicenow_download_attachment", {}, async () => {
        const file = await downloadAttachment(attachment_sys_id);
        return ok(file);
      }),
  );

  server.registerTool(
    "servicenow_upload_attachment",
    {
      title: "Upload ServiceNow attachment",
      description:
        "Attach a file (provided as base64) to a record identified by table + sys_id.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        table: z.string().describe("Table the record belongs to."),
        sys_id: z.string().describe("sys_id of the record to attach to."),
        file_name: z.string().describe("File name to store, e.g. 'log.txt'."),
        content_base64: z.string().describe("File contents, base64-encoded."),
        content_type: z
          .string()
          .optional()
          .describe("MIME type, e.g. 'text/plain'. Defaults to octet-stream."),
      },
    },
    async ({ table, sys_id, file_name, content_base64, content_type }) =>
      runTool("servicenow_upload_attachment", { table, file_name }, async () => {
        const record = await uploadAttachment({
          table,
          sysId: sys_id,
          fileName: file_name,
          contentBase64: content_base64,
          contentType: content_type,
        });
        return ok({ message: "Attachment uploaded", record });
      }),
  );

  server.registerTool(
    "servicenow_delete_attachment",
    {
      title: "Delete ServiceNow attachment",
      description: "Delete an attachment by its sys_id.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        attachment_sys_id: z
          .string()
          .describe("The sys_id of the attachment to delete."),
      },
    },
    async ({ attachment_sys_id }) =>
      runTool("servicenow_delete_attachment", {}, async () => {
        const result = await deleteAttachment(attachment_sys_id);
        return ok({ message: "Attachment deleted", ...result });
      }),
  );
}
