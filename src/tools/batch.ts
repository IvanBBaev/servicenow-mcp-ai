import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runBatch } from "../api/batch.js";
import { ok } from "../mcp/result.js";
import { runTool } from "./util.js";

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

export function registerBatchTools(server: McpServer): void {
  server.registerTool(
    "servicenow_batch",
    {
      title: "Run a ServiceNow batch",
      description:
        "Execute several ServiceNow REST sub-requests in a single HTTP round-trip via the Batch API. Each sub-request runs through the same read-only and table-access policy as a direct call.",
      annotations: {
        // A batch may contain writes, so it is not flagged read-only.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        requests: z
          .array(subRequestSchema)
          .min(1)
          .describe("The sub-requests to run together."),
      },
    },
    async ({ requests }) =>
      runTool("servicenow_batch", { count: requests.length }, async () => {
        const results = await runBatch(requests);
        return ok({ count: results.length, results });
      }),
  );
}
