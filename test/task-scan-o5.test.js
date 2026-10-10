// O-5 — task context (N-5) and Instance Scan (N-3) read the columns confirmed
// on a PDI: sysapproval_approver, task_sla, scan_result, scan_finding.
import test from "node:test";
import assert from "node:assert/strict";

import { readInstanceScan } from "../build/api/instance-scan.js";
import {
  pendingApprovals,
  pendingApprovalsMarkdown,
  taskContext,
} from "../build/api/task-context.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const TASK = "a".repeat(32);

function seen() {
  const calls = new Map();
  const handler = (url) => {
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    calls.set(table, {
      query: u.searchParams.get("sysparm_query"),
      fields: (u.searchParams.get("sysparm_fields") ?? "").split(","),
    });
    if (table === "task") {
      return jsonResponse(200, {
        result: [
          { sys_id: TASK, number: "CHG1", sys_class_name: "change_request" },
        ],
      });
    }
    return jsonResponse(200, { result: [] });
  };
  return { calls, handler };
}

test("task context reads the PDI columns of approvals and task SLAs", async () => {
  freshRuntime();
  const { calls, handler } = seen();
  await withFetch(handler, async () => {
    const ctx = await taskContext({ sysId: TASK });
    assert.equal(ctx.available, true);
  });
  const approvals = calls.get("sysapproval_approver");
  assert.match(approvals.query, new RegExp(`^sysapproval=${TASK}`));
  for (const f of ["approver", "group", "state", "due_date"]) {
    assert.ok(approvals.fields.includes(f), f);
  }
  const slas = calls.get("task_sla");
  assert.match(slas.query, new RegExp(`^task=${TASK}\\^ORDERBYstart_time`));
  for (const f of [
    "sla",
    "stage",
    "has_breached",
    "planned_end_time",
    "business_percentage",
    "business_time_left",
  ]) {
    assert.ok(slas.fields.includes(f), f);
  }
});

test("pending approvals use the PDI state choice and drop the unverified note", async () => {
  freshRuntime();
  const { calls, handler } = seen();
  const p = await withFetch(handler, () =>
    pendingApprovals({ approver: "abel.tuter" }),
  );
  assert.match(
    calls.get("sysapproval_approver").query,
    /^approver\.user_name=abel\.tuter\^state=requested\^/,
  );
  assert.doesNotMatch(
    pendingApprovalsMarkdown(p).join("\n"),
    /unverified until O-5/,
  );
});

test("Instance Scan without a result reads unmuted findings, not a missing active column", async () => {
  freshRuntime();
  const { calls, handler } = seen();
  await withFetch(handler, () => readInstanceScan());
  const findings = calls.get("scan_finding");
  assert.equal(findings.query, "muted=false");
  for (const f of [
    "check.name",
    "check.priority",
    "check.category",
    "source_table",
    "source",
  ]) {
    assert.ok(findings.fields.includes(f), f);
  }
});
