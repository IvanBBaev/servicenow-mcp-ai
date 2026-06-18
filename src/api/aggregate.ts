import { snRequest } from "../core/http.js";
import { assertTableAllowed } from "../core/policy.js";
import { expectResult } from "./shared.js";

/**
 * ServiceNow Aggregate (Stats) API: server-side count/avg/min/max/sum with
 * optional grouping, so the model can summarise without pulling every row.
 */

export interface AggregateOptions {
  table: string;
  query?: string;
  count?: boolean;
  avgFields?: string[];
  minFields?: string[];
  maxFields?: string[];
  sumFields?: string[];
  groupBy?: string[];
  having?: string;
}

export async function aggregate(opts: AggregateOptions): Promise<unknown> {
  assertTableAllowed(opts.table);
  const params = new URLSearchParams();
  if (opts.query) params.set("sysparm_query", opts.query);
  if (opts.count) params.set("sysparm_count", "true");
  if (opts.avgFields?.length)
    params.set("sysparm_avg_fields", opts.avgFields.join(","));
  if (opts.minFields?.length)
    params.set("sysparm_min_fields", opts.minFields.join(","));
  if (opts.maxFields?.length)
    params.set("sysparm_max_fields", opts.maxFields.join(","));
  if (opts.sumFields?.length)
    params.set("sysparm_sum_fields", opts.sumFields.join(","));
  if (opts.groupBy?.length)
    params.set("sysparm_group_by", opts.groupBy.join(","));
  if (opts.having) params.set("sysparm_having", opts.having);

  const { data } = await snRequest<{ result: unknown }>({
    method: "GET",
    path: `/api/now/stats/${encodeURIComponent(opts.table)}`,
    params,
  });
  return expectResult(data, "Aggregate API");
}
