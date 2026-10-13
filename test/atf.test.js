import test from "node:test";
import assert from "node:assert/strict";

import {
  listAtfTests,
  runAtfTest,
  runAtfSuite,
  getAtfResult,
} from "../build/api/atf.js";
import { ServiceNowError } from "../build/core/errors.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

test("listAtfTests reads sys_atf_test (FT-4)", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/sys_atf_test(\?|$)/);
      return jsonResponse(200, { result: [{ sys_id: "t1", name: "Smoke" }] });
    },
    async () => {
      const tests = await listAtfTests({ active: true });
      assert.equal(tests.length, 1);
      assert.equal(tests[0].name, "Smoke");
    },
  );
});

test("runAtfSuite posts to the CI/CD API and returns the execution id (FT-4)", async () => {
  await withFetch(
    (url, init) => {
      assert.equal(init.method, "POST");
      assert.match(url, /\/api\/sn_cicd\/testsuite\/run/);
      assert.equal(new URL(url).searchParams.get("sys_id"), "suite1");
      return jsonResponse(200, {
        result: {
          status: "2",
          status_label: "Running",
          percent_complete: 0,
          links: { progress: { id: "exec1", url: "https://x/progress/exec1" } },
        },
      });
    },
    async () => {
      const run = await runAtfSuite("suite1");
      assert.equal(run.executionId, "exec1");
      assert.equal(run.statusLabel, "Running");
    },
  );
});

test("the run tools are blocked in read-only mode before any request (FT-4)", async () => {
  process.env.SN_READONLY = "true";
  try {
    await withFetch(
      () => {
        throw new Error("fetch must not run in read-only mode");
      },
      async (calls) => {
        await assert.rejects(
          runAtfSuite("suite1"),
          (err) => err instanceof ServiceNowError && err.status === 403,
        );
        await assert.rejects(
          runAtfTest("test1"),
          (err) => err instanceof ServiceNowError && err.status === 403,
        );
        assert.equal(calls.length, 0);
      },
    );
  } finally {
    delete process.env.SN_READONLY;
  }
});

test("getAtfResult reads the CI/CD progress endpoint (FT-4)", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/sn_cicd\/progress\/exec1$/);
      return jsonResponse(200, {
        result: {
          status: "3",
          status_label: "Successful",
          percent_complete: 100,
        },
      });
    },
    async () => {
      const run = await getAtfResult("exec1");
      assert.equal(run.statusLabel, "Successful");
      assert.equal(run.percentComplete, 100);
    },
  );
});

test("an inactive CI/CD plugin is reported clearly (FT-4)", async () => {
  await withFetch(
    () =>
      jsonResponse(404, {
        error: { message: "Requested URI does not represent any resource" },
      }),
    async () => {
      await assert.rejects(
        getAtfResult("exec1"),
        (err) =>
          err instanceof ServiceNowError &&
          err.status === 404 &&
          /may not be active/i.test(err.message),
      );
    },
  );
});

test("the run tools are refused on a prod-marked profile before any request (B21)", async () => {
  await withEnv({ SN_ENV: "prod" }, async () => {
    await withFetch(
      () => {
        throw new Error("fetch must not run on prod");
      },
      async (calls) => {
        for (const run of [
          () => runAtfSuite("suite1"),
          () => runAtfTest("test1"),
        ]) {
          await assert.rejects(
            run(),
            (err) =>
              err instanceof ServiceNowError &&
              err.code === "POLICY_DENIED" &&
              err.status === 403 &&
              /marked prod \(SN_ENV\)/.test(err.message),
          );
        }
        assert.equal(calls.length, 0);
      },
    );
  });
  // A cached missing-namespace answer from an earlier test would mask the run.
  freshRuntime();
  await withEnv({ SN_ENV: "test" }, async () => {
    await withFetch(
      () =>
        jsonResponse(200, { result: { links: { progress: { id: "e1" } } } }),
      async (calls) => {
        await runAtfSuite("suite1");
        assert.equal(calls.length, 1);
      },
    );
  });
});
