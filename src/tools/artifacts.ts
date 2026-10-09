import { z } from "zod";
import { ServiceNowError } from "../core/errors.js";
import { legacyToolNames } from "../mcp/naming.js";
import { listArtifacts, getArtifact, LIST_LIMIT } from "../api/artifacts.js";
import { explainArtifact } from "../api/explain-artifact.js";
import {
  artifactDependencies,
  dependencyMermaid,
  DEPENDENCY_DEPTH,
  DEPENDENCY_LIMIT,
} from "../api/dependencies.js";
import { ok, okStructured } from "../mcp/result.js";
import {
  defineTool,
  encodedQuery,
  shortText,
  sysId,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";
import { WRITE_OUTPUT } from "../mcp/output-shapes.js";
import {
  applyArtifactPlan,
  assertNotPlanOnly,
  planArtifactUpsert,
  planWrites,
  type ArtifactPlan,
  type PlannedRecord,
} from "../api/upsert-artifact.js";
import { getArtifactType } from "../core/artifacts/registry.js";
import { assertTableWriteAllowed, assertWriteAllowed } from "../core/policy.js";
import { applyInput, planPreview, shouldApply } from "../mcp/write-mode.js";
import { sdkGuard } from "../mcp/sdk-guard.js";
import { bindingPlanDetail, planUpdateSetBinding } from "../api/updatesets.js";
import { assertUpsertUnchanged } from "./table.js";
import { updateSetInput } from "../mcp/params.js";

// A plain string, not an enum: the registry has dozens of types and an enum
// would cost tokens in every tools/list (SDK-PARITY §5(d)). The resource lists
// them; an unknown type fails with the valid ones in the message.
const artifactTypeInput = shortText(80)
  .min(1)
  .describe(
    "Registry type id, e.g. 'business_rule'; all types: servicenow://artifact-types.",
  );

const keyValue = z.union([shortText(), z.number(), z.boolean()]);

const artifactRefInput = {
  artifactType: artifactTypeInput,
  sys_id: sysId().optional().describe("Record sys_id; this or 'key'."),
  key: z
    .union([
      keyValue,
      z
        .record(z.string(), keyValue)
        .refine((o) => Object.keys(o).length <= 10, {
          message: "A key has at most 10 fields.",
        }),
    ])
    .optional()
    .describe(
      "Natural key (keyFields): a value for a single key field, else an object of every key field; this or 'sys_id'.",
    ),
};

/** Flat Table API values (the same shape the Table write tools take). */
const fieldsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

/** P-22 per record of an artefact plan; a deny throws before any write. */
async function guardPlan(plan: ArtifactPlan, phase: "plan" | "apply") {
  const managed: Record<string, unknown>[] = [];
  const warnings = new Set<string>();
  for (const r of [plan.parent, ...plan.children]) {
    if (r.action === "noop") continue;
    const g = await sdkGuard(
      r.action === "update"
        ? { table: r.table, sys_id: r.sys_id, fields: r.write }
        : { table: r.table, fields: r.write },
      phase,
    );
    if (g?.sdkManaged) {
      managed.push({
        table: r.table,
        ...(r.index !== undefined ? { child: r.index } : {}),
        ...(r.sys_id ? { sys_id: r.sys_id } : {}),
        ...g.sdkManaged,
      });
    }
    if (g?.sdkScopeWarning) warnings.add(g.sdkScopeWarning);
  }
  return {
    ...(managed.length ? { sdkManaged: managed } : {}),
    ...(warnings.size ? { sdkScopeWarning: [...warnings] } : {}),
  };
}

function childPlan(r: PlannedRecord): Record<string, unknown> {
  return {
    child: r.index,
    ...(r.parent !== undefined ? { parent: r.parent } : {}),
    table: r.table,
    action: r.action,
    ...(r.sys_id ? { sys_id: r.sys_id } : {}),
    key: r.key,
    ...(r.before ? { before: r.before } : {}),
    ...(r.action !== "noop" ? { after: r.write } : {}),
  };
}

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

/**
 * M-7: a child's write payload is `values`; the v2 name `fields` is accepted
 * only under SN_LEGACY_TOOL_NAMES=1 (the nested alias cannot be expressed by
 * the top-level `legacyParams`, so the child schema carries both, optional,
 * and this check enforces exactly one).
 */
export function normalizeChildValues<V, C extends { values?: V; fields?: V }>(
  children: C[],
): (Omit<C, "values" | "fields"> & { fields: V })[] {
  const legacy = legacyToolNames();
  return children.map((child, index) => {
    const { values, fields, ...rest } = child;
    if (fields !== undefined && !legacy) {
      throw new ServiceNowError(
        `children[${index}].fields was renamed to values.`,
        400,
        undefined,
        {
          code: "INVALID_INPUT",
          hint: "Pass children[].values (SN_LEGACY_TOOL_NAMES=1 accepts the old name for one minor).",
        },
      );
    }
    if (fields !== undefined && values !== undefined) {
      throw new ServiceNowError(
        `Pass either children[${index}].values or its deprecated alias fields, not both.`,
        400,
        undefined,
        { code: "INVALID_INPUT", hint: "Use values only." },
      );
    }
    const payload = values ?? fields;
    if (payload === undefined) {
      throw new ServiceNowError(
        `children[${index}].values is required.`,
        400,
        undefined,
        {
          code: "INVALID_INPUT",
          hint: "Give each child its field/value pairs in values.",
        },
      );
    }
    return { ...rest, fields: payload };
  });
}

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_artifacts",
    title: "List artifacts",
    description:
      "List records of any registry artifact type as summaries: sys_id, name, key, scope, active, SDK-managed verdict; no script bodies. verified:false types carry a caveat.",
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
        .describe("One scope: namespace (e.g. 'x_acme_app') or sys_id."),
      query: encodedQuery()
        .optional()
        .describe("Encoded query ANDed with the type's filter."),
      active: z
        .boolean()
        .optional()
        .describe("Filter by active; refused for types without one."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(LIST_LIMIT.max)
        .optional()
        .describe(
          `Max records (default ${LIST_LIMIT.default}, max ${LIST_LIMIT.max}).`,
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
            key: z.record(z.string(), z.string()),
            scope: scopeOutput,
            active: z.boolean().optional(),
            sdkManaged: z.enum(["yes", "no", "unknown"]),
          })
          .loose(),
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
      "Read one artifact of any registry type in full: the record, its registry children (e.g. UI policy actions, page layout), scope and SDK-managed verdict. By sys_id or natural key; denied child tables show as redacted.",
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
      key: z.record(z.string(), z.string()).optional(),
      scope: scopeOutput.optional(),
      sdkManaged: sdkManagedOutput.optional(),
      record: z.record(z.string(), z.unknown()).nullable(),
      children: z.array(
        z
          .object({
            table: z.string(),
            parentField: z.string(),
            parentTable: z.string().optional(),
            verified: z.boolean(),
            count: z.number(),
            truncated: z.boolean().optional(),
            records: z.array(z.record(z.string(), z.unknown())),
            redacted: z.boolean().optional(),
            reason: z.string().optional(),
            error: z.string().optional(),
            status: z.number().optional(),
          })
          .loose(),
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
      "Explain one artifact of any registry type: summary, trigger fields, non-empty fields, children, referenced records, decoded JSON fields and type-specific readings (state models, policy effects).",
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
      key: z.record(z.string(), z.string()).optional(),
      scope: scopeOutput.optional(),
      sdkManaged: sdkManagedOutput.optional(),
      missingFields: z.array(z.string()).optional(),
      summary: z.string(),
      when: z.record(z.string(), z.unknown()).nullable(),
      fields: z.record(z.string(), z.unknown()),
      truncatedFields: z.array(z.string()).optional(),
      explanation: z
        .object({ kind: z.string(), lines: z.array(z.string()) })
        .loose()
        .optional(),
      children: z.array(
        z
          .object({
            table: z.string(),
            count: z.number(),
            items: z.array(z.record(z.string(), z.unknown())),
            omitted: z.number().optional(),
          })
          .loose(),
      ),
      references: z.array(
        z
          .object({ field: z.string(), table: z.string(), sys_id: z.string() })
          .loose(),
      ),
      decoded: z.array(
        z
          .object({
            source: z.string(),
            field: z.string(),
            decoder: z.string(),
            decoded: z.boolean(),
          })
          .loose(),
      ),
      degraded: degradedOutput,
      available: availableOutput,
    },
    handler: async (args) => okStructured(await explainArtifact(args)),
  }),

  defineTool({
    name: "servicenow_get_artifact_dependencies",
    title: "Artifact dependencies",
    description:
      "Dependency graph of one artifact: outbound (references, decoded JSON, script calls, GlideRecord tables, UIB components and brokers) and inbound (reverse references, script, flow-step and UIB page callers). Depth-capped; JSON or Mermaid.",
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
        .describe("outbound (uses), inbound (used by), both (default)."),
      depth: z
        .number()
        .int()
        .min(1)
        .max(DEPENDENCY_DEPTH.max)
        .optional()
        .describe(
          `Levels to walk (default ${DEPENDENCY_DEPTH.default}); cycles visited once.`,
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(DEPENDENCY_LIMIT.max)
        .optional()
        .describe(
          `Rows per inbound source (default ${DEPENDENCY_LIMIT.default}).`,
        ),
      format: z
        .enum(["json", "mermaid"])
        .optional()
        .describe("json (default) nodes and edges, or mermaid."),
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
            .loose(),
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
            .loose(),
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
  defineTool({
    name: "servicenow_upsert_artifact",
    title: "Upsert artifact",
    description:
      "Create or update a registry artifact and its children (UI policy actions, portal page layout, catalog variables) as one journaled, revertible plan, parent first, with SDK pre-flight. Flows: {active} only (unverified).",
    package: "artifacts",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    // H-3: one token covers the whole plan (parent and children).
    confirm: {
      target: (args) => ({
        action: "update",
        table:
          getArtifactType(
            typeof args.artifactType === "string" ? args.artifactType : "",
          )?.table ?? "artifact",
      }),
    },
    legacyParams: { fields: "values" },
    input: {
      artifactType: artifactTypeInput,
      key: artifactRefInput.key
        .unwrap()
        .describe(
          "Primary key: a value for a single key field, or every key field as pairs (sys_id-keyed types: identifying fields, e.g. {table, short_description}). Written on create.",
        ),
      values: fieldsSchema.describe(
        "Primary-record fields (the type's descriptor fields; sys_scope on create only).",
      ),
      children: z
        .array(
          z.object({
            table: tableName()
              .optional()
              .describe("Child table (default: the type's only one)."),
            key: z
              .record(z.string(), keyValue)
              .optional()
              .describe(
                "Identifies the child under the parent (default: its name field, e.g. {field: 'state'}).",
              ),
            values: fieldsSchema
              .optional()
              .describe(
                "Child fields (required); the tool sets the parent link.",
              ),
            fields: fieldsSchema
              .optional()
              .describe(
                "Deprecated: use values (accepted only with SN_LEGACY_TOOL_NAMES=1).",
              ),
            parent: z
              .number()
              .int()
              .min(0)
              .max(199)
              .optional()
              .describe(
                "Index of the earlier child this one hangs off (sp_row under sp_container); omit for the primary.",
              ),
          }),
        )
        .max(200)
        .optional()
        .describe("Child records, applied in order after the parent."),
      expected_action: z
        .enum(["create", "update"])
        .optional()
        .describe(
          "From the plan's apply_with; a changed decision gives STALE_RECORD.",
        ),
      expected_sys_id: sysId()
        .optional()
        .describe("From the plan's apply_with (parent sys_id)."),
      update_set: updateSetInput,
      apply: applyInput,
    },
    output: WRITE_OUTPUT,
    logFields: (args) => ({
      artifactType: args.artifactType,
      children: args.children?.length ?? 0,
    }),
    handler: async ({
      artifactType,
      key,
      values: fields,
      children,
      expected_action,
      expected_sys_id,
      update_set,
      apply,
    }) => {
      const plan = await planArtifactUpsert({
        artifactType,
        key,
        fields,
        children: children && normalizeChildValues(children),
      });
      const { parent } = plan;
      const writes = planWrites(plan);
      const binding = writes
        ? await planUpdateSetBinding(parent.table, update_set)
        : undefined;
      const parentAction = parent.action === "create" ? "create" : "update";
      if (!shouldApply(apply)) {
        const count = { create: 0, update: 0, noop: 0 };
        for (const r of [parent, ...plan.children]) count[r.action] += 1;
        const guard = await guardPlan(plan, "plan");
        const refused =
          plan.planOnly.length > 0 ||
          plan.deniedTables.length > 0 ||
          (guard.sdkManaged ?? []).some((g) => g.would_refuse === true);
        return planPreview(
          {
            action: parentAction,
            table: parent.table,
            ...(parent.sys_id ? { sys_id: parent.sys_id } : {}),
            ...(parent.before ? { before: parent.before } : {}),
            after: parent.write,
          },
          {
            artifactType: plan.type.type,
            ...(plan.type.verified ? {} : { verified: false }),
            key: parent.key,
            parent_action: parent.action,
            ...(plan.children.length
              ? { children: plan.children.map(childPlan) }
              : {}),
            count,
            ...(writes ? {} : { no_changes: true }),
            apply_with: {
              expected_action: parentAction,
              ...(parent.sys_id ? { expected_sys_id: parent.sys_id } : {}),
            },
            ...(plan.planOnly.length
              ? {
                  plan_only: {
                    fields: plan.planOnly,
                    note: "These fields are plan-only (writable:false in the registry): the apply is refused with PLAN_ONLY_FIELD.",
                  },
                }
              : {}),
            ...(plan.deniedTables.length
              ? { policy_denied: plan.deniedTables }
              : {}),
            ...(refused ? { would_refuse: true } : {}),
            ...(plan.unknownFields.length
              ? { unknown_fields: plan.unknownFields }
              : {}),
            ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
            ...bindingPlanDetail(binding),
            ...guard,
          },
        );
      }
      assertUpsertUnchanged(
        parent.action === "create"
          ? { action: "create" }
          : { action: "update", sys_id: parent.sys_id as string, before: {} },
        expected_action,
        expected_sys_id,
      );
      assertNotPlanOnly(plan);
      // H-11 and P-22 for every table and record before the first write, so
      // a refusal never leaves a half-written artefact.
      if (writes) assertWriteAllowed("update");
      for (const r of [parent, ...plan.children]) {
        if (r.action !== "noop") assertTableWriteAllowed(r.table);
      }
      const guard = await guardPlan(plan, "apply");
      const applied = await applyArtifactPlan(plan, binding);
      const [head, ...rest] = applied.records;
      return ok({
        message: writes
          ? `Artifact ${parent.action === "create" ? "created" : "updated"}: ${writes} record${writes === 1 ? "" : "s"} written`
          : "No changes: every record already matches",
        artifactType: plan.type.type,
        action: head?.action,
        table: parent.table,
        sys_id: head?.sys_id,
        ...(rest.length ? { children: rest } : {}),
        ...(writes ? { artifact_write: applied.artifact_write } : {}),
        ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
        ...(applied.report ?? {}),
        ...guard,
      });
    },
  }),
];
