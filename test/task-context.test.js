// N-5 — task context: approvals, task SLAs, assignment, journal, pending-for view.
import test from "node:test";
import assert from "node:assert/strict";

import {
  countByState,
  display,
  pendingApprovals,
  pendingApprovalsMarkdown,
  taskContext,
  taskContextMarkdown,
} from "../build/api/task-context.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const CHG = "a".repeat(32);
const INC = "b".repeat(32);
const dv = (value, display_value = value) => ({ value, display_value });

const CHANGE = {
  sys_id: dv(CHG),
  number: dv("CHG0001"),
  sys_class_name: dv("change_request", "Change Request"),
  short_description: dv("Patch | the DB"),
  state: dv("-3", "Authorize"),
  priority: dv("3", "3 - Moderate"),
  assignment_group: dv("g1", "CAB Approval"),
  assigned_to: dv("u1", "Alice Admin"),
  approval: dv("requested", "Requested"),
};

const INCIDENT = {
  sys_id: dv(INC),
  number: dv("INC0001"),
  sys_class_name: dv("incident", "Incident"),
  short_description: dv("Mail down"),
  state: dv("2", "In Progress"),
  priority: dv("1", "1 - Critical"),
  assignment_group: dv("g2", "Service Desk"),
  assigned_to: dv("", ""),
  approval: dv("not requested", "Not Yet Requested"),
};

function tables(over = {}) {
  return (url) => {
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    if (over[table]) return over[table](u);
    const q = u.searchParams.get("sysparm_query") ?? "";
    switch (table) {
      case "task":
      case "change_request":
      case "incident":
        if (q.includes(CHG) || q.includes("CHG0001")) {
          return jsonResponse(200, { result: [CHANGE] });
        }
        if (q.includes(INC) || q.includes("INC0001")) {
          return jsonResponse(200, { result: [INCIDENT] });
        }
        return jsonResponse(200, { result: [] });
      case "sysapproval_approver":
        if (!q.includes(CHG)) return jsonResponse(200, { result: [] });
        return jsonResponse(200, {
          result: [
            {
              sys_id: dv("ap1"),
              approver: dv("u2", "Bob CAB"),
              group: dv("ag1", "CAB"),
              state: dv("approved", "Approved"),
              sys_created_on: dv("2026-10-01 08:00:00"),
              due_date: dv(""),
            },
            {
              sys_id: dv("ap2"),
              approver: dv("u3", "Carol CAB"),
              group: dv("ag1", "CAB"),
              state: dv("requested", "Requested"),
              sys_created_on: dv("2026-10-01 08:00:00"),
              due_date: dv("2026-10-08 08:00:00"),
            },
            {
              sys_id: dv("ap3"),
              approver: dv("u4", "Dave DBA"),
              group: dv("ag2", "DBA"),
              state: dv("requested", "Requested"),
              sys_created_on: dv("2026-10-02 08:00:00"),
              due_date: dv("2026-10-09 08:00:00"),
            },
          ],
        });
      case "task_sla":
        if (!q.includes(INC)) return jsonResponse(200, { result: [] });
        return jsonResponse(200, {
          result: [
            {
              sys_id: dv("s1"),
              sla: dv("d1", "P1 resolution (4h)"),
              stage: dv("in_progress", "In progress"),
              has_breached: dv("false"),
              active: dv("true"),
              planned_end_time: dv("2026-10-06 12:00:00"),
              business_percentage: dv("62.5"),
              business_time_left: dv(
                "1970-01-01 01:30:00",
                "1 Hour 30 Minutes",
              ),
            },
            {
              sys_id: dv("s2"),
              sla: dv("d2", "P1 response (15m)"),
              stage: dv("breached", "Breached"),
              has_breached: dv("true"),
              active: dv("true"),
              planned_end_time: dv("2026-10-06 08:15:00"),
              business_percentage: dv("140"),
              business_time_left: dv("", "0 Seconds"),
            },
          ],
        });
      case "sys_journal_field":
        return jsonResponse(200, {
          result: [
            {
              sys_id: "j1",
              element: "work_notes",
              value: "Restarted\nthe relay",
              sys_created_by: "alice",
              sys_created_on: "2026-10-06 09:00:00",
            },
          ],
        });
      default:
        return jsonResponse(404, {
          error: { message: `Invalid table ${table}` },
        });
    }
  };
}

const queryOf = (calls, table) =>
  calls
    .map((c) => new URL(c.url))
    .filter((u) => u.pathname.endsWith(`/${table}`))
    .map((u) => u.searchParams.get("sysparm_query"));

test("display prefers display_value; countByState keeps first-seen order", () => {
  assert.equal(display(dv("x", "X")), "X");
  assert.equal(display("raw"), "raw");
  assert.equal(display({ value: "v" }), "v");
  assert.deepEqual(
    countByState([
      { state: "Requested" },
      { state: "Approved" },
      { state: "Requested" },
      { state: "" },
    ]),
    { Requested: 2, Approved: 1, "(empty)": 1 },
  );
});

test("a change with two approval groups renders its approvals", async () => {
  freshRuntime();
  await withFetch(tables(), async (calls) => {
    const ctx = await taskContext({ number: "CHG0001" });
    assert.equal(ctx.available, true);
    assert.equal(ctx.task.sys_id, CHG);
    assert.equal(ctx.task.table, "change_request");
    assert.equal(ctx.task.assignmentGroup, "CAB Approval");
    assert.equal(ctx.task.assignedTo, "Alice Admin");
    assert.deepEqual(queryOf(calls, "task"), [
      "number=CHG0001^ORDERBYDESCsys_created_on",
    ]);
    assert.deepEqual(queryOf(calls, "sysapproval_approver"), [
      `sysapproval=${CHG}^ORDERBYsys_created_on`,
    ]);
    assert.equal(ctx.approvals.available, true);
    assert.equal(ctx.approvals.rows.length, 3);
    assert.deepEqual(
      [...new Set(ctx.approvals.rows.map((r) => r.group))],
      ["CAB", "DBA"],
    );
    assert.deepEqual(ctx.approvals.byState, { Approved: 1, Requested: 2 });
    assert.equal(ctx.slas.available, true);
    assert.equal(ctx.slas.rows.length, 0);
    assert.equal(ctx.history, undefined);
    assert.equal(queryOf(calls, "sys_journal_field").length, 0);

    const md = taskContextMarkdown(ctx).join("\n");
    assert.match(md, /^## CHG0001 \(change_request\) — Patch \\\| the DB/);
    assert.match(
      md,
      /\*\*Assignment group:\*\* CAB Approval · \*\*Assigned to:\*\* Alice Admin/,
    );
    assert.match(md, /3 approval\(s\): 1 Approved, 2 Requested\./);
    assert.match(
      md,
      /\| Carol CAB \| CAB \| Requested \| 2026-10-01 08:00:00 \| 2026-10-08 08:00:00 \|/,
    );
    assert.match(md, /\| Dave DBA \| DBA \| Requested \|/);
    assert.match(md, /### Task SLAs\n\n_No task SLAs\._/);
    assert.doesNotMatch(md, /### Journal/);
    assert.match(md, /unverified until O-5/);
  });
});

test("an incident with a running and a breached SLA, plus its journal", async () => {
  freshRuntime();
  await withFetch(tables(), async (calls) => {
    const ctx = await taskContext({
      table: "incident",
      sysId: INC,
      history: true,
    });
    assert.equal(ctx.available, true);
    assert.deepEqual(queryOf(calls, "incident"), [`sys_id=${INC}`]);
    assert.deepEqual(queryOf(calls, "task_sla"), [
      `task=${INC}^ORDERBYstart_time`,
    ]);
    assert.equal(ctx.slas.breached, 1);
    assert.deepEqual(
      ctx.slas.rows.map((s) => [s.definition, s.stage, s.breached]),
      [
        ["P1 resolution (4h)", "In progress", false],
        ["P1 response (15m)", "Breached", true],
      ],
    );
    assert.equal(ctx.slas.rows[0].businessTimeLeft, "1 Hour 30 Minutes");
    assert.equal(ctx.approvals.rows.length, 0);
    assert.equal(ctx.history.available, true);
    assert.equal(ctx.history.rows[0].field, "work_notes");
    const [journalQuery] = queryOf(calls, "sys_journal_field");
    assert.match(
      journalQuery,
      new RegExp(`^name=incident\\^element_id=${INC}`),
    );
    assert.equal(queryOf(calls, "sys_audit").length, 0);

    const md = taskContextMarkdown(ctx).join("\n");
    assert.match(md, /\*\*Assigned to:\*\* —/);
    assert.match(md, /### Approvals\n\n_No approvals\._/);
    assert.match(md, /2 task SLA\(s\), 1 breached\./);
    assert.match(
      md,
      /\| P1 resolution \(4h\) \| In progress \| no \| 2026-10-06 12:00:00 \| 62\.5 \| 1 Hour 30 Minutes \|/,
    );
    assert.match(md, /\| P1 response \(15m\) \| Breached \| \*\*yes\*\* \|/);
    assert.match(
      md,
      /### Journal[\s\S]*\| 2026-10-06 09:00:00 \| alice \| work_notes \| Restarted the relay \|/,
    );
  });
});

test("each failed section degrades on its own", async () => {
  freshRuntime();
  await withFetch(
    tables({
      sysapproval_approver: () =>
        jsonResponse(403, { error: { message: "denied" } }),
      sys_journal_field: () =>
        jsonResponse(403, { error: { message: "denied" } }),
    }),
    async () => {
      const ctx = await taskContext({ sysId: INC, history: true });
      assert.equal(ctx.available, true);
      assert.equal(ctx.approvals.available, false);
      assert.match(
        ctx.approvals.unavailableReason,
        /sysapproval_approver is not readable/,
      );
      assert.equal(ctx.slas.available, true);
      assert.equal(ctx.history.available, false);
      assert.match(ctx.history.unavailableReason, /sys_journal_field/);
      const md = taskContextMarkdown(ctx).join("\n");
      assert.match(md, /### Approvals\n\nUnavailable: sysapproval_approver/);
      assert.match(md, /### Journal\n\nUnavailable: sys_journal_field/);
    },
  );

  freshRuntime();
  await withFetch(
    tables({
      task_sla: () => jsonResponse(404, { error: { message: "nope" } }),
    }),
    async () => {
      const ctx = await taskContext({ sysId: INC });
      assert.equal(ctx.slas.available, false);
      assert.match(ctx.slas.unavailableReason, /task_sla does not exist/);
    },
  );
});

test("a missing or unreadable task makes the context unavailable", async () => {
  freshRuntime();
  await withFetch(tables(), async (calls) => {
    const ctx = await taskContext({ number: "CHG9999" });
    assert.equal(ctx.available, false);
    assert.match(ctx.unavailableReason, /No task record with number CHG9999/);
    assert.equal(calls.length, 1);
    assert.deepEqual(taskContextMarkdown(ctx), [
      "Unavailable: No task record with number CHG9999.",
    ]);
  });

  freshRuntime();
  await withFetch(
    () => jsonResponse(403, { error: { message: "denied" } }),
    async (calls) => {
      const ctx = await taskContext({ sysId: CHG });
      assert.equal(calls.length, 1);
      assert.equal(ctx.available, false);
      assert.match(ctx.unavailableReason, /task is not readable/);
    },
  );
});

test("invalid input never reaches the instance", async () => {
  freshRuntime();
  await withFetch(tables(), async (calls) => {
    for (const opts of [
      {},
      { sysId: "not-a-sys-id" },
      { number: "CHG1^ORsys_id!=x" },
      { table: "task^x", number: "CHG0001" },
    ]) {
      const ctx = await taskContext(opts);
      assert.equal(ctx.available, false);
    }
    const p = await pendingApprovals({ approver: "bob^ORstate=x" });
    assert.equal(p.available, false);
    assert.equal(calls.length, 0);
  });
});

test("pending approvals for an approver, by user_name and sys_id", async () => {
  const row = {
    sys_id: dv("ap2"),
    sysapproval: dv(CHG, "CHG0001"),
    "sysapproval.sys_class_name": dv("change_request", "Change Request"),
    "sysapproval.short_description": dv("Patch the DB"),
    group: dv("ag1", "CAB"),
    sys_created_on: dv("2026-10-01 08:00:00"),
    due_date: dv("2026-10-08 08:00:00"),
  };
  freshRuntime();
  await withFetch(
    tables({
      sysapproval_approver: () => jsonResponse(200, { result: [row, row] }),
    }),
    async (calls) => {
      const p = await pendingApprovals({ approver: "carol", limit: 2 });
      assert.equal(p.available, true);
      assert.equal(p.truncated, true);
      assert.equal(p.rows[0].task, "CHG0001");
      assert.equal(p.rows[0].taskTable, "change_request");
      const u = new URL(calls[0].url);
      assert.equal(
        u.searchParams.get("sysparm_query"),
        "approver.user_name=carol^state=requested^ORDERBYdue_date",
      );
      assert.equal(u.searchParams.get("sysparm_limit"), "2");
      const md = pendingApprovalsMarkdown(p).join("\n");
      assert.match(
        md,
        /2 requested approval\(s\) for carol \(first rows only — truncated\)/,
      );
      assert.match(
        md,
        /\| CHG0001 \| change_request \| Patch the DB \| CAB \| 2026-10-01 08:00:00 \| 2026-10-08 08:00:00 \|/,
      );

      await pendingApprovals({ approver: "c".repeat(32), limit: 10_000 });
      const u2 = new URL(calls[1].url);
      assert.match(u2.searchParams.get("sysparm_query"), /^approver=c{32}\^/);
      assert.equal(u2.searchParams.get("sysparm_limit"), "200");
    },
  );

  freshRuntime();
  await withFetch(
    tables({
      sysapproval_approver: () => jsonResponse(200, { result: [] }),
    }),
    async () => {
      const p = await pendingApprovals({ approver: "nobody" });
      assert.equal(p.truncated, false);
      assert.match(
        pendingApprovalsMarkdown(p).join("\n"),
        /_No requested approvals for nobody\._/,
      );
    },
  );

  freshRuntime();
  await withFetch(
    () => jsonResponse(403, { error: { message: "denied" } }),
    async () => {
      const p = await pendingApprovals({ approver: "carol" });
      assert.equal(p.available, false);
      assert.match(
        pendingApprovalsMarkdown(p)[0],
        /^Unavailable: sysapproval_approver is not readable/,
      );
    },
  );
});
