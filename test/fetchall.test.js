import test from "node:test";
import assert from "node:assert/strict";

import { queryTable } from "../build/api/table.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ n: i }));

/** Serve slices of `rows` according to sysparm_limit/sysparm_offset. */
const pagedHandler = (rows) => (url) => {
  const u = new URL(url);
  const limit = Number(u.searchParams.get("sysparm_limit"));
  const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
  return jsonResponse(
    200,
    { result: rows.slice(offset, offset + limit) },
    { "x-total-count": String(rows.length) },
  );
};

const offsetsOf = (calls) =>
  calls.map((c) => new URL(c.url).searchParams.get("sysparm_offset") ?? "0");

test("fetchAll pages through everything and stops on a short page", async () => {
  await withFetch(pagedHandler(makeRows(5)), async (calls) => {
    const { records, total } = await queryTable({
      table: "incident",
      fetchAll: true,
      limit: 2,
    });
    assert.deepEqual(
      records.map((r) => r.n),
      [0, 1, 2, 3, 4],
    );
    assert.equal(total, 5);
    assert.deepEqual(offsetsOf(calls), ["0", "2", "4"]);
  });
});

test("fetchAll needs one probe page when rows divide evenly", async () => {
  await withFetch(pagedHandler(makeRows(4)), async (calls) => {
    const { records } = await queryTable({
      table: "incident",
      fetchAll: true,
      limit: 2,
    });
    assert.equal(records.length, 4);
    // 2 + 2 + empty probe page.
    assert.deepEqual(offsetsOf(calls), ["0", "2", "4"]);
  });
});

test("fetchAll honours the SN_MAX_RECORDS cap and shrinks the last page", async () => {
  await withEnv({ SN_MAX_RECORDS: "3" }, () =>
    withFetch(pagedHandler(makeRows(10)), async (calls) => {
      const { records, total, truncated } = await queryTable({
        table: "incident",
        fetchAll: true,
        limit: 2,
      });
      assert.equal(records.length, 3);
      assert.equal(total, 10, "total still reports all matching rows");
      // ARCH-3: a cap that hides rows must be flagged so consumers (snapshot,
      // compare) cannot present a partial read as the whole picture.
      assert.equal(truncated, true);
      const limits = calls.map((c) =>
        new URL(c.url).searchParams.get("sysparm_limit"),
      );
      // Second request asks only for the single record left under the cap.
      assert.deepEqual(limits, ["2", "1"]);
    }),
  );
});

test("fetchAll does not flag truncated when it reads every matching row (QA-18)", async () => {
  await withFetch(pagedHandler(makeRows(5)), async () => {
    const { records, truncated } = await queryTable({
      table: "incident",
      fetchAll: true,
      limit: 2,
    });
    assert.equal(records.length, 5);
    assert.equal(truncated, undefined, "a complete read is never truncated");
  });
});

test("fetchAll does not flag truncated when the row count equals the cap exactly (QA-18)", async () => {
  // X-Total-Count == cap is a complete read, not a truncation: the next page
  // would be empty, so consumers must not be warned about a partial result.
  await withEnv({ SN_MAX_RECORDS: "4" }, () =>
    withFetch(pagedHandler(makeRows(4)), async () => {
      const { records, total, truncated } = await queryTable({
        table: "incident",
        fetchAll: true,
        limit: 2,
      });
      assert.equal(records.length, 4);
      assert.equal(total, 4);
      assert.equal(truncated, undefined);
    }),
  );
});

test("reference links are excluded by default, included on opt-in (O-1)", async () => {
  await withFetch(pagedHandler(makeRows(1)), async (calls) => {
    await queryTable({ table: "incident", limit: 1 });
    assert.equal(
      new URL(calls[0].url).searchParams.get("sysparm_exclude_reference_link"),
      "true",
    );
    await withEnv({ SN_INCLUDE_REF_LINKS: "true" }, async () => {
      await queryTable({ table: "incident", limit: 1 });
      assert.equal(
        new URL(calls[1].url).searchParams.get(
          "sysparm_exclude_reference_link",
        ),
        null,
      );
    });
  });
});

test("fetchAll adds ORDERBYsys_id when the query has no ordering", async () => {
  await withFetch(pagedHandler(makeRows(1)), async (calls) => {
    await queryTable({ table: "incident", fetchAll: true, limit: 2 });
    assert.equal(
      new URL(calls[0].url).searchParams.get("sysparm_query"),
      "ORDERBYsys_id",
    );

    await queryTable({
      table: "incident",
      fetchAll: true,
      limit: 2,
      query: "active=true",
    });
    assert.equal(
      new URL(calls[1].url).searchParams.get("sysparm_query"),
      "active=true^ORDERBYsys_id",
    );
  });
});

test("fetchAll keeps an explicit ORDERBY untouched", async () => {
  await withFetch(pagedHandler(makeRows(1)), async (calls) => {
    await queryTable({
      table: "incident",
      fetchAll: true,
      limit: 2,
      query: "active=true^ORDERBYnumber",
    });
    assert.equal(
      new URL(calls[0].url).searchParams.get("sysparm_query"),
      "active=true^ORDERBYnumber",
    );
    // Single-page (non-fetchAll) reads are also untouched.
    await queryTable({ table: "incident", limit: 2 });
    assert.equal(new URL(calls[1].url).searchParams.get("sysparm_query"), null);
  });
});

test("fetchAll respects a starting offset", async () => {
  await withFetch(pagedHandler(makeRows(5)), async (calls) => {
    const { records } = await queryTable({
      table: "incident",
      fetchAll: true,
      limit: 2,
      offset: 3,
    });
    assert.deepEqual(
      records.map((r) => r.n),
      [3, 4],
    );
    // Full page at offset 3, then the empty probe page at 5.
    assert.deepEqual(offsetsOf(calls), ["3", "5"]);
  });
});
