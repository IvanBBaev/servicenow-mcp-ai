import { z } from "zod";
import { lookupDirectory } from "../api/directory.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  shortText,
  sysId,
  type AnyToolSpec,
} from "../mcp/define.js";
import { listOutput } from "../mcp/output-shapes.js";

/**
 * S-10 — opt-in `directory` package: read-only user / group / role lookups.
 * A package of its own so SN_PACKAGES_DENY=directory removes the user-data
 * (PII) surface without touching anything else.
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
];
