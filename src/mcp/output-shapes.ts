import { z } from "zod";

/**
 * N-54 — shared output shapes (MCP `outputSchema`, M-6) for tools whose
 * payload is one of a few common envelopes. A tool reuses one of these
 * instead of declaring its own copy, so the `tools/list` cost per tool stays
 * at the envelope (about 80–160 B) and code-mode clients see the same field
 * names across packages. Every field a shape declares is present on every
 * success path of the tools that use it; optional fields are those a plan
 * preview or a degraded read leaves out. The registered schema is a loose
 * object, so a payload may carry more keys.
 */

/**
 * A read that wraps the instance's answer: `{ result }`, where `result` is
 * the record, list or API object as the instance returned it.
 */
export const RESULT_OUTPUT = {
  result: z.unknown().optional(),
} satisfies z.ZodRawShape;

/**
 * A write tool: a plan preview (`mode: "plan"`, the before/after and a
 * `note`) or the applied write (`message` and the instance's `result`).
 */
export const WRITE_OUTPUT = {
  mode: z.string().optional(),
  message: z.string().optional(),
  result: z.unknown().optional(),
} satisfies z.ZodRawShape;

/** A bounded list read: `count` and the rows under `key`. */
export function listOutput<K extends string>(key: K) {
  return { count: z.number(), [key]: z.array(z.unknown()) } as {
    count: z.ZodNumber;
  } & Record<K, z.ZodArray<z.ZodUnknown>>;
}
