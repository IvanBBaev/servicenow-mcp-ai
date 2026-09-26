import test from "node:test";
import assert from "node:assert/strict";

import { sendEmail, getEmail } from "../build/api/email.js";
import { ServiceNowError } from "../build/core/errors.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

test("sendEmail posts joined recipients and record association", async () => {
  await withEnv({ SN_EMAIL_ALLOWED_DOMAINS: "x.com" }, () =>
    withFetch(
      (url, init) => {
        assert.match(url, /\/api\/now\/email$/);
        const body = JSON.parse(init.body);
        assert.equal(body.to, "a@x.com,b@x.com");
        assert.equal(body.subject, "Hi");
        assert.equal(body.text, "Body");
        assert.equal(body.cc, "c@x.com");
        assert.equal(body.table_name, "incident");
        assert.equal(body.table_record_id, "rec1");
        assert.equal(body.bcc, undefined);
        return jsonResponse(200, { result: { id: "em1" } });
      },
      async () => {
        const result = await sendEmail({
          to: ["a@x.com", "b@x.com"],
          subject: "Hi",
          body: "Body",
          cc: ["c@x.com"],
          table: "incident",
          sysId: "rec1",
        });
        assert.deepEqual(result, { id: "em1" });
      },
    ),
  );
});

test("sendEmail is blocked in read-only mode before any request", async () => {
  await withEnv({ SN_READONLY: "true" }, () =>
    withFetch(
      () => {
        throw new Error("fetch must not run in read-only mode");
      },
      async (calls) => {
        await assert.rejects(
          sendEmail({ to: ["a@x.com"], subject: "s", body: "b" }),
          (err) => err instanceof ServiceNowError && err.status === 403,
        );
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test("getEmail reads one email record by sys_id", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/email\/em1$/);
      return jsonResponse(200, { result: { sys_id: "em1" } });
    },
    async () => {
      assert.deepEqual(await getEmail("em1"), { sys_id: "em1" });
    },
  );
});
