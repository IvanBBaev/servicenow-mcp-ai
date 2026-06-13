import test from "node:test";
import assert from "node:assert/strict";

import {
  uploadAttachment,
  downloadAttachment,
  listAttachments,
  getAttachmentMeta,
} from "../build/api/attachment.js";
import { ServiceNowError } from "../build/core/errors.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

test("uploadAttachment rejects malformed base64 before any request", async () => {
  for (const bad of ["не-base64!", "abc", "ab=c", "a===", "QUJ$"]) {
    await withFetch(
      () => {
        throw new Error("fetch must not be called for invalid base64");
      },
      async (calls) => {
        await assert.rejects(
          uploadAttachment({
            table: "incident",
            sysId: "rec1",
            fileName: "x.txt",
            contentBase64: bad,
          }),
          (err) =>
            err instanceof ServiceNowError &&
            /not valid base64/.test(err.message),
          `expected rejection for ${JSON.stringify(bad)}`,
        );
        assert.equal(calls.length, 0);
      },
    );
  }
});

test("uploadAttachment sends the decoded bytes (whitespace tolerated)", async () => {
  const base64 = Buffer.from("hello world", "utf8").toString("base64");
  // Linebreaks are standard in MIME-style base64 and must be accepted.
  const wrapped = base64.slice(0, 4) + "\n" + base64.slice(4);
  await withFetch(
    (url, init) => {
      assert.match(url, /\/api\/now\/attachment\/file\?/);
      assert.equal(Buffer.from(init.body).toString("utf8"), "hello world");
      assert.equal(init.headers["Content-Type"], "text/plain");
      return jsonResponse(201, { result: { sys_id: "att1" } });
    },
    async (calls) => {
      const meta = await uploadAttachment({
        table: "incident",
        sysId: "rec1",
        fileName: "x.txt",
        contentBase64: wrapped,
        contentType: "text/plain",
      });
      assert.equal(meta.sys_id, "att1");
      assert.equal(calls.length, 1);
    },
  );
});

test("downloadAttachment refuses an oversized file without fetching its bytes", async () => {
  await withEnv({ SN_MAX_RESULT_CHARS: "100" }, () =>
    withFetch(
      (url) => {
        assert.match(
          url,
          /\/api\/now\/attachment\/att1$/,
          "only the metadata endpoint may be hit",
        );
        return jsonResponse(200, {
          result: { sys_id: "att1", file_name: "big.bin", size_bytes: "5000" },
        });
      },
      async (calls) => {
        await assert.rejects(
          downloadAttachment("att1"),
          (err) =>
            err instanceof ServiceNowError &&
            /too large to return inline/.test(err.message),
        );
        assert.equal(calls.length, 1, "the /file endpoint must not be called");
      },
    ),
  );
});

test("downloadAttachment returns base64 for a small file", async () => {
  await withFetch(
    (url) => {
      if (/\/api\/now\/attachment\/att2$/.test(url)) {
        return jsonResponse(200, {
          result: { sys_id: "att2", file_name: "ok.txt", size_bytes: "5" },
        });
      }
      assert.match(url, /\/api\/now\/attachment\/att2\/file$/);
      return new Response(Buffer.from("hello", "utf8"), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    },
    async (calls) => {
      const file = await downloadAttachment("att2");
      assert.equal(
        Buffer.from(file.base64, "base64").toString("utf8"),
        "hello",
      );
      assert.equal(file.contentType, "text/plain");
      assert.equal(calls.length, 2);
    },
  );
});

test("listAttachments scopes the query to a record and returns the metadata (QA-10)", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/attachment\?/);
      assert.equal(
        new URL(url).searchParams.get("sysparm_query"),
        "table_name=incident^table_sys_id=rec1",
      );
      return jsonResponse(200, {
        result: [
          { sys_id: "a1", file_name: "one.txt", size_bytes: "10" },
          { sys_id: "a2", file_name: "two.png", size_bytes: "20" },
        ],
      });
    },
    async (calls) => {
      const list = await listAttachments("incident", "rec1");
      assert.equal(list.length, 2);
      assert.equal(list[0].file_name, "one.txt");
      assert.equal(calls.length, 1);
    },
  );
});

test("listAttachments rejects a '^' in table or sysId before any request (DEV-2)", async () => {
  for (const args of [
    ["incident^active=false", undefined],
    ["incident", "abc^ORDERBYsys_created_on"],
  ]) {
    await withFetch(
      () => {
        throw new Error("fetch must not run for a caret argument");
      },
      async (calls) => {
        await assert.rejects(
          listAttachments(args[0], args[1]),
          (err) =>
            err instanceof ServiceNowError &&
            /cannot contain '\^'/.test(err.message),
        );
        assert.equal(calls.length, 0);
      },
    );
  }
});

test("getAttachmentMeta returns the record and surfaces a malformed response (QA-13)", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/attachment\/att9$/);
      return jsonResponse(200, {
        result: { sys_id: "att9", file_name: "f.txt", size_bytes: "12" },
      });
    },
    async () => {
      const meta = await getAttachmentMeta("att9");
      assert.equal(meta.file_name, "f.txt");
    },
  );
  await withFetch(
    () => jsonResponse(200, {}),
    async () => {
      await assert.rejects(
        getAttachmentMeta("att9"),
        (err) =>
          err instanceof ServiceNowError && /Attachment API/.test(err.message),
      );
    },
  );
});

test("downloadAttachment uses the post-fetch size guard when size_bytes is absent (QA-14)", async () => {
  await withEnv({ SN_MAX_RESULT_CHARS: "8" }, () =>
    withFetch(
      (url) => {
        if (/\/api\/now\/attachment\/att5$/.test(url)) {
          // No size_bytes → the pre-fetch estimate guard is skipped.
          return jsonResponse(200, {
            result: { sys_id: "att5", file_name: "x.bin" },
          });
        }
        assert.match(url, /\/att5\/file$/);
        return new Response(Buffer.from("way too many bytes", "utf8"), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      },
      async (calls) => {
        await assert.rejects(
          downloadAttachment("att5"),
          (err) =>
            err instanceof ServiceNowError &&
            /too large to return inline/.test(err.message),
        );
        assert.equal(
          calls.length,
          2,
          "the /file endpoint is reached (no pre-guard), then the payload is rejected",
        );
      },
    ),
  );
});
