import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTableTools } from "../tools/table.js";
import { registerAdminTools } from "../tools/admin.js";
import { registerAttachmentTools } from "../tools/attachment.js";
import { registerAggregateTools } from "../tools/aggregate.js";
import { registerImportSetTools } from "../tools/importset.js";
import { registerMetaTools } from "../tools/meta.js";
import { registerBatchTools } from "../tools/batch.js";
import { registerCatalogTools } from "../tools/catalog.js";
import { registerChangeTools } from "../tools/change.js";
import { registerKnowledgeTools } from "../tools/knowledge.js";
import { registerCmdbTools } from "../tools/cmdb.js";
import { registerScriptTools } from "../tools/scripts.js";
import { registerDocsTools } from "../tools/docs.js";
import {
  getRequestedPackages,
  getDeniedPackages,
  getReadOnlyPackages,
} from "../core/settings.js";
import { logger } from "../core/logging.js";

/** A registrable group of tools, tagged with the package it belongs to. */
interface ToolGroup {
  package: string;
  register: (server: McpServer) => void;
}

/**
 * Every gated tool group and its package. The admin group (credentials +
 * status) is intentionally not listed here — it is always registered below as
 * the server's own management surface, regardless of the active packages.
 */
const TOOL_GROUPS: ToolGroup[] = [
  { package: "table", register: registerTableTools },
  { package: "schema", register: registerMetaTools },
  { package: "aggregate", register: registerAggregateTools },
  { package: "attachment", register: registerAttachmentTools },
  { package: "importset", register: registerImportSetTools },
  { package: "batch", register: registerBatchTools },
  { package: "catalog", register: registerCatalogTools },
  { package: "change", register: registerChangeTools },
  { package: "knowledge", register: registerKnowledgeTools },
  { package: "cmdb", register: registerCmdbTools },
  { package: "scripts", register: registerScriptTools },
  { package: "docs", register: registerDocsTools },
];

/** Canonical set of packages, derived from the tool groups. */
export const ALL_PACKAGES: string[] = [
  ...new Set(TOOL_GROUPS.map((g) => g.package)),
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

/**
 * Enumerate every tool with its package by replaying the registrations
 * against a capturing stub. The README generator and its sync test read the
 * same truth the server registers — the list cannot drift from the code.
 */
export function describeAllTools(): ToolInfo[] {
  const out: ToolInfo[] = [];
  const capture = (pkg: string): McpServer =>
    ({
      registerTool: (
        name: string,
        config: {
          title?: string;
          description?: string;
          annotations?: { readOnlyHint?: boolean } & Record<string, unknown>;
        },
      ) => {
        out.push({
          package: pkg,
          name,
          title: config.title ?? "",
          description: config.description ?? "",
          readOnly: config.annotations?.readOnlyHint === true,
          annotations: config.annotations ?? {},
        });
      },
    }) as unknown as McpServer;
  for (const group of TOOL_GROUPS) group.register(capture(group.package));
  registerAdminTools(capture("admin"));
  return out;
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
 * A facade over the server that registers only tools flagged readOnlyHint —
 * how SN_PACKAGES_READONLY strips the write tools out of a package without
 * the tool files knowing about the policy.
 */
function readOnlyToolsOnly(server: McpServer, pkg: string): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "registerTool") {
        return Reflect.get(target, prop, receiver) as unknown;
      }
      // registerTool is generic over the zod shape, so the passthrough has to
      // be typed loosely; the facade neither reads nor changes the arguments.
      const register = target.registerTool.bind(target) as (
        ...a: unknown[]
      ) => unknown;
      return (...args: unknown[]) => {
        const config = args[1] as {
          annotations?: { readOnlyHint?: boolean };
        };
        if (config.annotations?.readOnlyHint === true) {
          return register(...args);
        }
        logger.debug("Write tool skipped (package is read-only)", {
          tool: args[0],
          package: pkg,
        });
        return undefined;
      };
    },
  });
}

/**
 * Register the always-on admin tools plus every tool group whose package is
 * enabled by SN_TOOL_PACKAGES, minus SN_PACKAGES_DENY; packages listed in
 * SN_PACKAGES_READONLY register only their read tools.
 */
export function registerAllTools(server: McpServer): void {
  const { enabled, denied, readOnly } = effectivePackages();
  const enabledSet = new Set(enabled);
  const readOnlySet = new Set(readOnly);
  // Always available so the server can be inspected/configured even when a
  // narrow package set is active.
  registerAdminTools(server);
  for (const group of TOOL_GROUPS) {
    if (!enabledSet.has(group.package)) continue;
    const target = readOnlySet.has(group.package)
      ? readOnlyToolsOnly(server, group.package)
      : server;
    group.register(target);
  }
  logger.info("Tools registered", {
    packages: enabled,
    deniedPackages: denied,
    readOnlyPackages: readOnly,
  });
}
