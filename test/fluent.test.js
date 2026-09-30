// P-26 — Fluent emitter core: goldens over registry-shaped inputs, determinism,
// secret placeholders, the Record() fallback with its unsupported[] entries,
// the provenance header, the keys.ts fragment, a TypeScript parse of every
// emitted .ts file, and servicenow_generate_fluent end to end (inline and
// file output with the hand-edit guard) against a Table API mock.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  emitFluent,
  fluentSlug,
  FLUENT_EMITTERS,
  FLUENT_TARGET,
  SECRET_PLACEHOLDER,
} from "../build/api/fluent.js";
import { tsString } from "../build/api/fluent-render.js";
import {
  ARTIFACT_TYPES,
  SDK_BASELINE,
  getArtifactType,
} from "../build/core/artifacts/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fluent",
);
const SDK_OFF = { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" };
const NO_REDACT = { SN_REDACT_FIELDS: undefined, SN_REDACT_PII: undefined };

const id = (c) => c.repeat(32);
const SCOPE = { sys_id: id("5"), scope: "x_acme_app" };

/** Registry-shaped inputs (what getArtifactFor returns), one per golden. */
const CASES = {
  business_rule: {
    type: "business_rule",
    sources: [
      {
        scope: SCOPE,
        record: {
          sys_id: id("a"),
          name: "Set priority on insert",
          collection: "incident",
          when: "before",
          order: "100",
          active: "true",
          action_insert: "true",
          action_update: "true",
          action_delete: "false",
          action_query: "false",
          advanced: "true",
          abort_action: "false",
          condition: "current.impact == 1",
          filter_condition: "active=true^EQ",
          script:
            "(function executeRule(current, previous) {\n  current.priority = 1; // it's 'quoted'\n})(current, previous);",
          sys_scope: SCOPE.sys_id,
          sys_updated_on: "2026-09-01 10:00:00",
          sys_mod_count: "4",
        },
        children: [],
      },
    ],
  },
  acl_with_roles: {
    type: "acl",
    sources: [
      {
        scope: SCOPE,
        record: {
          sys_id: id("b"),
          name: "incident.close_notes",
          type: "record",
          operation: "write",
          active: "true",
          admin_overrides: "true",
          script: "answer = gs.hasRole('itil');",
          sys_scope: SCOPE.sys_id,
        },
        children: [
          {
            table: "sys_security_acl_role",
            parentField: "sys_security_acl",
            verified: true,
            count: 2,
            records: [
              {
                sys_id: id("d"),
                sys_security_acl: id("b"),
                sys_user_role: id("e"),
              },
              {
                sys_id: id("c"),
                sys_security_acl: id("b"),
                sys_user_role: "itil",
              },
            ],
          },
        ],
      },
    ],
  },
  property_password: {
    type: "property",
    sources: [
      {
        scope: SCOPE,
        record: {
          sys_id: id("1"),
          name: "x_acme_app.api.password",
          type: "password2",
          value: "hunter2",
          description: "Outbound API password",
          is_private: "true",
          sys_scope: SCOPE.sys_id,
        },
        children: [],
      },
    ],
  },
  ldap_server_record: {
    type: "ldap_server",
    sources: [
      {
        scope: SCOPE,
        record: {
          sys_id: id("2"),
          name: "Corp LDAP",
          password: "[redacted]",
          login_distinguished_name: "cn=svc",
          active: "true",
          sys_scope: SCOPE.sys_id,
        },
        children: [],
      },
    ],
  },
  uib_fallback: {
    type: "uib_client_script",
    sources: [
      {
        scope: SCOPE,
        record: {
          sys_id: id("3"),
          name: "Acme on load",
          macroponent: id("4"),
          type: "default",
          script: "function handler({ api }) { api.setState('x', 1); }",
          sys_scope: SCOPE.sys_id,
        },
        children: [],
      },
    ],
  },
  flow_fallback: {
    type: "flow",
    sources: [
      {
        scope: SCOPE,
        record: {
          sys_id: id("4"),
          name: "Onboard user",
          internal_name: "onboard_user",
          latest_snapshot: id("6"),
          active: "true",
          sys_scope: SCOPE.sys_id,
        },
        children: [
          {
            table: "sys_hub_action_instance",
            parentField: "flow",
            verified: true,
            count: 0,
            records: [],
            redacted: true,
            reason: "Denied by SN_TABLES_DENY.",
          },
        ],
      },
    ],
  },
  fix_script_none: {
    type: "fix_script",
    sources: [
      {
        scope: SCOPE,
        record: {
          sys_id: id("7"),
          name: "Backfill priority",
          script: "gs.info('x');",
          sys_scope: SCOPE.sys_id,
        },
        children: [],
      },
    ],
  },
};

function emitCase(name, rules = null) {
  const c = CASES[name];
  return emitFluent(getArtifactType(c.type), c.sources, c.type, rules);
}

/** A bundle as one reviewable text: every file behind a `===` banner. */
function bundleText(b) {
  const parts = b.files.map((f) => `=== ${f.path}\n${f.content}`);
  parts.push(
    `=== (unsupported)\n${JSON.stringify(b.unsupported, null, 2)}\n` +
      `=== (secretsReplaced) ${b.secretsReplaced}\n`,
  );
  return parts.join("\n");
}

function golden(name, actual) {
  const file = path.join(FIXTURES, `${name}.golden.txt`);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.equal(
    actual,
    readFileSync(file, "utf8"),
    `${name} drifted; regenerate deliberately with UPDATE_GOLDEN=1`,
  );
}

/** Parse diagnostics of a TypeScript source (syntax only; no SDK types). */
function parseErrors(file, content) {
  const sf = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return (sf.parseDiagnostics ?? []).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  );
}

for (const name of Object.keys(CASES)) {
  test(`fluent golden: ${name}`, () => {
    golden(name, bundleText(emitCase(name)));
  });
}

test("every emitted .ts file parses as TypeScript", () => {
  for (const name of Object.keys(CASES)) {
    for (const f of emitCase(name).files) {
      if (!f.path.endsWith(".ts")) continue;
      assert.deepEqual(parseErrors(f.path, f.content), [], `${name} ${f.path}`);
    }
  }
});

test("the TypeScript parse check itself rejects broken source", () => {
  // Guards the oracle: a parser that accepted everything would prove nothing.
  assert.notDeepEqual(parseErrors("x.ts", "Record({ a: 'b', "), []);
});

test("tsString survives any input: quotes, newlines, control and line-separator characters", () => {
  const nasty = "a'b\\c\nd\re\tf\u0000g h i\u007f";
  const literal = tsString(nasty);
  assert.deepEqual(parseErrors("s.ts", `const s = ${literal}`), []);
  assert.equal(new Function(`return ${literal}`)(), nasty);
});

test("output is deterministic: input order and field order do not matter", () => {
  const t = getArtifactType("business_rule");
  const [base] = CASES.business_rule.sources;
  const other = {
    ...base,
    record: { ...base.record, sys_id: id("9"), name: "Second rule" },
  };
  const shuffled = (rec) => Object.fromEntries(Object.entries(rec).reverse());
  const a = emitFluent(t, [base, other], "br", null);
  const b = emitFluent(
    t,
    [
      { ...other, record: shuffled(other.record) },
      { ...base, record: shuffled(base.record) },
    ],
    "br",
    null,
  );
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.keys.map((k) => k.key),
    ["business_rule_second_rule", "business_rule_set_priority_on_insert"],
  );
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a.files.map((f) => f.content).join("")));
});

test("key collisions get the sys_id prefix, never a duplicate Now.ID", () => {
  const t = getArtifactType("business_rule");
  const [base] = CASES.business_rule.sources;
  const twin = { ...base, record: { ...base.record, sys_id: id("f") } };
  const b = emitFluent(t, [twin, base], "br", null);
  const keys = b.keys.map((k) => k.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, [
    "business_rule_set_priority_on_insert",
    `business_rule_set_priority_on_insert_${"f".repeat(8)}`,
  ]);
});

test("secrets become the credential placeholder, never the value", () => {
  const prop = emitCase("property_password");
  const text = prop.files.map((f) => f.content).join("\n");
  assert.ok(!text.includes("hunter2"));
  assert.match(
    text,
    /\/\/ TODO: credential\n\s+value: '<redacted:credential>'/,
  );
  assert.equal(prop.secretsReplaced, 1);

  const ldap = emitCase("ldap_server_record");
  assert.ok(
    ldap.files
      .find((f) => f.path.endsWith(".now.ts"))
      .content.includes(`password: '${SECRET_PLACEHOLDER}'`),
  );
  assert.equal(ldap.secretsReplaced, 1);

  // A credential-like field name is a secret even when no descriptor says so.
  const t = getArtifactType("fix_script");
  const b = emitFluent(
    t,
    [
      {
        record: {
          sys_id: id("8"),
          name: "n",
          client_secret: "shh",
          api_key: "k",
        },
      },
    ],
    "x",
    null,
  );
  const body = b.files.map((f) => f.content).join("\n");
  assert.ok(!body.includes("shh") && !body.includes("'k'"));
  assert.equal(b.secretsReplaced, 2);
});

test("SN_REDACT_FIELDS fields become placeholders too", () => {
  const b = emitCase("business_rule", {
    fields: new Set(["condition"]),
    pii: false,
  });
  const text = b.files.find((f) => f.path.endsWith(".now.ts")).content;
  assert.ok(!text.includes("current.impact"));
  assert.match(text, /condition: '<redacted:credential>'/);
  assert.equal(b.secretsReplaced, 1);
});

test("types without an emitter fall back to Record() and say so in unsupported[]", () => {
  // UI Builder internals have no Fluent API (P-28 keeps them Record()).
  const uib = emitCase("uib_fallback");
  const main = uib.files.find((f) => f.path.endsWith(".now.ts"));
  assert.match(main.content, /^Record\(\{/m);
  assert.match(
    main.content,
    /import \{ Record \} from '@servicenow\/sdk\/core'/,
  );
  assert.deepEqual(
    uib.unsupported.map((u) => [u.kind, /no Fluent API/.test(u.reason)]),
    [["api", true]],
  );
  // Script bodies go to sidecars with the right suffix.
  assert.deepEqual(
    uib.files.map((f) => f.path).filter((p) => !p.endsWith(".ts")),
    ["uib_client_script_acme_on_load.script.client.js"],
  );

  const flow = emitCase("flow_fallback");
  assert.deepEqual(
    flow.unsupported.map((u) => u.kind),
    ["api", "child"],
  );
  assert.match(flow.unsupported[0].reason, /P-27/);
  assert.match(
    flow.files.find((f) => f.path.endsWith(".now.ts")).content,
    new RegExp(
      `latest_snapshot: Now.ref\\('sys_hub_flow_snapshot', '${id("6")}'\\)`,
    ),
  );

  const none = emitCase("fix_script_none");
  assert.equal(none.unsupported[0].kind, "api");
  assert.match(none.unsupported[0].reason, /No Fluent API/);

  // A plain Record type has nothing to report.
  const ldap = emitCase("ldap_server_record");
  assert.deepEqual(ldap.unsupported, []);
});

test("unmapped fields and unreadable records are reported, not lost", () => {
  const t = getArtifactType("business_rule");
  const [base] = CASES.business_rule.sources;
  const b = emitFluent(
    t,
    [
      {
        ...base,
        record: { ...base.record, custom_flag: "yes", order: "soon" },
      },
      {
        sys_id: id("0"),
        record: null,
        degraded: { status: 403, reason: "ACL" },
      },
    ],
    "br",
    null,
  );
  assert.deepEqual(
    b.unsupported.map((u) => [u.kind, u.field ?? null]),
    [
      ["unavailable", null],
      ["field", "order"],
      ["field", "advanced"],
      ["field", "custom_flag"],
    ],
  );
  const text = b.files.find((f) => f.path.endsWith(".now.ts")).content;
  assert.match(
    text,
    /Not emitted \(no BusinessRule property mapped\): advanced, custom_flag\./,
  );
  assert.ok(!/order:/.test(text));
});

test("the header names the SDK baseline and the O-7 assumption", () => {
  assert.equal(FLUENT_TARGET.version, SDK_BASELINE);
  assert.equal(FLUENT_TARGET.assumption, true);
  assert.equal(FLUENT_TARGET.typeChecked, false);
  for (const name of Object.keys(CASES)) {
    for (const f of emitCase(name).files.filter((x) =>
      x.path.endsWith(".ts"),
    )) {
      assert.ok(f.content.includes(`@servicenow/sdk ${SDK_BASELINE}`), f.path);
      assert.ok(f.content.includes("owner gate O-7"), f.path);
      assert.ok(f.content.includes("not been type-checked"), f.path);
    }
  }
});

test("the keys.ts fragment lists every key, sorted, with table and id", () => {
  const b = emitCase("acl_with_roles");
  const keys = b.files.find((f) => f.path === "acl.keys.ts").content;
  assert.match(keys, /interface Keys extends KeysRegistry/);
  const listed = [...keys.matchAll(/^ {20}'([^']+)': \{$/gm)].map((m) => m[1]);
  assert.deepEqual(
    listed,
    b.keys.map((k) => k.key),
  );
  assert.deepEqual([...listed].sort(), listed);
  assert.equal(listed.length, 3);
  // Children are ordered by sys_id when the child has no order field.
  assert.deepEqual(listed.slice(1), [
    `acl_incident_close_notes__sys_security_acl_role_${"c".repeat(8)}`,
    `acl_incident_close_notes__sys_security_acl_role_${"d".repeat(8)}`,
  ]);
});

test("every dedicated emitter calls its descriptor's SDK API", () => {
  for (const [type, e] of Object.entries(FLUENT_EMITTERS)) {
    const t = getArtifactType(type);
    assert.ok(t, `${type} is a registry type`);
    assert.equal(e.api, t.sdkApi, type);
    assert.ok(["core", "server", "classic-ui"].includes(t.group), type);
  }
  // Portal / workspace / catalog emitters live in UI_EMITTERS (P-28,
  // test/fluent-ui.test.js); flows and UIB have no entry here.
  const later = ARTIFACT_TYPES.filter((t) =>
    ["flow", "uib", "portal", "next-experience"].includes(t.group),
  ).map((t) => t.type);
  assert.deepEqual(
    later.filter((t) => FLUENT_EMITTERS[t]),
    [],
  );
});

test("fluentSlug makes identifier-safe keys", () => {
  assert.equal(fluentSlug("  Set Priority (v2)!  "), "set_priority_v2");
  assert.equal(fluentSlug("***"), "");
  assert.equal(fluentSlug("x".repeat(90)).length, 60);
});

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

const tool = ALL_TOOLS.find((s) => s.name === "servicenow_generate_fluent");

function tableMock(routes, calls) {
  return (url, init) => {
    calls?.push({ url, method: init?.method ?? "GET" });
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/);
    assert.ok(m, `unexpected request ${url}`);
    const route = routes[m[1]];
    if (!route) return jsonResponse(404, { error: { message: "no route" } });
    return route(u.searchParams, m[2]);
  };
}
const rows = (result) => jsonResponse(200, { result });

const BR = CASES.business_rule.sources[0].record;
const brRoutes = {
  sys_script: (_p, sysId) =>
    sysId ? rows(sysId === BR.sys_id ? BR : {}) : rows([BR]),
  sys_scope: () => rows([{ sys_id: SCOPE.sys_id, scope: SCOPE.scope }]),
};

test("generate_fluent inline: one artifact, GETs only, the golden content", async () => {
  freshRuntime();
  const calls = [];
  await withEnv({ ...SDK_OFF, ...NO_REDACT }, () =>
    withFetch(tableMock(brRoutes, calls), async () => {
      const res = await runSpec(tool, {
        artifactType: "business_rule",
        sys_id: BR.sys_id,
      });
      assert.equal(res.isError, undefined, res.content?.[0]?.text);
      const body = res.structuredContent;
      assert.equal(body.format, "inline");
      assert.equal(body.emitter, "dedicated");
      assert.equal(body.sdkApi, "BusinessRule");
      assert.equal(body.scope, "x_acme_app");
      assert.equal(body.count, 1);
      assert.equal(body.target.version, SDK_BASELINE);
      const expected = emitCase("business_rule");
      const base = "business_rule_set_priority_on_insert";
      assert.deepEqual(
        body.files.map((f) => f.path),
        expected.files
          .map((f) => f.path.replace(/^business_rule\.keys/, `${base}.keys`))
          .sort(),
      );
      const main = body.files.find((f) => f.path === `${base}.now.ts`);
      assert.equal(
        main.content,
        expected.files.find((f) => f.path === `${base}.now.ts`).content,
      );
    }),
  );
  assert.ok(calls.length > 0);
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ["GET"]);
});

test("generate_fluent needs exactly one of sys_id, key or scope", async () => {
  freshRuntime();
  for (const args of [
    { artifactType: "business_rule" },
    { artifactType: "business_rule", sys_id: BR.sys_id, scope: "x_acme_app" },
  ]) {
    const res = await runSpec(tool, args);
    assert.equal(res.isError, true);
    assert.match(
      res.content[0].text,
      /exactly one of 'sys_id', 'key' or 'scope'/,
    );
  }
  const bad = await runSpec(tool, { artifactType: "nope", sys_id: BR.sys_id });
  assert.equal(bad.isError, true);
});

test("generate_fluent file mode: created, unchanged, hand-edit guard, overwrite", async () => {
  freshRuntime();
  const dir = mkdtempSync(path.join(tmpdir(), "sn-fluent-"));
  try {
    await withEnv({ ...SDK_OFF, ...NO_REDACT, SN_DOCS_DIR: dir }, () =>
      withFetch(tableMock(brRoutes), async () => {
        const args = {
          artifactType: "business_rule",
          scope: "x_acme_app",
          format: "file",
        };
        const first = (await runSpec(tool, args)).structuredContent;
        assert.equal(first.format, "file");
        assert.equal(first.directory, "default/fluent/x_acme_app");
        assert.equal(
          first.companion,
          "default/fluent/x_acme_app/business_rule.fluent.json",
        );
        assert.deepEqual(
          [...new Set(first.files.map((f) => f.status))],
          ["created"],
        );
        const nowTs = path.join(
          dir,
          "default/fluent/x_acme_app/business_rule_set_priority_on_insert.now.ts",
        );
        const original = readFileSync(nowTs, "utf8");
        assert.equal(
          original,
          emitCase("business_rule").files.find((f) =>
            f.path.endsWith(".now.ts"),
          ).content,
        );
        const companion = JSON.parse(
          readFileSync(path.join(dir, first.companion), "utf8"),
        );
        assert.equal(companion.sn_kind, "fluent");
        assert.equal(companion.sn_generator, "servicenow_generate_fluent");
        assert.equal(companion.files.length, first.files.length);

        const second = (await runSpec(tool, args)).structuredContent;
        assert.deepEqual(
          [...new Set(second.files.map((f) => f.status))],
          ["unchanged"],
        );

        writeFileSync(nowTs, `${original}// my edit\n`);
        const guarded = await runSpec(tool, args);
        assert.equal(guarded.isError, true);
        assert.match(guarded.content[0].text, /edited by hand/);
        assert.equal(readFileSync(nowTs, "utf8"), `${original}// my edit\n`);

        const forced = (await runSpec(tool, { ...args, overwrite: true }))
          .structuredContent;
        assert.equal(
          forced.files.find((f) => f.path.endsWith(".now.ts")).status,
          "updated",
        );
        assert.equal(readFileSync(nowTs, "utf8"), original);
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
