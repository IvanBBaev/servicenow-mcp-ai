import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec, buildOutputSchema } from "../build/mcp/define.js";
import { baselineEnv, withEnv, realFetch } from "./helpers.js";

baselineEnv();

/**
 * Manifest-integrity smoke: every tool must be invokable through `runSpec` and
 * return a well-formed ToolResult — exercising each handler, its logFields and
 * the ok()/fail() envelope. Args are synthesised from each tool's own zod input
 * shape, so the test adapts automatically as tools change.
 */
function synth(zt) {
  // E-2: zod 4 keeps the definition on `_zod.def`, discriminated by `type`.
  const def = zt?._zod?.def;
  switch (def?.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      return synth(def.innerType);
    case "pipe":
      return synth(def.in);
    case "string":
      return "x";
    case "number":
      return 1;
    case "boolean":
      return true;
    case "enum":
      return Object.values(def.entries)[0];
    case "literal":
      return def.values[0];
    case "array":
      return [synth(def.element)];
    case "record":
      return {};
    case "union":
      return synth(def.options[0]);
    case "object": {
      const o = {};
      for (const [k, v] of Object.entries(def.shape)) o[k] = synth(v);
      return o;
    }
    default:
      return {};
  }
}

const argsFor = (spec) =>
  Object.fromEntries(
    Object.entries(spec.input).map(([k, zt]) => [k, synth(zt)]),
  );

// A permissive ServiceNow mock so every handler can run to completion.
function mockFetch(url, init) {
  const u = String(url);
  const body = (status, obj) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (/\/oauth_token\.do/.test(u))
    return body(200, { access_token: "t", expires_in: 3600 });
  if (/\/api\/sn_cicd\//.test(u))
    return body(200, {
      result: { links: { progress: { id: "e1" } }, status: "2" },
    });
  if (/\/api\/now\/stats\//.test(u))
    return body(200, { result: { stats: { count: "0" } } });
  if (/\/api\/now\/v1\/batch/.test(u))
    return body(200, {
      result: { serviced_requests: [], unserviced_requests: [] },
    });
  // A single-record read (table/<name>/<sys_id>) answers with one object.
  if (
    (init?.method ?? "GET") === "GET" &&
    /\/api\/now\/table\/[^/?]+\/[^/?]+/.test(u)
  )
    return body(200, { result: {} });
  if ((init?.method ?? "GET") === "GET") return body(200, { result: [] });
  return body(200, { result: {} });
}

test("every manifest tool returns a well-formed ToolResult via runSpec", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-alltools-"));
  try {
    await withEnv(
      { SN_DOCS_DIR: dir, SN_ENV_FILE: join(dir, ".env") },
      async () => {
        globalThis.fetch = mockFetch;
        try {
          assert.ok(ALL_TOOLS.length >= 60, "all packages are present");
          let structured = 0;
          for (const spec of ALL_TOOLS) {
            const res = await runSpec(spec, argsFor(spec));
            assert.ok(
              Array.isArray(res.content) &&
                typeof res.content[0]?.text === "string",
              `${spec.name} returned a valid ToolResult`,
            );
            // M-6: a tool with an output shape answers a success with
            // structuredContent that passes its (passthrough) outputSchema —
            // the SDK rejects the call otherwise; an error never carries it.
            if (res.isError) {
              assert.equal(res.structuredContent, undefined, spec.name);
            } else if (spec.output) {
              const parsed = buildOutputSchema(spec).safeParse(
                res.structuredContent,
              );
              assert.ok(
                parsed.success,
                `${spec.name} structuredContent matches its outputSchema`,
              );
              structured++;
            }
          }
          assert.ok(structured >= 20, "most output tools were exercised");
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // set_credentials may have mutated process.env — restore the baseline.
    baselineEnv();
  }
});
