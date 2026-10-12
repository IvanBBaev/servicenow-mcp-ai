// N-27 — which UI Builder variant one user sees. Tables and fields checked
// on a PDI (O-5): audiences come from sys_ux_applicability_m2m_screen, a
// screen has an inline screen_condition, and sys_ux_app_config has no roles.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  decideRoute,
  evaluateVariant,
  listValues,
  renderUiVariantResolution,
  resolveUiVariant,
  rolesAdmit,
  screenAudienceIds,
} from "../build/api/uib-variant.js";
import {
  baselineEnv,
  fcParams,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const USER = "a".repeat(32);
const PAGE = "b".repeat(32);
const CFG = "c".repeat(32);
const ROLE_ID = "d".repeat(32);

const screen = (over = {}) => ({
  sys_id: "s1",
  order: 100,
  active: true,
  conditions: 0,
  ...over,
});
const aud = (roles, active = true, sys_id = "a1") => ({
  sys_id,
  roles,
  active,
});
const roles = (...r) => new Set(r);
const ev = (sys_id, result) => ({
  sys_id,
  order: 0,
  conditions: 0,
  result,
  reason: "",
});

test("listValues and rolesAdmit: empty admits everyone, admin passes", () => {
  assert.deepEqual(listValues(" itil, ,admin "), ["itil", "admin"]);
  assert.deepEqual(listValues(undefined), []);
  assert.equal(rolesAdmit([], roles()), true);
  assert.equal(rolesAdmit(["itil"], roles("itil")), true);
  assert.equal(rolesAdmit(["itil"], roles("x")), false);
  assert.equal(rolesAdmit(["itil"], roles("admin")), true);
});

test("evaluateVariant: roles, inactive, conditions and missing audiences", () => {
  const r = roles("itil");
  const result = (sc, auds = [], missing = 0, rs = r) =>
    evaluateVariant(sc, auds, missing, rs).result;
  assert.equal(result(screen()), "match");
  assert.equal(result(screen({ active: false })), "inactive");
  assert.equal(result(screen(), [aud(["itil"])]), "match");
  assert.equal(result(screen(), [aud(["sn_hr"])]), "no-match");
  assert.equal(result(screen(), [aud(["itil"], false)]), "no-match");
  assert.equal(result(screen(), [], 1), "undetermined");
  // Any active audience admits: one of several is enough.
  assert.equal(
    result(screen(), [aud(["sn_hr"]), aud(["itil"], true, "a2")]),
    "match",
  );
  assert.equal(
    result(screen(), [aud(["itil"], false), aud(["sn_hr"], true, "a2")]),
    "no-match",
  );
  // An admitting audience decides even when another could not be read.
  assert.equal(result(screen(), [aud(["itil"])], 1), "match");
  assert.equal(result(screen(), [aud(["sn_hr"])], 1), "undetermined");
  const cond = evaluateVariant(
    screen({ conditions: 2 }),
    [aud(["itil"])],
    0,
    r,
  );
  assert.equal(cond.result, "undetermined");
  assert.match(cond.reason, /2 screen condition/);
  const inline = evaluateVariant(
    screen({ screenCondition: "mode!=template" }),
    [],
    0,
    r,
  );
  assert.equal(inline.result, "undetermined");
  assert.equal(inline.screenCondition, "mode!=template");
  assert.match(inline.reason, /"mode!=template"/);
  // A role mismatch decides even when the variant has conditions.
  assert.equal(result(screen({ conditions: 1 }), [aud(["sn_hr"])]), "no-match");
  assert.match(
    evaluateVariant(screen(), [aud(["sn_hr"])], 0, roles("admin")).reason,
    /admin passes/,
  );
  assert.equal("audiences" in evaluateVariant(screen(), [], 0, r), false);
});

test("screenAudienceIds: active links only, in order, per screen", () => {
  const ids = screenAudienceIds([
    { screen: "s1", applicability: "b", order: "200", active: "true" },
    { screen: "s1", applicability: "a", order: "100", active: "true" },
    { screen: "s1", applicability: "c", order: "50", active: "false" },
    { screen: "s1", applicability: "a", order: "300", active: "true" },
    { screen: "s2", applicability: "", order: "1", active: "true" },
  ]);
  assert.deepEqual([...ids], [["s1", ["a", "b"]]]);
});

test("decideRoute: first match wins, later active variants are shadowed", () => {
  assert.deepEqual(
    decideRoute([
      ev("a", "no-match"),
      ev("b", "match"),
      ev("c", "inactive"),
      ev("d", "match"),
    ]),
    { decision: "resolved", variant: "b", candidates: [], shadowed: ["d"] },
  );
  assert.deepEqual(decideRoute([ev("a", "no-match")]), {
    decision: "none",
    candidates: [],
    shadowed: [],
  });
  assert.deepEqual(decideRoute([]), {
    decision: "none",
    candidates: [],
    shadowed: [],
  });
});

test("decideRoute: an undetermined variant before the match lists every candidate", () => {
  assert.deepEqual(
    decideRoute([ev("a", "undetermined"), ev("b", "match"), ev("c", "match")]),
    {
      decision: "undetermined",
      candidates: ["a", "b"],
      shadowed: ["c"],
    },
  );
  assert.deepEqual(decideRoute([ev("a", "match"), ev("b", "undetermined")]), {
    decision: "resolved",
    variant: "a",
    candidates: [],
    shadowed: ["b"],
  });
  assert.deepEqual(
    decideRoute([ev("a", "undetermined"), ev("b", "no-match")]),
    {
      decision: "undetermined",
      candidates: ["a"],
      shadowed: [],
    },
  );
});

test("decideRoute property: the shown variant is the first match when nothing is undetermined", () => {
  const results = fc.constantFrom("match", "no-match", "inactive");
  fc.assert(
    fc.property(fc.array(results, { maxLength: 8 }), (rs) => {
      const vs = rs.map((r, i) => ev(`v${i}`, r));
      const d = decideRoute(vs);
      const first = vs.find((v) => v.result === "match");
      assert.equal(d.variant, first?.sys_id);
      assert.equal(d.decision, first ? "resolved" : "none");
      for (const s of d.shadowed) {
        assert.ok(vs.findIndex((v) => v.sys_id === s) > vs.indexOf(first));
      }
    }),
    fcParams(),
  );
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
          result: [{ "role.name": "itil", state: "active" }],
        });
      case "sys_ux_page_registry":
        return jsonResponse(200, {
          result: [
            {
              sys_id: PAGE,
              title: "SOW",
              path: "now/sow",
              admin_panel: CFG,
              admin_panel_table: "sys_ux_app_config",
            },
          ],
        });
      case "sys_user_role":
        return jsonResponse(200, {
          result: [{ sys_id: ROLE_ID, name: "itil" }],
        });
      case "sys_ux_app_route":
        return jsonResponse(200, {
          result: [
            { sys_id: "r1", name: "record", screen_type: "t1", order: "1" },
            { sys_id: "r2", name: "home", screen_type: "t2", order: "2" },
          ],
        });
      case "sys_ux_screen":
        return jsonResponse(200, {
          result: [
            {
              sys_id: "hr",
              name: "HR",
              screen_type: "t1",
              order: "10",
              active: "true",
            },
            {
              sys_id: "cond",
              name: "Cond",
              screen_type: "t1",
              order: "20",
              active: "true",
            },
            {
              sys_id: "def",
              name: "Default",
              screen_type: "t1",
              order: "30",
              active: "true",
            },
            {
              sys_id: "home",
              name: "Home",
              screen_type: "t2",
              order: "10",
              active: "true",
            },
            {
              sys_id: "home2",
              name: "Home 2",
              screen_type: "t2",
              screen_condition: "mode!=template",
              order: "20",
              active: "true",
            },
          ],
        });
      case "sys_ux_applicability":
        return jsonResponse(200, {
          result: [
            {
              sys_id: "ahr",
              name: "HR agents",
              roles: "sn_hr_core.case_writer",
              active: "true",
            },
            {
              sys_id: "aitil",
              name: "Agents",
              roles: ROLE_ID,
              active: "true",
            },
          ],
        });
      case "sys_ux_applicability_m2m_screen":
        return jsonResponse(200, {
          result: [
            { screen: "hr", applicability: "ahr", order: "1", active: "true" },
            {
              screen: "cond",
              applicability: "aitil",
              order: "1",
              active: "true",
            },
            // An inactive link is ignored: "def" is for every user.
            {
              screen: "def",
              applicability: "ahr",
              order: "1",
              active: "false",
            },
            {
              screen: "home",
              applicability: "aitil",
              order: "1",
              active: "true",
            },
          ],
        });
      case "sys_ux_screen_condition":
        return jsonResponse(200, {
          result: [{ sys_id: "c1", screen: "cond" }],
        });
      default:
        return jsonResponse(404, { error: { message: `no ${table}` } });
    }
  };
}

test("resolveUiVariant walks routes, variants, audiences and conditions", async () => {
  freshRuntime();
  await withFetch(instance(), async (calls) => {
    const r = await resolveUiVariant({ experience: "now/sow", user: "beth" });
    assert.equal(r.available, true);
    assert.deepEqual(r.roles, ["itil"]);
    assert.deepEqual(r.appConfig, { sys_id: CFG });
    assert.match(r.notes.join(" "), /ACL-governed/);
    const [record, home] = r.routes;
    assert.equal(record.decision, "undetermined");
    assert.deepEqual(record.candidates, ["cond", "def"]);
    assert.deepEqual(
      record.variants.map((v) => v.result),
      ["no-match", "undetermined", "match"],
    );
    assert.equal(home.decision, "resolved");
    assert.equal(home.variant, "home");
    assert.deepEqual(home.shadowed, ["home2"]);
    assert.deepEqual(home.variants[0].audiences, [
      { sys_id: "aitil", name: "Agents", roles: ["itil"], active: true },
    ]);
    assert.equal(home.variants[1].result, "undetermined");
    assert.equal(home.variants[1].screenCondition, "mode!=template");

    const q = (t) =>
      calls
        .map((c) => new URL(c.url))
        .find((u) => u.pathname.endsWith(`/${t}`))
        .searchParams.get("sysparm_query");
    assert.equal(q("sys_ux_page_registry"), "path=now/sow");
    assert.equal(q("sys_ux_app_route"), `app_config=${CFG}^ORDERBYorder`);
    assert.equal(q("sys_ux_screen"), "screen_typeINt1,t2^ORDERBYorder");
    assert.equal(
      q("sys_ux_applicability_m2m_screen"),
      "screenINhr,cond,def,home,home2",
    );
    assert.equal(q("sys_ux_applicability"), "sys_idINahr,aitil");
    assert.equal(
      q("sys_ux_screen_condition"),
      "screenINhr,cond,def,home,home2^active=true",
    );
    assert.equal(
      calls.some((c) => new URL(c.url).pathname.endsWith("/sys_ux_app_config")),
      false,
    );

    const md = renderUiVariantResolution(r).join("\n");
    assert.match(md, /# Variants of SOW for beth/);
    assert.match(md, /## Route record — undetermined between `cond`, `def`/);
    assert.match(md, /## Route home — shows `home`/);
    assert.match(md, /undetermined \(shadowed\)/);
    assert.match(md, /\| Agents \|/);
    assert.match(md, /`mode!=template`/);
    assert.doesNotMatch(md, /App config roles/);
  });
});

test("resolveUiVariant: audiences exclude the user; a route filter", async () => {
  freshRuntime();
  await withFetch(
    instance({
      sys_user_has_role: () =>
        jsonResponse(200, { result: [{ "role.name": "x", state: "active" }] }),
    }),
    async (calls) => {
      const r = await resolveUiVariant({
        experience: PAGE,
        user: USER,
        route: "home",
      });
      // The fake instance ignores the route filter; "home" is the one asked for.
      const home = r.routes.find((x) => x.name === "home");
      assert.deepEqual(
        home.variants.map((v) => v.result),
        ["no-match", "undetermined"],
      );
      assert.equal(home.decision, "undetermined");
      const route = calls
        .map((c) => new URL(c.url))
        .find((u) => u.pathname.endsWith("/sys_ux_app_route"))
        .searchParams.get("sysparm_query");
      assert.equal(route, `app_config=${CFG}^name=home^ORDERBYorder`);
      assert.match(
        calls
          .map((c) => new URL(c.url))
          .find((u) => u.pathname.endsWith("/sys_ux_page_registry"))
          .searchParams.get("sysparm_query"),
        new RegExp(`^sys_id=${PAGE}`),
      );
    },
  );
});

test("resolveUiVariant degrades: no user, no experience, no app config, unreadable table", async () => {
  freshRuntime();
  await withFetch(
    instance({ sys_user: () => jsonResponse(200, { result: [] }) }),
    async () => {
      const r = await resolveUiVariant({
        experience: "now/sow",
        user: "nobody",
      });
      assert.equal(r.available, false);
      assert.match(r.unavailableReason, /No user/);
    },
  );
  await withFetch(
    instance({ sys_ux_page_registry: () => jsonResponse(200, { result: [] }) }),
    async () => {
      const r = await resolveUiVariant({ experience: "x/y", user: "beth" });
      assert.equal(r.available, false);
      assert.match(r.unavailableReason, /No experience/);
    },
  );
  await withFetch(
    instance({
      sys_ux_page_registry: () =>
        jsonResponse(200, { result: [{ sys_id: PAGE, path: "x" }] }),
    }),
    async () => {
      const r = await resolveUiVariant({ experience: "x", user: "beth" });
      assert.equal(r.available, true);
      assert.deepEqual(r.routes, []);
      assert.match(r.notes[0], /no admin_panel/);
    },
  );
  await withFetch(
    instance({
      sys_ux_page_registry: () =>
        jsonResponse(200, {
          result: [
            {
              sys_id: PAGE,
              path: "x",
              admin_panel: CFG,
              admin_panel_table: "sys_aw_master_config",
            },
          ],
        }),
    }),
    async (calls) => {
      const r = await resolveUiVariant({ experience: "x", user: "beth" });
      assert.equal(r.available, true);
      assert.deepEqual(r.routes, []);
      assert.match(r.notes[0], /sys_aw_master_config/);
      assert.equal(
        calls.some((c) =>
          new URL(c.url).pathname.endsWith("/sys_ux_app_route"),
        ),
        false,
      );
    },
  );
  await withFetch(
    instance({
      sys_ux_screen: () => jsonResponse(403, { error: { message: "denied" } }),
    }),
    async () => {
      const r = await resolveUiVariant({ experience: "now/sow", user: "beth" });
      assert.equal(r.available, false);
      assert.match(r.unavailableReason, /sys_ux_screen/);
      assert.match(renderUiVariantResolution(r).join("\n"), /Unavailable/);
    },
  );
});

test("resolveUiVariant rejects query-injecting input", async () => {
  await assert.rejects(
    resolveUiVariant({ experience: "now/sow", user: "a^b" }),
    /user must be/,
  );
  await assert.rejects(
    resolveUiVariant({ experience: "x=1", user: "beth" }),
    /experience must be/,
  );
  await assert.rejects(
    resolveUiVariant({ experience: "x", user: "beth", route: "a,b" }),
    /route must be/,
  );
});
