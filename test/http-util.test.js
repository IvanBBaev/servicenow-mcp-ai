import test from "node:test";
import assert from "node:assert/strict";

import {
  retryAfterMs,
  shouldRetryStatus,
  isIdempotent,
} from "../build/core/http-util.js";

const withRetryAfter = (value) =>
  new Response(null, {
    headers: value == null ? {} : { "retry-after": value },
  });

// --- retryAfterMs -----------------------------------------------------------

test("retryAfterMs returns undefined when the header is absent", () => {
  assert.equal(retryAfterMs(withRetryAfter(null)), undefined);
});

test("retryAfterMs converts a seconds value to milliseconds", () => {
  assert.equal(retryAfterMs(withRetryAfter("5")), 5000);
});

test("retryAfterMs caps an absurd seconds value at 60s", () => {
  // A hostile/buggy "Retry-After: 3600" must not hang a tool call for an hour.
  assert.equal(retryAfterMs(withRetryAfter("3600")), 60_000);
});

test("retryAfterMs floors a past HTTP date at zero", () => {
  const past = new Date(Date.now() - 10_000).toUTCString();
  assert.equal(retryAfterMs(withRetryAfter(past)), 0);
});

test("retryAfterMs returns undefined for an unparseable header", () => {
  assert.equal(retryAfterMs(withRetryAfter("not-a-date")), undefined);
});

// --- shouldRetryStatus matrix ----------------------------------------------

test("429 is retried for every method (rejected before processing)", () => {
  assert.equal(shouldRetryStatus(429, "GET"), true);
  assert.equal(shouldRetryStatus(429, "POST"), true);
  assert.equal(shouldRetryStatus(429, "PUT"), true);
  assert.equal(shouldRetryStatus(429, "DELETE"), true);
});

test("502/503/504 are retried only for idempotent GETs", () => {
  for (const status of [502, 503, 504]) {
    assert.equal(shouldRetryStatus(status, "GET"), true, `GET ${status}`);
    assert.equal(shouldRetryStatus(status, "POST"), false, `POST ${status}`);
    assert.equal(shouldRetryStatus(status, "PUT"), false, `PUT ${status}`);
  }
});

test("non-retryable statuses are never retried", () => {
  for (const status of [400, 401, 403, 404, 409, 500]) {
    assert.equal(shouldRetryStatus(status, "GET"), false, `GET ${status}`);
    assert.equal(shouldRetryStatus(status, "POST"), false, `POST ${status}`);
  }
});

test("only GET is treated as idempotent", () => {
  assert.equal(isIdempotent("GET"), true);
  assert.equal(isIdempotent("PUT"), false);
  assert.equal(isIdempotent("DELETE"), false);
  assert.equal(isIdempotent("POST"), false);
});
