import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getCredentials,
  saveCredentials,
  hasCredentials,
  type ServiceNowCredentials,
} from "../config.js";
import { getAuthMode } from "../auth.js";
import { isReadOnly, getAllowedTables, getDeniedTables } from "../policy.js";
import { getRequestedPackages } from "../settings.js";
import { resolveEnabledPackages } from "../registry.js";
import { ok, fail } from "../result.js";
import { runTool } from "./util.js";

export function registerAdminTools(server: McpServer): void {
  server.registerTool(
    "servicenow_set_credentials",
    {
      title: "Set ServiceNow credentials",
      description:
        "Save or update the ServiceNow connection credentials. Values are persisted to the env file and used for all subsequent requests. Provide any subset of fields.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        instance: z
          .string()
          .optional()
          .describe(
            "Instance host, e.g. 'dev12345' or 'dev12345.service-now.com'.",
          ),
        user: z.string().optional().describe("ServiceNow username."),
        password: z.string().optional().describe("ServiceNow password."),
      },
    },
    async (args) =>
      runTool("servicenow_set_credentials", {}, async () => {
        const clean: Partial<ServiceNowCredentials> = {};
        if (args.instance?.trim()) clean.instance = args.instance.trim();
        if (args.user?.trim()) clean.user = args.user.trim();
        if (args.password) clean.password = args.password;
        if (Object.keys(clean).length === 0) {
          return fail(
            "Provide at least one non-empty value: instance, user or password.",
          );
        }
        const updated = saveCredentials(clean);
        return ok({
          message: "Credentials saved",
          instance: updated.instance,
          user: updated.user,
          password: "***",
        });
      }),
  );

  server.registerTool(
    "servicenow_get_status",
    {
      title: "Get ServiceNow connection status",
      description:
        "Show the configured instance, user, auth mode and access policy, and whether credentials are complete. The password is never revealed.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () =>
      runTool("servicenow_get_status", {}, async () => {
        const c = getCredentials();
        return ok({
          configured: hasCredentials(),
          instance: c.instance || "(not set)",
          user: c.user || "(not set)",
          passwordSet: Boolean(c.password),
          authMode: getAuthMode(),
          readOnly: isReadOnly(),
          allowedTables: getAllowedTables(),
          deniedTables: getDeniedTables(),
          enabledPackages: [
            ...resolveEnabledPackages(getRequestedPackages()),
          ].sort(),
        });
      }),
  );
}
