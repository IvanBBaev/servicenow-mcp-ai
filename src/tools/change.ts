import { z } from "zod";
import {
  listChanges,
  getChange,
  createChange,
  updateChange,
  changeConflicts,
} from "../api/change.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  encodedQuery,
  fieldList,
  sysId,
  type AnyToolSpec,
} from "../mcp/define.js";
import {
  shouldApply,
  planPreview,
  applyInput,
  resultSysId,
  captureBefore,
} from "../mcp/write-mode.js";
import { RESULT_OUTPUT, WRITE_OUTPUT } from "../mcp/output-shapes.js";
import { journaledWrite } from "../core/write-journal.js";

const changeFields = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe('Field name/value pairs, e.g. { "risk": "low" }.');

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_changes",
    title: "List change requests",
    description:
      "List change requests (Change Management API) with an encoded query, fields and paging.",
    package: "change",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      query: encodedQuery()
        .optional()
        .describe("Encoded query (sysparm_query)."),
      fields: fieldList().optional().describe("Columns to return."),
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("Rows (default 10)."),
      offset: z.number().int().nonnegative().optional(),
    },
    output: RESULT_OUTPUT,
    handler: async ({ query, fields, limit, offset }) =>
      ok({ result: await listChanges({ query, fields, limit, offset }) }),
  }),

  defineTool({
    name: "servicenow_get_change",
    title: "Get change request",
    description: "Get a single change request by sys_id.",
    package: "change",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      sys_id: sysId().describe("Change request sys_id."),
    },
    output: RESULT_OUTPUT,
    handler: async ({ sys_id }) => ok({ result: await getChange(sys_id) }),
  }),

  defineTool({
    name: "servicenow_create_change",
    title: "Create change request",
    description:
      "Create a normal, standard or emergency change. Standard changes require a template_id.",
    package: "change",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    legacyParams: { fields: "values" },
    input: {
      type: z
        .enum(["normal", "standard", "emergency"])
        .describe("Change type."),
      template_id: sysId()
        .optional()
        .describe("Template sys_id (required for standard)."),
      values: changeFields.optional(),
      apply: applyInput,
    },
    output: WRITE_OUTPUT,
    logFields: (args) => ({ type: args.type }),
    handler: async ({ type, template_id, values: fields, apply }) => {
      const proposed = {
        type,
        ...(template_id ? { template_id } : {}),
        ...fields,
      };
      if (!shouldApply(apply)) {
        return planPreview({
          action: "create",
          table: "change_request",
          after: proposed,
        });
      }
      const result = await journaledWrite(
        {
          action: "create",
          table: "change_request",
          fields: proposed,
        },
        () =>
          createChange({
            type,
            templateId: template_id,
            fields,
          }),
        (r) => ({ sys_id: resultSysId(r) }),
      );
      return ok({ message: "Change created", result });
    },
  }),

  defineTool({
    name: "servicenow_update_change",
    title: "Update change request",
    description: "Update fields on a change request by sys_id.",
    package: "change",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    legacyParams: { fields: "values" },
    input: {
      sys_id: sysId().describe("Change request sys_id."),
      values: changeFields,
      apply: applyInput,
    },
    output: WRITE_OUTPUT,
    handler: async ({ sys_id, values: fields, apply }) => {
      if (!shouldApply(apply)) {
        const before = await getChange(sys_id);
        return planPreview({
          action: "update",
          table: "change_request",
          sys_id,
          before,
          after: fields,
        });
      }
      const before = await captureBefore(() => getChange(sys_id));
      const result = await journaledWrite(
        {
          action: "update",
          table: "change_request",
          sys_id,
          fields,
          before,
        },
        () => updateChange(sys_id, fields),
      );
      return ok({ message: "Change updated", result });
    },
  }),

  defineTool({
    name: "servicenow_check_change_conflicts",
    title: "Change schedule conflicts",
    description:
      "Read schedule conflicts for a change, or recalculate them (calculate=true). Recalculation is a write: plan/apply like other writes, journaled, blocked in read-only mode.",
    package: "change",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      sys_id: sysId().describe("Change request sys_id."),
      calculate: z
        .boolean()
        .optional()
        .describe("Recalculate (POST) instead of reading."),
      apply: applyInput,
    },
    output: WRITE_OUTPUT,
    // H-3 / H-4: recalculation replaces the change's conflict rows.
    confirm: {
      when: (args) => args.calculate === true,
      target: (args) => ({
        action: "execute",
        table: "conflict",
        sys_id: String(args.sys_id),
      }),
    },
    logFields: (args) => ({ calculate: args.calculate }),
    handler: async ({ sys_id, calculate, apply }) => {
      if (!calculate) {
        return ok({ result: await changeConflicts(sys_id, false) });
      }
      // H-4: a recalculation is a write — preview it in plan mode (with the
      // conflicts it would replace) and journal it when applied.
      if (!shouldApply(apply)) {
        return planPreview({
          action: "execute",
          table: "conflict",
          sys_id,
          before: await changeConflicts(sys_id, false),
        });
      }
      const result = await journaledWrite(
        {
          action: "execute",
          table: "conflict",
          sys_id,
          fields: { calculate: true, change_request: sys_id },
        },
        () => changeConflicts(sys_id, true),
      );
      return ok({ result });
    },
  }),
];
