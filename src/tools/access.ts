import { z } from "zod";
import {
  assertRolePlanCurrent,
  planRoleChange,
  USER_ROLE_TABLE,
} from "../api/access.js";
import { createRecord, deleteRecord } from "../api/table.js";
import { assertTableWriteAllowed, assertWriteAllowed } from "../core/policy.js";
import { currentCall } from "../core/request-context.js";
import { journaledWrite, resultModCount } from "../core/write-journal.js";
import { ok } from "../mcp/result.js";
import { defineTool, sysId, type AnyToolSpec } from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";

/**
 * N-24 (O-17 option B, ADR 0011): opt-in `access` package — grant or revoke
 * one role for one user. Off by default (SN_TOOL_PACKAGES=…,access). Both
 * actions need the plan's single-use plan_token under SN_DESTRUCTIVE_CONFIRM;
 * the plan shows the user's effective roles before and after and binds them
 * into the token (roles that changed after the plan are refused). Privileged
 * and inherited roles are always refused (src/api/access.ts).
 */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_change_access",
    title: "Grant or revoke a user role",
    description:
      "Grant or revoke one role for one user (a direct sys_user_has_role row). The plan shows the effective roles before and after. Privileged roles (admin, security_admin, maint, elevated or containing one) and inherited roles are always refused.",
    package: "access",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    confirm: {
      target: (args) => ({
        action: args.action === "grant" ? "create" : "delete",
        table: USER_ROLE_TABLE,
      }),
    },
    input: {
      user: sysId().describe("sys_user sys_id."),
      role: z
        .string()
        .max(100)
        .regex(/^[A-Za-z0-9_.-]{1,100}$/)
        .describe("Role name, e.g. 'itil'."),
      action: z.enum(["grant", "revoke"]),
      apply: applyInput,
    },
    output: {
      mode: z.string().optional(),
      message: z.string().optional(),
      sys_id: z.string().optional(),
    },
    logFields: (args) => ({ action: args.action, role: args.role }),
    handler: async ({ user, role, action, apply }) => {
      if (shouldApply(apply)) {
        // Read-only mode and the table rails refuse before anything is read.
        assertWriteAllowed(`${action} role`);
        assertTableWriteAllowed(USER_ROLE_TABLE);
      }
      const plan = await planRoleChange(action, user, role);
      const { fingerprint, ...shown } = plan;
      if (!shouldApply(apply)) {
        return planPreview(
          {
            action: action === "grant" ? "create" : "delete",
            table: USER_ROLE_TABLE,
            ...(plan.row ? { sys_id: plan.row } : {}),
            before: { roles: plan.effective.before },
            after: { roles: plan.effective.after },
          },
          shown,
          fingerprint,
        );
      }
      assertRolePlanCurrent(plan, currentCall()?.plan?.binding);
      if (action === "grant") {
        const fields = { user, role: plan.role.sys_id };
        const record = await journaledWrite(
          { action: "create", table: USER_ROLE_TABLE, fields },
          () => createRecord(USER_ROLE_TABLE, fields),
          (r) => ({
            sys_id: typeof r.sys_id === "string" ? r.sys_id : undefined,
            after_mod_count: resultModCount(r),
          }),
        );
        return ok({ message: "Role granted", ...shown, sys_id: record.sys_id });
      }
      const row = plan.row as string;
      await journaledWrite(
        {
          action: "delete",
          table: USER_ROLE_TABLE,
          sys_id: row,
          before: { user, role: plan.role.sys_id },
        },
        () => deleteRecord(USER_ROLE_TABLE, row),
      );
      return ok({ message: "Role revoked", ...shown });
    },
  }),
];
