import { snRequest } from "../core/http.js";
import { assertWriteAllowed, assertTableAllowed } from "../core/policy.js";
import { expectResult, snParams } from "./shared.js";
import { pluginCall } from "./plugin.js";

/**
 * ServiceNow Service Catalog API (`/api/sn_sc/servicecatalog`). Lets the model
 * browse catalogs/categories/items, inspect an item's variables and place an
 * order — things the Table API cannot express. Plugin-scoped, so calls go
 * through {@link pluginCall} for a clear "not active" message on 404.
 */

const BASE = "/api/sn_sc/servicecatalog";
const LABEL = "Service Catalog";

export async function listCatalogs(): Promise<unknown> {
  assertTableAllowed("sc_catalog"); // H-4: the backing table
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/catalogs`,
    });
    return expectResult(data, "Service Catalog API");
  });
}

export async function listCatalogCategories(
  catalogSysId: string,
): Promise<unknown> {
  assertTableAllowed("sc_category"); // H-4: the backing table
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/catalogs/${encodeURIComponent(catalogSysId)}/categories`,
    });
    return expectResult(data, "Service Catalog API");
  });
}

export interface CatalogItemQuery {
  text?: string;
  category?: string;
  limit?: number;
  offset?: number;
}

export async function listCatalogItems(
  opts: CatalogItemQuery = {},
): Promise<unknown> {
  assertTableAllowed("sc_cat_item"); // H-4: the backing table
  const params = snParams({
    sysparm_text: opts.text,
    sysparm_category: opts.category,
    sysparm_limit: opts.limit,
    sysparm_offset: opts.offset,
  });
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/items`,
      params,
    });
    return expectResult(data, "Service Catalog API");
  });
}

export async function getCatalogItem(itemSysId: string): Promise<unknown> {
  assertTableAllowed("sc_cat_item"); // H-4: the backing table
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/items/${encodeURIComponent(itemSysId)}`,
    });
    return expectResult(data, "Service Catalog API");
  });
}

export interface OrderItemArgs {
  itemSysId: string;
  quantity?: number;
  variables?: Record<string, unknown>;
}

/** Order a catalog item directly ("order now"), producing a request/RITM. */
export async function orderCatalogItem(args: OrderItemArgs): Promise<unknown> {
  // H-4: an order reads the item and creates sc_request / sc_req_item rows.
  for (const table of ["sc_cat_item", "sc_request", "sc_req_item"]) {
    assertTableAllowed(table);
  }
  assertWriteAllowed("catalog order");
  const body: Record<string, unknown> = {
    sysparm_quantity: String(args.quantity ?? 1),
  };
  if (args.variables) body.variables = args.variables;
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "POST",
      path: `${BASE}/items/${encodeURIComponent(args.itemSysId)}/order_now`,
      body,
    });
    return expectResult(data, "Service Catalog API");
  });
}
