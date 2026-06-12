import test from "node:test";
import assert from "node:assert/strict";

import {
  pluginCall,
  pluginAvailability,
  _resetPluginAvailability,
} from "../build/api/plugin.js";
import { ServiceNowError } from "../build/core/errors.js";

test.beforeEach(() => _resetPluginAvailability());

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
  assert.deepEqual(pluginAvailability(), { "Change Management": "unavailable" });

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
