import test from "node:test";
import assert from "node:assert/strict";

import {
  pluginCall,
  pluginAvailability,
  clearPluginAvailability,
} from "../build/api/plugin.js";
import { expectResult } from "../build/api/shared.js";
import { ServiceNowError } from "../build/core/errors.js";
import { withEnv } from "./helpers.js";

test.beforeEach(() => clearPluginAvailability());

const namespace404 = () =>
  new ServiceNowError("ServiceNow API error (404): not found", 404, {
    error: { message: "Requested URI does not represent any resource" },
  });

const record404 = () =>
  new ServiceNowError("ServiceNow API error (404): No Record found", 404, {
    error: { message: "No Record found" },
  });

test("pluginCall annotates 404s with the inactive-plugin hint", async () => {
  await assert.rejects(
    pluginCall("Knowledge", async () => {
      throw record404();
    }),
    (err) =>
      err instanceof ServiceNowError &&
      err.status === 404 &&
      /Knowledge API\/plugin may not be active/.test(err.message),
  );
});

test("a missing-result error inside pluginCall propagates without mismarking availability (ARCH-4)", async () => {
  // catalog/change/knowledge unwrap via expectResult INSIDE pluginCall. A 200
  // body with no `result` must surface a clear error (status undefined → not the
  // 404 path) and must NOT mark the API unavailable — the namespace responded.
  await assert.rejects(
    pluginCall("Knowledge", async () =>
      expectResult({ notResult: 1 }, "Knowledge API"),
    ),
    (err) =>
      err instanceof ServiceNowError &&
      err.status === undefined &&
      /missing 'result'/.test(err.message) &&
      !/may not be active/.test(err.message),
  );
  assert.deepEqual(
    pluginAvailability(),
    {},
    "a missing-result error is not plugin absence",
  );
});

test("pluginCall passes non-404 errors through untouched", async () => {
  const original = new ServiceNowError("denied", 403);
  await assert.rejects(
    pluginCall("Knowledge", async () => {
      throw original;
    }),
    (err) => err === original,
  );
});

test("pluginCall returns the wrapped result on success and marks availability", async () => {
  assert.equal(await pluginCall("Knowledge", async () => 42), 42);
  assert.deepEqual(pluginAvailability(), { Knowledge: "available" });
});

test("a namespace 404 is cached: the next call fails fast without running fn", async () => {
  let fnCalls = 0;
  const attempt = () =>
    pluginCall("Change Management", async () => {
      fnCalls += 1;
      throw namespace404();
    });

  await assert.rejects(attempt, /may not be active/);
  assert.equal(fnCalls, 1);
  assert.deepEqual(pluginAvailability(), {
    "Change Management": "unavailable",
  });

  // Second call must be refused from the cache, not re-probed.
  await assert.rejects(
    attempt,
    (err) =>
      err instanceof ServiceNowError &&
      err.status === 404 &&
      /probably inactive/.test(err.message),
  );
  assert.equal(fnCalls, 1, "fn must not run while the API is cached as absent");
});

test("a record-level 404 is NOT cached as plugin absence", async () => {
  let fnCalls = 0;
  const attempt = () =>
    pluginCall("Knowledge", async () => {
      fnCalls += 1;
      throw record404();
    });

  await assert.rejects(attempt, /may not be active/);
  await assert.rejects(attempt, /may not be active/);
  assert.equal(fnCalls, 2, "record 404s must keep reaching the instance");
  assert.deepEqual(pluginAvailability(), {});
});

test("availability is cached per instance — a 404 on one host never blocks another (ARCH-1)", async () => {
  // Instance A: a namespace 404 marks the Email API unavailable there.
  await withEnv({ SN_INSTANCE: "inst-a.service-now.com" }, async () => {
    await assert.rejects(
      pluginCall("Email", async () => {
        throw namespace404();
      }),
      /may not be active/,
    );
    assert.deepEqual(pluginAvailability(), { Email: "unavailable" });
  });

  // Instance B: the SAME API must be probed, not refused from A's cache.
  await withEnv({ SN_INSTANCE: "inst-b.service-now.com" }, async () => {
    let ran = false;
    const out = await pluginCall("Email", async () => {
      ran = true;
      return "ok";
    });
    assert.equal(
      ran,
      true,
      "instance B must reach fn, not fast-fail on A's cache",
    );
    assert.equal(out, "ok");
    assert.deepEqual(pluginAvailability(), { Email: "available" });
  });
});
