import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { aggregate } from "../api/aggregate.js";
import { ok, fail } from "../mcp/result.js";
import { runTool } from "./util.js";

export function registerAggregateTools(server: McpServer): void {
  server.registerTool(
    "servicenow_aggregate",
    {
      title: "Aggregate ServiceNow records",
      description:
        "Compute server-side aggregates (count, avg, min, max, sum) over a table via the Stats API, with optional grouping. Avoids pulling individual rows.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        table: z.string().describe("Table name, e.g. 'incident'."),
        query: z
          .string()
          .optional()
          .describe("Encoded query to filter rows before aggregating."),
        count: z
          .boolean()
          .optional()
          .describe("Include a record count (sysparm_count)."),
        avg_fields: z
          .array(z.string())
          .optional()
          .describe("Numeric fields to average."),
        min_fields: z
          .array(z.string())
          .optional()
          .describe("Fields to take the minimum of."),
        max_fields: z
          .array(z.string())
          .optional()
          .describe("Fields to take the maximum of."),
        sum_fields: z
          .array(z.string())
          .optional()
          .describe("Numeric fields to sum."),
        group_by: z
          .array(z.string())
          .optional()
          .describe("Fields to group by."),
        having: z
          .string()
          .optional()
          .describe("HAVING clause to filter groups (sysparm_having)."),
      },
    },
    async (args) =>
      runTool("servicenow_aggregate", { table: args.table }, async () => {
        const hasAggregation =
          args.count ||
          args.avg_fields?.length ||
          args.min_fields?.length ||
          args.max_fields?.length ||
          args.sum_fields?.length;
        if (!hasAggregation) {
          return fail(
            "At least one aggregation is required: count, avg_fields, min_fields, max_fields or sum_fields.",
          );
        }
        const result = await aggregate({
          table: args.table,
          query: args.query,
          count: args.count,
          avgFields: args.avg_fields,
          minFields: args.min_fields,
          maxFields: args.max_fields,
          sumFields: args.sum_fields,
          groupBy: args.group_by,
          having: args.having,
        });
        return ok({ result });
      }),
  );
}
