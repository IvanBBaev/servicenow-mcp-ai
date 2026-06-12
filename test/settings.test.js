import test from "node:test";
import assert from "node:assert/strict";

import {
  getTimeoutMs,
  getMaxRetries,
  getMaxRecords,
  getMaxResultChars,
  getDeniedPackages,
  getReadOnlyPackages,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_RESULT_CHARS,
} from "../build/core/settings.js";
import { withEnv } from "./helpers.js";

test("getTimeoutMs: valid value, fallback on unset/invalid/zero/negative", async () => {
  await withEnv({ SN_TIMEOUT_MS: "5000" }, () =>
    assert.equal(getTimeoutMs(), 5000),
  );
  for (const bad of [undefined, "abc", "0", "-5"]) {
    await withEnv({ SN_TIMEOUT_MS: bad }, () =>
      assert.equal(getTimeoutMs(), DEFAULT_TIMEOUT_MS, `value: ${bad}`),
    );
  }
});

test("getMaxRetries: zero is allowed, decimals floor, invalid falls back", async () => {
  await withEnv({ SN_MAX_RETRIES: "0" }, () =>
    assert.equal(getMaxRetries(), 0),
  );
  await withEnv({ SN_MAX_RETRIES: "3.7" }, () =>
    assert.equal(getMaxRetries(), 3),
  );
  for (const bad of [undefined, "abc", "-1"]) {
    await withEnv({ SN_MAX_RETRIES: bad }, () =>
      assert.equal(getMaxRetries(), DEFAULT_MAX_RETRIES, `value: ${bad}`),
    );
  }
});

test("package policy lists parse like SN_TOOL_PACKAGES and default to empty", async () => {
  await withEnv({ SN_PACKAGES_DENY: undefined }, () =>
    assert.deepEqual(getDeniedPackages(), []),
  );
  await withEnv({ SN_PACKAGES_DENY: "Change,  CATALOG knowledge" }, () =>
    assert.deepEqual(getDeniedPackages(), ["change", "catalog", "knowledge"]),
  );
  await withEnv({ SN_PACKAGES_READONLY: "  " }, () =>
    assert.deepEqual(getReadOnlyPackages(), []),
  );
  await withEnv({ SN_PACKAGES_READONLY: "cmdb" }, () =>
    assert.deepEqual(getReadOnlyPackages(), ["cmdb"]),
  );
});

test("getMaxRecords and getMaxResultChars follow the same contract", async () => {
  await withEnv({ SN_MAX_RECORDS: "50" }, () =>
    assert.equal(getMaxRecords(), 50),
  );
  await withEnv({ SN_MAX_RECORDS: "nope" }, () =>
    assert.equal(getMaxRecords(), DEFAULT_MAX_RECORDS),
  );
  await withEnv({ SN_MAX_RESULT_CHARS: "1234" }, () =>
    assert.equal(getMaxResultChars(), 1234),
  );
  await withEnv({ SN_MAX_RESULT_CHARS: "-1" }, () =>
    assert.equal(getMaxResultChars(), DEFAULT_MAX_RESULT_CHARS),
  );
});
