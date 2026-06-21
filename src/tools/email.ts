import { z } from "zod";
import { sendEmail, getEmail } from "../api/email.js";
import { ok } from "../mcp/result.js";
import { defineTool, type AnyToolSpec } from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";
import { appendWriteJournal } from "../core/write-journal.js";

/** Email package: only enabled explicitly or via the `all` profile. */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_send_email",
    title: "Send ServiceNow email",
    description:
      "Send an email through the instance's Email API, optionally associated with a record (table + sys_id). Requires the Email API plugin to be active.",
    package: "email",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: {
      to: z.array(z.string()).min(1).describe("Recipient email addresses."),
      subject: z.string().describe("Email subject."),
      body: z.string().describe("Plain-text email body."),
      cc: z.array(z.string()).optional().describe("CC addresses."),
      bcc: z.array(z.string()).optional().describe("BCC addresses."),
      table: z
        .string()
        .optional()
        .describe("Table of the record to associate the email with."),
      sys_id: z
        .string()
        .optional()
        .describe("sys_id of the record to associate the email with."),
      apply: applyInput,
    },
    logFields: (args) => ({ recipients: args.to.length, table: args.table }),
    handler: async ({ to, subject, body, cc, bcc, table, sys_id, apply }) => {
      if (!shouldApply(apply)) {
        return planPreview({
          action: "create",
          table: "email",
          after: {
            to,
            subject,
            ...(cc ? { cc } : {}),
            ...(bcc ? { bcc } : {}),
            body,
            ...(table && sys_id ? { record: `${table}/${sys_id}` } : {}),
          },
        });
      }
      const result = await sendEmail({
        to,
        subject,
        body,
        cc,
        bcc,
        table,
        sysId: sys_id,
      });
      // The body can be large/sensitive — journal only the envelope.
      appendWriteJournal({
        action: "create",
        table: "email",
        fields: { to, subject, recipients: to.length },
      });
      return ok({ message: "Email queued", result });
    },
  }),

  defineTool({
    name: "servicenow_get_email",
    title: "Get ServiceNow email",
    description: "Read a sent/received email record by its sys_id (Email API).",
    package: "email",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      sys_id: z.string().describe("sys_id of the email record."),
    },
    handler: async ({ sys_id }) => ok({ result: await getEmail(sys_id) }),
  }),
];
