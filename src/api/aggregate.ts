import { snRequest } from "../core/http.js";
import { assertTableAllowed } from "../core/policy.js";
import { expectResult, snParams } from "./shared.js";

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
  const params = snParams({
    sysparm_query: opts.query,
    sysparm_count: opts.count,
    sysparm_avg_fields: opts.avgFields,
    sysparm_min_fields: opts.minFields,
    sysparm_max_fields: opts.maxFields,
    sysparm_sum_fields: opts.sumFields,
    sysparm_group_by: opts.groupBy,
    sysparm_having: opts.having,
  });

  const { data } = await snRequest<{ result: unknown }>({
    method: "GET",
    path: `/api/now/stats/${encodeURIComponent(opts.table)}`,
    params,
  });
  return expectResult(data, "Aggregate API");
}
