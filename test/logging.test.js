import test from "node:test";
import assert from "node:assert/strict";

import { logger, setLogSink } from "../build/core/logging.js";
import { withEnv } from "./helpers.js";

/** Capture stderr JSON lines emitted through console.error. */
async function captureLogs(fn) {
  const lines = [];
  const real = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return lines.map((l) => JSON.parse(l));
}

const emitAll = () => {
  logger.error("e");
  logger.warn("w");
  logger.info("i");
  logger.debug("d");
};

test("the default level (info) drops debug but keeps the rest", async () => {
  const entries = await captureLogs(() =>
    withEnv({ SN_LOG_LEVEL: undefined, LOG_LEVEL: undefined }, emitAll),
  );
  assert.deepEqual(
    entries.map((e) => e.level),
    ["error", "warn", "info"],
  );
});

test("SN_LOG_LEVEL=error silences everything below it", async () => {
  const entries = await captureLogs(() =>
    withEnv({ SN_LOG_LEVEL: "error" }, emitAll),
  );
  assert.deepEqual(
    entries.map((e) => e.level),
    ["error"],
  );
});

test("SN_LOG_LEVEL=debug lets every level through", async () => {
  const entries = await captureLogs(() =>
    withEnv({ SN_LOG_LEVEL: "debug" }, emitAll),
  );
  assert.equal(entries.length, 4);
});

test("a sink sees filtered entries; a throwing sink is swallowed (Х-4)", async () => {
  const seen = [];
  setLogSink((level, message) => seen.push(`${level}:${message}`));
  try {
    await captureLogs(() => withEnv({ SN_LOG_LEVEL: "warn" }, emitAll));
    assert.deepEqual(seen, ["error:e", "warn:w"], "sink respects the filter");

    setLogSink(() => {
      throw new Error("boom");
    });
    const entries = await captureLogs(() => logger.error("still works"));
    assert.equal(entries.length, 1, "a failing sink must not break logging");
  } finally {
    setLogSink(null);
  }
});

test("an unknown level falls back to info; entries are structured JSON", async () => {
  const entries = await captureLogs(() =>
    withEnv({ SN_LOG_LEVEL: "loud" }, () => {
      logger.info("hello", { table: "incident" });
      logger.debug("hidden");
    }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, "hello");
  assert.equal(entries[0].table, "incident");
  assert.ok(entries[0].ts, "timestamp present");
});
