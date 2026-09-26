import { z } from "zod";
import { sendEmail, getEmail } from "../api/email.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  email,
  longText,
  recipients,
  shortText,
  sysId,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";
import { journaledWrite } from "../core/write-journal.js";

/** Email package: only enabled explicitly or via the `all` profile. */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_send_email",
    title: "Send ServiceNow email",
    description:
      "Send an email through the Email API (plugin must be active), optionally tied to a record (table + sys_id). Recipients must match SN_EMAIL_ALLOWED_DOMAINS or, when that is unset, be users of the instance (sys_user.email).",
    package: "email",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: {
      to: recipients(50).describe("Recipient email addresses (1–50)."),
      subject: shortText(1000).describe("Email subject."),
      body: longText().describe("Plain-text email body."),
      cc: z.array(email()).max(50).optional().describe("CC addresses."),
      bcc: z.array(email()).max(50).optional().describe("BCC addresses."),
      table: tableName()
        .optional()
        .describe("Table of the record to associate the email with."),
      sys_id: sysId()
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
      // The body can be large/sensitive — journal only the envelope.
      const result = await journaledWrite(
        {
          action: "create",
          table: "email",
          fields: { to, subject, recipients: to.length },
        },
        () =>
          sendEmail({
            to,
            subject,
            body,
            cc,
            bcc,
            table,
            sysId: sys_id,
          }),
      );
      return ok({ message: "Email queued", result });
    },
  }),

  defineTool({
    name: "servicenow_get_email",
    title: "Get ServiceNow email",
    description: "Read a sent/received email record by its sys_id (Email API).",
    package: "email",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      sys_id: sysId().describe("sys_id of the email record."),
    },
    handler: async ({ sys_id }) => ok({ result: await getEmail(sys_id) }),
  }),
];
