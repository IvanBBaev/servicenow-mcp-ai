# Install footprint (D-5)

Measured 2026-09-28 on the D-5 working tree (version 2.0.1, Node 22.23.2,
npm 10.9.8, macOS). Re-measure with the commands below before quoting these
numbers in a release note.

## What `npm install servicenow-mcp-ai` downloads

| Measure                                       | Value                                    |
| --------------------------------------------- | ---------------------------------------- |
| `npm pack --dry-run` — files                  | 132                                      |
| `npm pack --dry-run` — tarball                | 418.2 KB                                 |
| `npm pack --dry-run` — unpacked               | 1,557,782 B (1,521.3 KB)                 |
| `npm run pack:check` ceiling                  | 800 KB unpacked — **fails** (owner, O-4) |
| `npm ls --omit=dev --all \| wc -l` (repo)     | 163 lines, 95 unique packages incl. root |
| Clean `npm install --omit=dev` of the tarball | 96 packages added                        |
| `du -sk node_modules` of that install         | 25,416 KB (~24.8 MB)                     |

The ROADMAP-V3 estimate ("93 packages ≈ 50 MB") was high on size: the real
install is about half of that.

## Ours vs the SDK's transitive tree

| Part                                              | Size (du)  | Share |
| ------------------------------------------------- | ---------- | ----- |
| `servicenow-mcp-ai` itself (build/, bin/, README) | 1,772 KB   | 7%    |
| `zod` (our direct dependency, also the SDK's)     | 5,136 KB   | 20%   |
| `acorn` (our direct dependency since S-12)        | ~568 KB    | 2%    |
| `@modelcontextprotocol/sdk` itself                | 6,112 KB   | 24%   |
| Everything the SDK pulls in (93 packages)         | ~12,300 KB | 48%   |

The largest SDK transitive packages: `hono` 2,864 KB, `ajv` 2,364 KB,
`zod-to-json-schema` 620 KB, `ip-address` 424 KB, `qs` 416 KB, `jose` 408 KB,
`iconv-lite` 400 KB, `fast-uri` 328 KB, `mime-db` 236 KB, `@hono/node-server`
220 KB. Most of the SDK tree (express, hono, cors, express-rate-limit,
eventsource, jose, pkce-challenge) serves the SDK's HTTP server and OAuth
helpers; this server uses the SDK's Streamable HTTP transport on a plain
`node:http` server and none of the SDK's auth code, but npm has no way to omit
a dependency's non-optional dependencies. Shrinking that part needs an SDK
split (upstream) or bundling the used SDK modules — both owner decisions, not
a D-5 trim.

## Inside our tarball

| Content                        | Bytes      |
| ------------------------------ | ---------- |
| `build/**/*.js` (compiled)     | ~1,440,000 |
| `README.md`                    | ~113,000   |
| `package.json`, `LICENSE`, bin | ~5,400     |

Largest compiled files: `build/core/artifacts/registry.js` 93.7 KB,
`build/api/document.js` 89.7 KB, `build/api/explain-flow.js` 58.8 KB.

Already excluded by the `files` list: source maps, the dark Jira client, tests,
sources, scripts. No declaration files are emitted.

## Trims considered

| Option                                    | Effect                   | Decision                                                                      |
| ----------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `tsc --removeComments` (+ no source maps) | JS 1,430 KB → 1,166 KB   | Not applied: still over 800 KB, and comments aid debugging a published build. |
| Minify / bundle `build/` (esbuild)        | not measured             | Owner decision: changes stack traces and the release pipeline.                |
| Ship a short README in the tarball        | −~110 KB                 | Not applied: npmjs.com renders the tarball README.                            |
| Raise the 800 KB pack ceiling             | makes `pack:check` green | Owner decision (O-4); `scripts/pack-check.mjs` is unchanged.                  |

Nothing obviously ours and safe remained to trim, so D-5 changes no build
setting. The pack stays at ~1.52 MB unpacked.

## Container image

The `Dockerfile` installs the same tarball contents (`npm pack`, then
`npm ci --omit=dev` against the lockfile) on
`gcr.io/distroless/nodejs22-debian12:nonroot`, so the image adds the ~25 MB
above to the distroless Node base. The image size was not measured: the local
Docker daemon failed with storage I/O errors during this change.

## How to re-measure

```bash
npm run build
npm pack --dry-run
npm ls --omit=dev --all | wc -l
npm pack --pack-destination /tmp/fp && cd /tmp/fp && npm init -y >/dev/null \
  && npm install --omit=dev ./servicenow-mcp-ai-*.tgz && du -sk node_modules \
  && du -sk node_modules/* node_modules/@*/* | sort -rn | head -20
```
