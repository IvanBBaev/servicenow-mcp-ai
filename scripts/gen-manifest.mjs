// Regenerates the checked-in tool manifest fixture used by the M-6 snapshot
// test: every surface change becomes a reviewable diff. Run
// `npm run gen:manifest` after an intentional change.
//
// Manifest v2 (M-6) pins, per tool: name, package, title, annotations, the
// input and output JSON Schemas as tools/list publishes them (keys sorted so
// the diff is stable), the SHA-256 of the description, and `since` — the
// package version the tool first appeared in. `since` is carried over from
// the previous fixture; a tool without history gets the current version.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  loadToolsFromSource,
  loadToolSchemasFromSource,
} from "./registry-from-source.mjs";

export const FIXTURE_PATH = fileURLToPath(
  new URL("../test/fixtures/tools-manifest.json", import.meta.url),
);

export const MANIFEST_VERSION = 2;

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

/**
 * Build the manifest from a ToolInfo[] and the matching ToolSchemas[] (the
 * snapshot test passes its own); `since` maps names to their first version.
 */
export function buildManifest(
  tools,
  schemas,
  since = new Map(),
  version = PACKAGE_VERSION,
) {
  const byName = new Map(schemas.map((s) => [s.name, s]));
  return {
    manifestVersion: MANIFEST_VERSION,
    tools: tools
      .map(({ name, package: pkg, title, description, annotations }) => {
        const schema = byName.get(name);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tools, schemas] = await Promise.all([
    loadToolsFromSource(),
    loadToolSchemasFromSource(),
  ]);
  const manifest = buildManifest(tools, schemas, sinceFrom(readFixture()));
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
