// N-4 (O-11, ADR 0011) — the `cicd` package: preview and commit a retrieved
// update set through the CI/CD API. A commit needs a clean preview, binds
// that preview into its plan_token and never forces.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { readPreviewState } from "../build/api/cicd.js";
import { ALL_PACKAGES } from "../build/mcp/package-policy.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const TOOL = "servicenow_commit_update_set";
const spec = ALL_TOOLS.find((s) => s.name === TOOL);
const out = (res) => JSON.parse(res.content[0].text);
const call = (args) => runSpec(spec, args);

const SET_ID = "a".repeat(32);
const args = (step, extra = {}) => ({ update_set: SET_ID, step, ...extra });

/**
 * A fake instance: the remote update set and its preview problems are
 * mutable, so a test can change them between the plan and the apply.
 */
function instance(state = { state: "previewed", mod: "4", problems: [] }) {
  return {
    state,
    handler: (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return jsonResponse(200, {
          result: {
            status: "1",
            status_label: "Pending",
            percent_complete: 0,
            links: { progress: { id: "prog1" } },
          },
        });
      }
      if (u.pathname.endsWith(`/sys_remote_update_set/${SET_ID}`)) {
        return jsonResponse(200, {
          result: {
            sys_id: SET_ID,
            name: "Release 4",
            state: state.state,
            sys_mod_count: state.mod,
            sys_updated_on: "2026-10-14 10:00:00",
          },
        });
      }
      if (u.pathname.endsWith("/sys_update_preview_problem")) {
        return jsonResponse(200, { result: state.problems });
      }
      if (u.pathname.includes("/api/sn_cicd/progress/")) {
        return jsonResponse(200, {
          result: {
            status: "2",
            status_label: "Successful",
            percent_complete: 100,
          },
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    },
  };
}

const posts = (calls) => calls.filter((c) => c.init?.method === "POST");

async function scenario(env, state, fn) {
  const docs = mkdtempSync(path.join(tmpdir(), "n4-"));
  freshRuntime();
  const inst = instance(state);
  try {
    return await withEnv({ SN_DOCS_DIR: docs, ...env }, () =>
      withFetch(inst.handler, (calls) => fn(calls, inst.state)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

test("cicd is a package of its own, off by default, with one destructive tool", () => {
  assert.ok(ALL_PACKAGES.includes("cicd"));
  assert.equal(spec.package, "cicd");
  assert.equal(spec.annotations.destructiveHint, true);
  assert.equal(spec.annotations.readOnlyHint, false);
});

test("readPreviewState: resolved problems keep a preview clean, an unresolved one does not", async () => {
  await scenario(
    {},
    {
      state: "previewed",
      mod: "1",
      problems: [
        { sys_id: "p1", type: "error", status: "ignored", description: "x" },
        { sys_id: "p2", type: "warning", status: "skipped", description: "y" },
      ],
    },
    async (_calls, state) => {
      const clean = await readPreviewState(SET_ID);
      assert.equal(clean.clean, true);
      assert.equal(clean.problems.total, 2);
      assert.equal(clean.problems.unresolved, 0);
      state.problems.push({
        sys_id: "p3",
        type: "error",
        status: "",
        description: "z",
      });
      const dirty = await readPreviewState(SET_ID);
      assert.equal(dirty.clean, false);
      assert.equal(dirty.problems.unresolved, 1);
      assert.equal(dirty.problems.items[0].sys_id, "p3", "unresolved first");
      assert.notEqual(dirty.fingerprint, clean.fingerprint);
    },
  );
});

test("preview: the plan starts nothing; apply posts the preview job and journals it", async () => {
  await scenario(
    { SN_DESTRUCTIVE_CONFIRM: "token" },
    undefined,
    async (calls) => {
      const plan = out(await call(args("preview")));
      assert.equal(plan.mode, "plan");
      assert.equal(plan.plan_token, undefined, "a preview is not destructive");
      assert.equal(posts(calls).length, 0);
      const res = await call(args("preview", { apply: true }));
      assert.equal(res.isError, undefined, res.content[0].text);
      assert.equal(out(res).executionId, "prog1");
      const [post] = posts(calls);
      assert.match(
        post.url,
        new RegExp(`/api/sn_cicd/update_set/preview/${SET_ID}`),
      );
    },
  );
});

test("preview with wait_seconds reports the preview state once the job finishes", async () => {
  await scenario({ SN_DESTRUCTIVE_CONFIRM: "token" }, undefined, async () => {
    const res = out(
      await call(args("preview", { apply: true, wait_seconds: 5 })),
    );
    assert.equal(res.wait.state, "finished");
    assert.equal(res.clean, true);
    assert.equal(res.preview.state, "previewed");
  });
});

test("commit: a preview that is not clean gets no plan and no token", async () => {
  await scenario(
    { SN_DESTRUCTIVE_CONFIRM: "token" },
    {
      state: "previewed",
      mod: "1",
      problems: [
        { sys_id: "p1", type: "error", status: "", description: "Missing ref" },
      ],
    },
    async (calls) => {
      const res = await call(args("commit"));
      assert.equal(res.isError, true);
      const body = out(res);
      assert.equal(body.code, "CONFLICT");
      assert.match(
        body.error ?? body.message ?? res.content[0].text,
        /1 unresolved problem/,
      );
      assert.equal(posts(calls).length, 0);
    },
  );
});

test("commit: a set that was never previewed is refused", async () => {
  await scenario(
    { SN_DESTRUCTIVE_CONFIRM: "off" },
    { state: "loaded", mod: "1", problems: [] },
    async (calls) => {
      const res = await call(args("commit", { apply: true }));
      assert.equal(res.isError, true);
      assert.equal(out(res).code, "CONFLICT");
      assert.equal(posts(calls).length, 0);
    },
  );
});

test("commit: clean plan → token → apply posts force_commit=false once", async () => {
  await scenario(
    { SN_DESTRUCTIVE_CONFIRM: "token" },
    undefined,
    async (calls) => {
      const plan = out(await call(args("commit")));
      assert.equal(plan.mode, "plan");
      assert.equal(plan.clean, true);
      assert.match(plan.plan_token, /^pt[a-z]{28}$/);
      assert.equal(plan.after.force_commit, false);
      const refused = out(await call(args("commit", { apply: true })));
      assert.equal(refused.code, "PLAN_REQUIRED");
      const res = await call(
        args("commit", { apply: true, plan_token: plan.plan_token }),
      );
      assert.equal(res.isError, undefined, res.content[0].text);
      const [post, ...rest] = posts(calls);
      assert.equal(rest.length, 0);
      const u = new URL(post.url);
      assert.equal(
        u.pathname.endsWith(`/api/sn_cicd/update_set/commit/${SET_ID}`),
        true,
      );
      assert.equal(u.searchParams.get("force_commit"), "false");
    },
  );
});

test("commit: a preview that changed after the plan is refused as stale", async () => {
  await scenario(
    { SN_DESTRUCTIVE_CONFIRM: "token" },
    undefined,
    async (calls, state) => {
      const plan = out(await call(args("commit")));
      // Still clean, but no longer the preview the plan showed.
      state.mod = "5";
      state.problems.push({
        sys_id: "p9",
        type: "warning",
        status: "skipped",
        description: "",
      });
      const res = await call(
        args("commit", { apply: true, plan_token: plan.plan_token }),
      );
      assert.equal(res.isError, true);
      assert.equal(out(res).code, "STALE_RECORD");
      assert.equal(posts(calls).length, 0);
    },
  );
});

test("commit: a preview that turned dirty after the plan is refused", async () => {
  await scenario(
    { SN_DESTRUCTIVE_CONFIRM: "token" },
    undefined,
    async (calls, state) => {
      const plan = out(await call(args("commit")));
      state.problems.push({
        sys_id: "p9",
        type: "error",
        status: "",
        description: "",
      });
      const res = await call(
        args("commit", { apply: true, plan_token: plan.plan_token }),
      );
      assert.equal(out(res).code, "CONFLICT");
      assert.equal(posts(calls).length, 0);
    },
  );
});

test("commit and preview are refused in read-only mode before any job starts", async () => {
  await scenario(
    { SN_DESTRUCTIVE_CONFIRM: "off", SN_READONLY: "true" },
    undefined,
    async (calls) => {
      for (const step of ["preview", "commit"]) {
        const res = await call(args(step, { apply: true }));
        assert.equal(res.isError, true, step);
      }
      assert.equal(posts(calls).length, 0);
    },
  );
});
