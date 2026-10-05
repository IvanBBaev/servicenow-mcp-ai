/**
 * N-18 — tool-selection eval: the pure parts.
 *
 * Everything here works without a ServiceNow instance or network access. It
 * covers loading and validating the case set, building the eval surface from
 * a published `tools/list`, the three model backends (lexical, recorded,
 * Anthropic), scoring, and comparing a run with a stored baseline.
 * `run.mjs` is the CLI around it, and `test/tool-selection-eval.test.js`
 * covers it offline.
 *
 * A backend is `{ id, model, pick(prompt, surface) -> Promise<Answer> }`.
 * An Answer is `{ tool: string | null, input?: object, usage?, error? }`.
 * `tool: null` means the model answered without calling a tool. `input` is
 * left `undefined` when the backend does not produce arguments (lexical), and
 * the argument metrics then skip the case.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const CASE_KINDS = ["positive", "cluster", "write", "negative"];
export const SURFACE_PROFILES = ["core", "all", "discovery"];
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** The env each eval profile publishes `tools/list` under. */
export const PROFILE_ENV = {
  core: {},
  all: { SN_TOOL_PACKAGES: "all" },
};

/** Tools that resolve a "tool not loaded" situation on a narrow surface. */
export const PACKAGE_RESCUE = [
  "servicenow_enable_package",
  "servicenow_list_packages",
];

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------- cases ---

/**
 * Validate a parsed case document. Returns the list of problems (empty when
 * valid). When `knownTools` is given, every expected name must be in it.
 */
export function validateCases(doc, knownTools) {
  const errors = [];
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.cases)) {
    return ["case file must be an object with a `cases` array"];
  }
  const seen = new Set();
  doc.cases.forEach((c, i) => {
    const at = `cases[${i}]${c && c.id ? ` (${c.id})` : ""}`;
    if (!c || typeof c !== "object") return errors.push(`${at}: not an object`);
    if (typeof c.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) {
      errors.push(`${at}: id must be kebab-case`);
    } else if (seen.has(c.id)) {
      errors.push(`${at}: duplicate id`);
    } else seen.add(c.id);
    if (!CASE_KINDS.includes(c.kind)) {
      errors.push(`${at}: kind must be one of ${CASE_KINDS.join(", ")}`);
    }
    if (typeof c.prompt !== "string" || c.prompt.trim().length < 3) {
      errors.push(`${at}: prompt is required`);
    }
    if (
      !Array.isArray(c.expected) ||
      c.expected.some((n) => typeof n !== "string")
    ) {
      errors.push(`${at}: expected must be an array of tool names`);
    } else {
      if (c.kind === "negative" && c.expected.length > 0) {
        errors.push(`${at}: a negative case expects no tool`);
      }
      if (c.kind !== "negative" && c.expected.length === 0) {
        errors.push(`${at}: only negative cases may expect no tool`);
      }
      if (knownTools) {
        for (const n of c.expected) {
          if (!knownTools.has(n)) errors.push(`${at}: unknown tool ${n}`);
        }
      }
    }
    if (c.kind === "cluster" && typeof c.cluster !== "string") {
      errors.push(`${at}: cluster cases need a cluster label`);
    }
    if (c.args !== undefined && (typeof c.args !== "object" || !c.args)) {
      errors.push(`${at}: args must be an object`);
    }
  });
  return errors;
}

/** Read and validate a case file; throws with every problem listed. */
export function loadCases(path, knownTools) {
  const text = readFileSync(path, "utf8");
  const doc = JSON.parse(text);
  const errors = validateCases(doc, knownTools);
  if (errors.length) {
    throw new Error(`invalid case file ${path}:\n  ${errors.join("\n  ")}`);
  }
  return { cases: doc.cases, sha256: sha256(text) };
}

// -------------------------------------------------------------- surface ---

/**
 * Build the eval surface for one profile from published tool lists.
 * `core` and `all` are the real `tools/list` of those profiles. `discovery`
 * simulates a deferred-loading surface until N-63 ships `find_tools`: the
 * core tools in full, every other tool as a name + title stub with an open
 * schema. Picking a stub counts as picking that tool.
 */
export function buildSurface(profile, { core, all }) {
  const full = (t) => ({
    name: t.name,
    title: t.title ?? "",
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object" },
  });
  if (profile === "core") return { profile, tools: core.map(full) };
  if (profile === "all") return { profile, tools: all.map(full) };
  if (profile === "discovery") {
    const coreNames = new Set(core.map((t) => t.name));
    const stubs = all
      .filter((t) => !coreNames.has(t.name))
      .map((t) => ({
        name: t.name,
        title: t.title ?? "",
        description: `${t.title ?? t.name}. (Deferred: full description and schema load on first use.)`,
        inputSchema: { type: "object" },
        stub: true,
      }));
    return { profile, tools: [...core.map(full), ...stubs] };
  }
  throw new Error(
    `unknown profile ${profile}; use ${SURFACE_PROFILES.join(", ")}`,
  );
}

/**
 * The names that count as correct for a case on a surface. Expected tools
 * that are on the surface win; when none of them is published (a package the
 * profile does not load), enabling or listing packages is the right first
 * step.
 */
export function effectiveExpected(c, surfaceNames) {
  if (c.expected.length === 0) return [];
  const present = c.expected.filter((n) => surfaceNames.has(n));
  if (present.length) return present;
  return PACKAGE_RESCUE.filter((n) => surfaceNames.has(n));
}

// ------------------------------------------------------------- argument ---

const typeOk = (type, value) => {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    if (t === "string") return typeof value === "string";
    if (t === "integer") return Number.isInteger(value);
    if (t === "number") return typeof value === "number";
    if (t === "boolean") return typeof value === "boolean";
    if (t === "array") return Array.isArray(value);
    if (t === "object") {
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    }
    if (t === "null") return value === null;
    return true;
  });
};

/**
 * Shallow JSON-Schema check of a tool input: required keys, unknown keys
 * when `additionalProperties` is false, and the top-level property types.
 * It is a selection metric, not a validator; the server re-validates.
 */
export function validateArgs(schema, input) {
  const problems = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["input is not an object"];
  }
  const props = schema?.properties ?? {};
  for (const key of schema?.required ?? []) {
    if (!(key in input)) problems.push(`missing ${key}`);
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = props[key];
    if (!prop) {
      if (schema?.additionalProperties === false) {
        problems.push(`unknown ${key}`);
      }
      continue;
    }
    if (prop.type !== undefined && !typeOk(prop.type, value)) {
      problems.push(`${key} has the wrong type`);
    }
  }
  return problems;
}

// -------------------------------------------------------------- scoring ---

/**
 * Score one answer. `toolPackages` maps tool name -> package for reporting.
 */
export function scoreCase(c, answer, surface, toolPackages = {}) {
  const byName = new Map(surface.tools.map((t) => [t.name, t]));
  const accepted = effectiveExpected(c, new Set(byName.keys()));
  const pick = answer?.tool ?? null;
  const correct =
    accepted.length === 0 ? pick === null : accepted.includes(pick);
  const tool = pick ? byName.get(pick) : undefined;
  const result = {
    id: c.id,
    kind: c.kind,
    cluster: c.cluster ?? null,
    package: c.expected.length
      ? (toolPackages[c.expected[0]] ?? "?")
      : "(none)",
    expected: accepted,
    pick,
    correct,
    unknownTool: Boolean(pick && !tool),
    error: answer?.error ?? null,
  };
  const scoreArgs = tool && !tool.stub && answer.input !== undefined;
  if (scoreArgs) {
    result.argProblems = validateArgs(tool.inputSchema, answer.input);
    if (c.args && correct) {
      for (const [k, v] of Object.entries(c.args)) {
        if (answer.input?.[k] !== v) result.argProblems.push(`${k} != ${v}`);
      }
    }
  }
  if (
    tool &&
    answer.input !== undefined &&
    tool.inputSchema?.properties?.apply !== undefined
  ) {
    // Plan-first: the first call to a write tool previews, it does not apply.
    result.planFirst = answer.input?.apply !== true;
  }
  if (answer?.usage) result.usage = answer.usage;
  return result;
}

const rate = (hits, total) =>
  total === 0 ? null : Math.round((hits / total) * 1000) / 10;

function tally(results, keyOf) {
  const groups = {};
  for (const r of results) {
    const key = keyOf(r);
    if (key === null || key === undefined) continue;
    const g = (groups[key] ??= { n: 0, correct: 0 });
    g.n++;
    if (r.correct) g.correct++;
  }
  for (const g of Object.values(groups)) g.accuracy = rate(g.correct, g.n);
  return Object.fromEntries(
    Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Aggregate scored cases of one profile into the report metrics. */
export function summarize(results) {
  const correct = results.filter((r) => r.correct).length;
  const confusion = {};
  for (const r of results) {
    if (r.correct) continue;
    const key = `${r.expected[0] ?? "(no tool)"} -> ${r.pick ?? "(no tool)"}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  const withArgs = results.filter((r) => r.argProblems !== undefined);
  const planned = results.filter((r) => r.planFirst !== undefined);
  const usage = results.reduce(
    (acc, r) => {
      if (!r.usage) return acc;
      acc.input_tokens += r.usage.input_tokens ?? 0;
      acc.output_tokens += r.usage.output_tokens ?? 0;
      acc.calls++;
      return acc;
    },
    { input_tokens: 0, output_tokens: 0, calls: 0 },
  );
  return {
    n: results.length,
    correct,
    top1: rate(correct, results.length),
    errors: results.filter((r) => r.error).length,
    unknownTools: results.filter((r) => r.unknownTool).length,
    byKind: tally(results, (r) => r.kind),
    byPackage: tally(results, (r) => r.package),
    byCluster: tally(results, (r) => r.cluster),
    confusion: Object.entries(confusion)
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([pair, count]) => ({ pair, count })),
    argValidity:
      withArgs.length === 0
        ? null
        : rate(
            withArgs.filter((r) => r.argProblems.length === 0).length,
            withArgs.length,
          ),
    planFirst:
      planned.length === 0
        ? null
        : rate(planned.filter((r) => r.planFirst).length, planned.length),
    usage: usage.calls ? usage : null,
  };
}

// ------------------------------------------------------------- backends ---

const STOP = new Set(
  (
    "a an and are as at be by can could do does for from has have how i if in " +
    "into is it its me my of on or our please show so that the their them " +
    "then there these this those to us we what when where which who why will " +
    "with you your all any each every one get give tell let make"
  ).split(" "),
);

/** Lowercase word tokens with a crude suffix strip; snake_case splits. */
export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) =>
      w.length > 4
        ? w.replace(/(ing|ies|es|ed|s)$/, (m) => (m === "ies" ? "y" : ""))
        : w,
    );
}

/**
 * Deterministic offline baseline: TF-IDF cosine between the prompt and each
 * tool's name + description. Below `threshold` it abstains (no tool). It
 * measures how lexically separable the descriptions are, not model quality.
 */
export function createLexicalBackend({
  threshold = 0.05,
  headWeight = 3,
} = {}) {
  const cache = new WeakMap();
  const index = (surface) => {
    let idx = cache.get(surface);
    if (idx) return idx;
    const docs = surface.tools.map((t) => {
      const name = t.name.replace(/^servicenow_/, "");
      // Name and title repeat: they are the most specific text a tool has.
      const head = `${name} ${t.title ?? ""} `.repeat(headWeight);
      return { name: t.name, terms: tokenize(`${head}${t.description}`) };
    });
    const df = new Map();
    for (const d of docs) {
      for (const term of new Set(d.terms))
        df.set(term, (df.get(term) ?? 0) + 1);
    }
    const idf = (term) => Math.log(1 + docs.length / (df.get(term) ?? 0.5));
    const vec = (terms) => {
      const v = new Map();
      for (const term of terms) v.set(term, (v.get(term) ?? 0) + 1);
      let norm = 0;
      for (const [term, tf] of v) {
        const w = (1 + Math.log(tf)) * idf(term);
        v.set(term, w);
        norm += w * w;
      }
      return { v, norm: Math.sqrt(norm) || 1 };
    };
    idx = { vec, docs: docs.map((d) => ({ name: d.name, ...vec(d.terms) })) };
    cache.set(surface, idx);
    return idx;
  };
  return {
    id: "lexical",
    model: `lexical-tfidf@${threshold}`,
    async pick(prompt, surface) {
      const idx = index(surface);
      const q = idx.vec(tokenize(prompt));
      let best = null;
      let bestScore = 0;
      for (const d of idx.docs) {
        let dot = 0;
        for (const [term, w] of q.v) dot += w * (d.v.get(term) ?? 0);
        const score = dot / (q.norm * d.norm);
        // Strictly greater: ties keep the earlier tool, so runs are stable.
        if (score > bestScore) {
          bestScore = score;
          best = d.name;
        }
      }
      return { tool: bestScore >= threshold ? best : null, score: bestScore };
    },
  };
}

/**
 * Replay answers recorded from an earlier run:
 * `{ backend, model, answers: { <profile>: { <caseId>: Answer } } }`.
 * A missing answer is reported as an error, never guessed.
 */
export function createRecordedBackend(doc) {
  if (!doc || typeof doc.answers !== "object") {
    throw new Error("recorded answers need an `answers` object");
  }
  return {
    id: "recorded",
    model: `recorded:${doc.model ?? doc.backend ?? "unknown"}`,
    async pick(_prompt, surface, c) {
      const a = doc.answers[surface.profile]?.[c.id];
      if (!a) return { tool: null, error: "no recorded answer" };
      return { tool: a.tool ?? null, input: a.input, usage: a.usage };
    },
  };
}

export const SYSTEM_PROMPT =
  "You are an assistant connected to a ServiceNow instance through the tools " +
  "listed. For the user's request, call the single tool that is the right " +
  "first step, with the arguments you can fill in from the request. If no " +
  "tool fits, reply in text without calling a tool.";

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Anthropic Messages API backend over plain `fetch` (no SDK dependency).
 * `fetchImpl` is injectable so tests never touch the network.
 */
export function createAnthropicBackend({
  apiKey,
  model = DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
  baseUrl = "https://api.anthropic.com",
  maxTokens = 1024,
  maxRetries = 4,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const toolsFor = new WeakMap();
  const apiTools = (surface) => {
    let tools = toolsFor.get(surface);
    if (!tools) {
      tools = surface.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
      toolsFor.set(surface, tools);
    }
    return tools;
  };
  return {
    id: "anthropic",
    model,
    async pick(prompt, surface) {
      const body = JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        tools: apiTools(surface),
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        messages: [{ role: "user", content: prompt }],
      });
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await fetchImpl(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body,
          });
        } catch (err) {
          if (attempt < maxRetries) {
            await sleep(1000 * 2 ** attempt);
            continue;
          }
          return { tool: null, error: `network: ${err.message}` };
        }
        if (RETRYABLE.has(res.status) && attempt < maxRetries) {
          const after = Number(res.headers?.get?.("retry-after"));
          await sleep(after > 0 ? after * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return {
            tool: null,
            error: `HTTP ${res.status}: ${text.slice(0, 300)}`,
          };
        }
        const msg = await res.json();
        const usage = msg.usage
          ? {
              input_tokens: msg.usage.input_tokens ?? 0,
              output_tokens: msg.usage.output_tokens ?? 0,
            }
          : undefined;
        if (msg.stop_reason === "refusal") {
          return { tool: null, usage, error: "refusal" };
        }
        const use = (msg.content ?? []).find((b) => b.type === "tool_use");
        return use
          ? { tool: use.name, input: use.input ?? {}, usage }
          : { tool: null, usage };
      }
    },
  };
}

/** Run `fn` over `items` with at most `limit` in flight; keeps order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

/** Score every case of one surface with one backend. */
export async function evaluate({
  cases,
  surface,
  backend,
  toolPackages,
  concurrency = 1,
}) {
  const answers = await mapLimit(cases, concurrency, (c) =>
    backend.pick(c.prompt, surface, c),
  );
  const results = cases.map((c, i) =>
    scoreCase(c, answers[i], surface, toolPackages),
  );
  return { answers, results, summary: summarize(results) };
}

// ------------------------------------------------------------- baseline ---

/** sha256 of every published description, keyed by tool name. */
export function descriptionHashes(tools) {
  return Object.fromEntries(
    [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => [t.name, sha256(t.description ?? "")]),
  );
}

/** Tools whose description changed, appeared or vanished since `before`. */
export function descriptionDrift(before = {}, after = {}) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [name, hash] of Object.entries(after)) {
    if (!(name in before)) added.push(name);
    else if (before[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) removed.push(name);
  }
  return { changed, added, removed };
}

/** Per-profile top-1 delta (points) and the cases that flipped. */
export function compareToBaseline(baseline, run) {
  const out = {};
  for (const [profile, cur] of Object.entries(run.profiles)) {
    const base = baseline.profiles?.[profile];
    if (!base) continue;
    const flips = { fixed: [], broken: [] };
    const basePicks = baseline.picks?.[profile] ?? {};
    for (const r of run.results?.[profile] ?? []) {
      const was = basePicks[r.id];
      if (!was) continue;
      if (was.correct && !r.correct) flips.broken.push(r.id);
      if (!was.correct && r.correct) flips.fixed.push(r.id);
    }
    out[profile] = {
      before: base.top1,
      after: cur.top1,
      delta: Math.round((cur.top1 - base.top1) * 10) / 10,
      ...flips,
    };
  }
  return out;
}
