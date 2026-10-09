// N-2 — access explainer: static evaluation of the record ACL chain.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  combineChecks,
  decideCheck,
  evaluateAcl,
  explainAccess,
  fieldCandidates,
  matchLevel,
  renderAccessExplanation,
  renderAccessMermaid,
  rowCandidates,
} from "../build/api/access-explain.js";
import {
  baselineEnv,
  fcParams,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const USER = "a".repeat(32);
const REC = "b".repeat(32);

const acl = (over = {}) => ({
  sys_id: "acl1",
  name: "incident",
  roles: [],
  condition: "",
  script: "",
  advanced: false,
  adminOverrides: true,
  ...over,
});

test("candidate names: row chain then *, field chain then table.* then *.field", () => {
  assert.deepEqual(rowCandidates(["incident", "task"]), [
    "incident",
    "task",
    "*",
  ]);
  assert.deepEqual(fieldCandidates(["incident", "task"], "state"), [
    "incident.state",
    "task.state",
    "incident.*",
    "task.*",
    "*.state",
    "*.*",
  ]);
});

test("the first name level with an ACL decides; less specific levels are ignored", () => {
  const acls = [
    acl({ sys_id: "star", name: "*" }),
    acl({ sys_id: "task", name: "task" }),
  ];
  const level = matchLevel(["incident", "task", "*"], acls);
  assert.equal(level.matched, "task");
  assert.deepEqual(
    level.acls.map((a) => a.sys_id),
    ["task"],
  );
  assert.deepEqual(matchLevel(["incident"], acls), { acls: [] });
});

test("ordering property: the matched level is the earliest candidate that has an ACL", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.constantFrom("a", "b", "c", "d", "e"), {
        minLength: 1,
      }),
      fc.array(fc.constantFrom("a", "b", "c", "d", "e", "z")),
      (candidates, names) => {
        const acls = names.map((name, i) => ({ name, i }));
        const { matched, acls: level } = matchLevel(candidates, acls);
        const expected = candidates.find((c) => names.includes(c));
        assert.equal(matched, expected);
        assert.ok(level.every((a) => a.name === expected));
        assert.equal(level.length, names.filter((n) => n === expected).length);
      },
    ),
    fcParams(),
  );
});

test("role part: any listed role passes; none held fails; elevation noted", () => {
  const roles = new Set(["itil", "security_admin"]);
  assert.equal(
    evaluateAcl(acl({ roles: ["itil", "x"] }), roles, undefined).result,
    "granted",
  );
  assert.equal(
    evaluateAcl(acl({ roles: ["x"] }), roles, undefined).role,
    "fail",
  );
  const elevated = evaluateAcl(
    acl({ roles: ["security_admin"] }),
    roles,
    undefined,
  );
  assert.equal(elevated.result, "granted");
  assert.match(elevated.notes[0], /must be elevated/);
});

test("admin short-circuits unless the ACL turns admin overrides off", () => {
  const admin = new Set(["admin"]);
  const scripted = acl({
    roles: ["x"],
    script: "answer=false;",
    advanced: true,
  });
  assert.equal(evaluateAcl(scripted, admin, undefined).result, "granted");
  const strict = evaluateAcl(
    { ...scripted, adminOverrides: false },
    admin,
    undefined,
  );
  assert.equal(strict.role, "fail");
  assert.equal(strict.result, "denied");
});

test("condition and script parts", () => {
  const none = new Set();
  const cond = acl({ condition: "active=true" });
  assert.equal(evaluateAcl(cond, none, true).result, "granted");
  assert.equal(evaluateAcl(cond, none, false).result, "denied");
  assert.equal(evaluateAcl(cond, none, undefined).result, "undetermined");
  const script = acl({ script: "answer=true;", advanced: true });
  assert.equal(evaluateAcl(script, none, undefined).result, "undetermined");
  // A script without `advanced` is not used by the platform.
  assert.equal(
    evaluateAcl({ ...script, advanced: false }, none, undefined).result,
    "granted",
  );
  // A failing part denies even when the script is undetermined.
  assert.equal(
    evaluateAcl({ ...script, roles: ["x"] }, none, undefined).result,
    "denied",
  );
});

test("a check grants on any passing ACL; checks combine with denial first", () => {
  const e = (sys_id, result) => ({ sys_id, result });
  assert.deepEqual(decideCheck("t", [e("1", "denied"), e("2", "granted")]), {
    decision: "granted",
    decidingAcl: "2",
  });
  assert.deepEqual(decideCheck("t", [e("1", "undetermined")]), {
    decision: "undetermined",
  });
  assert.deepEqual(decideCheck(undefined, []), { decision: "denied" });
  const c = (decision) => ({ decision });
  assert.equal(
    combineChecks([c("granted"), c("undetermined")]),
    "undetermined",
  );
  assert.equal(combineChecks([c("undetermined"), c("denied")]), "denied");
  assert.equal(combineChecks([c("granted"), c("granted")]), "granted");
});

function instance(over = {}) {
  return (url) => {
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    const q = u.searchParams.get("sysparm_query") ?? "";
    if (over[table]) return over[table](q, u);
    switch (table) {
      case "sys_user":
        return jsonResponse(200, { result: [{ sys_id: USER }] });
      case "sys_user_has_role":
        return jsonResponse(200, {
          result: [
            { "role.name": "itil", state: "active" },
            { "role.name": "itil", state: "active" },
            { "role.name": "x_pending", state: "pending" },
          ],
        });
      case "sys_db_object": {
        const parent = q === "name=incident" ? "task" : "";
        return jsonResponse(200, {
          result: [{ name: "x", "super_class.name": parent }],
        });
      }
      case "sys_security_acl":
        return jsonResponse(200, {
          result: [
            {
              sys_id: "row1",
              name: "task",
              condition: "active=true",
              advanced: "false",
              admin_overrides: "true",
            },
            {
              sys_id: "fld1",
              name: "task.*",
              script: "answer = gs.hasRole('x');",
              advanced: "true",
              admin_overrides: "true",
            },
            { sys_id: "star", name: "*", admin_overrides: "true" },
          ],
        });
      case "sys_security_acl_role":
        return jsonResponse(200, {
          result: [
            { sys_security_acl: "row1", "sys_user_role.name": "itil" },
            { sys_security_acl: "fld1", "sys_user_role.name": "itil" },
          ],
        });
      case "incident":
        return jsonResponse(200, { result: [{ sys_id: REC }] });
      default:
        return jsonResponse(404, { error: { message: `no ${table}` } });
    }
  };
}

test("explainAccess walks the chain, queries the condition and leaves scripts undetermined", async () => {
  freshRuntime();
  await withFetch(instance(), async (calls) => {
    const r = await explainAccess({
      user: "beth.anglin",
      table: "incident",
      operation: "read",
      sysId: REC,
      field: "state",
    });
    assert.equal(r.available, true);
    assert.deepEqual(r.roles, ["itil"]);
    assert.equal(r.admin, false);
    const [row, field] = r.checks;
    assert.equal(row.matched, "task");
    assert.equal(row.decision, "granted");
    assert.equal(row.decidingAcl, "row1");
    assert.equal(field.matched, "task.*");
    assert.equal(field.decision, "undetermined");
    assert.equal(r.decision, "undetermined");

    const urls = calls.map((c) => new URL(c.url));
    const q = (t) =>
      urls
        .find((u) => u.pathname.endsWith(`/${t}`))
        .searchParams.get("sysparm_query");
    assert.equal(q("sys_user"), "user_name=beth.anglin");
    assert.equal(q("sys_user_has_role"), `user=${USER}`);
    assert.match(
      q("sys_security_acl"),
      /^active=true\^type\.name=record\^operation=read\^nameINincident,task,\*,incident\.state,/,
    );
    assert.equal(q("incident"), `sys_id=${REC}^active=true`);

    const md = renderAccessExplanation(r).join("\n");
    assert.match(md, /\*\*Decision: undetermined\*\*/);
    assert.match(md, /`incident` → `task` → `\*`/);
    assert.match(
      md,
      /\| \*\*row1\*\* \| itil \| pass \| pass \| n\/a \| granted \|/,
    );
    assert.match(md, /as the connected user/);
  });
});

test("no ACL at any level denies; a ^NQ condition is not queried", async () => {
  freshRuntime();
  await withFetch(
    instance({
      sys_security_acl: () => jsonResponse(200, { result: [] }),
    }),
    async () => {
      const r = await explainAccess({
        user: USER,
        table: "incident",
        operation: "delete",
      });
      assert.equal(r.decision, "denied");
      assert.equal(r.checks[0].matched, undefined);
      assert.match(r.notes.join("\n"), /high-security default denies/);
    },
  );
  await withFetch(
    instance({
      sys_security_acl: () =>
        jsonResponse(200, {
          result: [{ sys_id: "nq", name: "incident", condition: "a=1^NQb=2" }],
        }),
      sys_security_acl_role: () => jsonResponse(200, { result: [] }),
    }),
    async (calls) => {
      const r = await explainAccess({
        user: USER,
        table: "incident",
        operation: "read",
        sysId: REC,
      });
      assert.equal(r.checks[0].acls[0].condition, "undetermined");
      assert.ok(
        !calls.some((c) => new URL(c.url).pathname.endsWith("/incident")),
      );
    },
  );
});

test("an unreadable ACL table or unknown user degrades; bad input throws", async () => {
  freshRuntime();
  await withFetch(
    instance({
      sys_security_acl: () =>
        jsonResponse(403, { error: { message: "ACL denied" } }),
    }),
    async () => {
      const r = await explainAccess({
        user: USER,
        table: "incident",
        operation: "read",
      });
      assert.equal(r.available, false);
      assert.match(r.unavailableReason, /sys_security_acl is not readable/);
      assert.match(renderAccessExplanation(r).join("\n"), /Not available/);
    },
  );
  await withFetch(
    instance({ sys_user: () => jsonResponse(200, { result: [] }) }),
    async () => {
      const r = await explainAccess({
        user: "ghost",
        table: "incident",
        operation: "read",
      });
      assert.equal(r.available, false);
      assert.match(r.unavailableReason, /No user "ghost"/);
    },
  );
  const bad = [
    { user: "x^ORactive=true", table: "incident", operation: "read" },
    { user: "x", table: "inc ident", operation: "read" },
    { user: "x", table: "incident", operation: "read", field: "a.b" },
    { user: "x", table: "incident", operation: "read", sysId: "nope" },
    { user: "x", table: "incident", operation: "execute" },
  ];
  for (const input of bad) {
    await assert.rejects(explainAccess(input), { status: 400 });
  }
});

test("N-12: domain-specific ACLs are attributed, grouped by domain and add the caveat", async () => {
  freshRuntime();
  await withFetch(
    instance({
      sys_security_acl: () =>
        jsonResponse(200, {
          result: [
            {
              sys_id: "acme",
              name: "incident",
              sys_domain: "d1",
              "sys_domain.name": "ACME",
              sys_overrides: "base",
            },
            {
              sys_id: "base",
              name: "incident",
              sys_domain: "global",
              "sys_domain.name": "global",
            },
          ],
        }),
      sys_security_acl_role: () => jsonResponse(200, { result: [] }),
    }),
    async (calls) => {
      const r = await explainAccess({
        user: USER,
        table: "incident",
        operation: "read",
      });
      const [acme, base] = r.checks[0].acls;
      assert.equal(acme.domain, "ACME");
      assert.match(acme.notes.join(";"), /overrides base in its domain/);
      assert.equal(base.domain, undefined);
      assert.match(r.notes.join("\n"), /Domain separation:/);
      const fields = calls
        .map((c) => new URL(c.url))
        .find((u) => u.pathname.endsWith("/sys_security_acl"))
        .searchParams.get("sysparm_fields");
      assert.match(fields, /sys_domain\.name/);

      const md = renderAccessExplanation(r).join("\n");
      assert.match(md, /\| ACL \| Domain \| Roles \|/);
      // Grouped by domain: global first.
      assert.ok(md.indexOf("| global |") < md.indexOf("| ACME |"));
    },
  );
});

test("N-12: without domain separation the output has no Domain column or caveat", async () => {
  freshRuntime();
  await withFetch(instance(), async () => {
    const r = await explainAccess({
      user: USER,
      table: "incident",
      operation: "read",
    });
    assert.ok(r.checks[0].acls.every((a) => !("domain" in a)));
    const md = renderAccessExplanation(r).join("\n");
    assert.doesNotMatch(md, /Domain/);
  });
});

test("an undetermined script part carries the S-12 ACL-script lint hints", () => {
  const e = evaluateAcl(
    acl({
      script: "// eval('x')\nanswer = gs.getUserID() == current.caller_id;",
      advanced: true,
    }),
    new Set(),
    undefined,
  );
  assert.equal(e.script, "undetermined");
  assert.deepEqual(
    e.scriptHints.map((h) => h.rule),
    ["getuser-in-acl"],
  );
  assert.match(e.notes.join(";"), /script: getuser-in-acl \(info\)/);
  // No hints key when the script is clean or not used.
  const clean = evaluateAcl(
    acl({ script: "answer = true;", advanced: true }),
    new Set(),
    undefined,
  );
  assert.ok(!("scriptHints" in clean));
});

test("the Mermaid decision diagram walks the tried names to the ACLs and the decision", async () => {
  freshRuntime();
  await withFetch(instance(), async () => {
    const r = await explainAccess({
      user: "beth.anglin",
      table: "incident",
      operation: "read",
      sysId: REC,
      field: "state",
    });
    const md = renderAccessMermaid(r);
    const lines = md.split("\n");
    assert.equal(lines[0], "flowchart TD");
    assert.ok(lines.includes('    start -.-> row_n0["incident: no ACL"]'));
    assert.ok(lines.includes('    row_n0 --> row_n1["task: 1 ACL"]'));
    assert.ok(
      lines.includes('    row_n1 --> row_acl0["row1: granted (deciding)"]'),
    );
    assert.ok(lines.includes("    row_acl0 --> row_decision"));
    assert.ok(
      lines.includes('    field_n3 --> field_acl0["fld1: undetermined"]'),
    );
    assert.ok(lines.includes("  decision([undetermined])"));
    assert.ok(lines.includes("  field_decision --> decision"));
  });
  await withFetch(
    instance({ sys_security_acl: () => jsonResponse(200, { result: [] }) }),
    async () => {
      const r = await explainAccess({
        user: USER,
        table: "incident",
        operation: "delete",
      });
      const md = renderAccessMermaid(r);
      assert.match(md, /row_n2 -.-> row_decision/);
      assert.match(md, /decision\(\[denied\]\)/);
    },
  );
  assert.equal(renderAccessMermaid({ available: false, checks: [] }), "");
});

// --- wiring: servicenow_explain_access (N-2, O-10) ---------------------------

const { runSpec } = await import("../build/mcp/define.js");
const { ALL_TOOLS } = await import("../build/mcp/registry.js");

const spec = ALL_TOOLS.find((s) => s.name === "servicenow_explain_access");
const body = (res) => res.structuredContent ?? JSON.parse(res.content[0].text);

test("explain_access sits in the opt-in directory package, read-only", () => {
  assert.equal(spec.package, "directory");
  assert.equal(spec.annotations.readOnlyHint, true);
  assert.equal(spec.input.operation.safeParse("execute").success, false);
  assert.equal(spec.input.user.safeParse("x".repeat(101)).success, false);
});

test("explain_access returns the explanation, or Markdown with the Mermaid diagram", async () => {
  freshRuntime();
  await withFetch(instance(), async () => {
    const args = {
      user: "beth.anglin",
      table: "incident",
      operation: "read",
      sys_id: REC,
      field: "state",
    };
    const json = body(await runSpec(spec, args));
    assert.equal(json.available, true);
    assert.equal(json.decision, "undetermined");
    assert.equal(json.sysId, REC);
    assert.equal(json.checks.length, 2);

    const md = body(await runSpec(spec, { ...args, format: "markdown" }));
    assert.equal(md.decision, "undetermined");
    assert.match(md.markdown, /\*\*Decision: undetermined\*\*/);
    assert.match(md.markdown, /```mermaid\nflowchart TD/);
  });
});

test("explain_access passes a bad user through to a validation error", async () => {
  const res = await runSpec(spec, {
    user: "a^b",
    table: "incident",
    operation: "read",
  });
  assert.equal(res.isError, true);
});
