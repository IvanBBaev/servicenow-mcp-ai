// Loads the live tool registry straight from the TypeScript sources in `src/`,
// so the generators (gen-manifest, readme-tools) run without `npm run build`.
//
// Lazy by design: importing this module is side-effect free, so a test can pull
// a generator's pure functions without dragging in `src/`. The TS loader is only
// registered — and `src/` only evaluated — when loadToolsFromSource() is first
// called, which happens from the CLI entry points. Those npm scripts start Node
// with --experimental-transform-types (the sources use parameter properties,
// which strip-only mode cannot handle).
import { register } from "node:module";

let pending;

/** Resolve the full ToolInfo[] from the TypeScript sources (cached). */
export function loadToolsFromSource() {
  if (!pending) {
    register("./ts-source-loader.mjs", import.meta.url);
    pending = import("../src/mcp/registry.ts").then((m) =>
      m.describeAllTools(),
    );
  }
  return pending;
}
