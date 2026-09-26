import { z } from "zod";
import {
  saveCredentials,
  getCredentials,
  useProfile,
  activeProfile,
  assertValidProfileName,
  envKeysFor,
  authEnvKey,
  authModeFor,
  oauthGrantFor,
  credentialStatus,
  envFileAclWarning,
  type AuthMode,
  type AuthSetting,
  type ServiceNowCredentials,
} from "../core/config.js";
import { appendWriteJournal } from "../core/write-journal.js";
import { logger } from "../core/logging.js";
import { isReadOnly } from "../core/policy.js";
import {
  allowUnconfirmedCredentialChange,
  getProfileEnv,
} from "../core/settings.js";
import { invalidateTokens } from "../core/auth.js";
import { disposeDispatchers } from "../core/dispatcher.js";
import { clearSchemaCache } from "../core/cache.js";
import { clearPluginAvailability } from "../api/plugin.js";
import { resolveHost } from "../core/host.js";
import { buildStatusPayload, profilesPayload } from "../mcp/status.js";
import { getServer } from "../mcp/context.js";
import {
  currentPackageSession,
  notifyProfileChanged,
  type PackageChange,
} from "../mcp/packages.js";
import { testConnection } from "../api/diagnostics.js";
import { checkCapabilities, MATRIX_GROUPS } from "../api/capabilities.js";
import { clearCapabilityCache } from "../api/capability-matrix.js";
import { ok, okStructured, fail } from "../mcp/result.js";
import {
  defineTool,
  shortText,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";
import { explainTable, policyPayload } from "../mcp/policy-view.js";

/**
 * Machine-readable token for the H-2 refusal. fail() carries no code field,
 * so the token leads the message where a client can match it.
 */
const CREDENTIALS_INCOMPLETE = "CREDENTIALS_INCOMPLETE";

const UNCONFIRMED_HINT =
  "Set SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1 on the server to let credential changes proceed without confirmation.";

/**
 * Ask the client to confirm a credential change through elicitation (X-2).
 * Returns null to proceed, or a refusal ToolResult. H-2: the check fails
 * closed — no live server, a client without the `elicitation` capability and
 * a transport error all refuse the change unless the operator opted out with
 * SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE. An explicit decline is refused
 * regardless of that opt-out.
 */
async function confirmCredentialChange(
  summary: string,
): Promise<ReturnType<typeof fail> | null> {
  const server = getServer();
  const capabilities = server?.server.getClientCapabilities();
  if (!server || !capabilities?.elicitation) {
    if (allowUnconfirmedCredentialChange()) return null;
    return fail(
      `Credential change refused: this client cannot confirm it (no elicitation support). ${UNCONFIRMED_HINT}`,
    );
  }

  let confirmed = false;
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
    confirmed =
      res.action === "accept" &&
      (res.content as { confirm?: boolean } | undefined)?.confirm === true;
  } catch (error) {
    // Elicitation failed at the protocol level. An unconfirmed change must
    // never slip through on an error, so this is a refusal unless opted out.
    if (allowUnconfirmedCredentialChange()) return null;
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      `Credential change refused: the confirmation prompt failed (${detail}). ${UNCONFIRMED_HINT}`,
    );
  }
  if (!confirmed) {
    return fail("Credential change was not confirmed by the user.");
  }
  return null;
}

/** The secrets set_credentials collects through elicitation, never as arguments. */
const SECRET_FIELDS = {
  api_key: {
    setting: "API_KEY",
    label: "ServiceNow REST API key (x-sn-apikey)",
  },
  oauth_client_secret: {
    setting: "OAUTH_CLIENT_SECRET",
    label: "OAuth client secret",
  },
} as const satisfies Record<string, { setting: AuthSetting; label: string }>;

type SecretName = keyof typeof SECRET_FIELDS;

/** Human summary of a credential change — values of secrets are never shown. */
function describeChange(
  clean: Partial<ServiceNowCredentials>,
  settings: Partial<Record<AuthSetting, string>>,
  secrets: readonly SecretName[],
): string {
  return [
    clean.instance ? `instance → ${clean.instance}` : null,
    clean.user ? `user → ${clean.user}` : null,
    clean.password ? "password → (new value)" : null,
    settings.AUTH ? `auth → ${settings.AUTH}` : null,
    settings.OAUTH_CLIENT_ID
      ? `OAuth client id → ${settings.OAUTH_CLIENT_ID}`
      : null,
    settings.OAUTH_GRANT ? `OAuth grant → ${settings.OAUTH_GRANT}` : null,
    ...secrets.map((name) => `${name} → (entered below)`),
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * D-2 — collect secrets (API key, OAuth client secret) through a form
 * elicitation so they never travel in a tool argument, which clients and
 * transports may log. There is no argument fallback and no opt-out: a client
 * without elicitation cannot set them through this tool. Accepting the form
 * also confirms the whole change it describes.
 */
async function elicitSecrets(
  summary: string,
  secrets: readonly SecretName[],
): Promise<
  | { ok: true; values: Partial<Record<AuthSetting, string>> }
  | { ok: false; refusal: ReturnType<typeof fail> }
> {
  const server = getServer();
  if (!server || !server.server.getClientCapabilities()?.elicitation) {
    return {
      ok: false,
      refusal: fail(
        `Secret entry refused: ${secrets.join(" and ")} can only be entered through an elicitation prompt, which this client does not support — secrets are never accepted as tool arguments. Set ${secrets.map((n) => `SN_${SECRET_FIELDS[n].setting}`).join(" / ")} in the env file instead. Nothing was changed.`,
      ),
    };
  }
  let content: Record<string, unknown> | undefined;
  try {
    const res = await server.server.elicitInput({
      message: `Save ServiceNow credentials (${summary})? Enter the secret value(s) to confirm.`,
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(
          secrets.map((name) => [
            name,
            {
              type: "string",
              title: SECRET_FIELDS[name].label,
              minLength: 1,
            },
          ]),
        ),
        required: [...secrets],
      },
    });
    if (res.action !== "accept") {
      return {
        ok: false,
        refusal: fail("Credential change was not confirmed by the user."),
      };
    }
    content = res.content;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      refusal: fail(
        `Secret entry refused: the elicitation prompt failed (${detail}). Nothing was changed.`,
      ),
    };
  }
  const values: Partial<Record<AuthSetting, string>> = {};
  for (const name of secrets) {
    const value = content?.[name];
    if (typeof value !== "string" || value.trim() === "") {
      return {
        ok: false,
        refusal: fail(
          `Secret entry refused: no value was entered for ${name}. Nothing was changed.`,
        ),
      };
    }
    values[SECRET_FIELDS[name].setting] = value.trim();
  }
  return { ok: true, values };
}

/**
 * H-2 extended to every auth method (D-2): what a host change must carry so
 * that no secret stored for the old host is sent to the new one. Returns the
 * missing material, or null when the call is complete.
 */
function hostChangeRequirement(
  mode: AuthMode,
  grant: string,
  clean: Partial<ServiceNowCredentials>,
  secrets: readonly SecretName[],
): string | null {
  const userAndPassword = Boolean(clean.user && clean.password);
  switch (mode) {
    case "apikey":
      return secrets.includes("api_key")
        ? null
        : 'a new API key (request_secrets: ["api_key"])';
    case "oauth":
      if (grant === "client_credentials" || grant === "password") {
        const secret = secrets.includes("oauth_client_secret");
        const basic = grant === "client_credentials" || userAndPassword;
        return secret && basic
          ? null
          : grant === "password"
            ? 'user, password and a new OAuth client secret (request_secrets: ["oauth_client_secret"])'
            : 'a new OAuth client secret (request_secrets: ["oauth_client_secret"])';
      }
      return `new ${grant} grant material, which this tool cannot set — edit the env file instead`;
    case "token":
      return "a new bearer token, which this tool cannot set — edit SN_BEARER_TOKEN / SN_TOKEN_FILE in the env file instead";
    default:
      // basic and none: the stored user/password must not ride along.
      return userAndPassword ? null : "user and password";
  }
}

/**
 * H-2 — true when `profile` already has a stored instance whose host differs
 * from `nextHost`. A first-time set (nothing stored) is not a change; a stored
 * value that no longer resolves (e.g. the allow-list changed underneath it) is
 * treated as one, so stored secrets cannot ride along to an unknown host.
 */
function instanceChanged(profile: string, nextHost: string): boolean {
  const stored = getCredentials(profile).instance;
  if (!stored) return false;
  try {
    return resolveHost(stored).toLowerCase() !== nextHost.toLowerCase();
  } catch {
    return true;
  }
}

/** The always-on management surface: registered regardless of SN_TOOL_PACKAGES. */
const NO_SESSION =
  "NO_PACKAGE_SESSION: packages can only be toggled on a running MCP server.";

/** Shared body of servicenow_enable_package / servicenow_disable_package (M-5). */
function togglePackage(name: string, on: boolean) {
  const session = currentPackageSession();
  if (!session) return fail(NO_SESSION);
  try {
    const change: PackageChange = on
      ? session.enable(name)
      : session.disable(name);
    return okStructured({ ...change });
  } catch (error) {
    return fail(error);
  }
}

const TOGGLE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const TOGGLE_OUTPUT = {
  package: z.string(),
  enabled: z.boolean(),
  changed: z.boolean(),
  readOnly: z.boolean(),
  tools: z.array(z.string()),
  prompts: z.array(z.string()),
};

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_set_credentials",
    title: "Set ServiceNow credentials",
    description:
      "Save connection credentials to the env file for later requests (any subset; auth / oauth_client_id / oauth_grant pick the method). Secrets are never arguments: list them in request_secrets for elicitation. See 'instance' for host changes.",
    package: "admin",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {
      instance: shortText()
        .optional()
        .describe(
          "Instance host, e.g. 'dev12345' or 'dev12345.service-now.com'. Changing it needs the new host's auth in the same call (user + password for Basic, else CREDENTIALS_INCOMPLETE) and client confirmation through elicitation unless SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1.",
        ),
      user: shortText().optional().describe("ServiceNow username."),
      password: shortText(1024).optional().describe("ServiceNow password."),
      auth: z
        .enum(["basic", "oauth", "apikey", "token", "none"])
        .optional()
        .describe(
          "Auth method to store as SN_AUTH (default: inferred from the configured keys).",
        ),
      oauth_client_id: shortText(1024)
        .optional()
        .describe("OAuth client id (not a secret)."),
      oauth_grant: z
        .enum(["password", "client_credentials", "refresh_token", "jwt_bearer"])
        .optional()
        .describe("OAuth grant to store as SN_OAUTH_GRANT."),
      request_secrets: z
        .array(z.enum(["api_key", "oauth_client_secret"]))
        .max(10)
        .optional()
        .describe(
          "Secrets to enter through an elicitation prompt (never as arguments): 'api_key', 'oauth_client_secret'.",
        ),
      profile: shortText(128)
        .optional()
        .describe(
          "Connection profile to write (default: the active one). Use a new name to create a profile.",
        ),
    },
    handler: async (args) => {
      const profile = args.profile?.trim().toLowerCase() || activeProfile();
      try {
        assertValidProfileName(profile);
      } catch (error) {
        return fail(error);
      }
      const clean: Partial<ServiceNowCredentials> = {};
      if (args.instance?.trim()) clean.instance = args.instance.trim();
      if (args.user?.trim()) clean.user = args.user.trim();
      if (args.password) clean.password = args.password;
      const settings: Partial<Record<AuthSetting, string>> = {};
      if (args.auth) settings.AUTH = args.auth;
      if (args.oauth_client_id?.trim())
        settings.OAUTH_CLIENT_ID = args.oauth_client_id.trim();
      if (args.oauth_grant) settings.OAUTH_GRANT = args.oauth_grant;
      const secrets = [...new Set(args.request_secrets ?? [])];
      if (
        Object.keys(clean).length === 0 &&
        Object.keys(settings).length === 0 &&
        secrets.length === 0
      ) {
        return fail(
          "Provide at least one non-empty value: instance, user, password, auth, oauth_client_id, oauth_grant or request_secrets.",
        );
      }
      // The auth method this profile will use once the change is saved; a
      // requested secret counts as present (it is entered before saving).
      const pending: Record<string, string> = { ...settings };
      for (const name of secrets) pending[SECRET_FIELDS[name].setting] = "*";
      const nextMode = authModeFor(profile, pending);
      // Validate the host before persisting anything: an invalid or SSRF-
      // blocked instance should fail here, not at the first real request.
      if (clean.instance) {
        let nextHost: string;
        try {
          nextHost = resolveHost(clean.instance);
        } catch (error) {
          return fail(error);
        }
        // H-2 — credential host binding: a host change must carry the auth
        // material meant for the new host. Otherwise the user/password stored
        // for the old host would be sent to the new one on the next call.
        // Checked before the confirmation prompt and before any write.
        // D-2: the material required follows the auth method in effect after
        // the change (API key, OAuth secret, …), not only user/password.
        const needed = hostChangeRequirement(
          nextMode,
          oauthGrantFor(profile, pending),
          clean,
          secrets,
        );
        if (needed && instanceChanged(profile, nextHost)) {
          return fail(
            `${CREDENTIALS_INCOMPLETE}: changing the instance of profile "${profile}" to "${nextHost}" requires ${needed} in the same call — the credentials stored for the current instance are never sent to a different host. Nothing was changed.`,
          );
        }
      }
      const summary = describeChange(clean, settings, secrets);
      if (secrets.length > 0) {
        const entered = await elicitSecrets(summary, secrets);
        if (!entered.ok) return entered.refusal;
        Object.assign(settings, entered.values);
      } else {
        const refusal = await confirmCredentialChange(summary);
        if (refusal) return refusal;
      }

      const updated = saveCredentials(clean, profile, settings);
      // L2-04: journal the change — env key names only, never the values.
      const envKeys = envKeysFor(profile);
      appendWriteJournal({
        action: "config",
        table: "config",
        target: `env:${profile}`,
        keys: [
          ...(["instance", "user", "password"] as const)
            .filter((k) => clean[k] !== undefined)
            .map((k) => envKeys[k]),
          ...Object.keys(settings).map((suffix) => authEnvKey(suffix, profile)),
        ],
      });
      // Nothing cached under the old identity may survive the change. The OAuth
      // token cache key omits the password/secret, and the schema and
      // plugin-availability caches are instance-keyed — so a password rotation
      // (same host) or an instance change on this profile would otherwise leave
      // stale entries behind. Clear all of them, and close the connection
      // pools built for the old identity (proxy/TLS dispatchers).
      invalidateTokens();
      disposeDispatchers();
      clearSchemaCache();
      clearPluginAvailability();
      clearCapabilityCache();
      // M-5: servicenow://status (and profile-scoped content) changed.
      await notifyProfileChanged(getServer());
      const status = credentialStatus(profile);
      const acl = envFileAclWarning();
      return ok({
        message: "Credentials saved",
        profile,
        instance: updated.instance,
        user: updated.user,
        password: "***",
        auth: status.mode,
        ...(status.grant ? { grant: status.grant } : {}),
        configured: status.configured,
        ...(status.missing.length ? { missing: status.missing } : {}),
        ...(secrets.length ? { secretsSaved: secrets } : {}),
        ...(acl ? { warnings: [acl] } : {}),
      });
    },
  }),

  defineTool({
    name: "servicenow_list_instances",
    title: "List connection profiles",
    description:
      "List the configured ServiceNow connection profiles (instances): name, host, user, auth method (and OAuth grant), refresh-token state, read-only flag, write mode and whether credentials are complete for that method. Secrets are never included.",
    package: "admin",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    output: { count: z.number(), profiles: z.array(z.unknown()) },
    input: {},
    handler: () => ok(profilesPayload()),
  }),

  defineTool({
    name: "servicenow_use_instance",
    title: "Switch connection profile",
    description:
      "Switch the active ServiceNow connection profile (persisted to the env file). All identity-scoped caches (OAuth tokens, schema, plugin availability) are cleared.",
    package: "admin",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {
      name: shortText(128).describe(
        "Profile to activate, e.g. 'default' or 'dev'.",
      ),
    },
    logFields: (args) => ({ name: args.name }),
    handler: ({ name }) => {
      try {
        const switched = useProfile(name);
        appendWriteJournal({
          action: "config",
          table: "config",
          target: `env:${activeProfile()}`,
          keys: ["SN_ACTIVE_PROFILE"],
        });
        // Nothing cached under the previous identity may survive the switch.
        invalidateTokens();
        disposeDispatchers();
        clearSchemaCache();
        clearPluginAvailability();
        clearCapabilityCache();
        // M-5: servicenow://status (and profile-scoped content) changed.
        void notifyProfileChanged(getServer());
        // H-11 (L3-03): switching to a production profile is called out.
        const env = getProfileEnv();
        if (env === "prod") {
          logger.warn("switched to a production profile", {
            profile: activeProfile(),
          });
        }
        return ok({
          message: "Profile switched",
          activeProfile: activeProfile(),
          instance: switched.instance || "(not set)",
          user: switched.user || "(not set)",
          readOnly: isReadOnly(),
          ...(env ? { environment: env } : {}),
          ...(env === "prod"
            ? {
                warning:
                  "This profile is marked PRODUCTION: writes stay in plan mode unless acknowledged, and destructive applies need confirmation.",
              }
            : {}),
        });
      } catch (error) {
        return fail(error);
      }
    },
  }),

  defineTool({
    name: "servicenow_explain_policy",
    title: "Explain ServiceNow access policy",
    description:
      "Say whether a table may be read or written under the active policy and which rule decides (the guards' own evaluator), or, without a table, return the effective policy. Local; no instance call.",
    package: "admin",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {
      table: tableName().optional().describe("Table to check."),
      action: z.enum(["read", "write"]).optional().describe("Default read."),
    },
    handler: ({ table, action }) =>
      ok(table ? explainTable(table, action ?? "read") : policyPayload()),
  }),

  defineTool({
    name: "servicenow_get_status",
    title: "Get ServiceNow connection status",
    description:
      "Show instance, auth, missing credentials, per-profile write mode, policy, limits, TLS, queue, write counters, version, uptime. Secrets are never shown.",
    package: "admin",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {},
    output: {
      configured: z.boolean(),
      activeProfile: z.string(),
      profiles: z.array(z.string()),
      instance: z.string(),
      user: z.string(),
      passwordSet: z.boolean(),
      authMode: z.string(),
      authWarnings: z.array(z.string()),
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
        perHost: z.record(
          z.object({
            requests: z.number(),
            retries: z.number(),
            errors: z.record(z.number()),
            totalMs: z.number(),
          }),
        ),
      }),
      http: z.object({
        userAgent: z.string(),
        proxy: z.union([
          z.object({ source: z.string(), host: z.string() }),
          z.null(),
        ]),
        tls: z.object({
          ca: z.string(),
          clientCert: z.boolean(),
          verify: z.string(),
        }),
        queue: z.record(z.object({ active: z.number(), queued: z.number() })),
      }),
      sdkManaged: z.object({
        authority: z.string(),
        declared: z.array(z.string()),
        projectDirs: z.array(z.string()),
        scopes: z.array(
          z.object({
            scope: z.union([z.string(), z.null()]),
            scopeId: z.union([z.string(), z.null()]),
            sources: z.array(z.string()),
          }),
        ),
        truncated: z.boolean(),
        warnings: z.array(z.string()),
      }),
      // M-1 (status v2): only the anchor keys are declared (passthrough shape,
      // TOOLS_LIST_BUDGET_CORE); redaction, docs, limits, profileSource ride along.
      server: z.object({ version: z.string(), uptimeSec: z.number() }),
      policy: z.object({ writeMode: z.string(), summary: z.string() }),
      writes: z.record(z.unknown()),
      profileDetails: z.array(z.object({ name: z.string() })),
    },
    handler: () => okStructured(buildStatusPayload()),
  }),

  defineTool({
    name: "servicenow_test_connection",
    title: "Test ServiceNow connection",
    description:
      "Verify that the configured credentials actually work: reads one sys_user record and reports ok/status/latency. Auth and connectivity problems are returned structurally (ok:false), not as errors.",
    package: "admin",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
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

  defineTool({
    name: "servicenow_check_capabilities",
    title: "Check achievable capabilities",
    description:
      "Preflight which sys_* tables the user can read and which capabilities (schema, script intelligence, ACL audit) work — run it before scripts/flows/codecheck on a governed instance. 'groups' picks matrix probes; results are cached (refresh:true).",
    package: "admin",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      degraded: z.boolean(),
      summary: z.string(),
      capabilities: z.unknown(),
      matrix: z.unknown(),
    },
    input: {
      groups: z
        .array(z.enum(MATRIX_GROUPS))
        .max(50)
        .optional()
        .describe(
          "Matrix groups to probe (default: all), one read-only probe each; status is available / unavailable / plan-only / read-only / unknown. update_sets adds canRead / canSet (inferred) and SN_UPDATE_SET. The sys_* table preflight always runs.",
        ),
      refresh: z
        .boolean()
        .optional()
        .describe(
          "Discard cached capability and plugin-availability results (SN_CAPABILITY_TTL_MS / SN_PLUGIN_NEGATIVE_TTL_MS) and probe again.",
        ),
    },
    logFields: (args) => ({
      groups: args.groups?.join(","),
      refresh: args.refresh,
    }),
    handler: async ({ groups, refresh }) =>
      ok(await checkCapabilities({ groups, refresh })),
  }),

  defineTool({
    name: "servicenow_list_packages",
    title: "List tool packages",
    description:
      "List the tool packages with their state for this session: enabled, configured (SN_TOOL_PACKAGES), denied, read-only and tool count. Toggle one with servicenow_enable_package / servicenow_disable_package.",
    package: "admin",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {},
    output: {
      packages: z.array(z.unknown()),
      enabled: z.array(z.string()),
    },
    handler: () => {
      const session = currentPackageSession();
      if (!session) return fail(NO_SESSION);
      return okStructured({
        packages: session.list(),
        enabled: session.enabledPackages(),
      });
    },
  }),

  defineTool({
    name: "servicenow_enable_package",
    title: "Enable a tool package",
    description:
      "Enable a tool package for this session: its tools, resources and prompts appear (list_changed is sent). Denied packages are refused; a read-only package brings only its read tools. Ends with the session.",
    package: "admin",
    annotations: TOGGLE_ANNOTATIONS,
    input: {
      name: shortText(64).describe(
        "Package name, e.g. 'codecheck' (see servicenow_list_packages).",
      ),
    },
    output: TOGGLE_OUTPUT,
    logFields: (args) => ({ name: args.name }),
    handler: ({ name }) => togglePackage(name, true),
  }),

  defineTool({
    name: "servicenow_disable_package",
    title: "Disable a tool package",
    description:
      "Disable a tool package for this session: its tools, resources and prompts are withdrawn (list_changed is sent). The admin tools cannot be disabled.",
    package: "admin",
    annotations: TOGGLE_ANNOTATIONS,
    input: {
      name: shortText(64).describe(
        "Package name, e.g. 'codecheck' (see servicenow_list_packages).",
      ),
    },
    output: TOGGLE_OUTPUT,
    logFields: (args) => ({ name: args.name }),
    handler: ({ name }) => togglePackage(name, false),
  }),
];
