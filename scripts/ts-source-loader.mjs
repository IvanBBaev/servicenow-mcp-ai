// ESM resolution hook that lets tooling import the TypeScript sources in `src/`
// directly — no `npm run build` first. Node strips the types natively (>=22.18
// / 23.6); this hook only fixes resolution: the sources use `module: Node16`,
// so a relative import reads `./foo.js`, but on disk it is `./foo.ts`. We rewrite
// the specifier to the `.ts` sibling whenever that file exists, and otherwise
// fall through to Node's default resolver (real `.js`, packages, builtins).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    context.parentURL
  ) {
    const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
    const tsURL = new URL(tsSpecifier, context.parentURL);
    if (existsSync(fileURLToPath(tsURL))) {
      return nextResolve(tsSpecifier, context);
    }
  }
  return nextResolve(specifier, context);
}
