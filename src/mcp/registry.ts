import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  runSpec,
  hasAutoInstanceParam,
  type AnyToolSpec,
  type PackageSpec,
} from "./define.js";
import {
  registerStatusResource,
  registerSchemaResources,
  registerDocsResources,
  registerInstanceResources,
} from "./resources.js";
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
import { specs as docsSpecs } from "../tools/docs.js";
import { specs as instanceSpecs } from "../tools/instance.js";
import { specs as emailSpecs } from "../tools/email.js";
import { specs as adminSpecs } from "../tools/admin.js";
import {
  getRequestedPackages,
  getDeniedPackages,
  getReadOnlyPackages,
} from "../core/settings.js";
import { logger } from "../core/logging.js";

/**
 * The package manifest (A2-1): a package is ONE object — its tools plus its
 * optional MCP resources. Plugging a package in or out touches exactly this
 * list; registration, gating, docs generators and snapshot tests all read it.
 * Admin stays last so the generated README keeps its ordering.
 */
export const PACKAGES: PackageSpec[] = [
  { name: "table", tools: tableSpecs },
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
  { name: "docs", tools: docsSpecs, resources: registerDocsResources },
  {
    name: "instance",
    tools: instanceSpecs,
    resources: registerInstanceResources,
  },
  { name: "email", tools: emailSpecs },
  { name: "admin", tools: adminSpecs, resources: registerStatusResource },
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
 * Named profiles that expand to a set of packages. `core` is the default
 * profile loaded when SN_TOOL_PACKAGES is unset; `all` enables everything.
 */
const PROFILES: Record<string, string[]> = {
  core: CORE_PROFILE,
  all: ALL_PACKAGES,
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
  /** The full MCP annotations as registered (snapshot-tested in М-6). */
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
 * Register the always-on admin tools plus every manifest tool whose package is
 * enabled by SN_TOOL_PACKAGES, minus SN_PACKAGES_DENY; packages listed in
 * SN_PACKAGES_READONLY register only their read tools.
 */
export function registerAllTools(server: McpServer): void {
  const { enabled, denied, readOnly } = effectivePackages();
  const enabledSet = new Set(enabled);
  const readOnlySet = new Set(readOnly);

  for (const spec of ALL_TOOLS) {
    if (spec.package !== "admin") {
      if (!enabledSet.has(spec.package)) continue;
      if (
        readOnlySet.has(spec.package) &&
        spec.annotations.readOnlyHint !== true
      ) {
        logger.debug("Write tool skipped (package is read-only)", {
          tool: spec.name,
          package: spec.package,
        });
        continue;
      }
    }
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        annotations: spec.annotations,
        // Strict object: an unknown argument (e.g. a typo like 'tabel') is a
        // visible validation error instead of being stripped silently. Every
        // tool also gets the automatic `instance` (profile) parameter (MI-3),
        // unless its own schema already uses that name.
        inputSchema: z
          .object(
            hasAutoInstanceParam(spec)
              ? {
                  ...spec.input,
                  instance: z
                    .string()
                    .optional()
                    .describe(
                      "Connection profile to use for this call (default: the active profile). See servicenow_list_instances.",
                    ),
                }
              : spec.input,
          )
          .strict() as unknown as typeof spec.input,
        ...(spec.output ? { outputSchema: spec.output } : {}),
      },
      (args) => runSpec(spec, args),
    );
  }

  logger.info("Tools registered", {
    packages: enabled,
    deniedPackages: denied,
    readOnlyPackages: readOnly,
  });
}

/**
 * Register package-scoped MCP resources declaratively from the manifest:
 * the admin (status) resource is always on; the rest follow the same
 * enabled/denied package policy as the tools.
 */
export function registerResources(server: McpServer): void {
  const enabledSet = new Set(effectivePackages().enabled);
  for (const pkg of PACKAGES) {
    if (!pkg.resources) continue;
    if (pkg.name !== "admin" && !enabledSet.has(pkg.name)) continue;
    pkg.resources(server);
  }
}
