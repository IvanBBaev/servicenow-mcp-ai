import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { saveCredentials, getCredentials, type ServiceNowCredentials } from "../core/config.js";
import { invalidateTokens } from "../core/auth.js";
import { resolveHost } from "../core/host.js";
import { buildStatusPayload } from "../mcp/status.js";
import { snRequest } from "../core/http.js";
import { ServiceNowError } from "../core/errors.js";
import { ok, fail } from "../mcp/result.js";
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
    (args) =>
      runTool("servicenow_set_credentials", {}, () => {
        const clean: Partial<ServiceNowCredentials> = {};
        if (args.instance?.trim()) clean.instance = args.instance.trim();
        if (args.user?.trim()) clean.user = args.user.trim();
        if (args.password) clean.password = args.password;
        if (Object.keys(clean).length === 0) {
          return fail(
            "Provide at least one non-empty value: instance, user or password.",
          );
        }
        // Validate the host before persisting anything: an invalid or SSRF-
        // blocked instance should fail here, not at the first real request.
        if (clean.instance) {
          try {
            resolveHost(clean.instance);
          } catch (error) {
            return fail(error);
          }
        }
        const updated = saveCredentials(clean);
        // A cached OAuth token obtained with the old secrets must not survive
        // a credential change (the cache key has no password in it).
        invalidateTokens();
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
    () =>
      runTool("servicenow_get_status", {}, () => ok(buildStatusPayload())),
  );

  server.registerTool(
    "servicenow_test_connection",
    {
      title: "Test ServiceNow connection",
      description:
        "Verify that the configured credentials actually work: reads one sys_user record and reports ok/status/latency. Auth and connectivity problems are returned structurally (ok:false), not as errors.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
    },
    () =>
      runTool("servicenow_test_connection", {}, async () => {
        const started = Date.now();
        try {
          // Direct snRequest on purpose: this is a connectivity diagnostic on
          // the admin surface — a table allow/deny list must not mask it.
          const params = new URLSearchParams({
            sysparm_limit: "1",
            sysparm_fields: "sys_id",
          });
          const { status } = await snRequest<unknown>({
            method: "GET",
            path: "/api/now/table/sys_user",
            params,
          });
          return ok({
            ok: true,
            status,
            latencyMs: Date.now() - started,
            user: getCredentials().user,
          });
        } catch (error) {
          if (error instanceof ServiceNowError) {
            // Structured, not an exception: the model should read and react
            // (401 → fix credentials, 403 → roles, timeout → connectivity).
            return ok({
              ok: false,
              status: error.status ?? null,
              latencyMs: Date.now() - started,
              message: error.message,
            });
          }
          throw error;
        }
      }),
  );
}
