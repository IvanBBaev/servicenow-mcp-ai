# Install footprint (D-5, N-85)

What `npm install servicenow-mcp-ai` downloads and what a production install pulls in. The
block below is generated: `npm run footprint` measures the current build (`npm run build`
first) and rewrites it, and `npm run footprint -- --check` — part of `npm run check` — fails
when the recorded figures drift more than 5 % from the build, when the ceiling in
`scripts/pack-check.mjs` or the production dependency list changes, or when the block was
edited by hand. Quote a release note from here instead of re-measuring by hand.

<!-- GENERATED:FOOTPRINT:BEGIN (npm run footprint) -->

<!-- footprint: {"measured":"2026-10-27","version":"3.0.0","entryCount":253,"tarballBytes":577141,"unpackedBytes":2343861,"buildJsBytes":2159750,"readmeBytes":142383,"largest":[{"path":"build/api/ui-experience.js","bytes":48439},{"path":"build/api/document.js","bytes":44940},{"path":"build/mcp/prompts.js","bytes":42886},{"path":"build/core/settings-data-runtime.js","bytes":31064},{"path":"build/tools/admin.js","bytes":30045}],"ceilingBytes":3145728,"dependencies":[{"name":"@modelcontextprotocol/core","version":"2.3.1","path":"node_modules/@modelcontextprotocol/core","bytes":1316868},{"name":"@modelcontextprotocol/node","version":"2.1.1","path":"node_modules/@modelcontextprotocol/node","bytes":153436},{"name":"@hono/node-server","version":"1.19.17","path":"node_modules/@modelcontextprotocol/node/node_modules/@hono/node-server","bytes":228376},{"name":"@modelcontextprotocol/server","version":"2.3.1","path":"node_modules/@modelcontextprotocol/server","bytes":6486743},{"name":"acorn","version":"8.18.0","path":"node_modules/acorn","bytes":565327},{"name":"hono","version":"4.13.12","path":"node_modules/hono","bytes":1287796},{"name":"zod","version":"4.6.7","path":"node_modules/zod","bytes":6148944}],"installedBytes":16187490} -->

Measured 2026-10-27 for version 3.0.0 with `npm run footprint`.

| Measure                                            | Value                              |
| -------------------------------------------------- | ---------------------------------- |
| `npm pack --dry-run` — files                       | 253                                |
| `npm pack --dry-run` — tarball                     | 577,141 B (564 KB)                 |
| `npm pack --dry-run` — unpacked                    | 2,343,861 B (2,289 KB)             |
| `npm run pack:check` ceiling                       | 3,145,728 B (3,072 KB) — 75 % used |
| `build/**/*.js` in the tarball                     | 2,159,750 B (2,109 KB)             |
| `README.md` in the tarball                         | 142,383 B (139 KB)                 |
| Production packages (lockfile, excluding this one) | 7 — 15,808 KB                      |

Largest compiled files: `build/api/ui-experience.js` 47 KB, `build/api/document.js` 44 KB, `build/mcp/prompts.js` 42 KB, `build/core/settings-data-runtime.js` 30 KB, `build/tools/admin.js` 29 KB.

| Package                        | Version | Installed |
| ------------------------------ | ------- | --------- |
| `@modelcontextprotocol/core`   | 2.3.1   | 1,286 KB  |
| `@modelcontextprotocol/node`   | 2.1.1   | 150 KB    |
| `@hono/node-server`            | 1.19.17 | 223 KB    |
| `@modelcontextprotocol/server` | 2.3.1   | 6,335 KB  |
| `acorn`                        | 8.18.0  | 552 KB    |
| `hono`                         | 4.13.12 | 1,258 KB  |
| `zod`                          | 4.6.7   | 6,005 KB  |

<!-- GENERATED:FOOTPRINT:END -->

## What the numbers mean

- **Files, tarball, unpacked:** `npm pack --dry-run --json` over the `files` list of
  `package.json` (`build/` without source maps and the dark Jira client, `bin/`, README, LICENSE,
  `package.json`). The unpacked size is what `scripts/pack-check.mjs` guards; its ceiling is the
  owner's (3 MB since 2026-10-05, O-4) and the footprint script only reads it.
- **`build/**/\*.js`:** the compiled server. Since N-85 (2026-10-27) `npm run build`compiles
through`tsconfig.build.json`—`tsconfig.json`plus`removeComments`and LF newlines — so the
shipped JavaScript carries no comments: 2,676,313 → 2,159,750 B (−516,563 B, −19.3 %).`declaration`is off, so no consumer ever read them, and stack traces keep their file names
(no minification, no bundling). Editors,`npm run watch`and the tests keep`tsconfig.json`.
- **README:** npmjs.com renders the tarball README, so it ships in full.
- **Production packages:** every non-dev entry of `package-lock.json` (a nested entry counts
  once) with its bytes in the local `node_modules` — the install, not the download. The SDK
  (`@modelcontextprotocol/server`, `/node`, `/core`, hono) is most of it; `zod` and `acorn` are
  the server's own dependencies.

## Trims considered

| Option                             | Effect                 | Decision                                                                    |
| ---------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| `removeComments` for the build     | −504 KB of compiled JS | **Applied** (N-85, `tsconfig.build.json`).                                  |
| Minify / bundle `build/` (esbuild) | not measured           | Owner decision: changes stack traces and the release pipeline.              |
| Ship a short README in the tarball | −139 KB                | Not applied: npmjs.com renders the tarball README.                          |
| Raise or lower the pack ceiling    | —                      | Owner decision (O-4); `scripts/pack-check.mjs` is edited by the owner only. |

## Container image

The `Dockerfile` installs the same tarball contents (`npm pack`, then `npm ci --omit=dev`
against the lockfile) on `gcr.io/distroless/nodejs22-debian12:nonroot`, so the image adds the
production packages above to the distroless Node base.

## History

- 2026-09-28 (D-5, 2.0.1 on SDK v1): 132 files, 418 KB tarball, 1,521 KB unpacked against an
  800 KB ceiling; 95 production packages, about 24.8 MB installed. The owner raised the ceiling
  to 3 MB on 2026-10-05.
- 2026-10-27 (N-85, 3.0.0 on SDK v2): the record above. The SDK's v2 split
  (`@modelcontextprotocol/server`) cut the production tree from 95 packages to the handful
  listed, and `removeComments` took 504 KB off the compiled server.
