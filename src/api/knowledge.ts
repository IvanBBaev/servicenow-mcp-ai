import { snRequest } from "../http.js";
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
  const params = new URLSearchParams();
  if (opts.search) params.set("sysparm_search", opts.search);
  if (opts.query) params.set("sysparm_query", opts.query);
  if (opts.limit !== undefined) params.set("sysparm_limit", String(opts.limit));
  if (opts.offset !== undefined)
    params.set("sysparm_offset", String(opts.offset));
  if (opts.fields?.length) params.set("sysparm_fields", opts.fields.join(","));
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/articles`,
      params,
    });
    return data.result;
  });
}

export async function getKnowledgeArticle(sysId: string): Promise<unknown> {
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/articles/${encodeURIComponent(sysId)}`,
    });
    return data.result;
  });
}

export type KnowledgeHighlight = "featured" | "most_viewed";

export async function knowledgeHighlights(
  mode: KnowledgeHighlight,
  limit?: number,
): Promise<unknown> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("sysparm_limit", String(limit));
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/articles/${mode}`,
      params,
    });
    return data.result;
  });
}
