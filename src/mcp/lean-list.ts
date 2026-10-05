/**
 * N-58 — the lean `tools/list` serializer. Pure transforms over the tools
 * array the SDK publishes: they drop what carries no meaning for a client and
 * keep every constraint a model or a validator acts on. The specs and their
 * zod shapes are unchanged.
 *
 * Not wired yet: the wire change waits for owner decision O-10 (b). Until then
 * this module is measured by `npm run tokens:report` and pinned by tests.
 *
 * Rules (project/TOKEN-OPTIMIZATION-PLAN-2026-10.md, N-58):
 *  1. drop `$schema` in input and output schemas;
 *  2. drop `execution` when `taskSupport` is `forbidden` (the default);
 *  3. drop `maxLength` when the whole pattern is `^[class]{m,n}$` and
 *     `maxLength` >= n — the pattern already bounds the length;
 *  4. drop `maximum` / `minimum` equal to ±(2^53−1) (zod's int bounds);
 *  5. drop `propertyNames: {type: "string"}` (always true for JSON keys);
 *  6. omit annotation hints a client already assumes (see wireAnnotations).
 */

type Json = Record<string, unknown>;

/** Rule 3: the anchored, single-class, bounded pattern form. */
const BOUNDED_PATTERN = /^\^\[[^\]]+\]\{(\d+),(\d+)\}\$$/;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Keywords whose value is one subschema. */
const SUBSCHEMA = ["items", "additionalProperties", "not", "contains"];
/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST = ["anyOf", "oneOf", "allOf", "prefixItems"];
/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAP = ["properties", "patternProperties", "$defs"];

/**
 * The lean form of one JSON Schema. Walks only schema positions, so a
 * property named `maximum` or `$schema` is never mistaken for a keyword.
 * Returns a new object; the input is not mutated.
 */
export function leanJsonSchema(schema: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") continue;
    if (
      (key === "maximum" && value === Number.MAX_SAFE_INTEGER) ||
      (key === "minimum" && value === Number.MIN_SAFE_INTEGER)
    ) {
      continue;
    }
    if (
      key === "propertyNames" &&
      isObject(value) &&
      Object.keys(value).length === 1 &&
      value.type === "string"
    ) {
      continue;
    }
    if (SUBSCHEMA.includes(key) && isObject(value)) {
      out[key] = leanJsonSchema(value);
    } else if (SUBSCHEMA_LIST.includes(key) && Array.isArray(value)) {
      out[key] = (value as unknown[]).map((s): unknown =>
        isObject(s) ? leanJsonSchema(s) : s,
      );
    } else if (SUBSCHEMA_MAP.includes(key) && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, s]) => [
          name,
          isObject(s) ? leanJsonSchema(s) : s,
        ]),
      );
    } else {
      out[key] = value;
    }
  }
  if (typeof out.maxLength === "number" && typeof out.pattern === "string") {
    const bound = BOUNDED_PATTERN.exec(out.pattern);
    if (bound && out.maxLength >= Number(bound[2])) delete out.maxLength;
  }
  return out;
}

/**
 * Rule 6, the safe annotation rule. Omitted: `openWorldHint: true`,
 * `idempotentHint: false`, `readOnlyHint: false`, and `destructiveHint: true`
 * on a write tool — each equals the MCP default. Always kept:
 * `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`, so a
 * read tool still states that it does not destroy. `title` stays (display).
 */
export function wireAnnotations(annotations: Json | undefined): Json {
  const out: Json = {};
  if (!annotations) return out;
  const readOnly = annotations.readOnlyHint === true;
  for (const [key, value] of Object.entries(annotations)) {
    if (key === "openWorldHint" && value === true) continue;
    if (key === "idempotentHint" && value === false) continue;
    if (key === "readOnlyHint" && value === false) continue;
    if (key === "destructiveHint" && value === true && !readOnly) continue;
    out[key] = value;
  }
  return out;
}

/** The lean form of one published tool. */
export function leanTool(tool: Json): Json {
  const out: Json = { ...tool };
  if (isObject(tool.inputSchema)) {
    out.inputSchema = leanJsonSchema(tool.inputSchema);
  }
  if (isObject(tool.outputSchema)) {
    out.outputSchema = leanJsonSchema(tool.outputSchema);
  }
  if (isObject(tool.execution)) {
    const { taskSupport, ...rest } = tool.execution;
    if (taskSupport === "forbidden" && !Object.keys(rest).length) {
      delete out.execution;
    }
  }
  if (isObject(tool.annotations)) {
    const annotations = wireAnnotations(tool.annotations);
    if (Object.keys(annotations).length) out.annotations = annotations;
    else delete out.annotations;
  }
  return out;
}

/** The lean form of a `tools/list` result's tools array. */
export function leanToolsList<T extends Json>(tools: T[]): Json[] {
  return tools.map(leanTool);
}
