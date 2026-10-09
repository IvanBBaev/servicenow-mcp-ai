import { z } from "zod";
import {
  snapshotInstance,
  RECORD_SECTIONS,
  SNAPSHOT_SECTIONS,
  type RecordSectionId,
} from "../api/snapshot.js";
import { compareInstances } from "../api/compare.js";
import {
  readSkipped,
  readStoreUpdates,
  readUpgradeHistory,
  reviewSkippedRecord,
} from "../api/upgrade.js";
import { deliverJson } from "../mcp/file-result.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  shortText,
  sysId,
  tableList,
  type AnyToolSpec,
} from "../mcp/define.js";

/** S-11: `format` for the snapshot / compare results. */
const formatInput = z
  .enum(["json", "file"])
  .optional()
  .describe(
    "'json' (default) or 'file': write the full (redacted) JSON to <profile>/exports/, return { path, bytes, preview } + summary.",
  );

/**
 * Instance analysis package (Phase 7): snapshot an instance's structural
 * metadata into the local docs folder; instance comparison (MI-7) joins it
 * next. Reads go through the regular api/ layers, output lands under
 * SN_DOCS_DIR/<profile>/. N-1: upgrade readiness (history, the skipped
 * records of one upgrade, one skipped record's base vs customer versions,
 * store apps with an update) through `servicenow_review_upgrade`.
 */
/** P-20: registry artefact types for snapshot / compare. */
const artifactTypesInput = z
  .array(shortText(80))
  .min(1)
  .max(200)
  .optional()
  .describe("Registry types (with children) or ['all']; default none.");

const artifactScopeInput = shortText(128)
  .optional()
  .describe("Scope for types.");

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_snapshot_instance",
    title: "Snapshot instance metadata",
    description:
      "Download structural metadata to SN_DOCS_DIR/<profile>/ as Markdown + JSON: tables, schemas, plugins, apps, script stats, properties (secrets redacted), choices, ACLs, flows, catalog, roles. resume:true resumes.",
    package: "instance",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      tables: tableList(1000)
        .optional()
        .describe("Tables to write as schema/<table>.md."),
      sections: z
        .array(z.enum(SNAPSHOT_SECTIONS))
        .min(1)
        .max(SNAPSHOT_SECTIONS.length)
        .optional()
        .describe("Sections to collect (default all)."),
      resume: z
        .boolean()
        .optional()
        .describe("Skip sections whose files carry the recorded source hash."),
      types: artifactTypesInput,
      scope: artifactScopeInput,
      format: formatInput,
    },
    logFields: (args) => ({
      tables: args.tables?.length ?? 0,
      sections: args.sections?.length,
      resume: args.resume === true,
    }),
    handler: async ({ tables, sections, resume, types, scope, format }) =>
      deliverJson(
        await snapshotInstance({ tables, sections, resume, types, scope }),
        "snapshot",
        format,
      ),
  }),

  defineTool({
    name: "servicenow_compare_instances",
    title: "Compare two instances",
    description:
      "Diff two profiles: tables, column differences, scripts missing/renamed/changed (unified diff), plugin/app inventory, optional record sections. Writes _compare/<a>-vs-<b>.md.",
    package: "instance",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      a: shortText(128).describe("First profile, e.g. 'dev'."),
      b: shortText(128).describe("Second profile, e.g. 'prod'."),
      from_snapshot: z
        .boolean()
        .optional()
        .describe(
          "Prefer stored snapshot JSON over live reads (default false).",
        ),
      sections: z
        .array(z.enum(Object.keys(RECORD_SECTIONS) as [RecordSectionId]))
        .min(1)
        .max(Object.keys(RECORD_SECTIONS).length)
        .optional()
        .describe(
          "Snapshot record sections to compare too, matched by sys_id then name (default none).",
        ),
      types: artifactTypesInput,
      scope: artifactScopeInput,
      mermaid: z
        .boolean()
        .optional()
        .describe(
          "With types: diff changed flow/workflow/portal/experience diagrams as Mermaid (live).",
        ),
      format: formatInput,
    },
    logFields: (args) => ({
      a: args.a,
      b: args.b,
      fromSnapshot: args.from_snapshot === true,
      sections: args.sections?.length,
    }),
    handler: async ({
      a,
      b,
      from_snapshot,
      sections,
      types,
      scope,
      mermaid,
      format,
    }) => {
      const result = await compareInstances({
        a,
        b,
        fromSnapshot: from_snapshot,
        sections,
        types,
        scope,
        mermaid,
      });
      return deliverJson(result, `compare-${result.a}-vs-${result.b}`, format);
    },
  }),

  defineTool({
    name: "servicenow_review_upgrade",
    title: "Review upgrade",
    description:
      "Upgrade history by default; upgrade: its unresolved skipped records by app/type; update_name: one skip classified by base vs customer versions; store_updates: store apps with an update and their customisations.",
    package: "instance",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      upgrade: sysId().optional(),
      update_name: shortText(255).optional(),
      store_updates: z.boolean().optional(),
    },
    output: { available: z.boolean() },
    logFields: (args) => ({
      view:
        args.update_name !== undefined
          ? "record"
          : args.upgrade !== undefined
            ? "skipped"
            : args.store_updates === true
              ? "store"
              : "history",
    }),
    handler: async ({ upgrade, update_name, store_updates }) =>
      ok(
        update_name !== undefined
          ? await reviewSkippedRecord(update_name)
          : upgrade !== undefined
            ? await readSkipped(upgrade)
            : store_updates === true
              ? await readStoreUpdates()
              : await readUpgradeHistory(),
      ),
  }),
];
