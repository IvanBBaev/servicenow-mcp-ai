import { z } from "zod";
import { runBatch } from "../api/batch.js";
import { ok } from "../mcp/result.js";
import { defineTool, type AnyToolSpec } from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";
import { appendWriteJournal } from "../core/write-journal.js";

const subRequestSchema = z.object({
  id: z
    .string()
    .optional()
    .describe("Optional id echoed back in the matching result."),
  method: z
    .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
    .describe("HTTP method for this sub-request."),
  url: z
    .string()
    .describe(
      "API path under the instance origin, e.g. '/api/now/table/incident?sysparm_limit=1'.",
    ),
  body: z
    .unknown()
    .optional()
    .describe("JSON body for write methods; encoded into the batch payload."),
  headers: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .optional()
    .describe(
      "Extra headers. Accept and Content-Type are added automatically.",
    ),
});

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_batch",
    title: "Run a ServiceNow batch",
    description:
      "Execute several ServiceNow REST sub-requests in a single HTTP round-trip via the Batch API. Each sub-request runs through the same read-only and table-access policy as a direct call.",
    package: "batch",
    annotations: {
      // A batch may contain writes, so it is not flagged read-only.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: {
      requests: z
        .array(subRequestSchema)
        .min(1)
        .describe("The sub-requests to run together."),
      apply: applyInput,
    },
    logFields: (args) => ({ count: args.requests.length }),
    handler: async ({ requests, apply }) => {
      // A read-only batch (all GET) needs no plan gate; a batch that writes does.
      const hasWrites = requests.some((r) => r.method !== "GET");
      if (hasWrites && !shouldApply(apply)) {
        return planPreview({
          action: "execute",
          table: "batch",
          after: {
            requests: requests.map((r) => ({ method: r.method, url: r.url })),
          },
        });
      }
      const results = await runBatch(requests);
      if (hasWrites) {
        appendWriteJournal({
          action: "execute",
          table: "batch",
          fields: { sub_requests: requests.length },
        });
      }
      return ok({ count: results.length, results });
    },
  }),
];
