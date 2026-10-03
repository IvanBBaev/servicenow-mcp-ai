import { z } from "zod";
import { aggregate } from "../api/aggregate.js";
import { ok, fail } from "../mcp/result.js";
import {
  defineTool,
  encodedQuery,
  fieldList,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_aggregate",
    title: "Aggregate ServiceNow records",
    description:
      "Compute server-side aggregates (count, avg, min, max, sum) over a table via the Stats API, with optional grouping. Avoids pulling individual rows.",
    package: "aggregate",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: { result: z.unknown().optional() },
    input: {
      table: tableName().describe("Table name, e.g. 'incident'."),
      query: encodedQuery()
        .optional()
        .describe("Encoded query to filter rows before aggregating."),
      count: z
        .boolean()
        .optional()
        .describe("Include a record count (sysparm_count)."),
      avg_fields: fieldList().optional().describe("Numeric fields to average."),
      min_fields: fieldList()
        .optional()
        .describe("Fields to take the minimum of."),
      max_fields: fieldList()
        .optional()
        .describe("Fields to take the maximum of."),
      sum_fields: fieldList().optional().describe("Numeric fields to sum."),
      group_by: fieldList().optional().describe("Fields to group by."),
      having: encodedQuery()
        .optional()
        .describe("HAVING clause to filter groups (sysparm_having)."),
    },
    logFields: (args) => ({ table: args.table }),
    handler: async (args) => {
      const hasAggregation =
        args.count ||
        args.avg_fields?.length ||
        args.min_fields?.length ||
        args.max_fields?.length ||
        args.sum_fields?.length;
      if (!hasAggregation) {
        return fail(
          "At least one aggregation is required: count, avg_fields, min_fields, max_fields or sum_fields.",
          { code: "INVALID_INPUT" },
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
    },
  }),
];
