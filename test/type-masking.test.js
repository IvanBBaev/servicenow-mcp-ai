// N-21 — type-based field masking: a column whose dictionary internal_type is
// password / password2 / glide_encrypted is masked at the result boundary and
// in the write journal for every record-returning tool, whatever
// SN_REDACT_FIELDS says; a schema miss falls back to the OOTB names and never
// blocks the read; the call's secret values are masked wherever they reappear.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";

import { queryTable, getRecord } from "../build/api/table.js";
import {
  noteSecretRecords,
  secretKeysFor,
} from "../build/api/secret-columns.js";
import { clearSchemaCache } from "../build/core/cache.js";
import { runWithCall } from "../build/core/request-context.js";
import {
  FALLBACK_SECRET_FIELDS,
  SECRET_INTERNAL_TYPES,
  createSecretRegistry,
} from "../build/core/secret-columns.js";
import { peekSecretColumns } from "../build/core/secret-index.js";
import { redactionRules, redactValue } from "../build/core/redaction.js";
import {
  appendWriteJournal,
  readWriteJournal,
} from "../build/core/write-journal.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { ok } from "../build/mcp/result.js";
import {
  baselineEnv,
  fcParams,
  isMaskingLookup,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const tool = (name) => ALL_TOOLS.find((s) => s.name === name);
const call = (name, args) => runSpec(tool(name), args);
const text = (res) => res.content.map((c) => c.text ?? "").join("\n");
const inCall = (fn) =>
  runWithCall(
    { requestId: "t-n21", tool: "test", secrets: createSecretRegistry() },
    fn,
  );

/**
 * The dictionary as the index query returns it: one column per secret type on
 * u_vault and its parent u_base, and a same-named secret column on an
 * unrelated table (u_other.u_note) that must not mask u_vault.u_note.
 */
const INDEX_ROWS = [
  { name: "u_vault", element: "u_secret_pw", internal_type: "password" },
  { name: "u_vault", element: "u_cipher", internal_type: "password2" },
  { name: "u_base", element: "u_enc", internal_type: "glide_encrypted" },
  { name: "u_other", element: "u_note", internal_type: "password2" },
];

/** sys_db_object: u_vault extends u_base; everything else is a root table. */
function chainRow(url) {
  const q = new URL(url).searchParams.get("sysparm_query") ?? "";
  const parent = q === "name=u_vault" ? "u_base" : "";
  return jsonResponse(200, {
    result: [
      { "super_class.name": parent, "super_class.super_class.name": "" },
    ],
  });
}

/**
 * A fetch handler that answers the masking lookups (index + chain) and hands
 * every other request to `table`. `index` overrides the index answer.
 */
const instance =
  (table, { index } = {}) =>
  (url, init) => {
    if (isMaskingLookup(url)) {
      return index ? index() : jsonResponse(200, { result: INDEX_ROWS });
    }
    if (new URL(url).pathname.endsWith("/table/sys_db_object")) {
      return chainRow(url);
    }
    return table(url, init);
  };

/** Run `fn(dir)` against a fresh schema cache and a throw-away SN_DOCS_DIR. */
async function fresh(env, fn) {
  clearSchemaCache();
  const dir = mkdtempSync(path.join(tmpdir(), "snmcp-n21-"));
  try {
    return await withEnv(
      { SN_DOCS_DIR: dir, SN_REDACT_FIELDS: undefined, ...env },
      () => fn(dir),
    );
  } finally {
    clearSchemaCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every journal file's raw text under `dir`. */
function journalText(dir) {
  const root = path.join(dir, "default");
  return readdirSync(root)
    .filter((f) => f.startsWith("write-journal"))
    .map((f) => readFileSync(path.join(root, f), "utf8"))
    .join("\n");
}

const VAULT = {
  sys_id: "v1",
  number: "VLT0001",
  u_secret_pw: "hash-Pw-1111",
  u_cipher: "cipher-Two-2222",
  u_enc: "enc-Three-3333",
  u_note: "plain note",
};

test("the secret types are exactly password, password2 and glide_encrypted", () => {
  assert.deepEqual(
    [...SECRET_INTERNAL_TYPES],
    ["password", "password2", "glide_encrypted"],
  );
  assert.ok(FALLBACK_SECRET_FIELDS.has("user_password"));
});

test("query_table masks every secret type (own and inherited); a same-named column of another table stays", async () => {
  await fresh({}, () =>
    withFetch(
      instance(() => jsonResponse(200, { result: [VAULT] })),
      async (calls) => {
        const res = await call("servicenow_query_table", { table: "u_vault" });
        const out = text(res);
        assert.ok(!res.isError, out);
        for (const v of [VAULT.u_secret_pw, VAULT.u_cipher, VAULT.u_enc]) {
          assert.ok(!out.includes(v), `${v} leaked: ${out}`);
        }
        assert.ok(out.includes("plain note"), out);
        assert.ok(out.includes("VLT0001"), out);
        // The lookups are cached: a second read costs only the read itself.
        const before = calls.length;
        await call("servicenow_query_table", { table: "u_vault" });
        assert.equal(calls.length, before + 1);
      },
      { maskingLookup: true },
    ),
  );
});

test("get_record: a { value, display_value } pair and a dot-walked secret are masked", async () => {
  await fresh({}, () =>
    withFetch(
      instance(() =>
        jsonResponse(200, {
          result: {
            sys_id: "v1",
            u_cipher: {
              value: "cipher-Pair-9999",
              display_value: "cipher-Pair-9999",
            },
            "parent.u_secret_pw": "walked-Pw-8888",
            "parent.user_password": "walked-Ootb-7777",
            short_description: "keeps cipher-Pair-9999 in free text",
          },
        }),
      ),
      async () => {
        const res = await call("servicenow_get_record", {
          table: "u_vault",
          sys_id: "v1",
        });
        const out = text(res);
        assert.ok(!res.isError, out);
        assert.ok(!out.includes("cipher-Pair-9999"), out);
        assert.ok(!out.includes("walked-Pw-8888"), out);
        assert.ok(!out.includes("walked-Ootb-7777"), out);
        assert.ok(out.includes("keeps [redacted] in free text"), out);
      },
      { maskingLookup: true },
    ),
  );
});

test("a schema miss (ACL, empty answer, error) falls back to the OOTB names and never blocks the read", async () => {
  const record = {
    sys_id: "u1",
    user_name: "abel",
    user_password: "ootb-Hash-5555",
    u_cipher: "unknown-type-6666",
  };
  for (const index of [
    () => jsonResponse(403, { error: { message: "ACL" } }),
    () => jsonResponse(200, { result: [] }),
    () => jsonResponse(500, { error: { message: "boom" } }),
  ]) {
    await fresh({}, () =>
      withFetch(
        instance(() => jsonResponse(200, { result: [record] }), { index }),
        async () => {
          const res = await call("servicenow_query_table", {
            table: "sys_user",
          });
          const out = text(res);
          assert.ok(!res.isError, out);
          assert.ok(out.includes("abel"), out);
          assert.ok(!out.includes("ootb-Hash-5555"), out);
          // Not a known column and no type: the name rules decide (visible).
          assert.ok(out.includes("unknown-type-6666"), out);
        },
        { maskingLookup: true },
      ),
    );
  }
});

test("a denied sys_dictionary is cached as unresolved; a transient error is retried next read", async () => {
  for (const [status, lookups] of [
    [403, 1],
    [500, 2],
  ]) {
    await fresh({}, async () => {
      let n = 0;
      await withFetch(
        instance(() => jsonResponse(200, { result: [VAULT] }), {
          index: () => {
            n++;
            return jsonResponse(status, { error: { message: "no" } });
          },
        }),
        async () => {
          await inCall(() => queryTable({ table: "u_vault" }));
          await inCall(() => queryTable({ table: "u_vault" }));
        },
        { maskingLookup: true },
      );
      assert.equal(n, lookups);
    });
  }
});

test("an unresolved chain over-masks a column that is secret somewhere", async () => {
  await fresh({}, () =>
    withFetch(
      (url) => {
        if (isMaskingLookup(url)) {
          return jsonResponse(200, { result: INDEX_ROWS });
        }
        if (new URL(url).pathname.endsWith("/table/sys_db_object")) {
          return jsonResponse(403, { error: { message: "ACL" } });
        }
        return jsonResponse(200, { result: [] });
      },
      async () => {
        const keys = await secretKeysFor("u_vault", [
          "u_note",
          "number",
          "x.u_cipher",
        ]);
        assert.deepEqual([...keys].sort(), ["u_note", "x.u_cipher"]);
        // The dictionary's own rows are never masked by type.
        const meta = await secretKeysFor("sys_dictionary", ["u_cipher"]);
        assert.equal(meta.size, 0);
      },
      { maskingLookup: true },
    ),
  );
});

test("a value read as a secret is masked when a tool re-embeds it (compare-style diff)", async () => {
  await fresh({}, () =>
    withFetch(
      instance(() => jsonResponse(200, { result: [VAULT] })),
      () =>
        inCall(async () => {
          await queryTable({ table: "u_vault" });
          const res = ok({
            diff: `- u_cipher: ${VAULT.u_cipher}\n+ u_cipher: other`,
            lines: [VAULT.u_enc, `x${VAULT.u_secret_pw}x`],
          });
          const out = text(res);
          for (const v of [VAULT.u_secret_pw, VAULT.u_cipher, VAULT.u_enc]) {
            assert.ok(!out.includes(v), `${v} leaked: ${out}`);
          }
        }),
      { maskingLookup: true },
    ),
  );
});

test("sys_properties: a password / password2 property value is masked in a raw read", async () => {
  await fresh({}, () =>
    withFetch(
      instance(() =>
        jsonResponse(200, {
          result: [
            {
              name: "x.conn.cred",
              type: "password2",
              value: "prop-Secret-4444",
            },
            { name: "x.flag", type: "boolean", value: "true" },
          ],
        }),
      ),
      async () => {
        const out = text(
          await call("servicenow_query_table", { table: "sys_properties" }),
        );
        assert.ok(!out.includes("prop-Secret-4444"), out);
        assert.ok(out.includes('"true"'), out);
      },
      { maskingLookup: true },
    ),
  );
});

test("compare_instances never carries a password2 property value", async () => {
  await fresh(
    {
      SN_PROFILE_PROD_INSTANCE: "prod99999.service-now.com",
      SN_PROFILE_PROD_USER: "prod.user",
      SN_PROFILE_PROD_PASSWORD: "pr0d",
    },
    () =>
      withFetch(
        instance((url) => {
          const u = new URL(url);
          if (u.pathname.includes("/stats/")) {
            return jsonResponse(200, { result: { stats: { count: "0" } } });
          }
          if (u.pathname.endsWith("/table/sys_properties")) {
            const prod = u.hostname.startsWith("prod");
            return jsonResponse(200, {
              result: [
                {
                  sys_id: "p1",
                  name: "x.conn.value",
                  type: "password2",
                  value: prod ? "cmp-Prod-Secret-1" : "cmp-Dev-Secret-2",
                },
              ],
            });
          }
          return jsonResponse(200, { result: [] });
        }),
        async () => {
          const res = await call("servicenow_compare_instances", {
            a: "default",
            b: "prod",
            sections: ["properties"],
          });
          const out = text(res);
          assert.ok(!res.isError, out);
          assert.ok(!out.includes("cmp-Prod-Secret-1"), out);
          assert.ok(!out.includes("cmp-Dev-Secret-2"), out);
        },
        { maskingLookup: true },
      ),
  );
});

test("the journal never stores a secret: fields, before-state and an out-of-call append", async () => {
  await fresh({ SN_WRITE_MODE: "apply" }, async (dir) => {
    await withFetch(
      instance((url, init) =>
        !init?.method || init.method === "GET"
          ? jsonResponse(200, { result: VAULT })
          : jsonResponse(200, {
              result: { ...VAULT, u_cipher: "cipher-New-0000" },
            }),
      ),
      async () => {
        const res = await call("servicenow_update_record", {
          table: "u_vault",
          sys_id: "v1",
          values: { u_cipher: "cipher-New-0000", u_note: "n" },
        });
        assert.ok(!res.isError, text(res));
        assert.ok(!text(res).includes("cipher-New-0000"), text(res));
      },
      { maskingLookup: true },
    );
    // Outside a call: the journal masks by the cached index of the table.
    assert.ok(peekSecretColumns("u_vault").has("u_enc"));
    appendWriteJournal({
      action: "create",
      table: "u_vault",
      fields: { u_enc: "enc-Out-of-call-1", u_note: "kept" },
    });
    const { entries } = readWriteJournal();
    assert.equal(entries[0].fields.u_cipher, "[redacted]");
    assert.equal(entries[0].fields.u_note, "n");
    assert.equal(entries[0].before.u_secret_pw, "[redacted]");
    assert.equal(entries[0].before.u_enc, "[redacted]");
    assert.equal(entries.at(-1).fields.u_enc, "[redacted]");
    assert.equal(entries.at(-1).fields.u_note, "kept");
    const raw = journalText(dir);
    for (const v of [
      "cipher-New-0000",
      VAULT.u_secret_pw,
      VAULT.u_cipher,
      VAULT.u_enc,
      "enc-Out-of-call-1",
    ]) {
      assert.ok(!raw.includes(v), `${v} in the journal`);
    }
  });
});

test("masking cannot be turned off: no setting removes the secret rules", async () => {
  await withEnv({ SN_REDACT_FIELDS: "", SN_REDACT_PII: "false" }, () => {
    const rules = redactionRules();
    assert.ok(rules.fields.has("user_password"));
    const r = redactValue({ user_password: "x", n: 1 });
    assert.deepEqual(r.value, { user_password: "[redacted]", n: 1 });
    // An existing mask is not re-masked or counted; untouched data keeps its reference.
    const masked = { password: "***" };
    assert.equal(redactValue(masked).value, masked);
    const plain = { n: 1 };
    assert.equal(redactValue(plain).value, plain);
  });
});

test("outside a tool call nothing is looked up and nothing is recorded", async () => {
  await fresh({}, () =>
    withFetch(
      instance(() => jsonResponse(200, { result: VAULT })),
      async (calls) => {
        await noteSecretRecords("u_vault", [VAULT]);
        await getRecord("u_vault", "v1");
        assert.equal(calls.length, 1); // the read only
      },
      { maskingLookup: true },
    ),
  );
});

test("property: no secret value appears in the serialized result or the journal", async () => {
  // A "~" prefix keeps a generated secret from colliding with key names or the mask.
  const secret = fc
    .stringMatching(/^[A-Za-z0-9!#%&*+=?@^]{7,20}$/)
    .map((s) => `~${s}`);
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        pw: secret,
        cipher: secret,
        enc: secret,
        walked: secret,
        embed: fc.boolean(),
        pair: fc.boolean(),
      }),
      async ({ pw, cipher, enc, walked, embed, pair }) => {
        const record = {
          sys_id: "v1",
          u_secret_pw: pw,
          u_cipher: pair ? { value: cipher, display_value: cipher } : cipher,
          u_enc: enc,
          "ref.u_cipher": walked,
          description: embed ? `see ${cipher} and ${enc}` : "none",
        };
        const secrets = [pw, cipher, enc, walked];
        await fresh({ SN_WRITE_MODE: "apply" }, async (dir) => {
          await withFetch(
            instance((url, init) =>
              (init?.method ?? "GET") === "GET" &&
              new URL(url).pathname.endsWith("/u_vault")
                ? jsonResponse(200, { result: [record] })
                : jsonResponse(200, { result: record }),
            ),
            async () => {
              const read = await call("servicenow_query_table", {
                table: "u_vault",
              });
              const written = await call("servicenow_update_record", {
                table: "u_vault",
                sys_id: "v1",
                values: { u_cipher: cipher, u_enc: enc },
              });
              const serialized =
                JSON.stringify(read) +
                JSON.stringify(written) +
                journalText(dir);
              for (const s of secrets) {
                assert.ok(!serialized.includes(s), `${s} leaked`);
                assert.ok(
                  !serialized.includes(JSON.stringify(s).slice(1, -1)),
                  `${s} leaked (escaped)`,
                );
              }
            },
            { maskingLookup: true },
          );
        });
      },
    ),
    fcParams({ scale: 0.25 }),
  );
});
