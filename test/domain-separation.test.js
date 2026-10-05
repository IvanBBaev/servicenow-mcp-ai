// N-12 (NX-16) — domain separation awareness: the sys_user domain probe
// reported by check_capabilities and repeated (cached, positive only) by
// get_status; list reads keeping sys_domain / sys_overrides; trace and
// explain attributing domain-specific records — and byte-identical output on
// an instance without domain separation.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  DOMAIN_CAVEAT,
  DOMAIN_FIELDS,
  recordDomain,
} from "../build/api/domain-separation.js";
import {
  cachedDomainSeparation,
  clearCapabilityCache,
  probeDomainSeparation,
} from "../build/api/capability-matrix.js";
import { checkCapabilities } from "../build/api/capabilities.js";
import { buildStatusPayload } from "../build/mcp/status.js";
import { listScripts } from "../build/api/scripts.js";
import { traceTableEvent } from "../build/api/flows.js";
import {
  artefactsByDomain,
  renderApp,
  renderTable,
} from "../build/api/document.js";
import { explainArtifactFor } from "../build/api/explain-artifact.js";
import { getArtifactType } from "../build/core/artifacts/registry.js";
import { clearSchemaCache } from "../build/core/cache.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

beforeEach(() => {
  freshRuntime();
  clearSchemaCache();
});

const DOMAIN_ID = "d".repeat(32);
const tableOf = (url) =>
  /\/api\/now\/table\/([^/?]+)/.exec(new URL(url).pathname)?.[1] ?? "";
const paramsOf = (url) => new URL(url).searchParams;

/** The sys_user row the probe reads, with display values (`all`). */
const userRow = (domain) =>
  jsonResponse(200, {
    result: [
      {
        sys_id: { value: "u1", display_value: "u1" },
        ...(domain
          ? {
              sys_domain: {
                value: domain.sys_id,
                display_value: domain.name,
              },
              sys_domain_path: { value: "!!!/!!#/", display_value: "!!!/!!#/" },
            }
          : {}),
      },
    ],
  });

test("recordDomain: domain-specific rows only; global and absent are silent", () => {
  assert.deepEqual(recordDomain({}), {});
  assert.deepEqual(recordDomain({ sys_domain: "global" }), {});
  assert.deepEqual(
    recordDomain({ sys_domain: { value: "global", display_value: "global" } }),
    {},
  );
  assert.deepEqual(recordDomain({ sys_domain: "" }), {});
  assert.deepEqual(recordDomain({ sys_domain: DOMAIN_ID }), {
    domain: DOMAIN_ID,
  });
  assert.deepEqual(
    recordDomain({ sys_domain: DOMAIN_ID, "sys_domain.name": "ACME" }),
    { domain: "ACME" },
  );
  assert.deepEqual(
    recordDomain({
      sys_domain: { value: DOMAIN_ID, display_value: "ACME" },
      sys_overrides: { value: "o1", link: "x" },
    }),
    { domain: "ACME", overrides: "o1" },
  );
  assert.deepEqual([...DOMAIN_FIELDS], ["sys_domain", "sys_overrides"]);
});

test("probe: an active domain is reported with the user's domain and cached", async () => {
  await withFetch(
    (url) => {
      assert.equal(tableOf(url), "sys_user");
      const p = paramsOf(url);
      assert.equal(p.get("sysparm_display_value"), "all");
      assert.ok(p.get("sysparm_fields").split(",").includes("sys_domain"));
      return userRow({ sys_id: DOMAIN_ID, name: "ACME" });
    },
    async (calls) => {
      const entry = await probeDomainSeparation();
      assert.equal(entry.status, "available");
      assert.deepEqual(entry.detail, {
        active: true,
        domain: { sys_id: DOMAIN_ID, name: "ACME" },
        path: "!!!/!!#/",
      });
      assert.match(entry.reason, /domain 'ACME'/);
      const again = await probeDomainSeparation();
      assert.equal(again.cached, true);
      assert.equal(calls.length, 1);
      assert.equal(cachedDomainSeparation()?.detail.active, true);
      // get_status repeats the cached positive answer without a request.
      const status = buildStatusPayload();
      assert.equal(status.domainSeparation.active, true);
      assert.equal(status.domainSeparation.domain.name, "ACME");
      assert.equal(calls.length, 1);
    },
  );
});

test("probe: the global domain is active but says reads are not limited", async () => {
  await withFetch(
    () => userRow({ sys_id: "global", name: "global" }),
    async () => {
      const entry = await probeDomainSeparation();
      assert.equal(entry.detail.active, true);
      assert.match(entry.reason, /global domain/);
    },
  );
});

test("probe: no domain field → not active; get_status unchanged", async () => {
  const before = Object.keys(buildStatusPayload());
  await withFetch(
    () => userRow(undefined),
    async () => {
      const entry = await probeDomainSeparation();
      assert.deepEqual(entry, {
        status: "available",
        detail: { active: false },
        httpStatus: 200,
      });
      assert.equal(cachedDomainSeparation(), undefined);
      const status = buildStatusPayload();
      assert.equal("domainSeparation" in status, false);
      assert.deepEqual(Object.keys(status), before);
    },
  );
});

test("probe: hidden user row → unknown; policy denial → not probed", async () => {
  await withFetch(
    () => jsonResponse(200, { result: [] }),
    async () => {
      const entry = await probeDomainSeparation();
      assert.equal(entry.status, "unknown");
      assert.match(entry.reason, /not visible/);
    },
  );
  clearCapabilityCache();
  await withEnv({ SN_TABLES_DENY: "sys_user" }, () =>
    withFetch(
      () => assert.fail("a denied table must not be probed"),
      async () => {
        const entry = await probeDomainSeparation();
        assert.equal(entry.status, "unknown");
        assert.match(entry.reason, /not probed/);
      },
    ),
  );
});

test("check_capabilities: full run reports domainSeparation; narrowed run skips it", async () => {
  const handler = (url) =>
    tableOf(url) === "sys_user" && paramsOf(url).has("sysparm_display_value")
      ? userRow({ sys_id: DOMAIN_ID, name: "ACME" })
      : jsonResponse(200, { result: [{ sys_id: "1" }] });
  await withFetch(handler, async () => {
    const full = await checkCapabilities();
    assert.equal(full.domainSeparation.detail.active, true);
    assert.equal(full.domainSeparation.detail.domain.name, "ACME");
  });
  clearCapabilityCache();
  await withFetch(handler, async (calls) => {
    const narrow = await checkCapabilities({ groups: [] });
    assert.equal("domainSeparation" in narrow, false);
    assert.ok(!calls.some((c) => paramsOf(c.url).has("sysparm_display_value")));
  });
});

test("list_scripts keeps sys_domain / sys_overrides only when returned", async () => {
  const rows = [
    { sys_id: "1", name: "Base", collection: "incident" },
    {
      sys_id: "2",
      name: "ACME copy",
      collection: "incident",
      sys_domain: "ACME",
      sys_overrides: "1",
    },
  ];
  await withFetch(
    (url) => {
      const fields = paramsOf(url).get("sysparm_fields").split(",");
      assert.ok(fields.includes("sys_domain"));
      assert.ok(fields.includes("sys_overrides"));
      return jsonResponse(200, { result: rows });
    },
    async () => {
      const { scripts } = await listScripts({ type: "business_rule" });
      assert.equal("sys_domain" in scripts[0], false);
      assert.equal(scripts[1].sys_domain, "ACME");
      assert.equal(scripts[1].sys_overrides, "1");
    },
  );
});

/** A one-rule trace of incident (no parents); `rule` adds fields. */
function traceHandler(rule) {
  return (url) => {
    const table = tableOf(url);
    if (table === "sys_db_object") {
      return jsonResponse(200, {
        result: [{ name: "incident", "super_class.name": "" }],
      });
    }
    if (table === "sys_script") {
      const q = paramsOf(url).get("sysparm_query") ?? "";
      if (!/when=before/.test(q)) return jsonResponse(200, { result: [] });
      return jsonResponse(200, {
        result: [
          {
            sys_id: "b1",
            name: "Set defaults",
            order: "100",
            when: "before",
            collection: "incident",
            global: "false",
            ...rule,
          },
        ],
      });
    }
    return jsonResponse(200, { result: [] });
  };
}

test("trace: a domain-specific rule is attributed to its domain, with one caveat", async () => {
  await withFetch(
    traceHandler({
      sys_domain: DOMAIN_ID,
      "sys_domain.name": "ACME",
      sys_overrides: "b0",
    }),
    async () => {
      const trace = await traceTableEvent("incident", "update");
      const rule = trace.chain.find((e) => e.sys_id === "b1");
      assert.equal(rule.domain, "ACME");
      assert.equal(rule.overrides, "b0");
      assert.equal(trace.warnings.filter((w) => w === DOMAIN_CAVEAT).length, 1);
    },
  );
});

test("trace: without domain separation the output carries no domain trace", async () => {
  await withFetch(traceHandler({}), async () => {
    const trace = await traceTableEvent("incident", "update");
    const rule = trace.chain.find((e) => e.sys_id === "b1");
    assert.equal("domain" in rule, false);
    assert.equal("overrides" in rule, false);
    assert.ok(!trace.warnings.includes(DOMAIN_CAVEAT));
    assert.ok(!JSON.stringify(trace).includes("domain"));
  });
  // A global-domain rule is not flagged either.
  clearSchemaCache();
  await withFetch(traceHandler({ sys_domain: "global" }), async () => {
    const trace = await traceTableEvent("incident", "update");
    assert.equal("domain" in trace.chain.find((e) => e.sys_id === "b1"), false);
  });
});

/** Explain mock: the primary record by sys_id, the scope, no children. */
function explainHandler(record) {
  return (url) => {
    const table = tableOf(url);
    if (table === "sys_scope") {
      return jsonResponse(200, { result: [{ sys_id: "s1", scope: "global" }] });
    }
    if (
      table === "sys_script" &&
      /\/sys_script\/\w+$/.test(new URL(url).pathname)
    ) {
      return jsonResponse(200, { result: record });
    }
    return jsonResponse(200, { result: [] });
  };
}

const BR = {
  sys_id: "b".repeat(32),
  name: "Set defaults",
  collection: "incident",
  when: "before",
  active: "true",
  script: "current.x = 1;",
};

test("explain_artifact names a record's domain only when it has one", async () => {
  const t = getArtifactType("business_rule");
  await withEnv(
    { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" },
    async () => {
      const plain = await withFetch(explainHandler(BR), () =>
        explainArtifactFor(t, { sys_id: BR.sys_id }),
      );
      assert.equal("domain" in plain, false);
      assert.doesNotMatch(plain.summary, /domain/);

      const scoped = await withFetch(
        explainHandler({
          ...BR,
          sys_domain: { value: DOMAIN_ID, link: "x" },
          sys_overrides: { value: "b0", link: "y" },
        }),
        () => explainArtifactFor(t, { sys_id: BR.sys_id }),
      );
      assert.equal(scoped.domain, DOMAIN_ID);
      assert.equal(scoped.overrides, "b0");
      assert.match(scoped.summary, new RegExp(`domain ${DOMAIN_ID}`));
    },
  );
});

/** An insert trace of incident with one flow, workflow and notification. */
function laneHandler(extra) {
  return (url) => {
    const table = tableOf(url);
    const fields = paramsOf(url).get("sysparm_fields") ?? "";
    if (table === "sys_db_object") {
      return jsonResponse(200, {
        result: [{ name: "incident", "super_class.name": "" }],
      });
    }
    if (table === "sys_hub_trigger_instance") {
      assert.ok(fields.split(",").includes("flow.sys_domain"));
      return jsonResponse(200, {
        result: [
          {
            flow: "f1",
            "flow.name": "Notify",
            table_name: "incident",
            trigger_type: "record_create",
            ...extra.flow,
          },
        ],
      });
    }
    if (table === "wf_workflow") {
      assert.ok(fields.split(",").includes("sys_domain"));
      return jsonResponse(200, {
        result: [{ sys_id: "w1", name: "Legacy", ...extra.workflow }],
      });
    }
    if (table === "sysevent_email_action") {
      assert.ok(fields.split(",").includes("sys_overrides"));
      return jsonResponse(200, {
        result: [
          {
            sys_id: "n1",
            name: "Mail",
            collection: "incident",
            action_insert: "true",
            ...extra.notification,
          },
        ],
      });
    }
    return jsonResponse(200, { result: [] });
  };
}

test("trace: flows, workflows and notifications carry their domain", async () => {
  await withFetch(
    laneHandler({
      flow: {
        "flow.sys_domain": DOMAIN_ID,
        "flow.sys_domain.name": "ACME",
        // The trigger's own domain is not the flow's.
        sys_domain: "global",
      },
      workflow: { sys_domain: DOMAIN_ID },
      notification: { "sys_domain.name": "ACME", sys_overrides: "n0" },
    }),
    async () => {
      const trace = await traceTableEvent("incident", "insert");
      const by = (id) => trace.chain.find((e) => e.sys_id === id);
      assert.equal(by("f1").domain, "ACME");
      assert.equal(by("w1").domain, DOMAIN_ID);
      assert.equal(by("n1").domain, "ACME");
      assert.equal(by("n1").overrides, "n0");
      assert.equal(trace.warnings.filter((w) => w === DOMAIN_CAVEAT).length, 1);
    },
  );
  clearSchemaCache();
  await withFetch(
    laneHandler({ flow: {}, workflow: {}, notification: {} }),
    async () => {
      const trace = await traceTableEvent("incident", "insert");
      assert.equal(trace.chain.length, 4, "database write + three lanes");
      assert.ok(!JSON.stringify(trace).includes("domain"));
    },
  );
});

const TABLE_DOC = (rule) => ({
  table: "incident",
  chain: ["incident"],
  columns: { incident: [] },
  referencedBy: [],
  logic: {
    businessRules: [
      {
        sys_id: "b1",
        name: "A",
        when: "before",
        order: "100",
        active: "true",
        condition: "",
        ...rule,
      },
      {
        sys_id: "b2",
        name: "B",
        when: "after",
        order: "200",
        active: "true",
        condition: "",
      },
    ],
    clientScripts: [],
    uiPolicies: [],
    uiActions: [],
    acls: [],
  },
  unreadable: [],
  caveats: [],
});

test("table document: a Domain column only when a logic entry has one", () => {
  const ctx = { profile: "default" };
  const plain = renderTable(TABLE_DOC({}), ctx);
  assert.doesNotMatch(plain, /Domain/);
  const scoped = renderTable(TABLE_DOC({ domain: "ACME" }), ctx);
  assert.match(
    scoped,
    /\| Name \| When \| Order \| Active \| Condition \| Domain \|/,
  );
  assert.match(scoped, /\| A \| before \| 100 \| true \| {2}\| ACME \|/);
  assert.match(scoped, /\| B \| after \| 200 \| true \| {2}\| {2}\|/);
});

const APP_DOC = (artefacts) => ({
  app: {
    table: "sys_app",
    sys_id: "s1",
    name: "App",
    scope: "x_app",
    version: "1.0.0",
    vendor: "",
    short_description: "",
  },
  tables: [],
  artefacts,
  degraded: [],
  unreadable: [],
  caveats: [],
});

const brRow = (id, extra = {}) => ({
  sys_id: id,
  name: `Rule ${id}`,
  key: { sys_id: id },
  active: true,
  sdkManaged: "no",
  ...extra,
});

test("app document: a domain column and a Domains section only when needed", () => {
  const ctx = { profile: "default" };
  const plain = renderApp(
    APP_DOC({
      business_rule: [brRow("1"), brRow("2", { sys_domain: "global" })],
    }),
    ctx,
  );
  assert.doesNotMatch(plain, /## Domains|\| domain \|/);

  const artefacts = {
    business_rule: [brRow("1", { sys_domain: DOMAIN_ID }), brRow("2")],
    script_include: [
      { ...brRow("3", { sys_domain: DOMAIN_ID }), name: "Util" },
      { ...brRow("4", { sys_domain: "e".repeat(32) }), name: "Other" },
    ],
  };
  assert.deepEqual(artefactsByDomain(artefacts), [
    { domain: DOMAIN_ID, count: 2, types: ["business_rule", "script_include"] },
    { domain: "e".repeat(32), count: 1, types: ["script_include"] },
  ]);
  const md = renderApp(APP_DOC(artefacts), ctx);
  assert.match(md, /## Domains/);
  assert.ok(md.includes(DOMAIN_CAVEAT));
  assert.match(
    md,
    new RegExp(
      `\\| ${DOMAIN_ID} \\| 2 \\| \`business_rule\`, \`script_include\` \\|`,
    ),
  );
  assert.match(md, /\| domain \|/);
});
