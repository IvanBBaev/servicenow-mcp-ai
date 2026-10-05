import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  runSpec,
  buildInputSchema,
  buildOutputSchema,
  type AnyToolSpec,
  type PackageSpec,
} from "./define.js";
import {
  legacyToolNames,
  TOOL_OVERLAPS,
  TOOL_RENAMES,
  type ToolRename,
} from "./naming.js";
import {
  registerAdminResources,
  registerSchemaResources,
  registerTableResources,
  registerDocsResources,
  registerInstanceResources,
  registerArtifactResources,
  registerToolsReferenceResource,
  registerToolReferenceTemplate,
  type ToolReferenceDetail,
} from "./resources.js";
import { linkToolView, mcpAppsEnabled, registerAppResources } from "./apps.js";
import { specs as tableSpecs } from "../tools/table.js";
import { specs as metaSpecs } from "../tools/meta.js";
import { specs as aggregateSpecs } from "../tools/aggregate.js";
import { specs as attachmentSpecs } from "../tools/attachment.js";
import { specs as importsetSpecs } from "../tools/importset.js";
import { specs as batchSpecs } from "../tools/batch.js";
import { specs as catalogSpecs } from "../tools/catalog.js";
import { specs as changeSpecs } from "../tools/change.js";
import { specs as knowledgeSpecs } from "../tools/knowledge.js";
import { specs as cmdbSpecs } from "../tools/cmdb.js";
import { specs as scriptSpecs } from "../tools/scripts.js";
import { specs as flowSpecs } from "../tools/flows.js";
import { specs as codecheckSpecs } from "../tools/codecheck.js";
import { specs as docsSpecs } from "../tools/docs.js";
import { specs as instanceSpecs } from "../tools/instance.js";
import { specs as emailSpecs } from "../tools/email.js";
import { specs as atfSpecs } from "../tools/atf.js";
import { specs as revertSpecs } from "../tools/revert.js";
import { specs as artifactsSpecs } from "../tools/artifacts.js";
import { specs as updatesetsSpecs } from "../tools/updatesets.js";
import { specs as opsSpecs } from "../tools/ops.js";
import { specs as historySpecs } from "../tools/history.js";
import { specs as propertiesSpecs } from "../tools/properties.js";
import { specs as directorySpecs } from "../tools/directory.js";
import { specs as uiSpecs } from "../tools/ui.js";
import { specs as adminSpecs } from "../tools/admin.js";
import {
  getRequestedPackages,
  getDeniedPackages,
  getReadOnlyPackages,
} from "../core/settings.js";
import { logger } from "../core/logging.js";
import { timeToolCall } from "../core/metrics.js";
import { runWithRuntime, type Runtime } from "../core/runtime.js";
import { runMaybeAsTask, withTaskInput, withTaskOutput } from "./tasks.js";
import {
  PackageSession,
  bindPackageSession,
  enableResourceSubscriptions,
  packageSessionOf,
} from "./packages.js";

/**
 * The package manifest (A2-1): a package is ONE object — its tools plus its
 * optional MCP resources. Plugging a package in or out touches exactly this
 * list; registration, gating, docs generators and snapshot tests all read it.
 * Admin stays last so the generated README keeps its ordering.
 */
export const PACKAGES: PackageSpec[] = [
  { name: "table", tools: tableSpecs, resources: registerTableResources },
  { name: "schema", tools: metaSpecs, resources: registerSchemaResources },
  { name: "aggregate", tools: aggregateSpecs },
  { name: "attachment", tools: attachmentSpecs },
  { name: "importset", tools: importsetSpecs },
  { name: "batch", tools: batchSpecs },
  { name: "catalog", tools: catalogSpecs },
  { name: "change", tools: changeSpecs },
  { name: "knowledge", tools: knowledgeSpecs },
  { name: "cmdb", tools: cmdbSpecs },
  { name: "scripts", tools: scriptSpecs },
  { name: "flows", tools: flowSpecs },
  { name: "codecheck", tools: codecheckSpecs },
  { name: "docs", tools: docsSpecs, resources: registerDocsResources },
  {
    name: "instance",
    tools: instanceSpecs,
    resources: registerInstanceResources,
  },
  { name: "email", tools: emailSpecs },
  { name: "atf", tools: atfSpecs },
  { name: "revert", tools: revertSpecs },
  {
    name: "artifacts",
    tools: artifactsSpecs,
    resources: registerArtifactResources,
  },
  { name: "updatesets", tools: updatesetsSpecs },
  { name: "ops", tools: opsSpecs },
  { name: "history", tools: historySpecs },
  { name: "properties", tools: propertiesSpecs },
  { name: "directory", tools: directorySpecs },
  { name: "ui", tools: uiSpecs },
  { name: "admin", tools: adminSpecs, resources: registerAdminResources },
];

// Invariant: a tool's own package tag must match the manifest entry it sits in.
for (const pkg of PACKAGES) {
  for (const tool of pkg.tools) {
    if (tool.package !== pkg.name) {
      throw new Error(
        `Tool ${tool.name} is tagged '${tool.package}' but listed under package '${pkg.name}'.`,
      );
    }
  }
}

/** Every tool of every package, flattened from the package manifest. */
export const ALL_TOOLS: AnyToolSpec[] = PACKAGES.flatMap((p) => p.tools);

/** Canonical package set (admin is the always-on management surface, not a package). */
export const ALL_PACKAGES: string[] = [
  ...new Set(ALL_TOOLS.map((t) => t.package).filter((p) => p !== "admin")),
];

/** The default package set when SN_TOOL_PACKAGES is unset or unusable. */
const CORE_PROFILE = ["table", "schema", "aggregate", "attachment"];

/**
 * The read-first surface: browse data and inspect schema without any write or
 * scripting tools. The base for the `developer` preset.
 */
const READER_PROFILE = ["table", "schema", "aggregate"];

/**
 * The developer surface: the reader set plus the build/inspect packages —
 * scripts, flows, code check, and the docs/diagram generators. (There is no
 * separate `diagrams` package; the Mermaid generators live in `docs` and
 * `scripts`.)
 */
const DEVELOPER_PROFILE = [
  ...READER_PROFILE,
  "scripts",
  "flows",
  "codecheck",
  "docs",
];

/**
 * Named profiles that expand to a set of packages, resolved by
 * {@link resolveEnabledPackages}. `core` is the default profile loaded when
 * SN_TOOL_PACKAGES is unset; `all` (and its `admin` alias) enables everything.
 * The `reader` / `developer` / `admin` presets (UX review §11) give clients a
 * memorable name for the common surfaces instead of a hand-typed package list;
 * a preset may still be combined with explicit packages in SN_TOOL_PACKAGES.
 */
const PROFILES: Record<string, string[]> = {
  core: CORE_PROFILE,
  all: ALL_PACKAGES,
  reader: READER_PROFILE,
  developer: DEVELOPER_PROFILE,
  admin: ALL_PACKAGES,
};

/**
 * Resolve requested package/profile names into a concrete package set.
 * Unknown names are ignored (with a warning); an empty result falls back to
 * the `core` profile so the server always exposes a usable tool set.
 */
export function resolveEnabledPackages(requested: string[]): Set<string> {
  const enabled = new Set<string>();
  for (const name of requested) {
    const profile = PROFILES[name];
    if (profile) {
      for (const p of profile) enabled.add(p);
    } else if (ALL_PACKAGES.includes(name)) {
      enabled.add(name);
    } else {
      logger.warn("Unknown tool package ignored", { package: name });
    }
  }
  if (enabled.size === 0) {
    for (const p of CORE_PROFILE) enabled.add(p);
  }
  return enabled;
}

/** Compact description of one registered tool (docs generator, snapshot tests). */
export interface ToolInfo {
  package: string;
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  /** The full MCP annotations as registered (snapshot-tested in M-6). */
  annotations: Record<string, unknown>;
}

/** Enumerate every tool with its package, straight from the manifest. */
export function describeAllTools(): ToolInfo[] {
  return ALL_TOOLS.map((spec) => ({
    package: spec.package,
    name: spec.name,
    title: spec.title,
    description: spec.description,
    readOnly: spec.annotations.readOnlyHint === true,
    annotations: { ...spec.annotations },
  }));
}

/** A tool's registered JSON Schemas, exactly as tools/list publishes them. */
export interface ToolSchemas {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/**
 * M-6: the input (and output) JSON Schema of every tool, converted the way
 * the SDK converts them for tools/list — pinned by the manifest v2 fixture.
 * Kept apart from describeAllTools(), which also feeds the status payload.
 */
export function describeToolSchemas(): ToolSchemas[] {
  return ALL_TOOLS.map(toolSchemas);
}

/** One tool's JSON Schemas (describeToolSchemas, per spec). */
function toolSchemas(spec: AnyToolSpec): ToolSchemas {
  const output = buildOutputSchema(spec);
  return {
    name: spec.name,
    inputSchema: toJsonSchemaCompat(buildInputSchema(spec, { legacy: false }), {
      strictUnions: true,
      pipeStrategy: "input",
    }),
    ...(output
      ? {
          outputSchema: toJsonSchemaCompat(output, {
            strictUnions: true,
            pipeStrategy: "output",
          }),
        }
      : {}),
  };
}

/** N-37: reference details per tool name, built on the first read. */
let toolDetails: Map<string, ToolReferenceDetail> | undefined;

/**
 * N-37: one tool's schemas and naming metadata for
 * servicenow://reference/tools/{name}; the schemas are converted once.
 */
export function describeToolDetail(
  name: string,
): ToolReferenceDetail | undefined {
  if (!toolDetails) {
    const naming = new Map(describeNaming().tools.map((n) => [n.name, n]));
    toolDetails = new Map(
      ALL_TOOLS.map((spec) => {
        const { inputSchema, outputSchema } = toolSchemas(spec);
        const { legacyParams, deprecatedParams, overlap } =
          naming.get(spec.name) ?? {};
        return [
          spec.name,
          {
            inputSchema,
            ...(outputSchema ? { outputSchema } : {}),
            ...(legacyParams ? { legacyParams } : {}),
            ...(deprecatedParams ? { deprecatedParams } : {}),
            ...(overlap ? { overlap } : {}),
          },
        ];
      }),
    );
  }
  return toolDetails.get(name);
}

/** M-7: one tool's naming metadata for the manifest. */
export interface ToolNamingInfo {
  name: string;
  /** v2 parameter names accepted only under SN_LEGACY_TOOL_NAMES=1 (old -> new). */
  legacyParams?: Record<string, string>;
  /** Deprecated parameter aliases accepted always (old -> new). */
  deprecatedParams?: Record<string, string>;
  /** Why the tool is kept although it overlaps another (TE-4). */
  overlap?: string;
}

/**
 * M-7: the naming contract — every v2 -> v3 tool rename and, per tool, its
 * parameter aliases and overlap reason. Feeds manifest v4.
 */
export function describeNaming(): {
  renames: ToolRename[];
  tools: ToolNamingInfo[];
} {
  return {
    renames: TOOL_RENAMES.map((r) => ({ ...r })),
    tools: ALL_TOOLS.map((spec) => {
      const overlap = TOOL_OVERLAPS[spec.name];
      return {
        name: spec.name,
        ...(spec.legacyParams
          ? { legacyParams: { ...spec.legacyParams } }
          : {}),
        ...(spec.deprecatedParams
          ? { deprecatedParams: { ...spec.deprecatedParams } }
          : {}),
        ...(overlap ? { overlap } : {}),
      };
    }),
  };
}

/** The package policy currently in effect (also shown in the status payload). */
export function effectivePackages(): {
  enabled: string[];
  denied: string[];
  readOnly: string[];
} {
  const denied = new Set(getDeniedPackages());
  const enabled = [...resolveEnabledPackages(getRequestedPackages())].filter(
    (p) => !denied.has(p),
  );
  return {
    enabled: enabled.sort(),
    denied: [...denied].sort(),
    readOnly: getReadOnlyPackages().sort(),
  };
}

/**
 * The tool specs this process registers under the current package policy:
 * `admin` always, else the enabled packages minus the write tools of a
 * read-only package. Shared by `registerAllTools` and the M-1 server
 * instructions, so the advertised count is the registered one.
 */
export function activeToolSpecs(log = false): AnyToolSpec[] {
  const { enabled, readOnly } = effectivePackages();
  const enabledSet = new Set(enabled);
  const readOnlySet = new Set(readOnly);
  return ALL_TOOLS.filter((spec) => {
    if (spec.package === "admin") return true;
    if (!enabledSet.has(spec.package)) return false;
    if (
      readOnlySet.has(spec.package) &&
      spec.annotations.readOnlyHint !== true
    ) {
      if (log) {
        logger.debug("Write tool skipped (package is read-only)", {
          tool: spec.name,
          package: spec.package,
        });
      }
      return false;
    }
    return true;
  });
}

/**
 * Whether the policy axes allow `spec` to exist in this process at all: admin
 * always; otherwise its package is not denied, and a read-only package keeps
 * only its read tools. M-5 registers exactly this set up front and toggles it.
 */
function policyPermits(
  spec: AnyToolSpec,
  denied: ReadonlySet<string>,
  readOnly: ReadonlySet<string>,
): boolean {
  if (spec.package === "admin") return true;
  if (denied.has(spec.package)) return false;
  return !(
    readOnly.has(spec.package) && spec.annotations.readOnlyHint !== true
  );
}

/**
 * Register the always-on admin tools plus every manifest tool the package
 * policy permits (not in SN_PACKAGES_DENY; only read tools of a package in
 * SN_PACKAGES_READONLY). Tools of packages SN_TOOL_PACKAGES does not enable
 * are registered disabled (M-5), so tools/list is unchanged until a client
 * calls servicenow_enable_package; the handles live in a PackageSession.
 *
 * Every tool call runs bound to `runtime` (E-3): the caches, queue, breakers,
 * dispatchers and telemetry it touches are that runtime's, whatever the
 * process-wide default is — the seam H-7 uses for per-session state.
 */
export function registerAllTools(server: McpServer, runtime: Runtime): void {
  const { enabled, denied, readOnly } = effectivePackages();
  const deniedSet = new Set(denied);
  const readOnlySet = new Set(readOnly);
  const session = new PackageSession(
    server,
    ALL_PACKAGES,
    new Set(enabled),
    deniedSet,
    readOnlySet,
  );
  // Logs the read-only skips of the configured surface, as before M-5.
  activeToolSpecs(true);

  const legacy = legacyToolNames();
  // N-50: under SN_MCP_APPS=1 the tools with a view link to it (_meta.ui).
  const apps = mcpAppsEnabled();
  const register = (
    spec: AnyToolSpec,
    name: string,
    title: string,
    description: string,
    onCall?: () => void,
  ) =>
    server.registerTool(
      name,
      {
        title,
        description,
        annotations: spec.annotations,
        // M-8: a real strict z.object (no cast) — see buildInputSchema. Every
        // tool also gets the automatic `instance` (profile) parameter (MI-3),
        // unless its own schema already uses that name.
        // M-9: `run_as_task` only when SN_EXPERIMENTAL_TASKS is on.
        // M-7: the legacy parameter names only when SN_LEGACY_TOOL_NAMES is on.
        inputSchema: withTaskInput(spec, buildInputSchema(spec, { legacy })),
        // M-6: a passthrough z.object — see buildOutputSchema.
        ...(spec.output
          ? { outputSchema: withTaskOutput(spec, buildOutputSchema(spec)!) }
          : {}),
      },
      // M-3: the whole SDK `extra` reaches runSpec — cancellation signal,
      // progressToken + sendNotification, request and session ids.
      // E-5: every call is timed into the runtime's per-tool statistics.
      // M-9: `run_as_task:true` returns a task handle and runs in background.
      (args, extra) => {
        onCall?.();
        return runWithRuntime(runtime, () =>
          runMaybeAsTask(spec, args, extra, (a, e) =>
            timeToolCall(spec.name, () => runSpec(spec, a, e)),
          ),
        );
      },
    );

  for (const spec of ALL_TOOLS) {
    if (!policyPermits(spec, deniedSet, readOnlySet)) continue;
    const handle = register(spec, spec.name, spec.title, spec.description);
    if (apps) linkToolView(server, spec, handle);
    session.addTool(spec.package, spec.name, handle);
  }

  // M-7 (B2): under SN_LEGACY_TOOL_NAMES=1 every v2 name is an alias that
  // dispatches to its v3 tool (same schema, same handler, logged under the
  // v3 name) and follows that tool's package. Off: the old names do not exist.
  if (legacy) {
    const byName = new Map(ALL_TOOLS.map((s) => [s.name as string, s]));
    for (const rename of TOOL_RENAMES) {
      const spec = byName.get(rename.to);
      if (!spec || !policyPermits(spec, deniedSet, readOnlySet)) continue;
      let warned = false;
      const handle = register(
        spec,
        rename.from,
        `${spec.title} (deprecated name)`,
        `Deprecated alias of ${spec.name} (SN_LEGACY_TOOL_NAMES=1); use ${spec.name}. ${spec.description}`,
        () => {
          if (warned) return;
          warned = true;
          logger.warn(
            `Tool ${rename.from} is a deprecated alias — use ${spec.name}.`,
          );
        },
      );
      if (apps) linkToolView(server, spec, handle);
      session.addAlias(spec.package, handle);
    }
  }
  bindPackageSession(session, runtime);

  logger.info("Tools registered", {
    packages: enabled,
    deniedPackages: denied,
    readOnlyPackages: readOnly,
  });
}

/**
 * Register package-scoped MCP resources declaratively from the manifest:
 * the admin (status) resource and the tool reference (M-4) are always on;
 * the rest follow the same enabled/denied package policy as the tools. With
 * a package session (M-5) they follow its live state instead, and the server
 * declares resources.subscribe for servicenow://status updates.
 */
export function registerResources(server: McpServer): void {
  const session = packageSessionOf(server);
  const policy = effectivePackages();
  const enabledSet = new Set(policy.enabled);
  const deniedSet = new Set(policy.denied);
  // N-38: the always-on resources first, the package resources last and in
  // manifest order, so resources/list keeps one order across package toggles.
  for (const pkg of PACKAGES) {
    if (pkg.name === "admin") pkg.resources?.(server);
  }
  // N-50: the ui:// MCP Apps views, only under SN_MCP_APPS=1.
  if (mcpAppsEnabled()) registerAppResources(server);
  const reference = () => ({
    tools: describeAllTools(),
    ...effectivePackages(),
    ...(session?.modified() ? { enabled: session.enabledPackages() } : {}),
  });
  registerToolsReferenceResource(server, reference);
  // N-37: the full definition of one tool, for lean descriptions to point at.
  registerToolReferenceTemplate(server, {
    reference,
    detail: describeToolDetail,
    renames: TOOL_RENAMES,
  });
  for (const pkg of PACKAGES) {
    if (!pkg.resources || pkg.name === "admin") continue;
    if (session) {
      if (!deniedSet.has(pkg.name))
        session.addResources(pkg.name, pkg.resources);
    } else if (enabledSet.has(pkg.name)) pkg.resources(server);
  }
  if (session) enableResourceSubscriptions(server);
}
