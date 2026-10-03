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

const updateSetInput = shortText(100)
  .min(1)
  .describe(
    "The update set: its sys_id or exact name (a name shared by several sets resolves to the single one in progress).",
  );

const limit = (bounds: { default: number; max: number }, what: string) =>
  z
    .number()
    .int()
    .min(1)
    .max(bounds.max)
    .optional()
    .describe(
      `Maximum ${what} to return (default ${bounds.default}, max ${bounds.max}).`,
    );

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
      "List update sets (sys_update_set), newest first, with state, application scope and whether each is the user's current update set. Filter by state, name fragment or application.",
    package: "updatesets",
    annotations: READ_ONLY,
    input: {
      state: z
        .enum(UPDATE_SET_STATES)
        .optional()
        .describe("Only sets in this state."),
      name: shortText()
        .optional()
        .describe("Name fragment to match (contains)."),
      application: shortText(100)
        .optional()
        .describe(
          "Application scope namespace (e.g. 'x_acme_app'), 'global', or a sys_scope sys_id.",
        ),
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
        .describe("Rows to skip, for paging."),
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
      "Summarise one update set: its customer updates (sys_update_xml) per artefact — type, target name, action, table — with counts by type and action. include_payload adds the parsed field values, each capped, secret-looking fields masked.",
    package: "updatesets",
    annotations: READ_ONLY,
    input: {
      update_set: updateSetInput,
      type: shortText(100)
        .optional()
        .describe("Only updates of this type label, e.g. 'Business Rule'."),
      limit: limit(GET_LIMIT, "updates"),
      include_payload: z
        .boolean()
        .optional()
        .describe(
          "Include each update's parsed payload fields (default false).",
        ),
      payload_max_chars: z
        .number()
        .int()
        .min(20)
        .max(20_000)
        .optional()
        .describe("Cap per payload field value, in characters (default 500)."),
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
      "Compare an update set's artefacts with another profile (live) or a stored snapshot: per artefact same / different (field names) / missing / not_comparable / not_covered / unknown, plus a summary. Only payload fields compared; audit columns ignored.",
    package: "updatesets",
    annotations: READ_ONLY,
    input: {
      update_set: updateSetInput,
      with_profile: shortText(64)
        .optional()
        .describe(
          "Connection profile to compare against, read live. Pass this or with_snapshot.",
        ),
      with_snapshot: shortText(64)
        .optional()
        .describe(
          "Profile whose saved snapshot to compare against (record sections only). Pass this or with_profile.",
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
