// Shared test utilities. Each test file still runs in its own process under
// `node --test`, but going through these helpers keeps env handling and fetch
// mocking identical everywhere (and survives a future move to a shared-process
// runner).

import { reloadCredentialsFromEnv } from "../build/core/config.js";
import { createRuntime, installRuntime } from "../build/core/runtime.js";
import { ARTIFACT_TYPES } from "../build/core/artifacts/registry.js";
import assert from "node:assert/strict";

export const realFetch = globalThis.fetch;

/** Proxy variables H-10's dispatcher reads (both spellings). */
const PROXY_ENV = [
  "SN_HTTPS_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
];

/**
 * Reset the credential/policy env to the baseline most tests assume:
 * valid instance, Basic auth, no retries, no policy restrictions.
 */
export function baselineEnv() {
  process.env.SN_INSTANCE = "dev00000.service-now.com";
  process.env.SN_USER = "alice";
  process.env.SN_PASSWORD = "s3cret";
  process.env.SN_MAX_RETRIES = "0";
  delete process.env.SN_AUTH;
  delete process.env.SN_OAUTH_CLIENT_ID;
  delete process.env.SN_OAUTH_CLIENT_SECRET;
  delete process.env.SN_TABLES_ALLOW;
  delete process.env.SN_TABLES_DENY;
  delete process.env.SN_READONLY;
  delete process.env.SN_ACTIVE_PROFILE;
  // A proxy in the developer's shell (corporate / cloud dev environments) must
  // not reach the mock-fetch tests: H-10 routes proxied hosts through undici.
  for (const key of PROXY_ENV) delete process.env[key];
  // Credentials live in the config store; staging env vars alone is not enough.
  reloadCredentialsFromEnv();
}

/**
 * E-3: install a brand-new runtime container (empty caches, queue, breakers,
 * dispatchers, telemetry and profile store) and return it; the previous one is
 * disposed. Replaces the old `_reset*` test hooks.
 */
export function freshRuntime() {
  const runtime = createRuntime();
  const previous = installRuntime(runtime);
  if (previous) void previous.dispose();
  return runtime;
}

/**
 * Deletes first, then sets: Windows env keys are case-insensitive, so
 * `{ HTTPS_PROXY: "x", https_proxy: undefined }` applied in order would drop
 * the value just set.
 */
function applyEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
}

/** Run `fn` with the given env overrides, restoring the previous values after. */
export async function withEnv(overrides, fn) {
  const saved = new Map();
  for (const key of Object.keys(overrides)) saved.set(key, process.env[key]);
  applyEnv(overrides);
  reloadCredentialsFromEnv();
  try {
    return await fn();
  } finally {
    applyEnv(Object.fromEntries(saved));
    reloadCredentialsFromEnv();
  }
}

/**
 * N-21: the secret-column index read (one sys_dictionary query per profile,
 * see api/secret-columns.ts) that every Table API read may trigger. The fetch
 * doubles answer it themselves — an empty index, i.e. "unresolved", so the
 * OOTB secret names apply — and leave it out of `calls`, so request-shape
 * tests keep their counts. Pass `{ maskingLookup: true }` to see and answer it.
 */
export function isMaskingLookup(url) {
  const u = new URL(String(url));
  return (
    /\/api\/now\/table\/sys_dictionary$/.test(u.pathname) &&
    (u.searchParams.get("sysparm_query") ?? "").startsWith("internal_typeIN")
  );
}

const emptyIndex = () => jsonResponse(200, { result: [] });

/** Run `fn` with `globalThis.fetch` replaced by `handler`, then restore it. */
export async function withFetch(handler, fn, { maskingLookup = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!maskingLookup && isMaskingLookup(url)) return emptyIndex();
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

export const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/**
 * Metadata-only invariant (ID-02, ID-27): documentation generators read
 * structure — dictionary, scripts, automation definitions, counts — never
 * record data. Every request of a generator under test must hit one of these
 * tables. Every artefact table of the P-1 registry (primary and child) is
 * metadata too, so those are derived from it rather than listed by hand.
 */
export const METADATA_TABLES = [
  /^sys_db_object$/,
  /^sys_dictionary$/,
  /^sys_script(_include|_client)?$/,
  /^sys_plugins$/,
  /^v_plugin$/,
  /^sys_app$/,
  /^sys_store_app$/,
  /^sys_scope_privilege$/,
  /^sys_security_acl$/,
  /^sys_security_acl_role$/,
  /^sys_user_role(_contains)?$/,
  // Flow Designer definition tables, versioned ones included (…_v2).
  /^sys_hub_[a-z0-9_]+$/,
  /^wf_workflow$/,
  /^sysevent_email_action$/,
  // Script-bearing configuration the where-used scan reads (scripts.ts).
  /^sys_ui_(policy|action)$/,
  /^sys_transform_script$/,
  /^sys_ws_(definition|operation)$/,
  /^sysauto_script$/,
  // S-4: the widened script-tools view — code-bearing configuration, still
  // metadata (sys_dictionary is already listed above).
  /^sysevent_script_action$/,
  /^sys_transform_(map|entry)$/,
  /^sys_script_(fix|email|validator)$/,
  /^sys_processor$/,
  /^sys_data_source$/,
  /^sys_rest_message(_fn)?$/,
  /^sys_ui_(script|page|macro)$/,
  /^sp_widget$/,
  /^catalog_script_client$/,
  // S-5: the opt-in trace lanes — data policies, SLA definitions and the
  // event registry (definitions, not records).
  /^sys_data_policy2$/,
  /^contract_sla$/,
  /^sysevent_register$/,
  // S-3 security scan and the S-15 kinds: public pages, properties, choices,
  // the catalog definitions.
  /^sys_public$/,
  /^sys_properties$/,
  /^sys_choice$/,
  /^sc_(catalog|category|cat_item)$/,
  /^item_option_new$/,
  // S-15 document_instance: in-progress update sets (names, not updates).
  /^sys_update_set$/,
  // S-9 structural where-used: list / form layouts and report definitions.
  /^sys_ui_(list|list_element|section|element)$/,
  /^sys_report$/,
  // N-14 cross-scope report: restricted caller access grants (configuration).
  /^sys_restricted_caller_access$/,
  // N-3 Instance Scan read: scan results and findings (check / target refs).
  /^scan_(result|finding)$/,
  // N-30 workspace coverage: declarative actions, themes, the workspace
  // category and the legacy Agent Workspace configuration.
  /^sys_declarative_action_[a-z_]+$/,
  /^m2m_app_theme$/,
  /^sys_ux_registry_m2m_category$/,
  /^sys_aw_(master_config|list)$/,
  // N-7 translation coverage: UI messages, labels, translated text, languages.
  /^sys_ui_message$/,
  /^sys_documentation$/,
  /^sys_translated_text$/,
  /^sys_language$/,
];

/** Primary and child tables of every registered artefact type. */
const ARTIFACT_TABLES = new Set(
  ARTIFACT_TYPES.flatMap((t) => [t.table, ...t.children.map((c) => c.table)]),
);

/** Throw unless `url` is a metadata read (a table in the allow-list, or stats). */
export function assertMetadataUrl(url) {
  const { pathname } = new URL(url);
  if (pathname.startsWith("/api/now/stats/")) return;
  const m = /^\/api\/now\/table\/([^/]+)/.exec(pathname);
  assert.ok(m, `non-table request from a generator: ${pathname}`);
  assert.ok(
    ARTIFACT_TABLES.has(m[1]) || METADATA_TABLES.some((re) => re.test(m[1])),
    `generator read a non-metadata table: ${m[1]}`,
  );
}

/**
 * withFetch plus the metadata-only allow-list. A rejected URL throws inside
 * the fetch double, but collectors turn fetch errors into `unreadable`
 * sections, so the violation is also recorded and re-thrown once `fn`
 * settles — a generator that reads record data fails the test even when it
 * degrades gracefully.
 */
export async function withMetadataFetch(handler, fn) {
  const violations = [];
  let outcome;
  try {
    outcome = {
      value: await withFetch((url, ...rest) => {
        try {
          assertMetadataUrl(url);
        } catch (err) {
          violations.push(err);
          throw err;
        }
        return handler(url, ...rest);
      }, fn),
    };
  } catch (err) {
    outcome = { error: err };
  }
  if (violations.length > 0) throw violations[0];
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

// --- E-6 / L9-01: fetch double v2 and a fake clock ------------------------
//
// `withFetch` above takes one handler for every request. The double below
// routes by method + path, records what each call sent (headers, body,
// dispatcher, signal), and builds responses from a small spec that can carry
// headers, a delay and a streamed body. Delays use the global `setTimeout`, so
// under node:test `mock.timers` they only elapse when the test advances the
// clock — retry, deadline and queue tests run in virtual time.

/** Resolve after `ms` on the (possibly mocked) clock, rejecting when `signal` aborts. */
function doubleSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    if (!(ms > 0)) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait until `signal` aborts (a request that never answers), then reject with its reason. */
function hangUntilAborted(signal) {
  return new Promise((_resolve, reject) => {
    if (!signal) return; // never settles — only use with a signal
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}

/** A plain lower-cased header record from any HeadersInit. */
function headerRecord(headers) {
  const out = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** A ReadableStream that yields `chunks` (strings or bytes), `chunkDelayMs` apart. */
function chunkStream(chunks, chunkDelayMs, signal) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      try {
        if (i > 0) await doubleSleep(chunkDelayMs, signal);
      } catch (reason) {
        controller.error(reason);
        return;
      }
      const chunk = chunks[i++];
      controller.enqueue(
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      );
    },
  });
}

/**
 * Turn a response spec into a Response. A spec is
 * `{ status, headers, json | body | stream, chunkDelayMs, delayMs, hang,
 *    error, abortable }`:
 *   - `json` is serialised with a JSON content type; `body` is sent as is;
 *     `stream` is a list of chunks sent `chunkDelayMs` apart.
 *   - `delayMs` holds the answer back on the (mockable) clock.
 *   - `hang: true` never answers; the request ends only through its signal.
 *   - `error` makes the fetch reject (a string becomes `TypeError(error)`,
 *     like undici's "fetch failed").
 *   - `abortable: false` ignores the request signal during the delay.
 * A Response instance is passed through unchanged.
 */
async function specResponse(spec, signal) {
  if (spec instanceof Response) return spec;
  const s = spec ?? {};
  const watch = s.abortable === false ? undefined : signal;
  if (s.hang) await hangUntilAborted(watch);
  if (s.delayMs) await doubleSleep(s.delayMs, watch);
  else if (watch?.aborted) throw watch.reason;
  if (s.error !== undefined) {
    throw typeof s.error === "string" ? new TypeError(s.error) : s.error;
  }
  const headers = { ...(s.headers ?? {}) };
  let body = null;
  if (s.stream) {
    body = chunkStream(s.stream, s.chunkDelayMs ?? 0, watch);
  } else if (s.json !== undefined) {
    body = JSON.stringify(s.json);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type"))
      headers["content-type"] = "application/json";
  } else if (s.body !== undefined) {
    body = s.body;
  }
  const status = s.status ?? 200;
  // A null-body status (204/304) must not carry a body.
  if (status === 204 || status === 304) body = null;
  return new Response(body, { status, headers });
}

/**
 * Create a fetch double (L9-01). Routes are tried in registration order;
 * `route(method, path, responder)`:
 *   - `method` is an HTTP method or `"*"`;
 *   - `path` is a RegExp tested against the pathname, or a string that must
 *     equal it;
 *   - `responder` is a spec (see specResponse), a Response factory
 *     `(call, hit) => spec | Response | Promise<…>` (throw to fail the fetch),
 *     or an array of those answered in turn (the last one repeats).
 * `calls` records `{ n, method, url, path, query, headers, body, dispatcher,
 * signal, at }` per request (`at` is `Date.now()`, i.e. virtual time under
 * mock timers). A request no route matches gets a 501 and is listed in
 * `unmatched`, so a missing route fails loudly instead of hanging.
 */
export function createFetchDouble({ fallback, maskingLookup = false } = {}) {
  const routes = [];
  const calls = [];
  const unmatched = [];

  const pick = (route) => {
    const r = route.responder;
    if (!Array.isArray(r)) return r;
    return r[Math.min(route.hits - 1, r.length - 1)];
  };

  const fetchImpl = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!maskingLookup && isMaskingLookup(url)) return emptyIndex();
    const parsed = new URL(url);
    const method = String(init.method ?? "GET").toUpperCase();
    const call = {
      n: calls.length + 1,
      method,
      url,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: headerRecord(init.headers),
      body: init.body,
      dispatcher: init.dispatcher,
      signal: init.signal,
      at: Date.now(),
    };
    calls.push(call);
    const route = routes.find(
      (r) =>
        (r.method === "*" || r.method === method) &&
        (typeof r.path === "string"
          ? r.path === call.path
          : r.path.test(call.path)),
    );
    let responder;
    if (route) {
      route.hits += 1;
      responder = pick(route);
    } else if (fallback !== undefined) {
      responder = fallback;
    } else {
      unmatched.push(call);
      return new Response(
        JSON.stringify({
          error: {
            message: `fetch double: no route for ${method} ${call.path}`,
          },
        }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
    }
    const spec =
      typeof responder === "function"
        ? await responder(call, route?.hits ?? 0)
        : responder;
    return specResponse(spec, init.signal);
  };

  const double = {
    calls,
    unmatched,
    fetch: fetchImpl,
    route(method, path, responder) {
      routes.push({ method: method.toUpperCase(), path, responder, hits: 0 });
      return double;
    },
    /** Calls whose method and path match (same rules as `route`). */
    callsTo(method, path) {
      return calls.filter(
        (c) =>
          (method === "*" || c.method === method.toUpperCase()) &&
          (typeof path === "string" ? c.path === path : path.test(c.path)),
      );
    },
    install() {
      globalThis.fetch = fetchImpl;
      return double;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
  return double;
}

/**
 * Run `fn(double)` with a fetch double installed; `setup(double)` registers
 * its routes first. The real fetch is restored afterwards.
 */
export async function withFetchDouble(setup, fn) {
  const double = createFetchDouble();
  setup?.(double);
  double.install();
  try {
    return await fn(double);
  } finally {
    double.restore();
  }
}

/** Let pending promise callbacks run (setImmediate stays on the real clock). */
export async function flushAsync(turns = 3) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Enable node:test fake timers (`setTimeout` + `Date`) on the test context
 * `t` and return a small clock driver:
 *   - `tick(ms)` advances virtual time;
 *   - `flush()` lets queued promise callbacks run;
 *   - `run(promise, { step, maxMs })` advances the clock in `step` slices until
 *     `promise` settles and returns (or throws) its outcome; `maxMs` bounds the
 *     virtual time so a stuck promise fails the test instead of hanging it;
 *   - `elapsed()` is the virtual time since the clock started.
 * `setImmediate` and `AbortSignal.timeout` keep real time; a double that
 * answers without `hang` never lets an AbortSignal.timeout fire.
 */
export function fakeClock(t, { now = 1_700_000_000_000 } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const start = now;
  const clock = {
    tick(ms) {
      t.mock.timers.tick(ms);
    },
    flush: flushAsync,
    elapsed() {
      return Date.now() - start;
    },
    async run(promise, { step = 25, maxMs = 120_000 } = {}) {
      let settled = false;
      const tracked = Promise.resolve(promise).then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      // Observe the rejection now; it is re-thrown by the final await below.
      tracked.catch(() => {});
      let advanced = 0;
      await flushAsync();
      while (!settled) {
        if (advanced >= maxMs) {
          throw new Error(
            `fakeClock.run: promise still pending after ${maxMs} ms of virtual time`,
          );
        }
        t.mock.timers.tick(step);
        advanced += step;
        await flushAsync();
      }
      return tracked;
    },
  };
  return clock;
}

// ---------------------------------------------------------------------------
// E-6 / L9-02: deterministic property-run parameters.
// ---------------------------------------------------------------------------

/** The fixed fast-check seed every property file shares (override: SN_FC_SEED). */
export const FC_SEED = Number(process.env.SN_FC_SEED) || 0x5e6c0de;

/**
 * fast-check parameters for the property files: a fixed seed so a failure
 * reproduces on every run, and a modest run count that `SN_FC_RUNS` can
 * raise (e.g. for a soak run). `scale` shrinks it for the slow, fs-heavy
 * properties (docs store, write journal).
 */
export function fcParams({ scale = 1, numRuns } = {}) {
  const base = Number(process.env.SN_FC_RUNS) || 100;
  return {
    seed: FC_SEED,
    numRuns: numRuns ?? Math.max(5, Math.round(base * scale)),
  };
}
