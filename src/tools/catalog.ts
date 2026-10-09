import { z } from "zod";
import {
  listCatalogs,
  listCatalogCategories,
  listCatalogItems,
  getCatalogItem,
  orderCatalogItem,
} from "../api/catalog.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  shortText,
  sysId,
  type AnyToolSpec,
} from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";
import { RESULT_OUTPUT, WRITE_OUTPUT } from "../mcp/output-shapes.js";
import { journaledWrite } from "../core/write-journal.js";

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_catalogs",
    title: "List service catalogs",
    description:
      "List the Service Catalogs available on the instance (Service Catalog API).",
    package: "catalog",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {},
    output: RESULT_OUTPUT,
    handler: async () => ok({ result: await listCatalogs() }),
  }),

  defineTool({
    name: "servicenow_list_catalog_categories",
    title: "List catalog categories",
    description: "List the categories within a service catalog.",
    package: "catalog",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    legacyParams: { catalog_sys_id: "sys_id" },
    input: {
      sys_id: sysId().describe("Catalog sys_id."),
    },
    output: RESULT_OUTPUT,
    handler: async ({ sys_id }) =>
      ok({ result: await listCatalogCategories(sys_id) }),
  }),

  defineTool({
    name: "servicenow_list_catalog_items",
    title: "List catalog items",
    description:
      "Search/list orderable catalog items, optionally by text or category.",
    package: "catalog",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      text: shortText(1000).optional().describe("Free-text search filter."),
      category: shortText().optional().describe("Category sys_id."),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    output: RESULT_OUTPUT,
    handler: async ({ text, category, limit, offset }) =>
      ok({ result: await listCatalogItems({ text, category, limit, offset }) }),
  }),

  defineTool({
    name: "servicenow_get_catalog_item",
    title: "Get catalog item",
    description:
      "Get a catalog item, including its order variables, by sys_id.",
    package: "catalog",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    legacyParams: { item_sys_id: "sys_id" },
    input: {
      sys_id: sysId().describe("Catalog item sys_id."),
    },
    output: RESULT_OUTPUT,
    handler: async ({ sys_id }) => ok({ result: await getCatalogItem(sys_id) }),
  }),

  defineTool({
    name: "servicenow_order_catalog_item",
    title: "Order catalog item",
    description:
      "Order a catalog item directly ('order now'). Creates a request/RITM. Provide variable values keyed by their names.",
    package: "catalog",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    output: WRITE_OUTPUT,
    confirm: {
      target: (args) => ({
        action: "create",
        table: "sc_request",
        fields: { item: args.sys_id, quantity: args.quantity ?? 1 },
      }),
    },
    legacyParams: { item_sys_id: "sys_id" },
    input: {
      sys_id: sysId().describe("Catalog item sys_id."),
      quantity: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Quantity to order (default 1)."),
      variables: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Variable name/value pairs."),
      apply: applyInput,
    },
    handler: async ({ sys_id, quantity, variables, apply }) => {
      if (!shouldApply(apply)) {
        return planPreview({
          action: "create",
          table: "sc_request",
          after: {
            item: sys_id,
            quantity: quantity ?? 1,
            ...(variables ? { variables } : {}),
          },
        });
      }
      const result = await journaledWrite(
        {
          action: "create",
          table: "sc_request",
          fields: { item: sys_id, quantity: quantity ?? 1 },
        },
        () =>
          orderCatalogItem({
            itemSysId: sys_id,
            quantity,
            variables,
          }),
      );
      return ok({ message: "Order submitted", result });
    },
  }),
];
