import { redactValue, redactionRules } from "../core/redaction.js";
import type { SnRecord } from "../api/table.js";

/**
 * DF-5 — client-side redaction. Sensitive values are masked **before** records
 * are serialised for the model, so they never leave this process. Named fields
 * (`SN_REDACT_FIELDS`) are masked outright; with `SN_REDACT_PII`, string values
 * that match an email/phone/national-id pattern are masked too. This is the
 * honest backing for the "bring-your-own-model, nothing sensitive leaks" story.
 *
 * H-5: the rules live in core/redaction.ts and are deep — a
 * `{ value, display_value, link }` field (H-8 C-4) or any nested object is
 * walked, and a named field is masked at any depth. The same primitive runs at
 * the ok()/fail() boundary for every tool result and on journal fields.
 *
 * N-21: type-based masking rides on the same rules — see core/secret-columns.ts.
 */

export interface RedactionResult {
  records: SnRecord[];
  /** Total number of values/matches masked (0 when redaction is off). */
  redacted: number;
}

/**
 * Mask sensitive values in a record set. Returns the records (the same
 * reference when nothing was masked) and the number of redactions. N-21:
 * secret columns (by dictionary type, or by OOTB name on a schema miss) are
 * masked whatever `SN_REDACT_FIELDS` / `SN_REDACT_PII` say.
 */
export function redactRecords(records: SnRecord[]): RedactionResult {
  const r = redactValue(records, redactionRules());
  return { records: r.value, redacted: r.redacted };
}
