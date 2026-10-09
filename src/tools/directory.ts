import { z } from "zod";
import {
  ACCESS_OPERATIONS,
  explainAccess,
  renderAccessExplanation,
  renderAccessMermaid,
} from "../api/access-explain.js";
import { lookupDirectory } from "../api/directory.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  fieldName,
  shortText,
  sysId,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";
import { listOutput } from "../mcp/output-shapes.js";

/**
 * S-10 — opt-in `directory` package: read-only user / group / role lookups.
 * A package of its own so SN_PACKAGES_DENY=directory removes the user-data
 * (PII) surface without touching anything else. N-2's access explainer
 * reads another user's roles too, so it lives here (O-13).
 */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_lookup_directory",
    title: "Look up users, groups and roles",
    description:
      "Find users, groups or roles by search term or sys_id. With include_details and one match: a user's roles and groups, a group's members and roles, or a role's contained roles and granting groups.",
    package: "directory",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      kind: z.enum(["user", "group", "role"]).describe("What to look up."),
      term: shortText(100)
        .optional()
        .describe(
          "user_name / email prefix or name fragment (users); name fragment (groups, roles).",
        ),
      sys_id: sysId().optional().describe("Exact sys_id."),
      active: z
        .boolean()
        .optional()
        .describe("Filter users / groups by active."),
      include_details: z
        .boolean()
        .optional()
        .describe("Add roles, groups, members when one record matches."),
      role_history: z
        .boolean()
        .optional()
        .describe(
          "Users only: add the user's role grants and revokes (last 90 days), newest first, when one user matches.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe("Max records (default 20)."),
    },
    output: listOutput("records"),
    logFields: (args) => ({ kind: args.kind }),
    handler: async ({
      kind,
      term,
      sys_id,
      active,
      include_details,
      role_history,
      limit,
    }) =>
      ok(
        await lookupDirectory({
          kind,
          term,
          sysId: sys_id,
          active,
          includeDetails: include_details,
          roleHistory: role_history,
          limit,
        }),
      ),
  }),

  defineTool({
    name: "servicenow_explain_access",
    title: "Explain a user's access",
    description:
      "Why a user can or cannot read, write, create or delete a table, record or field: roles, the matching row/field ACLs and their role, condition and script parts. Scripts stay undetermined.",
    package: "directory",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      user: shortText(100).describe("user_name or sys_id."),
      table: tableName().describe("Table."),
      operation: z.enum(ACCESS_OPERATIONS).describe("Operation."),
      sys_id: sysId()
        .optional()
        .describe("Record; conditions run as the connected user."),
      field: fieldName().optional().describe("Field ACL too."),
      format: z
        .enum(["json", "markdown"])
        .optional()
        .describe("json (default) or markdown report + Mermaid."),
    },
    output: {
      available: z.boolean(),
      decision: z.enum(["granted", "denied", "undetermined"]),
    },
    logFields: (args) => ({
      table: args.table,
      operation: args.operation,
      format: args.format,
    }),
    handler: async ({ user, table, operation, sys_id, field, format }) => {
      const result = await explainAccess({
        user,
        table,
        operation,
        sysId: sys_id,
        field,
      });
      if (format !== "markdown") return ok(result);
      const mermaid = renderAccessMermaid(result);
      const lines = renderAccessExplanation(result);
      if (mermaid) lines.push("", "```mermaid", mermaid, "```");
      return ok({
        decision: result.decision,
        available: result.available,
        markdown: lines.join("\n"),
      });
    },
  }),
];
