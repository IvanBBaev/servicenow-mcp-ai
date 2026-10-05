// Regenerates the checked-in tool manifest fixture used by the M-6 snapshot
// test: every surface change becomes a reviewable diff. Run
// `npm run gen:manifest` after an intentional change.
//
// Manifest v2 (M-6) pins, per tool: name, package, title, annotations, the
// input and output JSON Schemas as tools/list publishes them (keys sorted so
// the diff is stable), the SHA-256 of the description, and `since` — the
// package version the tool first appeared in. `since` is carried over from
// the previous fixture; a tool without history gets the current version.
//
// Manifest v3 (M-2) adds a top-level `errorCodes` table: every `code` a failed
// tool result can carry, with its `source` and a one-line description. It is
// deliberately global, not per tool: most codes come from shared layers (the
// request primitive, the policy gate, the plan-token gate, credentials) that
// any tool can hit, so a per-tool list would either over-promise or need a
// static analysis the code base does not have. The table is the contract.
//
// Manifest v4 (M-7) adds a top-level `toolRenames` list (every v2 -> v3 tool
// rename with its reason; the old names exist only under
// SN_LEGACY_TOOL_NAMES=1) and, per tool, `legacyParams` (v2 parameter names
// accepted only under the same flag), `deprecatedParams` (aliases accepted
// always) and `overlap` (why a tool overlapping another is kept).
//
// Manifest v5 (N-37) adds, per tool, `sizes`: the bytes of the description,
// the input schema, the parameter descriptions inside it and the output schema
// (0 when the tool has none), as test/surface.js's toolSizes() measures the
// published entry. The per-tool caps live in test/tool-size.test.js; the
// manifest makes every size change a reviewable diff. toolSizes() is read
// from test/surface.js, which imports build/ — run `npm run build` first.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  loadErrorCodesFromSource,
  loadNamingFromSource,
  loadToolsFromSource,
  loadToolSchemasFromSource,
} from "./registry-from-source.mjs";
import { join } from "node:path";

export const FIXTURE_PATH = join(
  import.meta.dirname,
  "../test/fixtures/tools-manifest.json",
);

export const MANIFEST_VERSION = 5;

/** The package version (the `since` of a tool without history). */
export const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/** Deep copy with every object's keys in sorted order (arrays keep order). */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** `since` per tool name from a previous manifest (v1 has none). */
export function sinceFrom(previous) {
  const since = new Map();
  for (const t of previous?.tools ?? []) {
    if (t.since) since.set(t.name, t.since);
  }
  return since;
}

/** N-37: the size components the manifest records per tool. */
export const SIZE_COMPONENTS = [
  "description",
  "inputSchema",
  "paramDescriptions",
  "outputSchema",
];

/**
 * Build the manifest from a ToolInfo[] and the matching ToolSchemas[] (the
 * snapshot test passes its own); `since` maps names to their first version;
 * `errorCodes` is the M-2 table (errorCodeTable() in src/core/errors.ts);
 * `toolSizes` is test/surface.js's measurer (N-37) — without it the
 * manifest carries no `sizes`.
 */
export function buildManifest(
  tools,
  schemas,
  since = new Map(),
  version = PACKAGE_VERSION,
  errorCodes = {},
  naming = { renames: [], tools: [] },
  toolSizes = undefined,
) {
  const byName = new Map(schemas.map((s) => [s.name, s]));
  const namingByName = new Map(naming.tools.map((n) => [n.name, n]));
  return {
    manifestVersion: MANIFEST_VERSION,
    errorCodes: sortKeys(errorCodes),
    toolRenames: [...naming.renames]
      .map(({ from, to, reason }) => ({ from, reason, to }))
      .sort((a, b) => a.from.localeCompare(b.from)),
    tools: tools
      .map(({ name, package: pkg, title, description, annotations }) => {
        const schema = byName.get(name);
        const { legacyParams, deprecatedParams, overlap } =
          namingByName.get(name) ?? {};
        const measured = toolSizes?.({
          name,
          title,
          description,
          annotations,
          inputSchema: schema?.inputSchema,
          outputSchema: schema?.outputSchema,
        });
        return {
          name,
          package: pkg,
          title,
          since: since.get(name) ?? version,
          description_sha256: sha256(description),
          annotations,
          inputSchema: sortKeys(schema?.inputSchema ?? {}),
          ...(schema?.outputSchema
            ? { outputSchema: sortKeys(schema.outputSchema) }
            : {}),
          ...(legacyParams ? { legacyParams: sortKeys(legacyParams) } : {}),
          ...(deprecatedParams
            ? { deprecatedParams: sortKeys(deprecatedParams) }
            : {}),
          ...(overlap ? { overlap } : {}),
          ...(measured
            ? {
                sizes: Object.fromEntries(
                  SIZE_COMPONENTS.map((c) => [c, measured[c]]),
                ),
              }
            : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The checked-in fixture, or undefined when there is none yet. */
export function readFixture() {
  return existsSync(FIXTURE_PATH)
    ? JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))
    : undefined;
}

if (process.argv[1] === import.meta.filename) {
  const [tools, schemas, errorCodes, naming, { toolSizes }] = await Promise.all(
    [
      loadToolsFromSource(),
      loadToolSchemasFromSource(),
      loadErrorCodesFromSource(),
      loadNamingFromSource(),
      import("../test/surface.js"),
    ],
  );
  const manifest = buildManifest(
    tools,
    schemas,
    sinceFrom(readFixture()),
    PACKAGE_VERSION,
    errorCodes,
    naming,
    toolSizes,
  );
  // Written in the repository's Prettier style so format:check stays green.
  const prettier = await import("prettier");
  const options = (await prettier.resolveConfig(FIXTURE_PATH)) ?? {};
  const text = await prettier.format(JSON.stringify(manifest), {
    ...options,
    filepath: FIXTURE_PATH,
  });
  writeFileSync(FIXTURE_PATH, text);
  console.error(`Manifest fixture written: ${FIXTURE_PATH}`);
}
