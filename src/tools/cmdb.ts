import { z } from "zod";
import {
  listCmdbInstances,
  getCmdbInstance,
  createCmdbInstance,
  updateCmdbInstance,
  getCmdbMeta,
  listCiRelations,
  identifyCis,
  identifyReconcile,
  type IrePayload,
} from "../api/cmdb.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  encodedQuery,
  shortText,
  sysId,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";
import {
  shouldApply,
  planPreview,
  applyInput,
  resultSysId,
  captureBefore,
} from "../mcp/write-mode.js";
import {
  RESULT_OUTPUT,
  WRITE_OUTPUT,
  listOutput,
} from "../mcp/output-shapes.js";
import { journaledWrite } from "../core/write-journal.js";

/** S-10: the relationship-type bound (e.g. 'Depends on::Used by'). */
const relType = shortText(200);

const ireItems = z
  .array(
    z.object({
      className: tableName().describe("CI class, e.g. 'cmdb_ci_linux_server'."),
      values: z
        .record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.null()]),
        )
        .describe("Identifying and descriptive attributes."),
    }),
  )
  .min(1)
  .max(100)
  .describe("The CIs to identify (IRE payload `items`).");

const ireRelations = z
  .array(
    z.object({
      parent: z
        .number()
        .int()
        .nonnegative()
        .max(99)
        .describe("Index of the parent item in `items`."),
      child: z
        .number()
        .int()
        .nonnegative()
        .max(99)
        .describe("Index of the child item in `items`."),
      type: relType.describe("Relationship type, e.g. 'Runs on::Runs'."),
    }),
  )
  .max(200)
  .optional()
  .describe("Relationships between the items.");

const attributes = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe("CI attribute name/value pairs.");

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_cis",
    title: "List configuration items",
    description:
      "List configuration items of a CMDB class through the class-aware CMDB Instance API.",
    package: "cmdb",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    deprecatedParams: { class_name: "table" },
    input: {
      table: tableName().describe("CMDB class/table, e.g. 'cmdb_ci_server'."),
      query: encodedQuery()
        .optional()
        .describe("Encoded query (sysparm_query)."),
      limit: z.number().int().positive().max(1000).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    output: RESULT_OUTPUT,
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, query, limit, offset }) =>
      ok({
        result: await listCmdbInstances(table, { query, limit, offset }),
      }),
  }),

  defineTool({
    name: "servicenow_get_ci",
    title: "Get configuration item",
    description:
      "Get a CI with its attributes and inbound/outbound relations by class and sys_id.",
    package: "cmdb",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    deprecatedParams: { class_name: "table" },
    input: {
      table: tableName().describe("CI class, e.g. 'cmdb_ci_server'."),
      sys_id: sysId().describe("CI sys_id."),
    },
    output: RESULT_OUTPUT,
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, sys_id }) =>
      ok({ result: await getCmdbInstance(table, sys_id) }),
  }),

  defineTool({
    name: "servicenow_create_ci",
    title: "Create configuration item",
    description:
      "Create a CI via the CMDB Instance API (routed through Identification & Reconciliation).",
    package: "cmdb",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    deprecatedParams: { class_name: "table" },
    legacyParams: { attributes: "values" },
    input: {
      table: tableName().describe("CI class, e.g. 'cmdb_ci_server'."),
      values: attributes,
      source: shortText()
        .optional()
        .describe("IRE discovery source (e.g. 'ServiceNow')."),
      apply: applyInput,
    },
    output: WRITE_OUTPUT,
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, values: attrs, source, apply }) => {
      if (!shouldApply(apply)) {
        return planPreview({
          action: "create",
          table,
          after: { ...attrs, ...(source ? { source } : {}) },
        });
      }
      const result = await journaledWrite(
        {
          action: "create",
          table,
          fields: attrs,
        },
        () =>
          createCmdbInstance({
            className: table,
            attributes: attrs,
            source,
          }),
        (r) => ({ sys_id: resultSysId(r) }),
      );
      return ok({ message: "CI created", result });
    },
  }),

  defineTool({
    name: "servicenow_update_ci",
    title: "Update configuration item",
    description: "Update a CI's attributes via the CMDB Instance API (IRE).",
    package: "cmdb",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    deprecatedParams: { class_name: "table" },
    legacyParams: { attributes: "values" },
    input: {
      table: tableName().describe("CI class, e.g. 'cmdb_ci_server'."),
      sys_id: sysId().describe("CI sys_id."),
      values: attributes,
      source: shortText().optional().describe("Discovery source for IRE."),
      apply: applyInput,
    },
    output: WRITE_OUTPUT,
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, sys_id, values: attrs, source, apply }) => {
      if (!shouldApply(apply)) {
        const before = await getCmdbInstance(table, sys_id);
        return planPreview({
          action: "update",
          table,
          sys_id,
          before,
          after: attrs,
        });
      }
      const before = await captureBefore(() => getCmdbInstance(table, sys_id));
      const result = await journaledWrite(
        {
          action: "update",
          table,
          sys_id,
          fields: attrs,
          before,
        },
        () =>
          updateCmdbInstance(sys_id, {
            className: table,
            attributes: attrs,
            source,
          }),
      );
      return ok({ message: "CI updated", result });
    },
  }),

  defineTool({
    name: "servicenow_get_cmdb_meta",
    title: "Get CMDB class metadata",
    description:
      "Schema of a CMDB class (attributes, relationship rules) from the CMDB Meta API.",
    package: "cmdb",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    deprecatedParams: { class_name: "table" },
    input: {
      table: tableName().describe("CI class, e.g. 'cmdb_ci_server'."),
    },
    output: RESULT_OUTPUT,
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table }) => ok({ result: await getCmdbMeta(table) }),
  }),

  defineTool({
    name: "servicenow_list_ci_relations",
    title: "List CI relationships",
    description:
      "List one CI's relationships (cmdb_rel_ci), outbound = parent, inbound = child, with the related CI's name and class. Filter by direction and type.",
    package: "cmdb",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      sys_id: sysId().describe("CI sys_id."),
      direction: z
        .enum(["both", "outbound", "inbound"])
        .optional()
        .describe("Default both."),
      type: relType
        .optional()
        .describe("Relationship type name ('Depends on::Used by') or sys_id."),
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("Max relationships (default 100)."),
    },
    output: listOutput("relations"),
    handler: async ({ sys_id, direction, type, limit }) =>
      ok(await listCiRelations({ ci: sys_id, direction, type, limit })),
  }),

  defineTool({
    name: "servicenow_identify_reconcile",
    title: "Identify and reconcile CIs (IRE)",
    description:
      "Send CIs and relationships through the Identification & Reconciliation Engine: matched by identification rules, then inserted or updated. The plan preview is identify-only.",
    package: "cmdb",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      items: ireItems,
      relations: ireRelations,
      data_source: shortText(100)
        .optional()
        .describe("sysparm_data_source (default 'ServiceNow')."),
      apply: applyInput,
    },
    output: WRITE_OUTPUT,
    logFields: (args) => ({ items: args.items.length }),
    handler: async ({ items, relations, data_source, apply }) => {
      const payload: IrePayload = {
        items,
        relations,
        dataSource: data_source ?? "ServiceNow",
      };
      if (!shouldApply(apply)) {
        return planPreview(
          {
            action: "execute",
            table: "cmdb_ci",
            after: {
              items,
              ...(relations?.length ? { relations } : {}),
              data_source: payload.dataSource,
            },
          },
          { identification: await identifyCis(payload) },
        );
      }
      const result = await journaledWrite(
        {
          action: "execute",
          table: "cmdb_ci",
          fields: {
            items,
            ...(relations?.length ? { relations } : {}),
            data_source: payload.dataSource,
          },
        },
        () => identifyReconcile(payload),
      );
      return ok({ message: "IRE payload processed", result });
    },
  }),
];
