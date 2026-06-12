// Regenerates the checked-in tool manifest fixture used by the М-6 snapshot
// test: every surface change (name, package, title, annotations) becomes a
// reviewable diff. Run `npm run gen:manifest` after an intentional change.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describeAllTools } from "../build/mcp/registry.js";

export const FIXTURE_PATH = fileURLToPath(
  new URL("../test/fixtures/tools-manifest.json", import.meta.url),
);

export function buildManifest() {
  return describeAllTools()
    .map(({ name, package: pkg, title, annotations }) => ({
      name,
      package: pkg,
      title,
      annotations,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(buildManifest(), null, 2)}\n`);
  console.error(`Manifest fixture written: ${FIXTURE_PATH}`);
}
