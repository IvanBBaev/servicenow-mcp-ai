import test from "node:test";
import assert from "node:assert/strict";

import { aggregate } from "../build/api/aggregate.js";
import { ServiceNowError } from "../build/core/errors.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

test("aggregate builds the stats params and returns the result (QA-11)", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/stats\/incident\?/);
      const p = new URL(url).searchParams;
      assert.equal(p.get("sysparm_count"), "true");
      assert.equal(p.get("sysparm_avg_fields"), "business_duration");
      assert.equal(p.get("sysparm_min_fields"), "priority");
      assert.equal(p.get("sysparm_max_fields"), "priority");
      assert.equal(p.get("sysparm_sum_fields"), "reassignment_count");
      assert.equal(p.get("sysparm_group_by"), "category");
      assert.equal(p.get("sysparm_query"), "active=true");
      return jsonResponse(200, {
        result: { stats: { count: "42", avg: { business_duration: "3600" } } },
      });
    },
    async (calls) => {
      const result = await aggregate({
        table: "incident",
        query: "active=true",
        count: true,
        avgFields: ["business_duration"],
        minFields: ["priority"],
        maxFields: ["priority"],
        sumFields: ["reassignment_count"],
        groupBy: ["category"],
      });
      assert.equal(result.stats.count, "42");
      assert.equal(calls.length, 1);
    },
  );
});

test("aggregate honours the table deny list before any request (QA-11)", async () => {
  await withEnv({ SN_TABLES_DENY: "incident" }, () =>
    withFetch(
      () => {
        throw new Error("fetch must not run for a denied table");
      },
      async (calls) => {
        await assert.rejects(
          aggregate({ table: "incident", count: true }),
          (err) => err instanceof ServiceNowError,
        );
        assert.equal(calls.length, 0);
      },
    ),
  );
});
