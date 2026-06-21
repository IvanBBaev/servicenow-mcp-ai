import { z } from "zod";
import {
  listCatalogs,
  listCatalogCategories,
  listCatalogItems,
  getCatalogItem,
  orderCatalogItem,
} from "../api/catalog.js";
import { ok } from "../mcp/result.js";
import { defineTool, type AnyToolSpec } from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";
import { appendWriteJournal } from "../core/write-journal.js";

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_catalogs",
    title: "List service catalogs",
    description:
      "List the Service Catalogs available on the instance (Service Catalog API).",
    package: "catalog",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {},
    handler: async () => ok({ result: await listCatalogs() }),
  }),

  defineTool({
    name: "servicenow_list_catalog_categories",
    title: "List catalog categories",
    description: "List the categories within a service catalog.",
    package: "catalog",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      catalog_sys_id: z.string().describe("sys_id of the catalog."),
    },
    handler: async ({ catalog_sys_id }) =>
      ok({ result: await listCatalogCategories(catalog_sys_id) }),
  }),

  defineTool({
    name: "servicenow_list_catalog_items",
    title: "List catalog items",
    description:
      "Search/list orderable catalog items, optionally by text or category.",
    package: "catalog",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      text: z.string().optional().describe("Free-text search filter."),
      category: z
        .string()
        .optional()
        .describe("Restrict to a category sys_id."),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    handler: async ({ text, category, limit, offset }) =>
      ok({ result: await listCatalogItems({ text, category, limit, offset }) }),
  }),

  defineTool({
    name: "servicenow_get_catalog_item",
    title: "Get catalog item",
    description:
      "Get a catalog item, including its order variables, by sys_id.",
    package: "catalog",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      item_sys_id: z.string().describe("sys_id of the catalog item."),
    },
    handler: async ({ item_sys_id }) =>
      ok({ result: await getCatalogItem(item_sys_id) }),
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
    input: {
      item_sys_id: z.string().describe("sys_id of the catalog item."),
      quantity: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Quantity to order (default 1)."),
      variables: z
        .record(z.unknown())
        .optional()
        .describe("Variable name/value pairs for the item."),
      apply: applyInput,
    },
    handler: async ({ item_sys_id, quantity, variables, apply }) => {
      if (!shouldApply(apply)) {
        return planPreview({
          action: "create",
          table: "sc_request",
          after: {
            item: item_sys_id,
            quantity: quantity ?? 1,
            ...(variables ? { variables } : {}),
          },
        });
      }
      const result = await orderCatalogItem({
        itemSysId: item_sys_id,
        quantity,
        variables,
      });
      appendWriteJournal({
        action: "create",
        table: "sc_request",
        fields: { item: item_sys_id, quantity: quantity ?? 1 },
      });
      return ok({ message: "Order submitted", result });
    },
  }),
];
