import { snRequest } from "../core/http.js";
import { assertWriteAllowed } from "../core/policy.js";
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
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/catalogs`,
    });
    return data.result;
  });
}

export async function listCatalogCategories(
  catalogSysId: string,
): Promise<unknown> {
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/catalogs/${encodeURIComponent(catalogSysId)}/categories`,
    });
    return data.result;
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
  const params = new URLSearchParams();
  if (opts.text) params.set("sysparm_text", opts.text);
  if (opts.category) params.set("sysparm_category", opts.category);
  if (opts.limit !== undefined) params.set("sysparm_limit", String(opts.limit));
  if (opts.offset !== undefined)
    params.set("sysparm_offset", String(opts.offset));
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/items`,
      params,
    });
    return data.result;
  });
}

export async function getCatalogItem(itemSysId: string): Promise<unknown> {
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/items/${encodeURIComponent(itemSysId)}`,
    });
    return data.result;
  });
}

export interface OrderItemArgs {
  itemSysId: string;
  quantity?: number;
  variables?: Record<string, unknown>;
}

/** Order a catalog item directly ("order now"), producing a request/RITM. */
export async function orderCatalogItem(args: OrderItemArgs): Promise<unknown> {
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
    return data.result;
  });
}
