import { z } from "zod";
import {
  opsRead,
  dataHealth,
  OPS_KINDS,
  SYSLOG_LEVELS,
  JOB_FILTERS,
  OPS_LIMIT,
  WINDOW_MINUTES,
  OVERDUE_MINUTES,
  DATA_HEALTH_LIMIT,
  MAX_KEY_FIELDS,
  MAX_REFERENCE_FIELDS,
} from "../api/ops.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  encodedQuery,
  fieldList,
  shortText,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const bounded = (b: { default: number; max: number }, what: string) =>
  z
    .number()
    .int()
    .min(1)
    .max(b.max)
    .optional()
    .describe(`${what} (default ${b.default}, max ${b.max}).`);

/**
 * S-10b — the opt-in `ops` package: platform health reads (system log,
 * scheduler queue, outbound email queue, semaphores) and the data-quality
 * twin of servicenow_code_health. Read-only; each section degrades to
 * `available:false` when its table is unreadable.
 */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_ops_read",
    title: "Read instance operations data",
    description:
      "Bounded operational views for 'why is it slow' triage: overview (all counts), syslog (recent entries by level/source), jobs (sys_trigger queue), email_queue (backlog, failures), semaphores. An unreadable section reports available:false + why.",
    package: "ops",
    annotations: READ_ONLY,
    input: {
      kind: z.enum(OPS_KINDS).describe("Which view to read."),
      minutes: bounded(
        WINDOW_MINUTES,
        "Time window in minutes for syslog and email failures",
      ),
      level: z
        .enum(SYSLOG_LEVELS)
        .optional()
        .describe("syslog: minimum severity (default 'warning')."),
      source: shortText(100)
        .optional()
        .describe("syslog: source fragment to match (contains)."),
      filter: z
        .enum(JOB_FILTERS)
        .optional()
        .describe(
          "jobs: which jobs to list — 'overdue' ready jobs past their next action (default), 'running' or 'queued'.",
        ),
      overdue_minutes: bounded(
        OVERDUE_MINUTES,
        "jobs: minutes past next_action before a ready job counts as overdue",
      ),
      limit: bounded(OPS_LIMIT, "Maximum rows to return"),
    },
    logFields: (args) => ({ kind: args.kind, minutes: args.minutes }),
    handler: async (args) => ok(await opsRead(args)),
  }),

  defineTool({
    name: "servicenow_data_health",
    title: "Data health report",
    description:
      "Data-quality counts for one table (twin of servicenow_code_health): duplicate groups over key_fields, and orphaned or stale (inactive target) references per reference field, each with the query listing the rows. Unreadable checks: available:false.",
    package: "ops",
    annotations: READ_ONLY,
    input: {
      table: tableName().describe("Table to check, e.g. 'incident'."),
      key_fields: fieldList(MAX_KEY_FIELDS)
        .optional()
        .describe(
          "Columns that should be unique together, e.g. ['email']; omit to skip the duplicate check.",
        ),
      reference_fields: fieldList(MAX_REFERENCE_FIELDS)
        .optional()
        .describe("Reference columns to check (default: auto, first 10)."),
      query: encodedQuery()
        .optional()
        .describe(
          "Encoded query that scopes every check, e.g. 'active=true' (no ^NQ or ORDERBY).",
        ),
      stale: z
        .boolean()
        .optional()
        .describe("Count references to inactive rows (default true)."),
      limit: bounded(DATA_HEALTH_LIMIT, "Maximum duplicate groups to return"),
    },
    logFields: (args) => ({ table: args.table }),
    handler: async (args) => ok(await dataHealth(args)),
  }),
];
