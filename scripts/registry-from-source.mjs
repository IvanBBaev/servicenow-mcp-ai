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

function loadRegistry() {
  if (!pending) {
    register("./ts-source-loader.mjs", import.meta.url);
    pending = import("../src/mcp/registry.ts");
  }
  return pending;
}

/** Resolve the full ToolInfo[] from the TypeScript sources (cached). */
export function loadToolsFromSource() {
  return loadRegistry().then((m) => m.describeAllTools());
}

/** Resolve every tool's registered JSON Schemas from the sources (M-6). */
export function loadToolSchemasFromSource() {
  return loadRegistry().then((m) => m.describeToolSchemas());
}

/** N-42: the packages of the default `core` profile. */
export function loadCorePackagesFromSource() {
  return loadRegistry().then((m) => m.resolveEnabledPackages(["core"]));
}

/** M-2: the error-code table from the sources (the manifest's errorCodes). */
export function loadErrorCodesFromSource() {
  return loadRegistry()
    .then(() => import("../src/core/errors.ts"))
    .then((m) => m.errorCodeTable());
}

/** M-7: renames and per-tool parameter aliases / overlap reasons. */
export function loadNamingFromSource() {
  return loadRegistry().then((m) => m.describeNaming());
}

/**
 * N-56: the server builder and the runtime factory, for an in-process server
 * whose model-facing surface scan:surface reads over an in-memory client.
 */
export function loadServerFromSource() {
  return loadRegistry().then(async () => {
    const [server, runtime] = await Promise.all([
      import("../src/server.ts"),
      import("../src/core/runtime.ts"),
    ]);
    return {
      buildMcpServer: server.buildMcpServer,
      createRuntime: runtime.createRuntime,
      installRuntime: runtime.installRuntime,
    };
  });
}
