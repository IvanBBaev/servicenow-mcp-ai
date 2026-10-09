// H-8 — platform corner-case pins. One test (or a small group) per corner
// from ROADMAP-V3 §H-8 (C-1, C-3, C-4, C-9, C-10, C-11/C-12). The instance
// responses are recorded-shape fixtures (the page and payload shapes a PDI
// returns), not live captures: they pin the behaviour this server promises
// for each shape.

import test from "node:test";
import assert from "node:assert/strict";

import { snRequest } from "../build/core/http.js";
import {
  shapeErrorBody,
  getTelemetry,
  HIBERNATING_HINT,
  INSTANCE_HTML_HINT,
} from "../build/core/http-util.js";
import { ServiceNowError } from "../build/core/errors.js";
import { queryTable, FETCH_ALL_SCAN_FACTOR } from "../build/api/table.js";
import { okQueryResult, queryCompleteness, fail } from "../build/mcp/result.js";
import { redactRecords } from "../build/mcp/redact.js";
import { toCsv } from "../build/mcp/csv.js";
import { snString } from "../build/api/shared.js";
import { generateErDiagram, generateTableFlow } from "../build/api/diagrams.js";
import {
  uploadAttachment,
  downloadAttachment,
} from "../build/api/attachment.js";
import {
  pluginCall,
  clearPluginAvailability,
  setPluginProbe,
  defaultPluginProbe,
  describeVerdict,
  PLUGIN_CANDIDATES,
} from "../build/api/plugin.js";
import { whereUsed, whereUsedCaveats } from "../build/api/whereused.js";
import { COMPARE_CAVEATS } from "../build/api/compare.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

const htmlResponse = (status, html, type = "text/html; charset=UTF-8") =>
  new Response(html, { status, headers: { "content-type": type } });

/** Recorded shape of the page a hibernating PDI serves on every URL. */
const HIBERNATING_PAGE = `<!DOCTYPE html><html><head><title>Instance Hibernating page</title>
<style>body{font-family:sans-serif}</style><script>var x = 1;</script></head>
<body><div class="container"><h1>Your instance is hibernating</h1>
<p>This developer instance is hibernating to save resources. To wake up your instance,
sign in to the Developer Site and select Wake up instance.</p></div></body></html>`;

/** Recorded shape of a login page reached through an SSO redirect. */
const LOGIN_PAGE = `<html><head><title>ServiceNow</title></head><body>
<form action="login.do" method="post"><input name="user_name"/><input name="user_password" type="password"/>
<button>Log in</button></form></body></html>`;

// --- C-3: an HTML page with a 2xx status --------------------------------------

test("C-3: a 2xx hibernation page throws INSTANCE_HTML_RESPONSE with the wake-up hint", async () => {
  freshRuntime();
  await withFetch(
    () => htmlResponse(200, HIBERNATING_PAGE),
    async () => {
      const err = await snRequest({
        method: "GET",
        path: "/api/now/table/incident",
        params: new URLSearchParams({ sysparm_query: "secret=1" }),
      }).then(
        () => assert.fail("expected a rejection"),
        (e) => e,
      );
      assert.ok(err instanceof ServiceNowError);
      assert.equal(err.code, "INSTANCE_HTML_RESPONSE");
      assert.equal(err.status, 200);
      assert.equal(err.hint, HIBERNATING_HINT);
      assert.match(err.hint, /developer\.servicenow\.com/);
      assert.match(err.message, /HTML page instead of JSON \(HTTP 200\)/);
      assert.match(err.message, /hibernating/);
      // The query string never reaches the message; the page is reduced to text.
      assert.doesNotMatch(err.message, /secret=1/);
      assert.equal(err.detail.html, true);
      assert.doesNotMatch(err.detail.raw, /<|var x/);
      assert.ok(err.detail.raw.length <= 512);
      assert.equal(getTelemetry().errors.instance_html, 1);

      // The tool boundary exposes the machine code and the hint.
      const out = JSON.parse(fail(err).content[0].text);
      assert.equal(out.code, "INSTANCE_HTML_RESPONSE");
      assert.match(out.hint, /wake it/i);
    },
  );
});

test("C-3: other HTML pages (login/SSO, no content type) get the generic PDI/login hint", async () => {
  for (const res of [
    () => htmlResponse(200, LOGIN_PAGE),
    // Some proxies drop the content type; the body alone identifies HTML.
    () => new Response("  <!doctype html><html><body>Sign in</body></html>"),
  ]) {
    await withFetch(res, async () => {
      await assert.rejects(
        snRequest({ method: "GET", path: "/api/now/table/incident" }),
        (err) =>
          err instanceof ServiceNowError &&
          err.code === "INSTANCE_HTML_RESPONSE" &&
          err.hint === INSTANCE_HTML_HINT &&
          /PDI may be hibernating/.test(err.hint) &&
          !/appears to be hibernating/.test(err.message),
      );
    });
  }
});

test("C-3: JSON and non-HTML text bodies keep their historical shapes", async () => {
  await withFetch(
    () => jsonResponse(200, { result: [{ note: "<b>bold</b>" }] }),
    async () => {
      const { data } = await snRequest({ method: "GET", path: "/api/x" });
      assert.deepEqual(data, { result: [{ note: "<b>bold</b>" }] });
    },
  );
  await withFetch(
    () =>
      new Response("plain text", {
        headers: { "content-type": "text/plain" },
      }),
    async () => {
      const { data } = await snRequest({ method: "GET", path: "/api/x" });
      assert.deepEqual(data, { raw: "plain text" });
    },
  );
  await withFetch(
    () => new Response(null, { status: 204 }),
    async () => {
      const { data } = await snRequest({ method: "DELETE", path: "/api/x" });
      assert.deepEqual(data, {});
    },
  );
});

test("C-3: a binary download of an HTML attachment is NOT mistaken for a hibernation page", async () => {
  await withFetch(
    () => htmlResponse(200, "<html><body>my page</body></html>"),
    async () => {
      const { data } = await snRequest({
        method: "GET",
        path: "/api/now/attachment/a1/file",
        responseType: "binary",
      });
      assert.equal(
        Buffer.from(data, "base64").toString("utf8"),
        "<html><body>my page</body></html>",
      );
    },
  );
});

test("C-3: an error-status hibernation page is classified too (shapeErrorBody)", () => {
  const shaped = shapeErrorBody(HIBERNATING_PAGE, "text/html", () => undefined);
  assert.equal(shaped.code, "INSTANCE_HTML_RESPONSE");
  assert.equal(shaped.hint, HIBERNATING_HINT);
  const proxy = shapeErrorBody(LOGIN_PAGE, "text/html", () => undefined);
  assert.equal(proxy.code, "UPSTREAM_HTML");
});

// --- C-1: short pages under row-level ACLs ------------------------------------

const rows = (n) => Array.from({ length: n }, (_, i) => ({ n: i }));

/**
 * Recorded ServiceNow behaviour: row-level ACLs are applied AFTER paging, so a
 * window of `limit` rows comes back with the unreadable ones dropped while
 * X-Total-Count still counts them.
 */
const aclHandler =
  (all, hidden, { withTotal = true } = {}) =>
  (url) => {
    const u = new URL(url);
    const limit = Number(u.searchParams.get("sysparm_limit"));
    const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
    const page = all.slice(offset, offset + limit).filter((r) => !hidden(r));
    return jsonResponse(
      200,
      { result: page },
      withTotal ? { "x-total-count": String(all.length) } : {},
    );
  };

test("C-1: fetchAll continues past a short (ACL-filtered) page until X-Total-Count", async () => {
  // Rows 2 and 3 are unreadable: page 1 = [0,1], page 2 = [] (both hidden),
  // page 3 = [4,5]. The old loop stopped at the first short page.
  await withFetch(
    aclHandler(rows(6), (r) => r.n === 2 || r.n === 3),
    async (calls) => {
      const res = await queryTable({
        table: "incident",
        fetchAll: true,
        limit: 2,
      });
      assert.deepEqual(
        res.records.map((r) => r.n),
        [0, 1, 4, 5],
      );
      assert.equal(res.total, 6);
      assert.equal(res.filtered, 2);
      assert.equal(res.truncated, undefined, "withheld rows are not a cap");
      assert.equal(calls.length, 3);
    },
  );
});

test("C-1: without X-Total-Count the read goes on until an empty page", async () => {
  await withFetch(
    aclHandler(rows(7), (r) => r.n === 1, { withTotal: false }),
    async (calls) => {
      const res = await queryTable({
        table: "incident",
        fetchAll: true,
        limit: 3,
      });
      assert.deepEqual(
        res.records.map((r) => r.n),
        [0, 2, 3, 4, 5, 6],
      );
      assert.equal(res.total, undefined);
      // The gap in page 1 is proven by later rows; the final short page is
      // indistinguishable from the end and is not counted.
      assert.equal(res.filtered, 1);
      assert.deepEqual(
        calls.map((c) => new URL(c.url).searchParams.get("sysparm_offset")),
        [null, "3", "6", "9"],
      );
    },
  );
});

test("C-1: a table the user can barely read stops on the scan budget with a named cause", async () => {
  await withEnv({ SN_MAX_RECORDS: "2" }, () =>
    withFetch(
      aclHandler(rows(1000), (r) => r.n !== 0),
      async (calls) => {
        const res = await queryTable({
          table: "incident",
          fetchAll: true,
          limit: 2,
        });
        assert.deepEqual(
          res.records.map((r) => r.n),
          [0],
        );
        assert.equal(res.truncated, true);
        assert.equal(res.truncatedReason, "scan_limit");
        // The scan budget is cap * FETCH_ALL_SCAN_FACTOR row positions.
        const last = Number(
          new URL(calls.at(-1).url).searchParams.get("sysparm_offset"),
        );
        assert.ok(last < 2 * FETCH_ALL_SCAN_FACTOR, String(last));
        assert.ok(calls.length > 1);
        const out = JSON.parse(
          okQueryResult(res.records, res.total, res.truncated, {
            truncatedReason: res.truncatedReason,
            filtered: res.filtered,
          }).content[0].text,
        );
        assert.equal(out.truncated, true);
        assert.match(out.note, /withheld most matching rows/);
        assert.doesNotMatch(out.note, /SN_MAX_RECORDS cap/);
      },
    ),
  );
});

test("C-1: a page that repeats (offset ignored) ends the read instead of duplicating rows", async () => {
  await withFetch(
    () => jsonResponse(200, { result: [{ n: 0 }] }),
    async (calls) => {
      const res = await queryTable({ table: "incident", fetchAll: true });
      assert.deepEqual(res.records, [{ n: 0 }]);
      assert.equal(calls.length, 2);
    },
  );
});

test("C-1: the truncation note names the real cause", () => {
  const cap = queryCompleteness(3, 10, true, { truncatedReason: "cap" });
  assert.match(cap.note, /SN_MAX_RECORDS cap: 3 of 10/);
  assert.equal(cap.filtered, undefined);

  const capAndAcl = queryCompleteness(3, 10, true, {
    truncatedReason: "cap",
    filtered: 2,
  });
  assert.equal(capAndAcl.filtered, 2);
  assert.match(capAndAcl.note, /withheld 2 matching row\(s\)/);

  const aclOnly = queryCompleteness(4, 6, undefined, { filtered: 2 });
  assert.equal(aclOnly.truncated, undefined);
  assert.equal(aclOnly.filtered, 2);
  assert.match(aclOnly.note, /Complete read of the rows this user can see/);
  assert.match(
    aclOnly.note,
    /X-Total-Count includes rows this user cannot read/,
  );

  assert.deepEqual(queryCompleteness(4, 4, undefined), {});
  // The legacy 3-argument call keeps the legacy cap note.
  const legacy = JSON.parse(okQueryResult([{ a: 1 }], 5, true).content[0].text);
  assert.match(legacy.note, /Stopped at the SN_MAX_RECORDS cap: 1 of 5/);
});

test("C-1: an oversized scan-limited result says the full set was itself partial", async () => {
  await withEnv({ SN_MAX_RESULT_CHARS: "1500" }, () => {
    const records = rows(100).map((r) => ({ ...r, pad: "x".repeat(20) }));
    const out = JSON.parse(
      okQueryResult(records, 900, true, { truncatedReason: "scan_limit" })
        .content[0].text,
    );
    assert.match(out.note, /itself partial \(scan limit reached\)/);
  });
});

// --- C-4: sysparm_display_value=all shapes -----------------------------------

/** Recorded shape of an incident read with sysparm_display_value=all. */
const DISPLAY_ALL_RECORD = {
  number: { display_value: "INC0010001", value: "INC0010001" },
  caller_id: {
    display_value: "Abel Tuter",
    link: "https://dev00000.service-now.com/api/now/table/sys_user/62826bf0",
    value: "62826bf03710200044e0bfc8bcbe5df1",
  },
  u_contact: {
    display_value: "abel.tuter@example.com, abel@example.org",
    value: "abel.tuter@example.com, abel@example.org",
  },
  priority: { display_value: "1 - Critical", value: "1" },
  short_description: "plain string field",
};

test("C-4: PII redaction reaches inside display_value / link pairs", async () => {
  await withEnv({ SN_REDACT_PII: "true" }, () => {
    const { records, redacted } = redactRecords([DISPLAY_ALL_RECORD]);
    const [r] = records;
    assert.equal(r.u_contact.display_value, "[redacted], [redacted]");
    assert.equal(r.u_contact.value, "[redacted], [redacted]");
    assert.equal(redacted, 4);
    // Non-PII pairs keep their shape and values untouched.
    assert.deepEqual(r.priority, DISPLAY_ALL_RECORD.priority);
    assert.deepEqual(r.caller_id, DISPLAY_ALL_RECORD.caller_id);
    // The input is not mutated.
    assert.match(DISPLAY_ALL_RECORD.u_contact.value, /example\.com/);
  });
  await withEnv({ SN_REDACT_FIELDS: "caller_id" }, () => {
    const { records } = redactRecords([DISPLAY_ALL_RECORD]);
    // A named field masks the whole pair.
    assert.equal(records[0].caller_id, "[redacted]");
  });
});

test("C-4: CSV encodes a display_value pair as one quoted JSON cell, after redaction", async () => {
  await withEnv({ SN_REDACT_PII: "true" }, () => {
    const { records } = redactRecords([DISPLAY_ALL_RECORD]);
    const csv = toCsv(records, ["number", "u_contact", "short_description"]);
    const [header, line] = csv.split(/\r?\n/);
    assert.equal(header, "number,u_contact,short_description");
    assert.ok(
      line.startsWith(
        '"{""display_value"":""INC0010001"",""value"":""INC0010001""}"',
      ),
      line,
    );
    assert.doesNotMatch(line, /example\.com/);
    assert.match(line, /plain string field$/);
  });
});

test("C-4: snString unwraps { value } pairs; other objects still map to ''", () => {
  assert.equal(snString(DISPLAY_ALL_RECORD.priority), "1");
  assert.equal(
    snString(DISPLAY_ALL_RECORD.caller_id),
    "62826bf03710200044e0bfc8bcbe5df1",
  );
  assert.equal(snString({ value: true }), "true");
  assert.equal(snString({ value: { nested: 1 } }), "");
  assert.equal(snString({ display_value: "only display" }), "");
  assert.equal(snString(null), "");
});

test("C-4: diagram generators read display_value / reference-link shapes", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/sys_script(\?|$)/);
      return jsonResponse(200, {
        result: [
          {
            sys_id: { display_value: "1", value: "1" },
            name: { display_value: "Validate", value: "Validate" },
            when: { display_value: "Before", value: "before" },
            order: { display_value: "100", value: "100" },
          },
        ],
      });
    },
    async () => {
      const { mermaid } = await generateTableFlow("incident");
      assert.doesNotMatch(mermaid, /\[object Object\]/);
      assert.match(mermaid, /subgraph P_before/);
      assert.match(mermaid, /Validate \(100\)/);
    },
  );

  // SN_INCLUDE_REF_LINKS=true: dictionary references arrive as { link, value }.
  await withEnv({ SN_INCLUDE_REF_LINKS: "true" }, () =>
    withFetch(
      (url) => {
        if (/\/api\/now\/table\/sys_db_object(\?|$)/.test(url)) {
          return jsonResponse(200, { result: [] });
        }
        return jsonResponse(200, {
          result: [
            {
              element: "caller_id",
              internal_type: {
                link: "https://x/sys_glide_object/ref",
                value: "reference",
              },
              reference: {
                link: "https://x/sys_db_object/1",
                value: "sys_user",
              },
              name: "c4_ref_probe",
            },
          ],
        });
      },
      async () => {
        const { mermaid } = await generateErDiagram(["c4_ref_probe"]);
        assert.match(mermaid, /c4_ref_probe \}o--\|\| sys_user : "caller_id"/);
        assert.match(mermaid, /reference caller_id/);
      },
    ),
  );
});

// --- C-9: attachment edges ----------------------------------------------------

test("C-9: a UTF-8 file name is percent-encoded in file_name and round-trips", async () => {
  const fileName = "отчет 2026 — ü.txt";
  await withFetch(
    (url) => {
      assert.match(url, /file_name=%D0%BE%D1%82/);
      assert.equal(new URL(url).searchParams.get("file_name"), fileName);
      return jsonResponse(201, {
        result: { sys_id: "a1", file_name: fileName },
      });
    },
    async () => {
      const meta = await uploadAttachment({
        table: "incident",
        sysId: "rec1",
        fileName,
        contentBase64: Buffer.from("x").toString("base64"),
      });
      assert.equal(meta.file_name, fileName);
    },
  );
});

test("C-9: a 0-byte file uploads with an empty body and downloads as empty base64", async () => {
  await withFetch(
    (url, init) => {
      assert.equal(Buffer.from(init.body).length, 0);
      return jsonResponse(201, {
        result: { sys_id: "empty", size_bytes: "0" },
      });
    },
    async () => {
      const meta = await uploadAttachment({
        table: "incident",
        sysId: "rec1",
        fileName: "empty.txt",
        contentBase64: "",
      });
      assert.equal(meta.size_bytes, "0");
    },
  );
  await withFetch(
    (url) =>
      /\/file$/.test(url)
        ? new Response(new Uint8Array(0), {
            headers: { "content-type": "text/plain" },
          })
        : jsonResponse(200, { result: { sys_id: "empty", size_bytes: "0" } }),
    async (calls) => {
      const file = await downloadAttachment("empty");
      assert.equal(file.base64, "");
      assert.equal(file.sizeBytes, 0);
      assert.equal(calls.length, 2);
    },
  );
});

test("C-9: a data: URL is accepted for upload and supplies the content type", async () => {
  await withFetch(
    (url, init) => {
      assert.equal(Buffer.from(init.body).toString("utf8"), "hi");
      assert.equal(init.headers["Content-Type"], "text/plain");
      return jsonResponse(201, { result: { sys_id: "d1" } });
    },
    async () => {
      await uploadAttachment({
        table: "incident",
        sysId: "rec1",
        fileName: "hi.txt",
        contentBase64: `data:text/plain;charset=utf-8;base64,${Buffer.from("hi").toString("base64")}`,
      });
    },
  );
  // An explicit content type still wins over the data URL's.
  await withFetch(
    (url, init) => {
      assert.equal(init.headers["Content-Type"], "application/x-custom");
      return jsonResponse(201, { result: { sys_id: "d2" } });
    },
    async () => {
      await uploadAttachment({
        table: "incident",
        sysId: "rec1",
        fileName: "hi.bin",
        contentBase64: `data:;base64,${Buffer.from("hi").toString("base64")}`,
        contentType: "application/x-custom",
      });
    },
  );
});

test("C-9: base64 inflation vs SN_MAX_RESULT_CHARS — exactly the limit passes, one group more is refused", async () => {
  // 30 bytes -> 40 base64 chars; 31 bytes -> 44.
  const serve = (bytes, sizeBytes) => (url) =>
    /\/file$/.test(url)
      ? new Response(Buffer.alloc(bytes, 7))
      : jsonResponse(200, {
          result: { sys_id: "b", size_bytes: sizeBytes },
        });

  await withEnv({ SN_MAX_RESULT_CHARS: "40" }, async () => {
    await withFetch(serve(30, "30"), async () => {
      const file = await downloadAttachment("b");
      assert.equal(file.base64.length, 40);
      assert.equal(file.sizeBytes, 30);
    });
    // Metadata pre-check: refused without fetching the bytes.
    await withFetch(serve(31, "31"), async (calls) => {
      await assert.rejects(downloadAttachment("b"), {
        code: "RESPONSE_TOO_LARGE",
        message: /~44 base64 chars > 40/,
      });
      assert.equal(calls.length, 1);
    });
    // Stale/missing size_bytes: the post-check catches the real payload.
    await withFetch(serve(31, ""), async (calls) => {
      await assert.rejects(downloadAttachment("b"), {
        code: "RESPONSE_TOO_LARGE",
        message: /\(44 base64 chars > 40\)/,
      });
      assert.equal(calls.length, 2);
    });
  });
});

test("C-9: sizeBytes accounts for base64 padding", async () => {
  for (const n of [1, 2, 3]) {
    await withFetch(
      (url) =>
        /\/file$/.test(url)
          ? new Response(Buffer.alloc(n, 1))
          : jsonResponse(200, {
              result: { sys_id: "p", size_bytes: String(n) },
            }),
      async () => {
        const file = await downloadAttachment("p");
        assert.equal(file.sizeBytes, n);
      },
    );
  }
});

// --- C-10: plugin inactive vs missing -----------------------------------------

const namespace404 = () =>
  new ServiceNowError("ServiceNow API error (404): not found", 404, {
    error: { message: "Requested URI does not represent any resource" },
  });

test("C-10: a namespace 404 names 'installed but inactive' vs 'not installed'", async () => {
  const prev = setPluginProbe(async () => ({
    state: "inactive",
    id: "com.snc.knowledge_management",
    name: "Knowledge Management",
  }));
  try {
    clearPluginAvailability();
    await assert.rejects(
      pluginCall("Knowledge", async () => {
        throw namespace404();
      }),
      (err) =>
        /may not be active/.test(err.message) &&
        /'Knowledge Management' \(com\.snc\.knowledge_management\) is installed but inactive — activate it/.test(
          err.message,
        ),
    );
    // The cached fast-fail carries the same verdict.
    await assert.rejects(
      pluginCall("Knowledge", async () => assert.fail("must not run")),
      (err) =>
        /probably inactive/.test(err.message) &&
        /activate it/.test(err.message),
    );

    clearPluginAvailability();
    setPluginProbe(async (ids) => ({ state: "missing", ids }));
    await assert.rejects(
      pluginCall("CI/CD", async () => {
        throw namespace404();
      }),
      /No backing plugin \(sn_cicd, com\.glide\.continuousdelivery\) is installed/,
    );

    // A probe that throws degrades to the generic wording.
    clearPluginAvailability();
    setPluginProbe(async () => {
      throw new Error("boom");
    });
    await assert.rejects(
      pluginCall("Service Catalog", async () => {
        throw namespace404();
      }),
      (err) =>
        /may not be active/.test(err.message) &&
        !/installed|No backing plugin/.test(err.message),
    );
  } finally {
    setPluginProbe(prev);
    clearPluginAvailability();
  }
});

test("C-10: the default probe reads v_plugin, falls back to sys_plugins, and never throws", async () => {
  const ids = PLUGIN_CANDIDATES["Change Management"];

  // v_plugin: installed, inactive.
  await withFetch(
    (url) => {
      const u = new URL(url);
      assert.match(u.pathname, /\/table\/v_plugin$/);
      assert.equal(u.searchParams.get("sysparm_query"), `idIN${ids.join(",")}`);
      return jsonResponse(200, {
        result: [
          {
            id: "com.snc.change_management",
            name: "Change",
            active: "inactive",
          },
        ],
      });
    },
    async () => {
      assert.deepEqual(await defaultPluginProbe(ids), {
        state: "inactive",
        id: "com.snc.change_management",
        name: "Change",
      });
    },
  );

  // v_plugin: one active candidate wins.
  await withFetch(
    () =>
      jsonResponse(200, {
        result: [
          { id: "a", active: "inactive" },
          { id: "b", active: "active" },
        ],
      }),
    async () => {
      assert.deepEqual(await defaultPluginProbe(["a", "b"]), {
        state: "active",
        id: "b",
      });
    },
  );

  // v_plugin denied -> sys_plugins (source/active boolean); nothing found.
  await withFetch(
    (url) => {
      if (/\/table\/v_plugin/.test(url)) {
        return jsonResponse(403, { error: { message: "ACL" } });
      }
      assert.match(url, /\/table\/sys_plugins\?/);
      assert.match(new URL(url).searchParams.get("sysparm_query"), /^sourceIN/);
      return jsonResponse(200, { result: [] });
    },
    async () => {
      assert.deepEqual(await defaultPluginProbe(ids), {
        state: "missing",
        ids,
      });
    },
  );

  // sys_plugins with a boolean flag and no id field.
  await withFetch(
    (url) =>
      /v_plugin/.test(url)
        ? jsonResponse(404, { error: { message: "no table" } })
        : jsonResponse(200, { result: [{ name: "X", active: "true" }] }),
    async () => {
      assert.deepEqual(await defaultPluginProbe(["x1"]), {
        state: "active",
        id: "x1",
        name: "X",
      });
    },
  );

  // Both sources fail -> unknown.
  await withFetch(
    () => jsonResponse(403, { error: { message: "ACL" } }),
    async () => {
      assert.equal(await defaultPluginProbe(ids), undefined);
    },
  );
});

test("C-10: verdict wording", () => {
  assert.equal(describeVerdict("Email", undefined), "");
  assert.match(
    describeVerdict("Email", { state: "active", id: "p" }),
    /p is active, so the 404 points at the API path/,
  );
});

// --- C-11 / C-12: domain-separation and cross-scope caveats -------------------

test("C-11: drift reports carry domain-separation and visibility caveats", () => {
  const text = COMPARE_CAVEATS.join("\n");
  assert.match(text, /Domain separation/);
  assert.match(text, /ACLs/);
  assert.match(text, /scopes/);
});

test("C-12: where-used carries cross-scope / visibility caveats", async () => {
  const plain = whereUsedCaveats("script", "MyUtil", 3);
  assert.ok(plain.some((c) => /Cross-scope/.test(c)));
  assert.ok(plain.some((c) => /ACLs and domain separation/.test(c)));
  assert.ok(!plain.some((c) => /scoped name/.test(c)));
  assert.ok(!plain.some((c) => /stopped at/.test(c)));

  const scoped = whereUsedCaveats("table", "x_acme_app_task", 200);
  assert.ok(scoped.some((c) => /scoped name/.test(c)));
  assert.ok(scoped.some((c) => /inherited from parent tables/.test(c)));
  assert.ok(scoped.some((c) => /stopped at 200 matches/.test(c)));

  await withFetch(
    () => jsonResponse(200, { result: [] }),
    async () => {
      const res = await whereUsed("field", "u_c12_probe");
      assert.equal(res.count, 0);
      assert.ok(res.caveats.length >= 3);
    },
  );
});
