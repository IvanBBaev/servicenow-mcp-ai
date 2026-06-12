import { z } from "zod";
import { saveCredentials, type ServiceNowCredentials } from "../core/config.js";
import { invalidateTokens } from "../core/auth.js";
import { resolveHost } from "../core/host.js";
import { buildStatusPayload } from "../mcp/status.js";
import { getServer } from "../mcp/context.js";
import { testConnection } from "../api/diagnostics.js";
import { ok, okStructured, fail } from "../mcp/result.js";
import { defineTool, type AnyToolSpec } from "../mcp/define.js";

/**
 * Ask the client to confirm a credential change when it supports elicitation
 * (Х-2). Returns null to proceed, or a refusal ToolResult. Clients without
 * the capability — and any elicitation transport error — fall back to the
 * old behaviour (save without confirmation), so nothing breaks.
 */
async function confirmCredentialChange(
  clean: Partial<ServiceNowCredentials>,
): Promise<ReturnType<typeof fail> | null> {
  const server = getServer();
  const capabilities = server?.server.getClientCapabilities();
  if (!server || !capabilities?.elicitation) return null;

  const summary = [
    clean.instance ? `instance → ${clean.instance}` : null,
    clean.user ? `user → ${clean.user}` : null,
    clean.password ? "password → (new value)" : null,
  ]
    .filter(Boolean)
    .join(", ");

  try {
    const res = await server.server.elicitInput({
      message: `Save ServiceNow credentials (${summary})?`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            description: "Confirm saving the new credentials.",
          },
        },
        required: ["confirm"],
      },
    });
    const confirmed =
      res.action === "accept" &&
      (res.content as { confirm?: boolean } | undefined)?.confirm === true;
    if (!confirmed) {
      return fail("Credential change was not confirmed by the user.");
    }
  } catch {
    // Elicitation failed at the protocol level — do not block the change.
  }
  return null;
}

/** The always-on management surface: registered regardless of SN_TOOL_PACKAGES. */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_set_credentials",
    title: "Set ServiceNow credentials",
    description:
      "Save or update the ServiceNow connection credentials. Values are persisted to the env file and used for all subsequent requests. Provide any subset of fields.",
    package: "admin",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {
      instance: z
        .string()
        .optional()
        .describe("Instance host, e.g. 'dev12345' or 'dev12345.service-now.com'."),
      user: z.string().optional().describe("ServiceNow username."),
      password: z.string().optional().describe("ServiceNow password."),
    },
    handler: async (args) => {
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
      const refusal = await confirmCredentialChange(clean);
      if (refusal) return refusal;

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
    },
  }),

  defineTool({
    name: "servicenow_get_status",
    title: "Get ServiceNow connection status",
    description:
      "Show the configured instance, user, auth mode and access policy, and whether credentials are complete. The password is never revealed.",
    package: "admin",
    annotations: { readOnlyHint: true, openWorldHint: false },
    input: {},
    output: {
      configured: z.boolean(),
      instance: z.string(),
      user: z.string(),
      passwordSet: z.boolean(),
      authMode: z.string(),
      readOnly: z.boolean(),
      allowedTables: z.array(z.string()),
      deniedTables: z.array(z.string()),
      enabledPackages: z.array(z.string()),
      deniedPackages: z.array(z.string()),
      readOnlyPackages: z.array(z.string()),
      pluginApis: z.record(z.string()),
      telemetry: z.object({
        requests: z.number(),
        retries: z.number(),
        errors: z.record(z.number()),
        totalMs: z.number(),
      }),
    },
    handler: () => okStructured(buildStatusPayload()),
  }),

  defineTool({
    name: "servicenow_test_connection",
    title: "Test ServiceNow connection",
    description:
      "Verify that the configured credentials actually work: reads one sys_user record and reports ok/status/latency. Auth and connectivity problems are returned structurally (ok:false), not as errors.",
    package: "admin",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {},
    output: {
      ok: z.boolean(),
      status: z.union([z.number(), z.null()]),
      latencyMs: z.number(),
      user: z.string().optional(),
      message: z.string().optional(),
    },
    handler: async () =>
      okStructured(
        (await testConnection()) as unknown as Record<string, unknown>,
      ),
  }),
];
