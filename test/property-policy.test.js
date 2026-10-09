// E-6 / L9-02: property tests for policy resolution (global vs per-profile
// keys, deny-over-allow, read-only spellings) and the two glob-style
// allow-lists: the host allow-list (exact / suffix / port /
// internal-needs-exact), the upload MIME allow-list (`type/*`) and the H-11
// table glob (`*` / `?` entries in SN_TABLES_ALLOW / SN_TABLES_DENY).
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  assertTableAllowed,
  evaluateTable,
  getAllowedTables,
  getDeniedTables,
  globToRegExp,
  isReadOnly,
} from "../build/core/policy.js";
import { _isBlockedHost, resolveHost } from "../build/core/host.js";
import { prepareUpload } from "../build/api/attachment.js";
import { ServiceNowError } from "../build/core/errors.js";
import { baselineEnv, fcParams } from "./helpers.js";

baselineEnv();

/** Set env keys for the duration of a synchronous `fn`, then restore them. */
function withEnvSync(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const TABLES = [
  "incident",
  "problem",
  "sys_user",
  "change_request",
  "cmdb_ci",
  "task",
];
const table = fc.constantFrom(...TABLES);
/** A table name as a user might type it: any case, stray whitespace. */
const spelled = table.chain((t) =>
  fc
    .tuple(
      fc.array(fc.boolean(), { minLength: t.length, maxLength: t.length }),
      fc.constantFrom("", " ", "  ", "\t"),
      fc.constantFrom("", " ", "\t"),
    )
    .map(
      ([caps, pre, post]) =>
        pre +
        [...t].map((c, i) => (caps[i] ? c.toUpperCase() : c)).join("") +
        post,
    ),
);
/** A raw comma list the way it sits in the env file (blanks and spacing included). */
const rawList = fc
  .array(fc.oneof(spelled, fc.constant(""), fc.constant(" ")), { maxLength: 4 })
  .map((xs) => xs.join(","));
const maybeList = fc.option(rawList, { nil: undefined });
const parse = (raw) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
const profileName = fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/);

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

test("policy resolution: a defined profile key overrides the global one, otherwise the global applies", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.constant("default"), profileName),
      maybeList,
      maybeList,
      maybeList,
      maybeList,
      (profile, gAllow, gDeny, pAllow, pDeny) => {
        const P = `SN_PROFILE_${profile.toUpperCase()}`;
        withEnvSync(
          {
            SN_TABLES_ALLOW: gAllow,
            SN_TABLES_DENY: gDeny,
            [`${P}_TABLES_ALLOW`]: pAllow,
            [`${P}_TABLES_DENY`]: pDeny,
          },
          () => {
            const scoped = profile !== "default";
            const allow = scoped && pAllow !== undefined ? pAllow : gAllow;
            const deny = scoped && pDeny !== undefined ? pDeny : gDeny;
            assert.deepEqual(getAllowedTables(profile), parse(allow));
            assert.deepEqual(getDeniedTables(profile), parse(deny));
            // An empty profile value is still "defined": it clears the global list.
            if (scoped && pAllow === "")
              assert.deepEqual(getAllowedTables(profile), []);
          },
        );
      },
    ),
    fcParams(),
  );
});

test("assertTableAllowed: deny always wins, an allow-list admits only its members, case and spacing never matter", () => {
  fc.assert(
    fc.property(
      fc.option(profileName, { nil: undefined }),
      maybeList,
      maybeList,
      spelled,
      (profile, allowRaw, denyRaw, requested) => {
        // The active profile's scoped keys carry the lists (or the global ones
        // when no profile is active) — the guard must resolve the same way.
        const P = profile ? `SN_PROFILE_${profile.toUpperCase()}_` : "SN_";
        withEnvSync(
          {
            SN_ACTIVE_PROFILE: profile,
            SN_TABLES_ALLOW: profile ? "unrelated_table" : undefined,
            SN_TABLES_DENY: undefined,
            [`${P}TABLES_ALLOW`]: allowRaw,
            [`${P}TABLES_DENY`]: denyRaw,
          },
          () => {
            const t = requested.trim().toLowerCase();
            // With a profile active and no scoped allow key, the global one applies.
            const allow = parse(
              profile && allowRaw === undefined ? "unrelated_table" : allowRaw,
            );
            const denied = parse(denyRaw).includes(t);
            const permitted =
              !denied && (allow.length === 0 || allow.includes(t));
            let error;
            try {
              assertTableAllowed(requested);
            } catch (e) {
              error = e;
            }
            if (permitted)
              assert.equal(error, undefined, `${requested} should pass`);
            else {
              assert.ok(
                error instanceof ServiceNowError,
                `${requested} should be refused`,
              );
              assert.equal(error.status, 403);
              assert.match(
                error.message,
                denied ? /SN_TABLES_DENY/ : /SN_TABLES_ALLOW/,
              );
            }
          },
        );
      },
    ),
    fcParams(),
  );
});

test("isReadOnly: exactly 1/true/yes/on (any case, padded) switch writes off, per profile with global fallback", () => {
  const truthy = ["1", "true", "yes", "on"];
  const flag = fc.oneof(
    fc.constantFrom(
      ...truthy,
      "0",
      "false",
      "no",
      "off",
      "",
      "2",
      "y",
      "enabled",
    ),
    fc.string({ maxLength: 5 }),
  );
  const spelledFlag = fc
    .tuple(flag, fc.boolean(), fc.constantFrom("", " "))
    .map(([f, upper, pad]) => pad + (upper ? f.toUpperCase() : f) + pad);
  fc.assert(
    fc.property(
      fc.oneof(fc.constant("default"), profileName),
      fc.option(spelledFlag, { nil: undefined }),
      fc.option(spelledFlag, { nil: undefined }),
      (profile, global, scoped) => {
        withEnvSync(
          {
            SN_READONLY: global,
            [`SN_PROFILE_${profile.toUpperCase()}_READONLY`]: scoped,
          },
          () => {
            const raw =
              profile !== "default" && scoped !== undefined ? scoped : global;
            const want = truthy.includes((raw ?? "").trim().toLowerCase());
            assert.equal(
              isReadOnly(profile),
              want,
              JSON.stringify({ profile, global, scoped }),
            );
          },
        );
      },
    ),
    fcParams(),
  );
});

// ---------------------------------------------------------------------------
// Host allow-list (policy glob: exact / .suffix / port / internal)
// ---------------------------------------------------------------------------

const label = fc.constantFrom(
  "a",
  "b",
  "corp",
  "example",
  "com",
  "internal",
  "local",
  "localhost",
  "sn",
);
const hostName = fc
  .array(label, { minLength: 2, maxLength: 4 })
  .map((ls) => ls.join("."));
const port = fc.constantFrom(undefined, undefined, "443", "8443", "9000");
const withPort = (h, p) => (p ? `${h}:${p}` : h);
const norm = (p) => (p === "443" ? undefined : p);

test("host allow-list: accepted iff an entry matches exactly or as a parent domain with the same port; internal hosts need an exact entry", () => {
  const entry = fc
    .tuple(fc.oneof(hostName, label), fc.boolean(), port, fc.boolean())
    .map(([h, dot, p, upper]) => {
      const e = withPort((dot ? "." : "") + h, p);
      return upper ? e.toUpperCase() : e;
    });
  fc.assert(
    fc.property(
      hostName,
      port,
      fc.array(entry, { minLength: 1, maxLength: 4 }),
      fc.constantFrom("", "https://"),
      (host, p, entries, scheme) => {
        withEnvSync({ SN_ALLOWED_HOSTS: entries.join(" , ") }, () => {
          const target = { host, port: norm(p) };
          const matches = entries.map((raw) => {
            const e = raw.toLowerCase().replace(/^\./, "");
            const [eh, ep] = e.split(":");
            if (norm(ep) !== target.port) return "none";
            if (eh === host) return "exact";
            return host.endsWith(`.${eh}`) ? "suffix" : "none";
          });
          const any = matches.some((m) => m !== "none");
          const exact = matches.includes("exact");
          const want = any && (!_isBlockedHost(host) || exact);
          const canonical = withPort(host, target.port);
          let got;
          try {
            got = resolveHost(`${scheme}${withPort(host, p)}/some/path`);
          } catch (e) {
            assert.ok(e instanceof ServiceNowError, String(e));
            got = undefined;
          }
          if (want)
            assert.equal(got, canonical, `${canonical} vs [${entries}]`);
          else
            assert.equal(
              got,
              undefined,
              `${canonical} should be refused by [${entries}]`,
            );
        });
      },
    ),
    fcParams(),
  );
});

test("host allow-list off: only *.service-now.com without a port, never an internal name", () => {
  fc.assert(
    fc.property(hostName, port, fc.boolean(), (host, p, canonicalDomain) => {
      const full = canonicalDomain ? `${host}.service-now.com` : host;
      withEnvSync({ SN_ALLOWED_HOSTS: undefined }, () => {
        let got;
        try {
          got = resolveHost(withPort(full, p));
        } catch {
          got = undefined;
        }
        const want =
          canonicalDomain && !norm(p) && !_isBlockedHost(full)
            ? full
            : undefined;
        assert.equal(got, want, withPort(full, p));
      });
    }),
    fcParams(),
  );
});

// ---------------------------------------------------------------------------
// Upload MIME allow-list (`type/*` glob)
// ---------------------------------------------------------------------------

test("upload MIME allow-list: `major/*` admits every subtype of that major type only; exact entries match exactly", () => {
  const major = fc.constantFrom("image", "text", "application", "video");
  const minor = fc.constantFrom(
    "png",
    "plain",
    "json",
    "pdf",
    "mp4",
    "html",
    "x-foo",
  );
  const allowEntry = fc.oneof(
    major.map((m) => `${m}/*`),
    fc.tuple(major, minor).map(([m, s]) => `${m}/${s}`),
  );
  const contentType = fc
    .tuple(
      major,
      minor,
      fc.boolean(),
      fc.constantFrom("", "; charset=utf-8", " ;q=1"),
    )
    .map(([m, s, upper, params]) => {
      const t = `${m}/${s}`;
      return (upper ? t.toUpperCase() : t) + params;
    });
  fc.assert(
    fc.property(
      fc.array(allowEntry, { minLength: 1, maxLength: 4 }),
      contentType,
      (allow, type) => {
        withEnvSync({ SN_UPLOAD_MIME_ALLOW: allow.join(",") }, () => {
          const bare = type.split(";")[0].trim().toLowerCase();
          const [m] = bare.split("/");
          const want = allow.some((e) => e === bare || e === `${m}/*`);
          let ok = true;
          try {
            prepareUpload({
              fileName: "a.bin",
              contentBase64: "",
              contentType: type,
            });
          } catch (e) {
            assert.equal(e.code, "MIME_NOT_ALLOWED");
            ok = false;
          }
          assert.equal(ok, want, `${type} vs [${allow}]`);
        });
      },
    ),
    fcParams(),
  );
});

// ---------------------------------------------------------------------------
// Table glob (H-11 / L3-01): `*` any run, `?` one character, else literal
// ---------------------------------------------------------------------------

/** Reference glob matcher: plain dynamic programming over pattern × name. */
function globMatches(pattern, name) {
  const p = [...pattern];
  const n = [...name];
  let row = [true, ...n.map(() => false)];
  for (const c of p) {
    const next = [c === "*" && row[0]];
    for (let j = 1; j <= n.length; j++) {
      next[j] =
        c === "*"
          ? row[j] || next[j - 1]
          : (c === "?" || c === n[j - 1]) && row[j - 1];
    }
    row = next;
  }
  return row[n.length];
}

// A tiny alphabet so random names and patterns actually collide.
const nameChar = fc.constantFrom("a", "b", "_", ".");
const tableName = fc
  .array(nameChar, { minLength: 1, maxLength: 5 })
  .map((cs) => cs.join(""));
const globEntry = fc
  .array(fc.oneof(nameChar, fc.constantFrom("*", "?")), {
    minLength: 1,
    maxLength: 5,
  })
  .map((cs) => cs.join(""));

test("table glob: an entry matches exactly the names the reference matcher accepts; `.` and `_` are literal", () => {
  fc.assert(
    fc.property(globEntry, tableName, (entry, name) => {
      const re = globToRegExp(entry);
      const isGlob = /[*?]/.test(entry);
      assert.equal(re === null, !isGlob, entry);
      const got = re ? re.test(name) : entry === name;
      assert.equal(got, globMatches(entry, name), `${entry} vs ${name}`);
    }),
    fcParams(),
  );
});

test("table policy order: exact deny, exact allow, pattern deny, then the allow-list's patterns; no list means no policy", () => {
  const entries = fc.array(fc.oneof(tableName, globEntry), { maxLength: 4 });
  fc.assert(
    fc.property(entries, entries, tableName, (allow, deny, name) => {
      withEnvSync(
        {
          SN_TABLES_ALLOW: allow.join(","),
          SN_TABLES_DENY: deny.join(","),
        },
        () => {
          const glob = (e) => /[*?]/.test(e);
          const expected = deny.some((e) => !glob(e) && e === name)
            ? ["deny-exact", false]
            : allow.some((e) => !glob(e) && e === name)
              ? ["allow-exact", true]
              : deny.some((e) => glob(e) && globMatches(e, name))
                ? ["deny-pattern", false]
                : allow.length === 0
                  ? ["no-policy", true]
                  : allow.some((e) => glob(e) && globMatches(e, name))
                    ? ["allow-pattern", true]
                    : ["not-in-allowlist", false];
          // Reads only: the protected list applies to writes.
          const verdict = evaluateTable(name, "read", "default");
          assert.deepEqual(
            [verdict.rule, verdict.allowed],
            expected,
            JSON.stringify({ allow, deny, name }),
          );
        },
      );
    }),
    fcParams(),
  );
});
