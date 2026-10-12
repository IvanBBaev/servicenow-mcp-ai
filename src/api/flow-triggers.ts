/**
 * Where a Flow Designer trigger keeps its inputs (table, condition,
 * trigger_strategy, run_on_extended…), checked on a PDI (O-5). Neither
 * trigger table has `table` / `condition` columns:
 *
 * - `sys_hub_trigger_instance_v2`: `trigger_inputs` holds a base64 + gzip
 *   JSON array of `{ name, value, … }`;
 * - `sys_hub_trigger_instance`: `trigger_inputs` is empty; each input is a
 *   `sys_variable_value` row (`document` = the table, `document_key` = the
 *   trigger sys_id, `variable.element` = the input name).
 *
 * Most flows have a trigger in only one of the two tables, so readers check
 * both.
 */
import { type SnRecord } from "./table.js";
import { snString } from "./shared.js";
import { detectFlowValues } from "../core/artifacts/flow-values.js";

export const TRIGGER_V1 = "sys_hub_trigger_instance";
export const TRIGGER_V2 = "sys_hub_trigger_instance_v2";

/** Input name → raw value. */
export type TriggerInputs = Record<string, string>;

/** Where v1 trigger inputs are read from. */
export const V1_INPUTS = {
  table: "sys_variable_value",
  prefix: `document=${TRIGGER_V1}`,
  fields: ["document_key", "variable.element", "value"],
} as const;

/** The inputs of a v2 trigger's `trigger_inputs`; empty when not decodable. */
export function v2Inputs(raw: unknown): TriggerInputs {
  const out: TriggerInputs = {};
  const d = detectFlowValues(snString(raw));
  if (!d.decoded || !Array.isArray(d.value)) return out;
  for (const e of d.value as unknown[]) {
    if (!e || typeof e !== "object") continue;
    const { name, value } = e as Record<string, unknown>;
    if (typeof name === "string" && name) out[name] = snString(value);
  }
  return out;
}

/** `sys_variable_value` rows (V1_INPUTS) grouped by trigger sys_id. */
export function v1Inputs(rows: SnRecord[]): Map<string, TriggerInputs> {
  const out = new Map<string, TriggerInputs>();
  for (const r of rows) {
    const id = snString(r.document_key);
    const name = snString(r["variable.element"]);
    if (!id || !name) continue;
    const inputs = out.get(id) ?? {};
    inputs[name] = snString(r.value);
    out.set(id, inputs);
  }
  return out;
}

/** The v1 query for the trigger ids whose `table` input is one of these. */
export const v1TableQuery = (tables: string[]): string =>
  `${V1_INPUTS.prefix}^variable.element=table^valueIN${tables.join(",")}`;
