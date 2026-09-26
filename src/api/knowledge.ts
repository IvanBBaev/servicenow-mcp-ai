import { snRequest } from "../core/http.js";
import { expectResult, snParams } from "./shared.js";
import { pluginCall } from "./plugin.js";

/**
 * ServiceNow Knowledge Management API (`/api/sn_km_api/knowledge`). Full-text
 * article search with relevance plus featured/most-viewed lists — richer than
 * a plain Table API read of kb_knowledge. Plugin-scoped.
 */

const BASE = "/api/sn_km_api/knowledge";
const LABEL = "Knowledge";

export interface KnowledgeSearch {
  search?: string;
  query?: string;
  limit?: number;
  offset?: number;
  fields?: string[];
}

export async function searchKnowledge(
  opts: KnowledgeSearch = {},
): Promise<unknown> {
  const params = snParams({
    sysparm_search: opts.search,
    sysparm_query: opts.query,
    sysparm_limit: opts.limit,
    sysparm_offset: opts.offset,
    sysparm_fields: opts.fields,
  });
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/articles`,
      params,
    });
    return expectResult(data, "Knowledge API");
  });
}

export async function getKnowledgeArticle(sysId: string): Promise<unknown> {
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/articles/${encodeURIComponent(sysId)}`,
    });
    return expectResult(data, "Knowledge API");
  });
}

export type KnowledgeHighlight = "featured" | "most_viewed";

export async function knowledgeHighlights(
  mode: KnowledgeHighlight,
  limit?: number,
): Promise<unknown> {
  const params = snParams({ sysparm_limit: limit });
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/articles/${mode}`,
      params,
    });
    return expectResult(data, "Knowledge API");
  });
}
