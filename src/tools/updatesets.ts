import { z } from "zod";
import {
  listUpdateSets,
  getUpdateSet,
  compareUpdateSet,
  LIST_LIMIT,
  GET_LIMIT,
  COMPARE_LIMIT,
  UPDATE_SET_STATES,
} from "../api/updatesets.js";
import { okStructured } from "../mcp/result.js";
import { updateSetRef } from "../mcp/params.js";
import {
  defineTool,
  encodedQuery,
  shortText,
  type AnyToolSpec,
} from "../mcp/define.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const limit = (bounds: { default: number; max: number }, what: string) =>
  z
    .number()
    .int()
    .min(1)
    .max(bounds.max)
    .optional()
    .describe(`Max ${what} (default ${bounds.default}, max ${bounds.max}).`);

const setOutput = z
  .object({
    sys_id: z.string(),
    name: z.string(),
    state: z.string(),
    application: z.string(),
    application_name: z.string().optional(),
  })
  .loose();

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_update_sets",
    title: "List update sets",
    description:
      "List update sets, newest first, with state, scope and whether each is the user's current one. Filter by state, name or application.",
    package: "updatesets",
    annotations: READ_ONLY,
    input: {
      state: z
        .enum(UPDATE_SET_STATES)
        .optional()
        .describe("Only sets in this state."),
      name: shortText().optional().describe("Name fragment (contains)."),
      application: shortText(100)
        .optional()
        .describe("Scope namespace (e.g. 'x_acme_app') or sys_id."),
      query: encodedQuery()
        .optional()
        .describe("Extra encoded query ANDed with the filters."),
      limit: limit(LIST_LIMIT, "update sets"),
      offset: z
        .number()
        .int()
        .min(0)
        .max(100_000)
        .optional()
        .describe("Rows to skip (paging)."),
    },
    output: {
      count: z.number(),
      total: z.number().optional(),
      truncated: z.boolean(),
      current_update_set: z.string().nullable(),
      update_sets: z.array(setOutput),
    },
    handler: async (args) => okStructured(await listUpdateSets(args)),
  }),

  defineTool({
    name: "servicenow_get_update_set",
    title: "Get update set",
    description:
      "Summarise one update set: its customer updates (sys_update_xml) per artefact — type, target, action, table — with counts; UIB pages it touches list the records it lacks. include_payload adds parsed field values, capped, secrets masked.",
    package: "updatesets",
    annotations: READ_ONLY,
    input: {
      update_set: updateSetRef,
      type: shortText(100)
        .optional()
        .describe("Only this type label, e.g. 'Business Rule'."),
      limit: limit(GET_LIMIT, "updates"),
      include_payload: z
        .boolean()
        .optional()
        .describe("Add parsed payload fields."),
      payload_max_chars: z
        .number()
        .int()
        .min(20)
        .max(20_000)
        .optional()
        .describe("Chars per payload field (default 500)."),
    },
    output: {
      update_set: setOutput,
      count: z.number(),
      total: z.number().optional(),
      truncated: z.boolean(),
      by_type: z.record(z.string(), z.number()),
      by_action: z.record(z.string(), z.number()),
      updates: z.array(
        z
          .object({
            sys_id: z.string(),
            name: z.string(),
            type: z.string(),
            target_name: z.string(),
            action: z.string(),
            table: z.string(),
          })
          .loose(),
      ),
    },
    handler: async (args) => okStructured(await getUpdateSet(args)),
  }),

  defineTool({
    name: "servicenow_compare_update_set",
    title: "Compare update set",
    description:
      "Compare an update set's artefacts with another profile (live) or a stored snapshot: a status per artefact (same, different with field names, missing, …) plus a summary. Audit columns ignored.",
    package: "updatesets",
    annotations: READ_ONLY,
    input: {
      update_set: updateSetRef,
      with_profile: shortText(64)
        .optional()
        .describe("Profile to compare against live; this or with_snapshot."),
      with_snapshot: shortText(64)
        .optional()
        .describe(
          "Profile snapshot to compare with (record sections); this or with_profile.",
        ),
      limit: limit(COMPARE_LIMIT, "updates to compare"),
    },
    output: {
      update_set: setOutput,
      against: z.record(z.string(), z.string()),
      count: z.number(),
      total: z.number().optional(),
      truncated: z.boolean(),
      summary: z.record(z.string(), z.number()),
      artefacts: z.array(
        z
          .object({
            name: z.string(),
            table: z.string(),
            sys_id: z.string(),
            action: z.string(),
            status: z.enum([
              "same",
              "different",
              "missing",
              "not_comparable",
              "not_covered",
              "unknown",
            ]),
            fields: z.array(z.string()).optional(),
            reason: z.string().optional(),
          })
          .loose(),
      ),
      warnings: z.array(z.string()).optional(),
      caveats: z.array(z.string()),
    },
    handler: async (args) => okStructured(await compareUpdateSet(args)),
  }),
];
