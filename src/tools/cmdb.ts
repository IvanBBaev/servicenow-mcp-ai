import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listCmdbInstances,
  getCmdbInstance,
  createCmdbInstance,
  updateCmdbInstance,
  getCmdbMeta,
} from "../api/cmdb.js";
import { ok } from "../result.js";
import { runTool } from "./util.js";

const attributes = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe("CI attribute name/value pairs.");

export function registerCmdbTools(server: McpServer): void {
  server.registerTool(
    "servicenow_list_cis",
    {
      title: "List configuration items",
      description:
        "List configuration items of a CMDB class through the class-aware CMDB Instance API.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        class_name: z
          .string()
          .describe("CMDB class/table, e.g. 'cmdb_ci_server'."),
        query: z.string().optional().describe("Encoded query (sysparm_query)."),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async ({ class_name, query, limit, offset }) =>
      runTool("servicenow_list_cis", { class_name }, async () => {
        const result = await listCmdbInstances(class_name, {
          query,
          limit,
          offset,
        });
        return ok({ result });
      }),
  );

  server.registerTool(
    "servicenow_get_ci",
    {
      title: "Get configuration item",
      description:
        "Get a CI with its attributes and inbound/outbound relations by class and sys_id.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        class_name: z.string().describe("CMDB class, e.g. 'cmdb_ci_server'."),
        sys_id: z.string().describe("sys_id of the CI."),
      },
    },
    async ({ class_name, sys_id }) =>
      runTool("servicenow_get_ci", { class_name }, async () => {
        const result = await getCmdbInstance(class_name, sys_id);
        return ok({ result });
      }),
  );

  server.registerTool(
    "servicenow_create_ci",
    {
      title: "Create configuration item",
      description:
        "Create a CI via the CMDB Instance API (routed through Identification & Reconciliation).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        class_name: z.string().describe("CMDB class, e.g. 'cmdb_ci_server'."),
        attributes,
        source: z
          .string()
          .optional()
          .describe("Discovery source recorded by IRE (e.g. 'ServiceNow')."),
      },
    },
    async ({ class_name, attributes: attrs, source }) =>
      runTool("servicenow_create_ci", { class_name }, async () => {
        const result = await createCmdbInstance({
          className: class_name,
          attributes: attrs,
          source,
        });
        return ok({ message: "CI created", result });
      }),
  );

  server.registerTool(
    "servicenow_update_ci",
    {
      title: "Update configuration item",
      description: "Update a CI's attributes via the CMDB Instance API (IRE).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        class_name: z.string().describe("CMDB class, e.g. 'cmdb_ci_server'."),
        sys_id: z.string().describe("sys_id of the CI."),
        attributes,
        source: z.string().optional().describe("Discovery source for IRE."),
      },
    },
    async ({ class_name, sys_id, attributes: attrs, source }) =>
      runTool("servicenow_update_ci", { class_name }, async () => {
        const result = await updateCmdbInstance(sys_id, {
          className: class_name,
          attributes: attrs,
          source,
        });
        return ok({ message: "CI updated", result });
      }),
  );

  server.registerTool(
    "servicenow_get_cmdb_meta",
    {
      title: "Get CMDB class metadata",
      description:
        "Get the schema/metadata of a CMDB class (attributes, relationship rules) from the CMDB Meta API.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        class_name: z.string().describe("CMDB class, e.g. 'cmdb_ci_server'."),
      },
    },
    async ({ class_name }) =>
      runTool("servicenow_get_cmdb_meta", { class_name }, async () => {
        const result = await getCmdbMeta(class_name);
        return ok({ result });
      }),
  );
}
