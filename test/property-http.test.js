// E-6 / L9-02: property tests for the HTTP retry matrix and the query
// encoders. Every property runs with a fixed seed (fcParams) so a failure
// reproduces run to run; the end-to-end retry property runs on the fake clock.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  backoffMs,
  isIdempotent,
  retryAfterMs,
  shouldRetryStatus,
  shouldRetryStatusFor,
} from "../build/core/http-util.js";
import { snRequest } from "../build/core/http.js";
import { snParams } from "../build/api/shared.js";
import { keyQuery } from "../build/api/table.js";
import { ServiceNowError } from "../build/core/errors.js";
import {
  baselineEnv,
  fakeClock,
  fcParams,
  freshRuntime,
  withEnv,
  withFetchDouble,
} from "./helpers.js";

baselineEnv();

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];
const method = fc.constantFrom(...METHODS);
const status = fc.oneof(
  fc.constantFrom(
    200,
    201,
    204,
    400,
    401,
    403,
    404,
    409,
    429,
    500,
    502,
    503,
    504,
  ),
  fc.integer({ min: 100, max: 599 }),
);

/** The documented retry matrix, written out independently of the code. */
const expectedRetry = (s, m) =>
  s === 429 || (m === "GET" && (s === 502 || s === 503 || s === 504));

// ---------------------------------------------------------------------------
// Retry matrix
// ---------------------------------------------------------------------------

test("retry matrix: 429 retries for any method, 502/503/504 only for GET, nothing else", () => {
  fc.assert(
    fc.property(status, method, (s, m) => {
      assert.equal(shouldRetryStatus(s, m), expectedRetry(s, m), `${m} ${s}`);
      // The explicit-idempotency variant agrees with the method-based one.
      assert.equal(
        shouldRetryStatus(s, m),
        shouldRetryStatusFor(s, isIdempotent(m)),
      );
      // Idempotency is monotone: whatever retries for a POST retries for a GET.
      if (shouldRetryStatusFor(s, false))
        assert.ok(shouldRetryStatusFor(s, true));
    }),
    fcParams(),
  );
});

test("backoffMs stays within min(500·2^(n-1), 8000) + [0, 250)", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 40 }), (n) => {
      const base = Math.min(500 * 2 ** (n - 1), 8000);
      const ms = backoffMs(n);
      assert.ok(Number.isInteger(ms), `integer ${ms}`);
      assert.ok(ms >= base && ms < base + 250, `attempt ${n}: ${ms}`);
    }),
    fcParams(),
  );
});

test("retryAfterMs: numeric seconds are clamped to [0, max]; garbage is ignored", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer({ min: -3600, max: 7200 }).map(String),
        fc
          .double({ min: -100, max: 1000, noNaN: true })
          .map((d) => d.toFixed(3)),
        fc
          .string({ minLength: 1, maxLength: 12 })
          .filter((s) => s.trim() !== "" && !/[\r\n\0]/.test(s)),
      ),
      fc.integer({ min: 0, max: 120_000 }),
      (header, max) => {
        let res;
        try {
          res = new Response(null, { headers: { "retry-after": header } });
        } catch {
          return; // not a legal header value — nothing reaches retryAfterMs
        }
        const got = retryAfterMs(res, max);
        const value = res.headers.get("retry-after");
        const seconds = Number(value);
        if (Number.isFinite(seconds)) {
          assert.equal(got, Math.min(max, Math.max(0, seconds * 1000)));
        } else if (Number.isNaN(Date.parse(value))) {
          assert.equal(got, undefined);
        } else {
          assert.ok(got >= 0 && got <= max, `date form clamped: ${got}`);
        }
      },
    ),
    fcParams(),
  );
  assert.equal(retryAfterMs(new Response(null), 1000), undefined);
});

test("retryAfterMs: an HTTP date is honoured relative to now and clamped", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -600, max: 600 }),
      fc.integer({ min: 0, max: 300_000 }),
      (offsetSeconds, max) => {
        const date = new Date(Date.now() + offsetSeconds * 1000).toUTCString();
        const got = retryAfterMs(
          new Response(null, { headers: { "retry-after": date } }),
          max,
        );
        assert.ok(got >= 0 && got <= max, `clamped: ${got}`);
        // HTTP dates have one-second precision, and the clock moves on.
        const want = Math.min(max, Math.max(0, offsetSeconds * 1000));
        assert.ok(Math.abs(got - want) <= 2000, `${got} vs ${want}`);
      },
    ),
    fcParams(),
  );
});

test("retry matrix end to end: the request loop retries exactly when the matrix says so (virtual time)", async (t) => {
  const clock = fakeClock(t);
  await withEnv({ SN_MAX_RETRIES: "2", SN_DEADLINE_MS: undefined }, () =>
    fc.assert(
      fc.asyncProperty(
        method,
        fc.constantFrom(400, 404, 409, 429, 500, 502, 503, 504),
        fc.boolean(),
        async (m, s, recovers) => {
          freshRuntime(); // no breaker state leaks from one run to the next
          await withFetchDouble(
            (d) =>
              d.route(m, "/api/now/table/incident", [
                { status: s, json: { error: { message: `status ${s}` } } },
                recovers
                  ? { json: { result: { ok: true } } }
                  : { status: s, json: { error: { message: `status ${s}` } } },
              ]),
            async (d) => {
              const outcome = await clock
                .run(
                  snRequest({
                    method: m,
                    path: "/api/now/table/incident",
                    body: m === "GET" || m === "DELETE" ? undefined : { a: 1 },
                  }),
                  { step: 250 },
                )
                .then(
                  () => "ok",
                  (e) => e,
                );
              const retries = expectedRetry(s, m);
              // No retry → one call; retry → a second call, and a third only
              // when the second failed the same way (SN_MAX_RETRIES=2).
              const want = !retries ? 1 : recovers ? 2 : 3;
              assert.equal(
                d.calls.length,
                want,
                `${m} ${s} recovers=${recovers}`,
              );
              if (retries && recovers) assert.equal(outcome, "ok");
              else {
                assert.ok(outcome instanceof ServiceNowError, `${m} ${s}`);
                assert.equal(outcome.status, s);
              }
              // A retry never fires before the minimum backoff.
              for (let i = 1; i < d.calls.length; i++) {
                assert.ok(d.calls[i].at - d.calls[i - 1].at >= 500);
              }
            },
          );
        },
      ),
      fcParams({ scale: 0.4 }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Query encoders
// ---------------------------------------------------------------------------

const paramValue = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.boolean(),
  fc.string({ maxLength: 8 }),
  fc.integer({ min: -5, max: 1000 }),
  fc.array(fc.string({ minLength: 1, maxLength: 5 }), { maxLength: 3 }),
);

test("snParams keeps exactly the present values, stringified, in insertion order", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.stringMatching(/^sysparm_[a-z_]{1,10}$/), {
        maxLength: 8,
      }),
      fc.array(paramValue, { minLength: 8, maxLength: 8 }),
      (keys, values) => {
        const input = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
        const params = snParams(input);
        const expected = [];
        for (const [k, v] of Object.entries(input)) {
          if (v === undefined || v === null || v === false || v === "")
            continue;
          if (Array.isArray(v)) {
            if (v.length) expected.push([k, v.join(",")]);
            continue;
          }
          expected.push([k, String(v)]);
        }
        assert.deepEqual([...params.entries()], expected);
        // Every value survives a URL-encoding round trip unchanged.
        const back = new URLSearchParams(params.toString());
        assert.deepEqual([...back.entries()], expected);
      },
    ),
    fcParams(),
  );
});

const keyField = fc.stringMatching(
  /^[A-Za-z0-9_]{1,8}(\.[A-Za-z0-9_]{1,8}){0,2}$/,
);
const safeValue = fc.oneof(
  fc.string({ maxLength: 10 }).filter((s) => !/[\^\r\n]/.test(s)),
  fc.integer(),
  fc.boolean(),
);

test("keyQuery: one clause per field, in order, and each clause decodes back to its pair", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.tuple(keyField, safeValue), {
        minLength: 1,
        maxLength: 5,
        selector: ([f]) => f,
      }),
      (pairs) => {
        // Object key order (integer-like keys first) is the order keyQuery sees.
        const key = Object.fromEntries(pairs);
        const q = keyQuery(key);
        const clauses = q.split("^");
        assert.equal(clauses.length, pairs.length, q);
        Object.entries(key).forEach(([field, value], i) => {
          const text = String(value);
          assert.equal(
            clauses[i],
            text === "" ? `${field}ISEMPTY` : `${field}=${text}`,
          );
        });
      },
    ),
    fcParams(),
  );
});

test("keyQuery refuses a '^' or a line break in a value and a malformed field name, with 400", () => {
  const badValue = fc
    .tuple(
      fc.string({ maxLength: 5 }),
      fc.constantFrom("^", "\n", "\r", "^NQ", "\r\n"),
      fc.string({ maxLength: 5 }),
    )
    .map(([a, b, c]) => a + b + c);
  const badField = fc
    .string({ maxLength: 10 })
    .filter((f) => !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(f));
  fc.assert(
    fc.property(
      fc.oneof(fc.tuple(keyField, badValue), fc.tuple(badField, safeValue)),
      ([field, value]) => {
        assert.throws(
          () => keyQuery({ [field]: value }),
          (e) => e instanceof ServiceNowError && e.status === 400,
        );
      },
    ),
    fcParams(),
  );
  assert.throws(
    () => keyQuery({}),
    (e) => e.status === 400,
  );
});
