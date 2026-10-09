/**
 * `explain_flow` read helpers: the root read and its degrade path, typed
 * field accessors, data-pill labels, the `values` decoder and the stage row.
 */
import { detectFlowValues } from "../core/artifacts/flow-values.js";
import { decodeField } from "../core/artifacts/decoders.js";
import { ServiceNowError } from "../core/errors.js";
import { tableAvailable } from "./artifacts.js";
import { snString, degradeStatus } from "./shared.js";
import { noteMissing, type ReadCtx, type Unreadable } from "./bounded-read.js";
import { queryTable, type SnRecord } from "./table.js";
import {
  type DecodedValues,
  type ExplainFlowResult,
  INPUTS_PER_STEP,
  type Pill,
  RAW_PREVIEW,
  type Ref,
  type Stage,
  type StepInput,
} from "./explain-flow-model.js";

// --- bounded reads (the P-16 pattern) -----------------------------------------

/** Read the root record by sys_id; an unreadable table degrades. */
export async function readRoot(
  ctx: ReadCtx,
  table: string,
  sysId: string,
  fields: string[],
): Promise<{ row: SnRecord } | { unreadable: Unreadable }> {
  ctx.progress.tick(table);
  let records: SnRecord[];
  try {
    ({ records } = await queryTable({
      table,
      query: `sys_id=${sysId}`,
      fields,
      limit: 1,
      displayValue: "false",
    }));
  } catch (error) {
    const status = degradeStatus(error);
    if (status === undefined) throw error;
    return { unreadable: { table, status, reason: (error as Error).message } };
  }
  if (!records.length) {
    throw new ServiceNowError(
      `No ${table} record matches sys_id '${sysId}'.`,
      404,
      undefined,
      {
        hint:
          table === "wf_workflow"
            ? "Pass a wf_workflow sys_id with kind:'workflow' (servicenow_list_flows kind:'workflow' lists them)."
            : table === "sys_hub_action_type_definition"
              ? "Pass a sys_hub_action_type_definition sys_id with kind:'action' (a flow's action steps carry it as ref)."
              : table === "sys_pd_process_definition"
                ? "Pass a sys_pd_process_definition sys_id with kind:'playbook'."
                : "Pass a sys_hub_flow sys_id (servicenow_list_flows lists them); use kind:'workflow' for a legacy workflow.",
      },
    );
  }
  noteMissing(ctx, table, fields, records);
  return { row: records[0]! };
}

/** The root table could not be read: a degraded result, not a failure. */
export async function degrade(
  result: ExplainFlowResult,
  why: Unreadable,
): Promise<ExplainFlowResult> {
  result.degraded = why;
  result.unreadable.push(why);
  result.caveats.push(
    `${why.table} could not be read (${why.status}): ${why.reason}`,
  );
  const available = await tableAvailable(why.table);
  if (available !== undefined) result.available = available;
  return result;
}

export const str = (row: SnRecord, field: string): string =>
  snString(row[field]);

export const opt = (row: SnRecord, field: string): string | undefined =>
  str(row, field) || undefined;

export const num = (row: SnRecord, field: string): number => {
  const n = Number(str(row, field));
  return Number.isFinite(n) ? n : 0;
};

export const optNum = (row: SnRecord, field: string): number | undefined => {
  const text = str(row, field);
  const n = Number(text);
  return text && Number.isFinite(n) ? n : undefined;
};

export const bool = (row: SnRecord, field: string): boolean | undefined => {
  const v = str(row, field);
  return v ? v === "true" || v === "1" : undefined;
};

export const ref = (row: SnRecord, field: string): Ref | undefined => {
  const sys_id = str(row, field);
  if (!sys_id) return undefined;
  const name = opt(row, `${field}.name`);
  return name ? { sys_id, name } : { sys_id };
};

// --- values and data pills ------------------------------------------------------

const PILL = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * `label_cache` as pill name → label. The JSON shape is unverified (O-5):
 * a list of `{name, label}` or an object keyed by pill name (string or
 * `{label}` values) are both read.
 */
export function pillLabels(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw.trim()) return out;
  const d = decodeField("json", raw);
  if (!d.decoded) return out;
  const v = d.value;
  if (Array.isArray(v)) {
    for (const e of v) {
      if (e && typeof e === "object") {
        const name = (e as Record<string, unknown>).name;
        const lab = (e as Record<string, unknown>).label;
        if (typeof name === "string" && typeof lab === "string") {
          out.set(name, lab);
        }
      }
    }
  } else if (v && typeof v === "object") {
    for (const [name, e] of Object.entries(v as Record<string, unknown>)) {
      if (typeof e === "string") out.set(name, e);
      else if (e && typeof e === "object") {
        const lab = (e as Record<string, unknown>).label;
        if (typeof lab === "string") out.set(name, lab);
      }
    }
  }
  return out;
}

function pillsIn(value: unknown, labels: Map<string, string>): Pill[] {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return [];
  const seen = new Map<string, Pill>();
  for (const m of text.matchAll(PILL)) {
    const pill = m[1]!;
    if (seen.has(pill)) continue;
    const lab = labels.get(pill);
    seen.set(pill, lab ? { pill, label: lab } : { pill });
  }
  return [...seen.values()];
}

function inputOf(
  e: Record<string, unknown>,
  labels: Map<string, string>,
): StepInput {
  const input: StepInput = { name: String(e.name) };
  const param = e.parameter;
  const lab =
    param && typeof param === "object"
      ? (param as Record<string, unknown>).label
      : e.label;
  if (typeof lab === "string" && lab) input.label = lab;
  if (e.value !== undefined) input.value = e.value;
  if (typeof e.displayValue === "string" && e.displayValue) {
    input.displayValue = e.displayValue;
  }
  const pills = pillsIn(e.value, labels);
  if (pills.length) input.pills = pills;
  return input;
}

const isNamed = (e: unknown): e is Record<string, unknown> =>
  !!e &&
  typeof e === "object" &&
  typeof (e as Record<string, unknown>).name === "string";

/**
 * Decode a `values` column (flow-values detection) into name / value inputs
 * with labelled data pills. Never throws.
 */
export function decodeValues(
  raw: string,
  labels: Map<string, string>,
): DecodedValues | undefined {
  if (!raw) return undefined;
  const d = detectFlowValues(raw);
  if (!d.decoded) {
    return {
      format: d.format,
      decoded: false,
      bytes: d.bytes,
      reason: d.reason,
      raw: raw.slice(0, RAW_PREVIEW),
      ...(raw.length > RAW_PREVIEW ? { rawTruncated: true } : {}),
    };
  }
  const out: DecodedValues = {
    format: d.format,
    decoded: true,
    bytes: d.bytes,
  };
  let list: unknown = d.value;
  if (
    list &&
    typeof list === "object" &&
    !Array.isArray(list) &&
    Array.isArray((list as Record<string, unknown>).inputs)
  ) {
    list = (list as Record<string, unknown>).inputs;
  }
  if (Array.isArray(list) && list.length && list.every(isNamed)) {
    out.inputs = list.slice(0, INPUTS_PER_STEP).map((e) => inputOf(e, labels));
    if (list.length > INPUTS_PER_STEP) {
      out.inputsOmitted = list.length - INPUTS_PER_STEP;
    }
  } else if (d.value !== null) {
    out.value = d.value;
    const pills = pillsIn(d.value, labels);
    if (pills.length) out.pills = pills;
  }
  return out;
}

export function stage(row: SnRecord): Stage {
  return {
    sys_id: str(row, "sys_id"),
    label: str(row, "label") || str(row, "name") || str(row, "value"),
    ...(opt(row, "value") ? { value: str(row, "value") } : {}),
    order: num(row, "order"),
    ...(opt(row, "duration") ? { duration: str(row, "duration") } : {}),
  };
}
