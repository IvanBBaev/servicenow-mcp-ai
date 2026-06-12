import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listCatalogs,
  listCatalogCategories,
  listCatalogItems,
  getCatalogItem,
  orderCatalogItem,
} from "../api/catalog.js";
import { ok } from "../mcp/result.js";
import { runTool } from "./util.js";

export function registerCatalogTools(server: McpServer): void {
  server.registerTool(
    "servicenow_list_catalogs",
    {
      title: "List service catalogs",
      description:
        "List the Service Catalogs available on the instance (Service Catalog API).",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () =>
      runTool("servicenow_list_catalogs", {}, async () => {
        const result = await listCatalogs();
        return ok({ result });
      }),
  );

  server.registerTool(
    "servicenow_list_catalog_categories",
    {
      title: "List catalog categories",
      description: "List the categories within a service catalog.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        catalog_sys_id: z.string().describe("sys_id of the catalog."),
      },
    },
    async ({ catalog_sys_id }) =>
      runTool("servicenow_list_catalog_categories", {}, async () => {
        const result = await listCatalogCategories(catalog_sys_id);
        return ok({ result });
      }),
  );

  server.registerTool(
    "servicenow_list_catalog_items",
    {
      title: "List catalog items",
      description:
        "Search/list orderable catalog items, optionally by text or category.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        text: z.string().optional().describe("Free-text search filter."),
        category: z
          .string()
          .optional()
          .describe("Restrict to a category sys_id."),
        limit: z.number().int().positive().max(100).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async ({ text, category, limit, offset }) =>
      runTool("servicenow_list_catalog_items", {}, async () => {
        const result = await listCatalogItems({ text, category, limit, offset });
        return ok({ result });
      }),
  );

  server.registerTool(
    "servicenow_get_catalog_item",
    {
      title: "Get catalog item",
      description:
        "Get a catalog item, including its order variables, by sys_id.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        item_sys_id: z.string().describe("sys_id of the catalog item."),
      },
    },
    async ({ item_sys_id }) =>
      runTool("servicenow_get_catalog_item", {}, async () => {
        const result = await getCatalogItem(item_sys_id);
        return ok({ result });
      }),
  );

  server.registerTool(
    "servicenow_order_catalog_item",
    {
      title: "Order catalog item",
      description:
        "Order a catalog item directly ('order now'). Creates a request/RITM. Provide variable values keyed by their names.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
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
      },
    },
    async ({ item_sys_id, quantity, variables }) =>
      runTool("servicenow_order_catalog_item", {}, async () => {
        const result = await orderCatalogItem({
          itemSysId: item_sys_id,
          quantity,
          variables,
        });
        return ok({ message: "Order submitted", result });
      }),
  );
}
