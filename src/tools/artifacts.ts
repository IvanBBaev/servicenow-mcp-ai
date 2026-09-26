import { z } from "zod";
import { listArtifacts, getArtifact, LIST_LIMIT } from "../api/artifacts.js";
import { explainArtifact } from "../api/explain-artifact.js";
import {
  artifactDependencies,
  dependencyMermaid,
  DEPENDENCY_DEPTH,
  DEPENDENCY_LIMIT,
} from "../api/dependencies.js";
import { okStructured } from "../mcp/result.js";
import {
  defineTool,
  encodedQuery,
  shortText,
  sysId,
  type AnyToolSpec,
} from "../mcp/define.js";

// A plain string, not an enum: the registry has dozens of types and an enum
// would cost tokens in every tools/list (SDK-PARITY §5(d)). The resource lists
// them; an unknown type fails with the valid ones in the message.
const artifactTypeInput = shortText(80)
  .min(1)
  .describe(
    "Artifact type id from the registry, e.g. 'business_rule', 'ui_policy', 'sp_widget', 'flow'. Read the servicenow://artifact-types resource for every type with its table and key fields.",
  );

const keyValue = z.union([shortText(), z.number(), z.boolean()]);

const artifactRefInput = {
  artifactType: artifactTypeInput,
  sys_id: sysId()
    .optional()
    .describe("sys_id of the record. Pass this or 'key', not both."),
  key: z
    .union([
      keyValue,
      z.record(keyValue).refine((o) => Object.keys(o).length <= 10, {
        message: "A key has at most 10 fields.",
      }),
    ])
    .optional()
    .describe(
      "The type's natural key (keyFields in servicenow://artifact-types): a plain value for a single key field, e.g. a portal page id, or an object with every key field. Pass this or 'sys_id', not both.",
    ),
};

const scopeOutput = z.object({
  sys_id: z.string().nullable(),
  scope: z.string().nullable(),
});

const sdkManagedOutput = z.object({
  managed: z.enum(["yes", "no", "unknown"]),
  unverified: z.boolean(),
  evidence: z.array(z.unknown()),
  warnings: z.array(z.string()).optional(),
});

const degradedOutput = z
  .object({ status: z.number(), reason: z.string() })
  .optional();

/** Set on a degraded read: whether the instance has the type's table at all. */
const availableOutput = z.boolean().optional();

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_artifacts",
    title: "List artifacts",
    description:
      "List records of any registry artifact type (business rules, UI policies, widgets, flows, catalog items, …) as summaries: sys_id, name, key, scope, active, SDK-managed verdict; no script bodies. verified:false types carry a caveat.",
    package: "artifacts",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      artifactType: artifactTypeInput,
      scope: shortText()
        .optional()
        .describe(
          "Restrict to one application scope: its namespace (e.g. 'global', 'x_acme_app') or its sys_scope sys_id.",
        ),
      query: encodedQuery()
        .optional()
        .describe(
          "Extra encoded query ANDed with the type's own filter, e.g. 'nameLIKEincident'.",
        ),
      active: z
        .boolean()
        .optional()
        .describe(
          "Only active (true) or inactive (false) records; refused for types without an active flag.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(LIST_LIMIT.max)
        .optional()
        .describe(
          `Maximum records to return (default ${LIST_LIMIT.default}, max ${LIST_LIMIT.max}).`,
        ),
    },
    output: {
      artifactType: z.string(),
      table: z.string(),
      verified: z.boolean(),
      caveat: z.string().optional(),
      count: z.number(),
      total: z.number().optional(),
      artifacts: z.array(
        z
          .object({
            sys_id: z.string(),
            name: z.string(),
            key: z.record(z.string()),
            scope: scopeOutput,
            active: z.boolean().optional(),
            sdkManaged: z.enum(["yes", "no", "unknown"]),
          })
          .passthrough(),
      ),
      missingFields: z.array(z.string()).optional(),
      degraded: degradedOutput,
      available: availableOutput,
    },
    handler: async (args) => okStructured(await listArtifacts(args)),
  }),

  defineTool({
    name: "servicenow_get_artifact",
    title: "Get artifact",
    description:
      "Read one artifact of any registry type in full: the record, its registry child records (e.g. UI policy actions, portal page layout, flow actions), scope and SDK-managed verdict. By sys_id or natural key; denied child tables show as redacted.",
    package: "artifacts",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: artifactRefInput,
    output: {
      artifactType: z.string(),
      table: z.string(),
      verified: z.boolean(),
      caveat: z.string().optional(),
      sys_id: z.string().optional(),
      name: z.string().optional(),
      key: z.record(z.string()).optional(),
      scope: scopeOutput.optional(),
      sdkManaged: sdkManagedOutput.optional(),
      record: z.record(z.unknown()).nullable(),
      children: z.array(
        z
          .object({
            table: z.string(),
            parentField: z.string(),
            parentTable: z.string().optional(),
            verified: z.boolean(),
            count: z.number(),
            truncated: z.boolean().optional(),
            records: z.array(z.record(z.unknown())),
            redacted: z.boolean().optional(),
            reason: z.string().optional(),
            error: z.string().optional(),
            status: z.number().optional(),
          })
          .passthrough(),
      ),
      missingFields: z.array(z.string()).optional(),
      degraded: degradedOutput,
      available: availableOutput,
    },
    handler: async (args) => okStructured(await getArtifact(args)),
  }),

  defineTool({
    name: "servicenow_explain_artifact",
    title: "Explain artifact",
    description:
      "Explain one artifact of any registry type: summary, trigger fields, non-empty fields, children, referenced records, decoded JSON fields (raw with decoded:false when undecodable) and type-specific readings (state models, policy effects).",
    package: "artifacts",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: artifactRefInput,
    output: {
      artifactType: z.string(),
      table: z.string(),
      verified: z.boolean(),
      caveat: z.string().optional(),
      sys_id: z.string().optional(),
      name: z.string().optional(),
      key: z.record(z.string()).optional(),
      scope: scopeOutput.optional(),
      sdkManaged: sdkManagedOutput.optional(),
      missingFields: z.array(z.string()).optional(),
      summary: z.string(),
      when: z.record(z.unknown()).nullable(),
      fields: z.record(z.unknown()),
      truncatedFields: z.array(z.string()).optional(),
      explanation: z
        .object({ kind: z.string(), lines: z.array(z.string()) })
        .passthrough()
        .optional(),
      children: z.array(
        z
          .object({
            table: z.string(),
            count: z.number(),
            items: z.array(z.record(z.unknown())),
            omitted: z.number().optional(),
          })
          .passthrough(),
      ),
      references: z.array(
        z
          .object({ field: z.string(), table: z.string(), sys_id: z.string() })
          .passthrough(),
      ),
      decoded: z.array(
        z
          .object({
            source: z.string(),
            field: z.string(),
            decoder: z.string(),
            decoded: z.boolean(),
          })
          .passthrough(),
      ),
      degraded: degradedOutput,
      available: availableOutput,
    },
    handler: async (args) => okStructured(await explainArtifact(args)),
  }),

  defineTool({
    name: "servicenow_artifact_dependencies",
    title: "Artifact dependencies",
    description:
      "Dependency graph of one artifact: outbound (reference fields, decoded JSON, script calls and GlideRecord tables) and inbound (reverse reference queries, script and flow-step callers, structural refs). Depth-capped; JSON or Mermaid.",
    package: "artifacts",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      ...artifactRefInput,
      direction: z
        .enum(["outbound", "inbound", "both"])
        .optional()
        .describe(
          "'outbound' what the artifact uses, 'inbound' what uses it, 'both' (default).",
        ),
      depth: z
        .number()
        .int()
        .min(1)
        .max(DEPENDENCY_DEPTH.max)
        .optional()
        .describe(
          `Levels to walk from the artifact (default ${DEPENDENCY_DEPTH.default}); cycles are visited once.`,
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(DEPENDENCY_LIMIT.max)
        .optional()
        .describe(
          `Rows kept per inbound source read (default ${DEPENDENCY_LIMIT.default}).`,
        ),
      format: z
        .enum(["json", "mermaid"])
        .optional()
        .describe(
          "'json' (default) nodes and edges; 'mermaid' a graph LR diagram with the counts.",
        ),
    },
    output: {
      artifactType: z.string(),
      table: z.string(),
      verified: z.boolean(),
      caveat: z.string().optional(),
      sys_id: z.string().optional(),
      name: z.string().optional(),
      root: z.string().nullable(),
      direction: z.enum(["outbound", "inbound", "both"]),
      depth: z.number(),
      count: z.object({
        nodes: z.number(),
        edges: z.number(),
        outbound: z.number(),
        inbound: z.number(),
      }),
      nodes: z
        .array(
          z
            .object({ id: z.string(), kind: z.string(), name: z.string() })
            .passthrough(),
        )
        .optional(),
      edges: z
        .array(
          z
            .object({
              from: z.string(),
              to: z.string(),
              via: z.string(),
              field: z.string(),
            })
            .passthrough(),
        )
        .optional(),
      truncated: z.boolean().optional(),
      unavailable: z
        .array(
          z.object({
            node: z.string(),
            source: z.string(),
            reason: z.string(),
          }),
        )
        .optional(),
      caveats: z.array(z.string()).optional(),
      mermaid: z.string().optional(),
      mermaidTruncated: z.number().optional(),
      degraded: degradedOutput,
      available: availableOutput,
    },
    logFields: (args) => ({
      artifactType: args.artifactType,
      direction: args.direction,
      depth: args.depth,
      format: args.format,
    }),
    handler: async ({ format, ...args }) => {
      const result = await artifactDependencies(args);
      if (format !== "mermaid") return okStructured(result);
      const { mermaid, truncated } = dependencyMermaid(result);
      const summary: Record<string, unknown> = { ...result };
      delete summary.nodes;
      delete summary.edges;
      return okStructured({
        ...summary,
        ...(truncated > 0 ? { mermaidTruncated: truncated } : {}),
        mermaid,
      });
    },
  }),
];
