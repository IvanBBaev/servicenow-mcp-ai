import test from "node:test";
import assert from "node:assert/strict";

import { setLogSink } from "../build/core/logging.js";
import { queryTable } from "../build/api/table.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

/**
 * N-35 / ADR 0008 — logging hygiene on the 2026-07-28 revision: server logs
 * go to stderr (stdout carries the protocol on stdio), and no sink — stderr
 * or the `notifications/message` bridge — receives credentials, auth headers
 * or the caller's encoded query (which may carry personal data).
 */

const SECRET_QUERY =
  "caller_id.email=bob@example.com^short_description=hunter2";
const BASIC = Buffer.from("alice:s3cret").toString("base64");

/** Captures stderr lines, stdout writes and the secondary log sink. */
async function captureLogs(fn) {
  const stderr = [];
  const stdout = [];
  const sink = [];
  const realError = console.error;
  const realLog = console.log;
  const realWrite = process.stdout.write;
  console.error = (line) => stderr.push(String(line));
  console.log = (...args) => stdout.push(args.join(" "));
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  setLogSink((level, message, fields) =>
    sink.push(JSON.stringify({ level, message, ...fields })),
  );
  try {
    await fn();
  } finally {
    console.error = realError;
    console.log = realLog;
    process.stdout.write = realWrite;
    setLogSink(null);
  }
  return { stderr, stdout, sink };
}

test("logs go to stderr only and never carry credentials, headers or the query", async () => {
  baselineEnv();
  freshRuntime();
  const responses = [
    () => jsonResponse(200, { result: [{ sys_id: "a".repeat(32) }] }),
    () => jsonResponse(403, { error: { message: "User Not Authorized" } }),
    () => jsonResponse(500, { error: { message: "boom" } }),
  ];
  const { stderr, stdout, sink } = await captureLogs(() =>
    withEnv({ SN_LOG_LEVEL: "debug", SN_LOG_FORMAT: undefined }, () =>
      withFetch(
        (_url, _init, n) => responses[n - 1](),
        async () => {
          await queryTable({ table: "incident", query: SECRET_QUERY });
          await assert.rejects(
            queryTable({ table: "incident", query: SECRET_QUERY }),
          );
          await assert.rejects(
            queryTable({ table: "incident", query: SECRET_QUERY }),
          );
        },
      ),
    ),
  );
  freshRuntime();

  assert.deepEqual(stdout, [], "nothing is written to stdout");
  assert.ok(stderr.length >= 2, "the failed requests are logged");
  for (const line of stderr) JSON.parse(line);
  assert.equal(sink.length, stderr.length, "the bridge sees every line");

  for (const text of [...stderr, ...sink]) {
    assert.ok(!text.includes("s3cret"), `password in ${text}`);
    assert.ok(!text.includes(BASIC), `Basic credentials in ${text}`);
    assert.ok(!/authorization/i.test(text), `auth header in ${text}`);
    assert.ok(!text.includes("bob@example.com"), `query PII in ${text}`);
    assert.ok(!text.includes("hunter2"), `query value in ${text}`);
    assert.ok(!text.includes("sysparm_query"), `query string in ${text}`);
  }
});
